import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { availableParallelism, freemem, hostname, loadavg } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { captureSnapshot, restoreSnapshot } from "@harness/checkpoints";
import { executeTurn, type Provider, type RuntimeEvent } from "@harness/core";
import type { NativeSessionStore } from "@harness/core/native-store";
import type { WorkerReport } from "@harness/core/scheduling";
import { createRuntime } from "@harness/runtimes";
import type { WorkerAssignment } from "@harness/storage/control";
import { WorkerClient } from "./client";
import { workerIdentity } from "./identity";

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
const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () =>
    shutdown.abort(new Error("Worker is shutting down.")),
  );
const detected: Provider[] = ["demo"];
if (executable(process.env.CODEX_BIN ?? "codex")) detected.push("codex");
if (executable(process.env.CLAUDE_BIN ?? "claude")) detected.push("claude");
const providers = process.env.HARNESS_PROVIDERS
  ? (process.env.HARNESS_PROVIDERS.split(",") as Provider[])
  : detected;
if (
  providers.some((provider) => !["demo", "codex", "claude"].includes(provider))
)
  throw new Error("Invalid HARNESS_PROVIDERS.");
const maxLoad = Number(process.env.HARNESS_MAX_LOAD_PER_CPU ?? 1.5);
if (!Number.isFinite(maxLoad) || maxLoad < 0)
  throw new Error("Invalid HARNESS_MAX_LOAD_PER_CPU.");
function report(): WorkerReport {
  return {
    hostname: hostname(),
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
    availableMemoryMiB: Math.floor(freemem() / 1024 / 1024),
    reserveMemoryMiB: setting("HARNESS_MEMORY_RESERVE_MIB", 1024),
    loadPerCpu: loadavg()[0] / availableParallelism(),
    maxLoadPerCpu: maxLoad,
    draining: shutdown.signal.aborted,
  };
}

async function run(assignment: WorkerAssignment): Promise<void> {
  const { claim, checkpoint } = assignment;
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
      .post("heartbeat", { turnId, generation })
      .catch((error) => controller.abort(error))
      .finally(() => {
        heartbeatBusy = false;
      });
  }, 5000);
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
            entries,
          }),
        );
      nativeQueue = operation;
      return operation.then(() => {});
    },
    load: (key) => client.post("native-load", { turnId, generation, key }),
    listSubkeys: (key) =>
      client.post("native-subkeys", { turnId, generation, key }),
  };
  const saveCheckpoint = async () => {
    if (claim.session.provider !== "demo" && !useNativeStore) return;
    await nativeQueue;
    const snapshot = await captureSnapshot(directory);
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
        async appendOutput(_id, _generation, text) {
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
          if (status === "completed") await saveCheckpoint();
          await client.post("complete", {
            turnId,
            generation,
            status,
            ...(error ? { error: error.slice(0, 4000) } : {}),
          });
        },
      },
      claim,
      createRuntime(claim.session.provider),
      directory,
      controller.signal,
      saveCheckpoint,
      useNativeStore ? sessionStore : undefined,
    );
  } catch (error) {
    console.error(
      `Turn ${turnId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    await client
      .post("complete", {
        turnId,
        generation,
        status: controller.signal.aborted ? "interrupted" : "failed",
        error: (error instanceof Error ? error.message : String(error)).slice(
          0,
          4000,
        ),
      })
      .catch(() => {});
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    shutdown.signal.removeEventListener("abort", stop);
  }
}

async function lane() {
  while (!shutdown.signal.aborted) {
    try {
      await client.post("report", { report: report() });
      const assignment = await client.post<WorkerAssignment | null>("claim", {
        requestId: crypto.randomUUID(),
      });
      if (assignment) {
        await run(assignment);
        continue;
      }
    } catch (error) {
      console.error(
        `Control connection: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await delay(pollMs, undefined, { signal: shutdown.signal }).catch(() => {});
  }
}

console.log(
  `Worker ${identity.id}; control ${identity.serverUrl}; ${concurrency} slot(s); idle agents: 0`,
);
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
  await Promise.all(Array.from({ length: concurrency }, lane));
} finally {
  clearInterval(reportingTimer);
}
