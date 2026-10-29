import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import {
  availableParallelism,
  homedir,
  hostname,
  loadavg,
  totalmem,
} from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { browserStreamWorker } from "@harness/browser/live";
import { captureSnapshot, restoreSnapshot } from "@harness/checkpoints";
import type { ClaimedTurn } from "@harness/core";
import {
  executeTurn,
  HarnessError,
  type Provider,
  type RuntimeEvent,
} from "@harness/core";
import {
  type DecisionSnapshot,
  decisionInstructions,
} from "@harness/core/knowledge";
import type { NativeSessionStore } from "@harness/core/native-store";
import {
  COMMIT,
  parseWorkerReport,
  sameCommit,
  type WorkerReport,
} from "@harness/core/scheduling";
import { createRuntime, fullAccess } from "@harness/runtimes";
import type { WorkerAssignment } from "@harness/storage/control";
import {
  confirmRelease,
  prepareRelease,
  RESTART,
  readState,
  switchRelease,
} from "../../../scripts/worker-launcher.mjs";
import { materializeAttachments } from "./attachments";
import { browserWorker, createBrowserHost } from "./browser";
import { WorkerClient } from "./client";
import { workerIdentity } from "./identity";
import { isolatedAgents, prepareIdentity } from "./isolation";
import {
  clearDecisionUpdates,
  collectDecisionUpdates,
  prepareDecisionFiles,
} from "./knowledge";
import { SecretRedactor } from "./redaction";
import { hostMemory } from "./resources";

