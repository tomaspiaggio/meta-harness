import { requiredText } from "@harness/core";
import { flushDispatch } from "../../../server/dispatcher";
import { failure, jsonBody } from "../../../server/http";
import { getStore } from "../../../server/store";
export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    await (await getStore()).answerInput(
      requiredText(body.id, "Request ID", 100),
      requiredText(body.response, "Response"),
    );
    await flushDispatch();
    return Response.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
