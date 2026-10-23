import { start } from "workflow/api";
import { turnWorkflow } from "../workflows/turn";
import { getStore } from "./store";

let flushing = false;
/** Pending turns are the local dispatch outbox. Duplicate dispatch is harmless. */
export async function flushDispatch(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const store = await getStore();
    for (const id of await store.pendingDispatch()) {
      const run = await start(turnWorkflow, [id]);
      await store.attachRun(id, run.runId);
    }
  } finally {
    flushing = false;
  }
}
