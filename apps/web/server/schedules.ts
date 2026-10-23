import { getRun, start } from "workflow/api";
import { scheduleWorkflow } from "../workflows/schedule";
import { getStore } from "./store";

export async function dispatchSchedules() {
  const store = await getStore();
  for (const schedule of await store.listSchedules()) {
    if (schedule.status !== "active" || schedule.nextAt === null) continue;
    const id = await store.claimScheduleWake(
      schedule.id,
      schedule.revision,
      schedule.nextAt,
    );
    if (!id) continue;
    const run = await start(scheduleWorkflow, [
      schedule.id,
      schedule.revision,
      schedule.nextAt,
    ]);
    await store.attachScheduleWake(id, run.runId);
    try {
      await store.getSchedule(schedule.id);
    } catch {
      await getRun(run.runId).cancel();
    }
  }
}
