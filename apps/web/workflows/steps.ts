import { enqueueTurn, HarnessError, readTurnOutcome } from "@harness/core";
import type { ScheduleOccurrence } from "@harness/core/automations";
import { getStore } from "../server/store";
export async function dispatchTurnStep(turnId: string, runId: string) {
  "use step";
  const store = await getStore();
  return store.databaseConnection().transaction(async () => {
    try {
      await store.getTurn(turnId);
    } catch (error) {
      if (error instanceof HarnessError && error.status === 404) return false;
      throw error;
    }
    await store.subscribeWorkflow(turnId, runId);
    await store.attachRun(turnId, runId);
    await enqueueTurn(store, turnId);
    return true;
  });
}

export async function fireScheduleStep(
  id: string,
  revision: number,
  dueAt: number,
) {
  "use step";
  let result: ScheduleOccurrence | null = null;
  try {
    result = await (await getStore()).scheduledOccurrence(id, revision, dueAt);
  } catch (error) {
    if (error instanceof HarnessError && error.status === 404) return null;
    throw error;
  }
  const { maintain } = await import("../server/maintenance");
  await maintain();
  return result;
}
export async function readTurnStep(turnId: string) {
  "use step";
  try {
    return await readTurnOutcome(await getStore(), turnId);
  } catch (error) {
    if (error instanceof HarnessError && error.status === 404)
      return { id: turnId, status: "interrupted" as const, terminal: true };
    throw error;
  }
}
