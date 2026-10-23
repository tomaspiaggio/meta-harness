import { sleep } from "workflow";
import { fireScheduleStep } from "./steps";

/** One bounded workflow per occurrence; the destination conversation persists. */
export async function scheduleWorkflow(
  id: string,
  revision: number,
  dueAt: number,
) {
  "use workflow";
  await sleep(new Date(dueAt));
  return fireScheduleStep(id, revision, dueAt);
}
