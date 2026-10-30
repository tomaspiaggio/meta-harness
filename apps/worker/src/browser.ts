import { setTimeout as delay } from "node:timers/promises";
import { BrowserActionNotStarted, BrowserHost } from "@harness/browser";
import type { BrowserAssignment, BrowserIdentity } from "@harness/core/browser";
import type { WorkerClient } from "./client";

export async function browserWorker(
  client: WorkerClient,
  _root: string,
  signal: AbortSignal,
  host: BrowserHost,
): Promise<void> {
  try {
    while (!signal.aborted) {
      let active = false;
      let renewing: NodeJS.Timeout | undefined;
      try {
        const work = await client.post<{
          assignments: BrowserAssignment[];
          identities: BrowserIdentity[];
        }>("browser-poll", { requestId: crypto.randomUUID() });
        active = host.active().length > 0 || work.assignments.length > 0;
        // Leases last 30 s and only polls renew them; keep them while this
        // iteration starts browsers or runs actions.
        renewing = setInterval(() => {
          void client.post("browser-renew", {}).catch(() => {});
        }, 10000);
        await host.synchronize(work.identities);
        for (const identity of work.identities)
          if (
            identity.mode === "agent" &&
            (identity.status !== "starting" ||
              Date.now() - identity.updatedAt > 10000) &&
            !host.active().some((item) => item.id === identity.id) &&
            !work.assignments.some((item) => item.identity.id === identity.id)
          )
            await client.post("browser-release", {
              id: identity.id,
              generation: identity.generation,
            });
        for (const assignment of work.assignments) {
          const started = Date.now();
          try {
            const output = await host.execute(assignment);
            if (Date.now() - started > 20000)
              console.warn(
                `[browser] ${assignment.command.action} took ${Math.round((Date.now() - started) / 1000)} s`,
              );
            await client.post("browser-complete", {
              id: assignment.command.id,
              generation: assignment.identity.generation,
              ...output,
            });
          } catch (error) {
            console.warn(
              `[browser] ${assignment.command.action} failed after ${Math.round((Date.now() - started) / 1000)} s: ${error instanceof Error ? error.message.slice(0, 300) : "unknown error"}`,
            );
            await client
              .post("browser-complete", {
                id: assignment.command.id,
                generation: assignment.identity.generation,
                result:
                  assignment.command.action !== "manual" &&
                  error instanceof BrowserActionNotStarted
                    ? { execution: "not_started" }
                    : null,
                error:
                  assignment.command.action === "manual"
                    ? "Manual browser input failed. Inspect the page before repeating it."
                    : error instanceof Error
                      ? error.message.slice(0, 500)
                      : "Browser execution failed.",
              })
              .catch(() => {});
          }
        }
      } catch (error) {
        console.warn(
          `[browser] Poll failed; closing local browsers: ${error instanceof Error ? error.message.slice(0, 300) : "unknown error"}`,
        );
        await host.synchronize([]);
      } finally {
        clearInterval(renewing);
      }
      await delay(active ? 250 : 5000, undefined, { signal }).catch(() => {});
    }
  } finally {
    await host.close();
  }
}

export async function createBrowserHost(
  root: string,
): Promise<BrowserHost | null> {
  if (
    process.env.HARNESS_BROWSER_ENABLED === "0" ||
    !(await BrowserHost.available())
  )
    return null;
  const host = new BrowserHost(root, {
    headless: process.env.HARNESS_BROWSER_HEADLESS !== "0",
    idleMs: Number(process.env.HARNESS_BROWSER_IDLE_MS ?? 120000),
    allowTestLoopback:
      process.env.HARNESS_TEST_BROWSER_LOOPBACK === "1" &&
      /fixture/.test(process.env.HARNESS_DATA_DIR ?? ""),
  });
  await host.initialize();
  return host;
}