function setting(name: string, fallback: number, minimum = 0): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${name} must be an integer >= ${minimum}.`);
  return value;
}
function executable(command: string): boolean {
  return (
    command.includes("/")
      ? [command]
      : (process.env.PATH ?? "")
          .split(delimiter)
          .map((path) => join(path, command))
  ).some((path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
const concurrency = setting("HARNESS_CONCURRENCY", 1, 1);
const pollMs = setting("HARNESS_POLL_MS", 1000, 50);
const idlePollMs = setting(
  "HARNESS_IDLE_POLL_MS",
  Math.max(5000, pollMs),
  pollMs,
);
const timeoutMs = setting("HARNESS_TURN_TIMEOUT_MS", 30 * 60 * 1000, 1);
const identity = await workerIdentity();
const client = new WorkerClient(identity);
const cache = resolve(
  process.env.HARNESS_WORKER_DATA_DIR ??
    join(
      process.env.HARNESS_DATA_DIR ?? "../../.data",
      "worker-cache",
      identity.id,
    ),
);
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(
  process.env.HARNESS_BROWSER_CACHE_DIR ?? "../../.data/browser-cache",
);
process.env.PLAYWRIGHT_SKIP_BROWSER_GC = "1";
const browserHost = await createBrowserHost(
  join(cache, "browser-profiles"),
).catch(() => null);
const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () =>
    shutdown.abort(new Error("Worker is shutting down.")),
  );
const detected: Provider[] = ["demo"];
if (executable(process.env.CODEX_BIN ?? "codex")) detected.push("codex");
if (
  process.env.HARNESS_CLAUDE_RUNTIME === "sdk" ||
  executable(process.env.CLAUDE_BIN ?? "claude")
)
  detected.push("claude");
const providers = process.env.HARNESS_PROVIDERS
  ? (process.env.HARNESS_PROVIDERS.split(",") as Provider[])
  : detected;
if (
  providers.some((provider) => !["demo", "codex", "claude"].includes(provider))
)
  throw new Error("Invalid HARNESS_PROVIDERS.");
for (const provider of providers)
  if (!detected.includes(provider))
    throw new Error(
      `Configured runtime ${provider} is not installed on this worker.`,
    );
/** The commit this worker runs, so control can tell which release it has. */
const build = (() => {
  try {
    const value = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return COMMIT.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
})();
// Set by scripts/worker-launcher.mjs, which lets this worker update itself.
const releaseRoot = process.env.HARNESS_RELEASE_ROOT;
const releaseName = process.env.HARNESS_RELEASE;
let updating: WorkerReport["update"];
let restarting = false;
let running = 0;
// A release the launcher just rolled back is reported as a failed update.
if (releaseRoot)
  try {
    const failure = readState(releaseRoot).lastFailure;
    if (failure && failure.at > Date.now() - 60 * 60 * 1000)
      updating = {
        target: failure.target,
        phase: "failed",
        message: `Rolled back to ${releaseName}: ${failure.reason}.`,
      };
  } catch {
    // A missing or unreadable state file only means nothing to report.
  }
/** Claiming stops while an update waits for running work to finish. */
const paused = () => !!updating && updating.phase !== "failed";
const maxLoad = Number(process.env.HARNESS_MAX_LOAD_PER_CPU ?? 1.5);
if (!Number.isFinite(maxLoad) || maxLoad < 0)
  throw new Error("Invalid HARNESS_MAX_LOAD_PER_CPU.");
/**
 * Where the agent is running, so the owner can refer to "the harness", a
 * worker or a workspace without explaining the setup each time.
 */
/** The workspace folder on this machine, if it exists here. */
function workingFolder(claim: ClaimedTurn): string | undefined {
  const folder = claim.workspace.folder?.replace(/^~(?=\/)/, homedir());
  try {
    return folder && statSync(folder).isDirectory() ? folder : undefined;
  } catch {
    return undefined;
  }
}
function folderContext(claim: ClaimedTurn, folder: string | undefined) {
  const full = fullAccess() && !claim.session.sandboxed;
  const access = full
    ? " You run with full permissions on this machine, like the owner's own sessions: never delete data, spend money, use credentials or message people outside without asking the owner (request_input) first."
    : " This session is sandboxed: you can only write in the current directory.";
  if (folder)
    return `${access} Work in the workspace folder ${folder}: run commands from there (cd into it) and follow its CLAUDE.md or AGENTS.md house rules. The current directory is only a private scratch folder for harness files such as DECISION_UPDATES.json.`;
  if (claim.workspace.folder)
    return `${access} The workspace folder ${claim.workspace.folder} does not exist on this machine (${hostname()}). For work that only needs the code, clone the repositories you need from their remotes into the current directory and push your branch when done. For work that needs that folder's local tools or data, use machines_list and continue_on to move to a machine that has them. Never create the folder itself here.`;
  return access;
}
function harnessContext(claim: ClaimedTurn, folder?: string) {
  return `You are running inside Meta Harness, the owner's self-hosted, distributed agent harness (the owner may call it "the harness" or "meta harness"). A control server at ${identity.serverUrl} keeps workspaces, sessions (conversations), shared decisions, schedules and the owner's web UI, which they also use as a phone app. It dispatches each turn to one of the owner's worker machines (for example a Mac or a Raspberry Pi), each running Claude Code or Codex. This turn runs as ${claim.session.provider} on worker host ${hostname()}, in workspace ${JSON.stringify(claim.workspace.name)}, session ${JSON.stringify(claim.session.title)}. Turns of one conversation can run on different hosts: files, CLI logins, installed tools and browser sign-ins belong to the host they were made on. Each host's browser is shared live with the owner in the UI.${folderContext(claim, folder)}`;
}
function report(): WorkerReport {
  return {
    hostname: hostname(),
    agentIsolation: isolatedAgents(),
    browserHost: !!browserHost,
    browserStreaming: browserHost?.backend === "managed",
    browserBackend: browserHost?.backend,
    browserExtensionReady: browserHost?.extensionConnected(),
    browserSlotsUsed: browserHost?.active().length ?? 0,
    browserMemoryMiB: (browserHost?.active().length ?? 0) * 384,
    providers,
    portableProviders:
      process.env.HARNESS_CLAUDE_RUNTIME === "sdk"
        ? ["demo", "claude"]
        : ["demo"],
    labels: (process.env.HARNESS_WORKER_LABELS ?? process.arch).split(","),
    maxAgents: concurrency,
    // Half the machine's memory by default; free memory is checked separately.
    memoryBudgetMiB: setting(
      "HARNESS_MEMORY_BUDGET_MIB",
      Math.max(2048, Math.floor(totalmem() / 2 ** 21)),
      1,
    ),
    cpuSlots: setting(
      "HARNESS_CPU_SLOTS",
      // One per agent the owner allows, leaving a core for the host.
      Math.max(1, Math.min(concurrency, availableParallelism() - 1)),
      1,
    ),
    maxBuilds: setting("HARNESS_BUILD_SLOTS", 1),
    maxBrowsers: setting("HARNESS_BROWSER_SLOTS", 1),
    ...hostMemory(),
    reserveMemoryMiB: setting("HARNESS_MEMORY_RESERVE_MIB", 1024),
    loadPerCpu: loadavg()[0] / availableParallelism(),
    maxLoadPerCpu: maxLoad,
    draining: shutdown.signal.aborted || paused(),
    ...(build ? { build } : {}),
    ...(releaseRoot ? { updatable: true } : {}),
    ...(updating ? { update: updating } : {}),
  };
}
let confirmed = false;
async function sendReport() {
  const reply = await client.post<{ update?: { target: string } | null }>(
    "report",
    { report: report() },
  );
  // Reaching control is what makes a new release stay.
  if (!confirmed && releaseRoot && releaseName) {
    confirmed = true;
    try {
      if (confirmRelease(releaseRoot, releaseName))
        console.log(`Release ${releaseName} confirmed.`);
    } catch (error) {
      console.error("Could not confirm the release:", error);
    }
  }
  handleUpdate(reply?.update?.target ?? null);
}
function handleUpdate(target: string | null) {
  if (restarting) return;
  if (!target) {
    if (updating && updating.phase !== "failed")
      console.log(`Update to ${updating.target} cancelled; taking work again.`);
    updating = undefined;
    return;
  }
  if (updating && sameCommit(updating.target, target)) return;
  updating = { target, phase: "preparing" };
  void performUpdate(target);
}
/**
 * Prepares the release while running turns finish, then restarts into it. No
 * turn is interrupted: the switch waits until this worker is idle.
 */
