import { alertBackups } from "./backup";
import { dispatchBriefs } from "./briefs";
import { BrowserBroker } from "./browser";
import { deliverDelegationReports } from "./delegation";
import { cleanupDeleted } from "./deletion";
import { flushDispatch } from "./dispatcher";
import { dispatchOutcomes } from "./outcomes";
import { reconcileSandboxes } from "./sandbox";
import { dispatchSchedules } from "./schedules";
import { getStore } from "./store";
import { deliverNotifications, deliverTelegramInbox } from "./telegram";
import { generateTitles } from "./titles";

let active: Promise<void> | undefined;
/** Reconciliation is idempotent and may run on more than one control instance. */
export function maintain(): Promise<void> {
  active ??= (async () => {
    const store = await getStore();
    await store.recoverExpired(Date.now());
    await new BrowserBroker(store).expire();
    // Repair missed timers without depending on a resident process.
    for (const schedule of await store.dueSchedules()) {
      try {
        if (schedule.nextAt !== null)
          await store.scheduledOccurrence(
            schedule.id,
            schedule.revision,
            schedule.nextAt,
          );
      } catch {
        // A destination's full queue must not starve unrelated work or wakeups.
        console.error("A schedule occurrence will retry:", schedule.id);
      }
    }
    for (const job of [
      cleanupDeleted,
      flushDispatch,
      dispatchOutcomes,
      deliverDelegationReports,
      dispatchSchedules,
      reconcileSandboxes,
      generateTitles,
      deliverTelegramInbox,
      deliverNotifications,
      alertBackups,
      dispatchBriefs,
    ]) {
      try {
        await job();
      } catch (error) {
        console.error(
          "Reconciliation will retry:",
          error instanceof Error ? error.message : "Unavailable",
        );
      }
    }
  })().finally(() => {
    active = undefined;
  });
  return active;
}
