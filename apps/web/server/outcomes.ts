import { getRun, resumeHook } from "workflow/api";
import { getStore } from "./store";
export async function dispatchOutcomes() {
  const store = await getStore();
  for (const turn of await store.terminalWakeups()) {
    const waiters = await store.workflowWaiters(turn.id);
    let delivered = true;
    for (const waiter of waiters) {
      try {
        await resumeHook(`turn:${turn.id}:${waiter.runId}:finished`, {
          id: turn.id,
        });
        await store.acknowledgeWorkflow(waiter.runId);
      } catch {
        try {
          if (
            ["completed", "failed", "cancelled"].includes(
              await getRun(waiter.runId).status,
            )
          )
            await store.acknowledgeWorkflow(waiter.runId);
          else delivered = false;
        } catch {
          delivered = false;
        }
      }
    }
    if (!waiters.length && turn.runId) {
      // Compatibility for runs accepted before per-run waiter registration.
      try {
        await resumeHook(`turn:${turn.id}:finished`, { id: turn.id });
      } catch {
        /* A later workflow reads the already terminal turn before waiting. */
      }
    }
    if (delivered) await store.acknowledgeWakeup(turn.id);
  }
}
