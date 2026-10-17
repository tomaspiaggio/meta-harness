import { requiredText } from "@harness/core";
import { flushDispatch } from "../../../server/dispatcher";
import { failure, jsonBody } from "../../../server/http";
import { getStore } from "../../../server/store";

export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    const store = getStore();
    const id = requiredText(body.id, "Turn ID", 100);
    store.createTurn(
      id,
      requiredText(body.sessionId, "Session ID", 100),
      requiredText(body.prompt, "Prompt"),
    );
    // Acceptance is durable before dispatch; the background outbox retries failure.
    void flushDispatch().catch((error) =>
      console.error("Turn accepted; dispatch will retry:", error),
    );
    return Response.json(store.getTurn(id), { status: 202 });
  } catch (error) {
    return failure(error);
  }
}
