import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { Pool } from "pg";
import { getStore } from "../../../apps/web/server/store";
import {
  connectTelegram,
  createTelegramBridge,
  deliverTelegramInbox,
  telegramInboundId,
} from "../../../apps/web/server/telegram";

test("official Chat SDK Telegram adapter: topics, verified ingress, durable replies and crash-safe duplicate delivery", {
  skip: !process.env.HARNESS_TEST_DATABASE_URL,
  timeout: 30000,
}, async () => {
  const url = process.env.HARNESS_TEST_DATABASE_URL;
  assert.ok(url);
  const schema = `harness_telegram_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  const isolated = new URL(url);
  isolated.searchParams.set("options", `-c search_path=${schema}`);
  const requests: { method: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const part of request) chunks.push(Buffer.from(part));
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : {};
    const method = request.url?.split("/").at(-1) ?? "";
    requests.push({ method, body });
    let result: unknown = true;
    if (method === "getMe")
      result = {
        id: 999,
        is_bot: true,
        first_name: "Harness",
        username: "meta_harness_bot",
      };
    if (method === "createForumTopic")
      result = { message_thread_id: 77, name: body.name };
    if (method === "sendMessage")
      result = {
        message_id: 1000 + requests.length,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -100123, type: "supergroup" },
        text: body.text,
        message_thread_id: body.message_thread_id,
      };
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const prior = { ...process.env };
  const realFetch = globalThis.fetch;
  let bridge: Awaited<ReturnType<typeof createTelegramBridge>> | undefined;
  let store: Awaited<ReturnType<typeof getStore>> | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const setup = new Pool({ connectionString: isolated.toString(), max: 1 });
    try {
      const directory = new URL("../prisma/migrations/", import.meta.url);
      for (const name of (await readdir(directory)).sort())
        if (/^\d/.test(name))
          await setup.query(
            await readFile(new URL(`${name}/migration.sql`, directory), "utf8"),
          );
    } finally {
      await setup.end();
    }
    Object.assign(process.env, {
      DATABASE_URL: isolated.toString(),
      TELEGRAM_BOT_TOKEN: "fixture",
      TELEGRAM_WEBHOOK_SECRET: "fixture-secret-that-is-at-least-32-characters",
      TELEGRAM_ALLOWED_USER_IDS: "42",
      TELEGRAM_CHAT_ID: "-100123",
      TELEGRAM_API_BASE_URL: origin,
    });
    globalThis.fetch = (input, init) => {
      const value =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      return realFetch(
        value.startsWith("https://api.telegram.org/botfixture/")
          ? value.replace("https://api.telegram.org", origin)
          : input,
        init,
      );
    };
    store = await getStore();
    const session = await store.createSession(
      "business",
      "Persistent research",
      "demo",
    );
    bridge = await createTelegramBridge(async () => {});
    const service = async () => {
      assert.ok(bridge);
      return bridge;
    };
    const binding = await connectTelegram(session.id, undefined, service);
    assert.equal(binding.topicId, "77");
    assert.equal(
      (await connectTelegram(session.id, undefined, service)).topicId,
      "77",
    );
    assert.equal(
      requests.filter((item) => item.method === "createForumTopic").length,
      1,
    );
    const encoded = bridge.adapter.encodeThreadId({
      chatId: "-100123",
      messageThreadId: 77,
    });
    assert.equal(bridge.adapter.decodeThreadId(encoded).messageThreadId, 77);
    const message = {
      update_id: 1,
      message: {
        message_id: 55,
        message_thread_id: 77,
        date: Math.floor(Date.now() / 1000),
        chat: {
          id: -100123,
          type: "supergroup",
          is_forum: true,
          title: "Harness",
        },
        from: { id: 42, is_bot: false, first_name: "Tom" },
        text: "Review my tasks",
      },
    };
    const forged = await bridge.chat.webhooks.telegram(
      new Request("https://control.example/api/telegram", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-telegram-bot-api-secret-token": "forged",
        },
        body: JSON.stringify(message),
      }),
    );
    assert.equal(forged.status, 401);
    const id = telegramInboundId("-100123", "55");
    await store.acceptTelegram(id, message);
    await store.acceptTelegram(id, message);
    await deliverTelegramInbox(service);
    assert.equal(await store.telegramStatus(id), "delivered");
    assert.equal((await store.listTurns(session.id)).length, 1);
    await store
      .databaseConnection()
      .prepare("UPDATE telegram_inbox SET status = 'pending' WHERE id = ?")
      .run(id);
    await deliverTelegramInbox(service);
    assert.equal(
      (await store.listTurns(session.id)).length,
      1,
      "restarting after a lost receipt cannot create a second turn",
    );
    await bridge.adapter.postMessage(encoded, "A result is ready.");
    assert.equal(
      requests.filter((item) => item.method === "sendMessage").at(-1)?.body
        .message_thread_id,
      77,
    );
  } finally {
    globalThis.fetch = realFetch;
    await bridge?.close();
    await store?.close();
    for (const key of Object.keys(process.env))
      if (!(key in prior)) delete process.env[key];
    Object.assign(process.env, prior);
    await new Promise<void>((done) => server.close(() => done()));
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
