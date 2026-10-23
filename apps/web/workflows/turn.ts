import { createHook, getWorkflowMetadata } from "workflow";
import { dispatchTurnStep, readTurnStep } from "./steps";
/** Duplicate dispatch can create runs, but never duplicates an application turn. */
export async function turnWorkflow(turnId: string) {
  "use workflow";
  const { workflowRunId: runId } = getWorkflowMetadata();
  const completion = createHook({ token: `turn:${turnId}:${runId}:finished` });
  try {
    if (!(await dispatchTurnStep(turnId, runId)))
      return { id: turnId, status: "interrupted", terminal: true };
    const outcome = await readTurnStep(turnId);
    if (outcome.terminal) return outcome;
    await completion;
    return readTurnStep(turnId);
  } finally {
    completion.dispose();
  }
}
