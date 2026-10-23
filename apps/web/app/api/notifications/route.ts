import { requiredText } from "@harness/core";
import { failure, jsonBody, localRequest } from "../../../server/http";
import { getStore } from "../../../server/store";
import {
  connectTelegram,
  telegramConfiguration,
} from "../../../server/telegram";
export async function GET(request: Request) {
  try {
    await localRequest(request);
    const id = new URL(request.url).searchParams.get("session");
    return Response.json({
      configured: !!telegramConfiguration(),
      binding: id ? await (await getStore()).channelBinding(id) : null,
      deliveries: id ? await (await getStore()).notificationHistory(id) : [],
    });
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    return Response.json(
      await connectTelegram(
        requiredText(body.sessionId, "Session ID", 100),
        typeof body.topicId === "string" ? body.topicId : undefined,
      ),
    );
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await jsonBody(request);
    await (await getStore()).unbindChannel(
      requiredText(body.sessionId, "Session ID", 100),
    );
    return Response.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
