import { enqueueTurn, readTurnOutcome } from "@harness/core";
import { getStore } from "../server/store";

export async function dispatchTurnStep(turnId: string) {
  "use step";
  enqueueTurn(getStore(), turnId);
}

export async function readTurnStep(turnId: string) {
  "use step";
  return readTurnOutcome(getStore(), turnId);
}
