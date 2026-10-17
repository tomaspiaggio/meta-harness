import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { executeTurn } from "@harness/core";
import { createRuntime } from "@harness/runtimes";
import { dataDirectory, SqliteStore } from "@harness/storage";

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer.`);
  return value;
}

const concurrency = positiveInteger("HARNESS_CONCURRENCY", 1);
const pollMs = positiveInteger("HARNESS_POLL_MS", 1000);
const timeoutMs = positiveInteger("HARNESS_TURN_TIMEOUT_MS", 30 * 60 * 1000);
const leaseMs = 30_000;
const workerId = `${hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
const store = new SqliteStore();
const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => shutdown.abort());

async function lane(): Promise<void> {
  while (!shutdown.signal.aborted) {
    const claim = store.claim(workerId, Date.now(), leaseMs);
    if (!claim) {
      await delay(pollMs, undefined, { signal: shutdown.signal }).catch(
        () => {},
      );
      continue;
    }
    const controller = new AbortController();
    const stop = () => controller.abort(new Error("Worker is shutting down."));
    shutdown.signal.addEventListener("abort", stop, { once: true });
    if (shutdown.signal.aborted) stop();
    const timeout = setTimeout(
      () => controller.abort(new Error("Turn time limit exceeded.")),
      timeoutMs,
    );
    const heartbeat = setInterval(() => {
      try {
        if (
          !store.heartbeat(
            claim.turn.id,
            claim.turn.generation,
            Date.now(),
            leaseMs,
          )
        ) {
          controller.abort(new Error("Worker lost turn ownership."));
        }
      } catch (error) {
        controller.abort(error);
      }
    }, 5000);
    try {
      const directory = join(dataDirectory(), "sessions", claim.session.id);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      console.log(`Running ${claim.turn.id} (${claim.session.provider})`);
      await executeTurn(
        store,
        claim,
        createRuntime(claim.session.provider),
        directory,
        controller.signal,
      );
    } catch (error) {
      console.error(
        `Turn ${claim.turn.id}:`,
        error instanceof Error ? error.message : error,
      );
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      shutdown.signal.removeEventListener("abort", stop);
    }
  }
}

console.log(`Worker ${workerId}; ${concurrency} slot(s); idle agents: 0`);
try {
  await Promise.all(Array.from({ length: concurrency }, lane));
} finally {
  store.close();
}