async function performUpdate(target: string) {
  const current = () =>
    !shutdown.signal.aborted &&
    !!updating &&
    sameCommit(updating.target, target) &&
    updating.phase !== "failed";
  try {
    if (!releaseRoot)
      throw new Error(
        "This worker wasn't started by the release launcher, so it can't update itself.",
      );
    console.log(`Updating to ${target}: preparing; no new work meanwhile.`);
    const name = await prepareRelease(releaseRoot, target);
    if (!current()) return;
    updating = { target, phase: "waiting" };
    while (running > 0 || (browserHost?.active().length ?? 0) > 0) {
      await delay(2000);
      if (!current()) return;
    }
    restarting = true;
    updating = { target, phase: "restarting" };
    switchRelease(releaseRoot, name);
    await sendReport().catch(() => {});
    console.log(`Restarting into ${name}.`);
    process.exitCode = RESTART;
    shutdown.abort(new Error("Restarting for an update."));
  } catch (error) {
    if (!current() && !restarting) return;
    restarting = false;
    const message = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 1000);
    updating = { target, phase: "failed", message };
    console.error(`Update to ${target} failed: ${message}`);
    void sendReport().catch(() => {});
  }
}
const activeSessions = new Set<string>();
async function run(assignment: WorkerAssignment): Promise<void> {
  const { claim, checkpoint } = assignment;
  running++;
  activeSessions.add(claim.session.id);
  const { id: turnId, generation } = claim.turn;
  const controller = new AbortController();
  const stop = () => controller.abort(shutdown.signal.reason);
  shutdown.signal.addEventListener("abort", stop, { once: true });
  if (shutdown.signal.aborted) stop();
  const timeout = setTimeout(
    () => controller.abort(new Error("Turn time limit exceeded.")),
    timeoutMs,
  );
  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void client
      .post<{
        stopRequested?: boolean;
      }>("heartbeat", { turnId, generation })
      .then((result) => {
        if (result.stopRequested)
          controller.abort(new Error("Stopped by you."));
      })
      .catch((error) => controller.abort(error))
      .finally(() => {
        heartbeatBusy = false;
      });
  }, 5000);
  let redactor = new SecretRedactor([]);
  let sequence = 0;
  const send = async (event: RuntimeEvent) => {
    await client.post("event", {
      turnId,
      generation,
      sequence: ++sequence,
      event,
    });
  };
  const directory = join(cache, "sessions", claim.session.id);
  const useNativeStore =
    claim.session.provider === "claude" &&
    process.env.HARNESS_CLAUDE_RUNTIME === "sdk";
  let nativeQueue: Promise<unknown> = Promise.resolve();
  const sessionStore: NativeSessionStore = {
    append(key, entries) {
      const id = crypto.randomUUID();
      const operation = nativeQueue
        .catch(() => {})
        .then(() =>
          client.post("native-append", {
            turnId,
            generation,
            id,
            key,
            entries: redactor.sanitize(entries),
          }),
        );
      nativeQueue = operation;
      return operation.then(() => {});
    },
    load: (key) => client.post("native-load", { turnId, generation, key }),
    listSubkeys: (key) =>
      client.post("native-subkeys", { turnId, generation, key }),
  };
  const attachmentReferences: { id: string; hash: string }[] = [];
  const saveCheckpoint = async () => {
    if (!redactor.canCheckpoint()) return;
    if (claim.session.provider !== "demo" && !useNativeStore) return;
    await nativeQueue;
    const snapshot = await captureSnapshot(directory);
    snapshot.attachments = attachmentReferences;
    if (
      snapshot.files.some((file) =>
        redactor.contains(Buffer.from(file.data, "base64")),
      )
    )
      throw new Error(
        "A checkpoint file contains a granted secret. Remove credentials from execution files before publishing a checkpoint.",
      );
    await client.post("checkpoint", {
      turnId,
      generation,
      id: crypto.randomUUID(),
      snapshot,
    });
  };
  try {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(claim.session.id))
      throw new Error("Unsafe assigned session ID.");
    if (claim.session.provider === "demo")
      await restoreSnapshot(
        directory,
        checkpoint?.snapshot ?? { version: 1, files: [] },
      );
    else if (
      useNativeStore &&
      checkpoint &&
      (claim.session.ownerWorkerId !== identity.id || !existsSync(directory))
    )
      await restoreSnapshot(directory, checkpoint.snapshot);
    else mkdirSync(directory, { recursive: true, mode: 0o700 });
    const knowledge = await client.post<DecisionSnapshot>("decisions", {
      turnId,
      generation,
    });
    await prepareDecisionFiles(directory, knowledge);
    const attachments = await materializeAttachments(
      client,
      directory,
      turnId,
      generation,
      attachmentReferences,
    );
    const context = await client.post<{
      tools: { url: string; token: string };
      policy: Record<string, unknown>;
      unfinishedOperations: unknown[];
      environment: Record<string, string>;
    }>("context", { turnId, generation });
    redactor = new SecretRedactor([
      ...Object.values(context.environment ?? {}),
      context.tools.token,
      process.env.ANTHROPIC_API_KEY ?? "",
      process.env.OPENAI_API_KEY ?? "",
      process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
    ]);
    const tools = {
      ...context.tools,
      url: new URL("/api/tools", identity.serverUrl).toString(),
    };
    const folder = workingFolder(claim);
    const processIdentity =
      claim.session.provider === "demo"
        ? undefined
        : await prepareIdentity(directory, claim.session.id);
    console.log(
      `Running ${turnId} (${claim.session.provider}); generation ${generation}`,
    );
    await executeTurn(
      {
        async providerUnavailable(_provider, retryAt, reason) {
          await client.post("cooldown", {
            turnId,
            generation,
            retryAt,
            reason,
          });
        },
        async appendOutput(_id, _generation, rawText) {
          const text = redactor.push(rawText);
          for (let start = 0; start < text.length; ) {
            let end = Math.min(start + 4096, text.length);
            if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]))
              end--;
            await send({ type: "text", text: text.slice(start, end) });
            start = end;
          }
        },
        async saveNativeId(_id, _generation, id) {
          await send({ type: "native-session", id });
        },
        async finish(_id, _generation, status, error) {
          const remaining = redactor.push("", true);
          if (remaining) await send({ type: "text", text: remaining });
          if (error) error = redactor.redact(error);
          const decisionUpdates =
            status === "completed"
              ? await collectDecisionUpdates(directory)
              : [];
          if (status === "completed") await saveCheckpoint();
          await client.post("complete", {
            turnId,
            generation,
            status,
            decisionUpdates,
            ...(error ? { error: error.slice(0, 4000) } : {}),
          });
          if (status === "completed")
            await clearDecisionUpdates(directory).catch((error) =>
              console.error(
                "Could not clear committed decision updates:",
                error,
              ),
            );
        },
      },
      {
        ...claim,
        workspace: {
          ...claim.workspace,
          instructions: `${harnessContext(claim, folder)}\n${claim.workspace.instructions}\n${decisionInstructions(knowledge, claim.workspace.id)}\nCurrent time: ${new Date().toISOString()}. Unfinished operations from this session: ${JSON.stringify(context.unfinishedOperations ?? [])}. Reconcile these against current external state before repeating any mutation; never change an operation ID just to bypass an unknown outcome. Browser connection failures confirmed as not_started are reconciled as failed, not unknown, and may be explicitly retried with the same operation_id once Chrome is connected; they do not require the owner to clear platform state. The owner’s scheduling timezone is ${String(context.policy.timezone ?? "UTC")}. Interpret natural-language dates in that timezone and include it in schedule proposals. Harness MCP tools are available for current shared decisions, schedule proposals, user questions, authorized browser work, and reading the owner's past conversations in any workspace (decision_source for the conversation behind a decision, session_read, history_search, workspace_list). When a decision or reference lacks context, read its source instead of asking the owner to paste it. The current conversation title is ${JSON.stringify(claim.session.title)} (source: ${claim.session.titleSource ?? "prompt"}). When it merely repeats the opening request, call session_title once near the start with a clear 2–5 word title of at most 45 characters describing the goal. Preserve manual titles. This uses the current turn, not another model request. For any requested schedule, call schedule_propose with the exact future prompt; it creates an inactive review card, not an active schedule. Use schedule_list to inspect existing schedules. A question requiring a person should use request_input, then finish the turn instead of keeping a process waiting. For spreadsheet CRM work, opening Google Sheets is not enough: use browser_action sheet_read to inspect bounded cell rows for the correct gid; use read accessibility and screenshots for other app details. Verify actual content before claiming success. Browser login happens in the UI's shared browser; never ask for credentials in chat. Use the browser host selected by the harness; it need not be the Mac. If that host is signed out, navigate to the page you actually need (its sign-in redirect is where the owner resumes), fill in what you already know such as the account email, and call browser_action needs_login, then finish the turn; the owner signs in (password, MFA) in the shared browser and replies with a new message when done. Reuse valid host-local logins. If no browser host is available, report the resource error rather than asking for passwords in chat. Do not ask the owner to enable remote debugging or approve repeated Chrome connections. A different host may require a new manual login; never assume it has another machine’s accounts. Existing Chrome credentials stay in Chrome; do not read or copy credential files.`,
        },
      },
      createRuntime(claim.session.provider),
      directory,
      controller.signal,
      saveCheckpoint,
      useNativeStore ? sessionStore : undefined,
      {
        attachments,
        tools,
        environment: context.environment,
        identity: processIdentity,
        workingFolder: folder,
      },
    );
  } catch (error) {
    console.error(
      `Turn ${turnId}: ${redactor.redact(error instanceof Error ? error.message : String(error))}`,
    );
    await client
      .post("complete", {
        turnId,
        generation,
        status: controller.signal.aborted ? "interrupted" : "failed",
        error: redactor
          .redact(error instanceof Error ? error.message : String(error))
          .slice(0, 4000),
      })
      .catch(() => {});
  } finally {
    running--;
    activeSessions.delete(claim.session.id);
    clearInterval(heartbeat);
    clearTimeout(timeout);
    shutdown.signal.removeEventListener("abort", stop);
  }
}
let cleaning: Promise<void> | undefined;
let nextCleanup = 0;
function cleanupLocal() {
  if (cleaning) return cleaning;
  if (Date.now() < nextCleanup) return Promise.resolve();
  nextCleanup = Date.now() + 5000;
  cleaning = (async () => {
    for (const item of await client.post<{ kind: string; id: string }[]>(
      "cleanup-list",
      {},
    )) {
      try {
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(item.id))
          throw new Error("Invalid cleanup ID");
        if (item.kind === "session") {
          if (activeSessions.has(item.id)) continue;
          const { rm } = await import("node:fs/promises");
          await rm(join(cache, "sessions", item.id), {
            recursive: true,
            force: true,
          });
        } else if (item.kind === "browser") await browserHost?.forget(item.id);
        else throw new Error("Invalid cleanup kind");
        await client.post("cleanup-ack", item);
      } catch {
        console.error("Local deletion cleanup will retry:", item.id);
      }
    }
  })().finally(() => {
    cleaning = undefined;
  });
  return cleaning;
}
async function lane() {
  let idleDelay = pollMs;
  while (!shutdown.signal.aborted) {
    if (paused()) {
      await delay(idlePollMs, undefined, { signal: shutdown.signal }).catch(
        () => {},
      );
      continue;
    }
    try {
      await cleanupLocal();
      const assignment = await client.post<WorkerAssignment | null>("claim", {
        requestId: crypto.randomUUID(),
      });
      if (assignment) {
        idleDelay = pollMs;
        await run(assignment);
        continue;
      }
    } catch (error) {
      console.error(
        `Control connection: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (
        error instanceof HarnessError &&
        (error.status === 401 || error.status === 403)
      ) {
        process.exitCode = 1;
        shutdown.abort(new Error("Worker credential was rejected."));
      }
    }
    await delay(idleDelay, undefined, { signal: shutdown.signal }).catch(
      () => {},
    );
    idleDelay = Math.min(idlePollMs, idleDelay * 2);
  }
}
console.log(
  `Worker ${identity.id}; control ${identity.serverUrl}; ${concurrency} slot(s); build ${build ?? "unknown"}${releaseName ? ` (release ${releaseName})` : ""}; idle agents: 0`,
);
parseWorkerReport(report());
await sendReport().catch(() => {});
let reporting = false;
const reportingTimer = setInterval(() => {
  if (reporting) return;
  reporting = true;
  void sendReport()
    .catch(() => {})
    .finally(() => {
      reporting = false;
    });
}, 5000);
try {
  await Promise.all([
    ...Array.from({ length: concurrency }, lane),
    ...(browserHost
      ? [
          browserWorker(client, cache, shutdown.signal, browserHost),
          browserStreamWorker(identity, browserHost, shutdown.signal),
        ]
      : []),
  ]);
} finally {
  clearInterval(reportingTimer);
}
// Open browser streams must not keep an updating worker alive.
if (process.exitCode === RESTART) process.exit(RESTART);
