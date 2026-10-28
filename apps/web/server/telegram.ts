import { createHash } from "node:crypto";
import { HarnessError } from "@harness/core";
import type { ChannelBinding } from "@harness/storage/application";
import { flushDispatch } from "./dispatcher";
import { deliverPush } from "./push";
import { getStore } from "./store";

export function telegramConfiguration() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const owners = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (
    !owners.length ||
    !secret ||
    secret.length < 32 ||
    !/^[A-Za-z0-9_-]+$/.test(secret) ||
    !chatId ||
    !process.env.DATABASE_URL
  )
    throw new HarnessError(
      "Telegram requires an owner allowlist, webhook secret, destination chat and PostgreSQL.",
      503,
    );
  return { token, owners, secret, chatId };
}
let bot: Promise<Awaited<ReturnType<typeof createTelegramBridge>>> | undefined;
export async function createTelegramBridge(
  dispatch: () => Promise<void> = flushDispatch,
) {
  const config = telegramConfiguration();
  if (!config) throw new HarnessError("Telegram is not configured.", 503);
  const [
    { Chat },
    { createTelegramAdapter },
    { createPostgresState },
    { Pool },
  ] = await Promise.all([
    import("chat"),
    import("@chat-adapter/telegram"),
    import("@chat-adapter/state-pg"),
    import("pg"),
  ]);
  const adapter = createTelegramAdapter({
    botToken: config.token,
    secretToken: config.secret,
    allowedUserIds: config.owners,
    mode: "webhook",
    allowUnverifiedWebhooks: false,
  });
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10000,
  });
  const chat = new Chat({
    userName: "meta-harness",
    adapters: { telegram: adapter },
    state: createPostgresState({
      client: pool,
      autoCreateSchema: false,
      keyPrefix: "meta-harness",
    }),
  });
  const receive = async (
    thread: import("chat").Thread,
    message: import("chat").Message,
  ) => {
    if (
      !config.owners.includes(message.author.userId) ||
      message.author.isMe ||
      message.author.isBot === true
    )
      return;
    const location = adapter.decodeThreadId(thread.id);
    if (String(location.chatId) !== config.chatId) return;
    const store = await getStore();
    const binding = await store.findChannel(
      String(location.chatId),
      String(location.messageThreadId ?? ""),
    );
    if (!binding) {
      await thread.post(
        "Connect this topic to a session in the Meta Harness UI first.",
      );
      const raw = message.raw as { chat: { id: number }; message_id: number };
      await store.finishTelegram(
        telegramInboundId(String(raw.chat.id), String(raw.message_id)),
      );
      return;
    }
    const text = message.text.trim();
    if (!text) {
      await thread.post(
        "Upload files through the session UI; send a text message here.",
      );
      const raw = message.raw as { chat: { id: number }; message_id: number };
      await store.finishTelegram(
        telegramInboundId(String(raw.chat.id), String(raw.message_id)),
      );
      return;
    }
    const raw = message.raw as { chat?: { id: number }; message_id?: number };
    if (!raw.chat || !Number.isSafeInteger(raw.message_id))
      throw new Error("Telegram message identity is missing.");
    await store.receiveTelegram(
      telegramInboundId(String(raw.chat.id), String(raw.message_id)),
      binding.sessionId,
      text,
    );
    await dispatch();
  };
  chat.onDirectMessage((thread, message) => receive(thread, message));
  chat.onNewMention((thread, message) => receive(thread, message));
  chat.onSubscribedMessage((thread, message) => receive(thread, message));
  chat.onNewMessage((thread, message) => receive(thread, message));
  await chat.initialize();
  return {
    chat,
    adapter,
    close: async () => {
      await chat.shutdown();
      await pool.end();
    },
  };
}
export function telegram() {
  bot ??= createTelegramBridge().catch((error) => {
    bot = undefined;
    throw error;
  });
  return bot;
}
/** Narrow native bridge: the official adapter handles messages and topic IDs. */
async function topicMethod(
  method: "createForumTopic" | "editForumTopic",
  body: Record<string, unknown>,
) {
  const config = telegramConfiguration();
  if (!config) throw new HarnessError("Telegram is not configured.", 503);
  const response = await fetch(
    `https://api.telegram.org/bot${config.token}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    },
  );
  const result = (await response.json()) as { ok?: boolean; result?: unknown };
  if (!response.ok || !result.ok)
    throw new Error(
      `Telegram topic operation returned ${response.status}. Inspect the topic before retrying.`,
    );
  return result.result;
}
export async function connectTelegram(
  sessionId: string,
  topicId?: string,
  service: typeof telegram = telegram,
): Promise<ChannelBinding> {
  const config = telegramConfiguration();
  if (!config) throw new HarnessError("Telegram is not configured.", 503);
  const store = await getStore();
  const session = await store.getSession(sessionId);
  const existing = await store.channelBinding(sessionId);
  if (existing?.topicId && !topicId) return existing;
  if (topicId && !/^\d+$/.test(topicId))
    throw new HarnessError("Invalid Telegram topic ID.");
  if (!topicId) {
    // Persist intent before the API request. An ambiguous create is never retried.
    const db = store.databaseConnection();
    const claimed = await db.transaction(async () => {
      if (await store.channelBinding(sessionId)) return false;
      await store.bindChannel({
        sessionId,
        platform: "telegram",
        chatId: config.chatId,
        topicId: null,
        title: session.title,
      });
      return true;
    });
    if (!claimed)
      throw new HarnessError(
        "Topic creation has no confirmed receipt. Inspect Telegram and connect its existing topic ID.",
        409,
      );
    const topic = await topicMethod("createForumTopic", {
      chat_id: config.chatId,
      name: session.title.slice(0, 100),
    });
    if (
      !topic ||
      typeof topic !== "object" ||
      !("message_thread_id" in topic) ||
      typeof topic.message_thread_id !== "number" ||
      !Number.isSafeInteger(topic.message_thread_id)
    )
      throw new Error(
        "Telegram returned no valid topic receipt. Inspect the chat before retrying.",
      );
    topicId = String(topic.message_thread_id);
  }
  await store.bindChannel({
    sessionId,
    platform: "telegram",
    chatId: config.chatId,
    topicId,
    title: session.title,
  });
  const { chat, adapter } = await service();
  await chat
    .thread(
      adapter.encodeThreadId({
        chatId: config.chatId,
        messageThreadId: Number(topicId),
      }),
    )
    .subscribe();
  const binding = await store.channelBinding(sessionId);
  if (!binding) throw new Error("Topic binding was not saved.");
  return binding;
}
export async function deliverNotifications() {
  const store = await getStore();
  const configured = !!telegramConfiguration();
  for (const item of await store.claimNotifications()) {
    if (await store.notificationIsQuiet(item)) {
      await store.finishNotification(item.id, "quiet:via-planner");
      continue;
    }
    // Push is best effort and sent on the first attempt only, so a Telegram
    // retry cannot repeat it; the app shows every event either way.
    const pushed =
      item.attempts === 1 ? await deliverPush(store, item).catch(() => 0) : 0;
    if (!configured) {
      await store.finishNotification(
        item.id,
        pushed ? `push:${pushed}` : "in-app-only",
      );
      continue;
    }
    try {
      const { adapter } = await telegram();
      let binding = await store.channelBinding(item.sessionId);
      if (!binding && process.env.TELEGRAM_AUTO_TOPICS === "1")
        binding = await connectTelegram(item.sessionId);
      if (!binding?.topicId) {
        await store.finishNotification(item.id, "in-app-only");
        continue;
      }
      const session = await store.getSession(item.sessionId);
      if (binding.title !== session.title) {
        await topicMethod("editForumTopic", {
          chat_id: binding.chatId,
          message_thread_id: Number(binding.topicId),
          name: session.title.slice(0, 100),
        });
        await store.bindChannel({ ...binding, title: session.title });
      }
      if (item.kind === "title") {
        await store.finishNotification(item.id, "topic-title-synchronized");
        continue;
      }
      const origin = process.env.HARNESS_PUBLIC_URL;
      const link = origin
        ? new URL(
            `/?workspace=${encodeURIComponent(session.workspaceId)}&session=${encodeURIComponent(session.id)}`,
            origin,
          ).toString()
        : "Open the local Meta Harness UI.";
      const text = `${session.title}: ${item.kind === "completed" ? "A new result is ready." : item.kind === "needs-input" ? "Your input is needed." : item.kind === "schedule-review" ? "A schedule is waiting for your review." : `Task ${item.kind}.`}\n${link}`;
      const receipt = await adapter.postMessage(
        adapter.encodeThreadId({
          chatId: binding.chatId,
          messageThreadId: Number(binding.topicId),
        }),
        text,
      );
      await store.finishNotification(item.id, receipt.id);
    } catch {
      await store.finishNotification(
        item.id,
        undefined,
        "Telegram delivery unavailable. A lost acknowledgement can duplicate a notification; session work is deduplicated independently.",
      );
    }
  }
}

export const telegramInboundId = (chatId: string, messageId: string) =>
  createHash("sha256").update(`${chatId}:${messageId}`).digest("hex");
export async function deliverTelegramInbox(
  service: typeof telegram = telegram,
) {
  if (!telegramConfiguration()) return;
  const store = await getStore();
  const pending = await store.pendingTelegram();
  if (!pending.length) return;
  const { chat } = await service();
  for (const item of pending) {
    try {
      if ((await store.telegramStatus(item.id)) === "delivered") continue;
      const update = JSON.parse(item.payload);
      delete update.update_id;
      // Application inbox owns durable deduplication. The SDK's early update-ID
      // marker would suppress a retry after a handler/process crash.
      const tasks: Promise<unknown>[] = [];
      const response = await chat.webhooks.telegram(
        new Request("https://harness.invalid/api/telegram", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-telegram-bot-api-secret-token":
              process.env.TELEGRAM_WEBHOOK_SECRET ?? "",
          },
          body: JSON.stringify(update),
        }),
        {
          deduplicate: false,
          propagateHandlerErrors: true,
          waitUntil: (task) => {
            tasks.push(task);
          },
        },
      );
      await Promise.all(tasks);
      if (!response.ok || (await store.telegramStatus(item.id)) !== "delivered")
        throw new Error(
          "Telegram handler has not durably accepted the message yet.",
        );
    } catch {
      await store.finishTelegram(
        item.id,
        "Processing will retry; the durable message identity prevents duplicate turns.",
      );
    }
  }
}
