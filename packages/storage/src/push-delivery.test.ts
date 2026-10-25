import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { deliverPush, pushKeys } from "../../../apps/web/server/push";
import { HarnessStore, type Notification } from "./application";

// The web app's own copy, so the stub replaces what push.ts actually calls.
const webpush = createRequire(
  new URL("../../../apps/web/package.json", import.meta.url),
)("web-push");

test("push delivery: fresh attention events, opted-in results, expired devices forgotten", async (t) => {
  process.env.HARNESS_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  const sent: { endpoint: string; payload: string }[] = [];
  const gone = new Set<string>();
  t.mock.method(
    webpush,
    "sendNotification",
    async (subscription: { endpoint: string }, payload: string) => {
      if (gone.has(subscription.endpoint))
        throw Object.assign(new Error("Gone"), { statusCode: 410 });
      sent.push({ endpoint: subscription.endpoint, payload });
      return { statusCode: 201, body: "", headers: {} };
    },
  );
  const store = new HarnessStore(":memory:");
  await store.ready;
  try {
    assert.equal(
      Buffer.from(pushKeys().publicKey, "base64url").length,
      65,
      "VAPID public key is an uncompressed P-256 point",
    );
    const session = await store.createSession("business", "CRM review", "demo");
    const keys = { p256dh: "k", auth: "a" };
    await store.savePushSubscription({
      endpoint: "https://push.example/phone",
      ...keys,
      label: "iPhone app",
      results: true,
    });
    await store.savePushSubscription({
      endpoint: "https://push.example/laptop",
      ...keys,
      label: "Mac browser",
    });
    const event = (kind: string, age = 0) =>
      ({
        id: `${kind}-${age}`,
        sessionId: session.id,
        kind,
        referenceId: "x",
        createdAt: Date.now() - age,
        attempts: 1,
      }) as Notification;

    assert.equal(await deliverPush(store, event("needs-input")), 2);
    const payload = JSON.parse(sent[0].payload);
    assert.equal(payload.title, "The agent needs you");
    assert.equal(payload.body, "CRM review");
    assert.match(payload.url, new RegExp(`session=${session.id}`));

    sent.length = 0;
    assert.equal(await deliverPush(store, event("completed")), 1);
    assert.equal(sent[0].endpoint, "https://push.example/phone");

    assert.equal(await deliverPush(store, event("title")), 0);
    assert.equal(
      await deliverPush(store, event("needs-input", 60 * 60000)),
      0,
      "A backlog is not replayed",
    );

    gone.add("https://push.example/laptop");
    await deliverPush(store, event("failed"));
    assert.deepEqual(
      (await store.pushSubscriptions()).map((device) => device.label),
      ["iPhone app"],
    );
  } finally {
    await store.close();
  }
});
