import { timingSafeEqual } from "node:crypto";
import { HarnessError } from "@harness/core";
import { after } from "next/server";
import { failure, readJson } from "../../../server/http";
import { maintain } from "../../../server/maintenance";
import { getStore } from "../../../server/store";
import {
  telegramConfiguration,
  telegramInboundId,
} from "../../../server/telegram";
export async function POST(request: Request) {
  try {
    const config = telegramConfiguration();
    if (!config) throw new HarnessError("Telegram is not configured.", 503);
    const actual = Buffer.from(
      request.headers.get("x-telegram-bot-api-secret-token") ?? "",
    );
    const expected = Buffer.from(config.secret);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new HarnessError("Invalid webhook signature.", 401);
    const update = await readJson(request, 65536);
    const message = update.message as
      | {
          chat?: { id?: number };
          from?: { id?: number; is_bot?: boolean };
          message_id?: number;
        }
      | undefined;
    if (!Number.isSafeInteger(update.update_id))
      throw new HarnessError("Invalid update identity.");
    if (
      !message ||
      message.from?.is_bot ||
      !config.owners.includes(String(message.from?.id)) ||
      String(message.chat?.id) !== config.chatId
    )
      return Response.json({ ok: true });
    if (!Number.isSafeInteger(message.message_id))
      throw new HarnessError("Invalid message identity.");
    await (await getStore()).acceptTelegram(
      telegramInboundId(String(message.chat?.id), String(message.message_id)),
      update,
    );
    after(() => maintain());
    return Response.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
