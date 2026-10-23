import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { availableParallelism, hostname, loadavg } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { captureSnapshot, restoreSnapshot } from "@harness/checkpoints";
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
import { parseWorkerReport, type WorkerReport } from "@harness/core/scheduling";
import { createRuntime } from "@harness/runtimes";
import type { WorkerAssignment } from "@harness/storage/control";
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
const maxLoad = Number(process.env.HARNESS_MAX_LOAD_PER_CPU ?? 1.5);
if (!Number.isFinite(maxLoad) || maxLoad < 0)
  throw new Error("Invalid HARNESS_MAX_LOAD_PER_CPU.");
function report(): WorkerReport {
  return {
    hostname: hostname(),
    agentIsolation: isolatedAgents(),
    browserHost: !!browserHost,
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
    memoryBudgetMiB: setting("HARNESS_MEMORY_BUDGET_MIB", 2048, 1),
    cpuSlots: setting(
      "HARNESS_CPU_SLOTS",
      Math.max(1, Math.min(2, availableParallelism() - 1)),
      1,
    ),
    maxBuilds: setting("HARNESS_BUILD_SLOTS", 1),
    maxBrowsers: setting("HARNESS_BROWSER_SLOTS", 1),
    ...hostMemory(),
    reserveMemoryMiB: setting("HARNESS_MEMORY_RESERVE_MIB", 1024),
    loadPerCpu: loadavg()[0] / availableParallelism(),
    maxLoadPerCpu: maxLoad,
    draining: shutdown.signal.aborted,
  };
}
const activeSessions = new Set<string>();
async function run(assignment: WorkerAssignment): Promise<void> {
  const { claim, checkpoint } = assignment;
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
          instructions: `${claim.workspace.instructions}\n${decisionInstructions(knowledge)}\nCurrent time: ${new Date().toISOString()}. Unfinished operations from this session: ${JSON.stringify(context.unfinishedOperations ?? [])}. Reconcile these against current external state before repeating any mutation; never change an operation ID just to bypass an unknown outcome. Browser connection failures confirmed as not_started are reconciled as failed, not unknown, and may be explicitly retried with the same operation_id once Chrome is connected; they do not require the owner to clear platform state. The owner’s scheduling timezone is ${String(context.policy.timezone ?? "UTC")}. Interpret natural-language dates in that timezone and include it in schedule proposals. Harness MCP tools are available for current shared decisions, schedule proposals, user questions, and authorized browser work. The current conversation title is ${JSON.stringify(claim.session.title)} (source: ${claim.session.titleSource ?? "prompt"}). When it merely repeats the opening request, call session_title once near the start with a clear 2–5 word title of at most 45 characters describing the goal. Preserve manual titles. This uses the current turn, not another model request. For any requested schedule, call schedule_propose with the exact future prompt; it creates an inactive review card, not an active schedule. Use schedule_list to inspect existing schedules. A question requiring a person should use request_input, then finish the turn instead of keeping a process waiting. For spreadsheet CRM work, opening Google Sheets is not enough: use browser_action sheet_read to inspect bounded cell rows for the correct gid; use read accessibility and screenshots for other app details. Verify actual content before claiming success. Browser takeover and login happen in the UI; never ask for credentials in chat. If the browser extension is not paired or connected, point to the one-time Meta Harness Browser setup in Settings, then finish the turn. Do not ask the owner to enable remote debugging or approve repeated Chrome connections. Do not switch to an empty profile when the task needs an existing signed-in identity. Existing Chrome credentials stay in Chrome; do not read or copy credential files.`,
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
  `Worker ${identity.id}; control ${identity.serverUrl}; ${concurrency} slot(s); idle agents: 0`,
);
const initialReport = report();
parseWorkerReport(initialReport);
await client.post("report", { report: initialReport }).catch(() => {});
let reporting = false;
const reportingTimer = setInterval(() => {
  if (reporting) return;
  reporting = true;
  void client
    .post("report", { report: report() })
    .catch(() => {})
    .finally(() => {
      reporting = false;
    });
}, 5000);
try {
  await Promise.all([
    ...Array.from({ length: concurrency }, lane),
    ...(browserHost
      ? [browserWorker(client, cache, shutdown.signal, browserHost)]
      : []),
  ]);
} finally {
  clearInterval(reportingTimer);
}
