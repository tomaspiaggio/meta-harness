import { HarnessError, requiredText } from "@harness/core";
import { after } from "next/server";
import { failure, jsonBody } from "../../../server/http";
import { maintain } from "../../../server/maintenance";
import { getStore } from "../../../server/store";
export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    const store = await getStore();
    const id = requiredText(body.id, "Turn ID", 100);
    if (
      body.attachmentIds !== undefined &&
      (!Array.isArray(body.attachmentIds) ||
        body.attachmentIds.some((id) => typeof id !== "string"))
    )
      throw new HarnessError("Invalid attachment IDs.");
    await store.submitMessage(
      id,
      requiredText(body.sessionId, "Session ID", 100),
      requiredText(body.prompt, "Prompt"),
      (body.attachmentIds ?? []) as string[],
      body.interruptsTurnId === undefined
        ? undefined
        : requiredText(body.interruptsTurnId, "Interrupted turn ID", 100),
    );
    // Acceptance is durable before dispatch; the background outbox retries failure.
    after(() => maintain());
    return Response.json(await store.getTurn(id), { status: 202 });
  } catch (error) {
    return failure(error);
  }
}
export async function PATCH(request: Request) {
  try {
    const body = await jsonBody(request);
    const turn = await (await getStore()).requestStop(
      requiredText(body.id, "Turn ID", 100),
    );
    after(() => maintain());
    return Response.json(turn);
  } catch (error) {
    return failure(error);
  }
}
