import { start } from "workflow/api";
import { turnWorkflow } from "../workflows/turn";
import { getStore } from "./store";

let flushing = false;

/** Pending turns are the local dispatch outbox. Duplicate dispatch is harmless. */
export async function flushDispatch(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const store = getStore();
    for (const id of store.pendingDispatch()) {
      const run = await start(turnWorkflow, [id]);
      store.attachRun(id, run.runId);
    }
  } finally {
    flushing = false;
  }
}
