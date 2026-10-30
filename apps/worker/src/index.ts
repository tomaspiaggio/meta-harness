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
// Claims posted but not yet started; an idle check must count them.
let claiming = 0;
// A queued update stops taking new work after this long without an idle moment.
const drainAfterMs = Number(
  process.env.HARNESS_UPDATE_DRAIN_AFTER_MS ?? 2 * 60 * 60 * 1000,
);
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
/**
 * A queued update keeps taking work; claiming stops only when it restarts, or
 * when it has waited too long for an idle moment and drains instead.
 */
const paused = () =>
  restarting ||
  updating?.phase === "waiting" ||
  updating?.phase === "restarting";
const maxLoad = Number(process.env.HARNESS_MAX_LOAD_PER_CPU ?? 1.5);
if (!Number.isFinite(maxLoad) || maxLoad < 0)
  throw new Error("Invalid HARNESS_MAX_LOAD_PER_CPU.");
/** The workspace folder on this machine, if it exists here. */
function workingFolder(claim: ClaimedTurn): string | undefined {
  const folder = claim.workspace.folder?.replace(/^~(?=\/)/, homedir());
  try {
    return folder && statSync(folder).isDirectory() ? folder : undefined;
  } catch {
    return undefined;
  }
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
    totalMemoryMiB: Math.floor(totalmem() / 2 ** 20),
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
 * Prepares the release, then restarts into it the first moment this worker is
 * idle, taking work as usual until then. No turn is interrupted. A worker that
 * never goes idle stops taking new work after HARNESS_UPDATE_DRAIN_AFTER_MS
 * (2 hours) so its running turns can finish.
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
    console.log(`Updating to ${target}: preparing while work continues.`);
    const queuedAt = Date.now();
    const name = await prepareRelease(releaseRoot, target);
    if (!current()) return;
    updating = { target, phase: "queued" };
    console.log(`Update to ${target} queued until this worker is idle.`);
    // Checked and acted on without an await in between, so no lane can claim
    // a turn after the check and before claiming stops.
    while (
      running > 0 ||
      claiming > 0 ||
      (browserHost?.active().length ?? 0) > 0
    ) {
      await delay(2000);
      if (!current()) return;
      if (updating.phase === "queued" && Date.now() - queuedAt > drainAfterMs) {
        updating = { target, phase: "waiting" };
        console.log(
          `Update to ${target}: no idle moment in ${Math.round(drainAfterMs / 60000)} min; no new work until running turns finish.`,
        );
      }
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
    const folder = workingFolder(claim);
    // Control writes the agent's instructions from what only this host knows.
    const context = await client.post<{
      instructions?: string;
      tools: { url: string; token: string };
      policy: Record<string, unknown>;
      unfinishedOperations: unknown[];
      environment: Record<string, string>;
    }>("context", {
      turnId,
      generation,
      host: {
        hostname: hostname(),
        controlUrl: identity.serverUrl,
        folder: folder ?? null,
        fullAccess: fullAccess(),
      },
    });
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
          // An older control sends no instructions: keep the essentials.
          instructions:
            context.instructions ??
            `${claim.workspace.instructions}\n${decisionInstructions(knowledge, claim.workspace.id)}`,
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
      if (paused()) continue;
      claiming++;
      let assignment: WorkerAssignment | null;
      try {
        assignment = await client.post<WorkerAssignment | null>("claim", {
          requestId: crypto.randomUUID(),
        });
      } finally {
        // run() counts the turn before its first await, so the update never
        // sees this claim as neither claiming nor running.
        claiming--;
      }
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
