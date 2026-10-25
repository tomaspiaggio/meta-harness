import assert from "node:assert/strict";
import { test } from "node:test";
import { HarnessStore } from "./application";

test("push subscriptions keep each device's choice across re-registration", async () => {
  const store = new HarnessStore(":memory:");
  await store.ready;
  try {
    const endpoint = "https://web.push.apple.com/fixture";
    const keys = { p256dh: "public-key", auth: "secret" };
    const first = await store.savePushSubscription({
      endpoint,
      ...keys,
      label: "iPhone app",
      results: true,
    });
    assert.equal(first.results, true);
    // The app re-registers on every open without restating the choice.
    const renewed = await store.savePushSubscription({
      endpoint,
      ...keys,
      p256dh: "rotated-key",
      label: "iPhone app",
    });
    assert.equal(renewed.results, true);
    assert.equal(renewed.p256dh, "rotated-key");
    await store.pushSent(endpoint, "Push failed (500).");
    assert.match(
      String((await store.pushSubscription(endpoint))?.error),
      /500/,
    );
    await store.pushSent(endpoint);
    assert.equal((await store.pushSubscription(endpoint))?.error, null);
    await assert.rejects(
      store.savePushSubscription({
        endpoint: "http://insecure.example/push",
        ...keys,
        label: "x",
      }),
      /HTTPS/,
    );
    await store.removePushSubscription(endpoint);
    assert.equal((await store.pushSubscriptions()).length, 0);
  } finally {
    await store.close();
  }
});
