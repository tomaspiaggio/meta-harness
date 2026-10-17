import { sleep } from "workflow";
import { dispatchTurnStep, readTurnStep } from "./steps";

/** One workflow per turn; application sessions outlive any orchestration run. */
export async function turnWorkflow(turnId: string) {
  "use workflow";
  await dispatchTurnStep(turnId);
  while (true) {
    const outcome = await readTurnStep(turnId);
    if (outcome.terminal) return outcome;
    // Local bridge uses durable polling; a hosted adapter can use hooks to wake it.
    await sleep("5s");
  }
}
