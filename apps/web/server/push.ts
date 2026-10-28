import { createECDH } from "node:crypto";
import type { HarnessStore, Notification } from "@harness/storage/application";
import webpush from "web-push";
import { encryptionKey } from "./keys";

/**
 * Web Push to the owner's devices (including the iPhone home-screen app). The
 * signing key is derived from the harness encryption key, so there is no extra
 * secret to store. Payloads are encrypted for each device; Apple, Google or
 * Mozilla only relay them.
 */
export function pushKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(encryptionKey("web-push-vapid"), "base64"));
  return {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: ecdh.getPrivateKey().toString("base64url"),
  };
}

/** Events that need the owner; results only for devices that opted in. */
const attention: Record<string, string> = {
  "needs-input": "The agent needs you",
  "schedule-review": "A schedule is waiting for your review",
  failed: "A task failed",
  interrupted: "A task was interrupted",
};
// Older events stay in the app: a new device or a deploy must not replay a
// backlog of stale alerts.
const FRESH_MS = 15 * 60000;

export async function sendPush(
  store: HarnessStore,
  endpoint: string,
  payload: { title: string; body: string; url: string; tag: string },
) {
  const subscription = await store.pushSubscription(endpoint);
  if (!subscription) return false;
  const keys = pushKeys();
  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload),
      {
        TTL: 3600,
        urgency: "high",
        vapidDetails: {
          // Push services only accept an https: or mailto: contact.
          subject: process.env.HARNESS_PUBLIC_URL?.startsWith("https://")
            ? process.env.HARNESS_PUBLIC_URL
            : "mailto:owner@meta-harness.invalid",
          publicKey: keys.publicKey,
          privateKey: keys.privateKey,
        },
      },
    );
    await store.pushSent(endpoint);
    return true;
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    // The device unsubscribed or the subscription expired: forget it. The app
    // registers again the next time it opens.
    if (status === 404 || status === 410)
      await store.removePushSubscription(endpoint);
    else
      await store.pushSent(
        endpoint,
        `Push failed${status ? ` (${status})` : `: ${error instanceof Error ? error.message.slice(0, 120) : "unknown error"}`}. It will be tried again on the next event.`,
      );
    return false;
  }
}

/** Best effort: a failed push never blocks other channels or retries. */
export async function deliverPush(
  store: HarnessStore,
  item: Notification,
): Promise<number> {
  if (Date.now() - Number(item.createdAt) > FRESH_MS) return 0;
  const title =
    attention[item.kind] ?? (item.kind === "completed" ? "Result ready" : null);
  if (!title) return 0;
  const devices = (await store.pushSubscriptions()).filter(
    (device) => item.kind !== "completed" || device.results,
  );
  if (!devices.length) return 0;
  const session = await store.getSession(item.sessionId);
  const alert = await store.ownerAlert(String(item.referenceId));
  const payload = {
    title: alert ? `${session.title}` : title,
    body: alert ?? session.title,
    url: `/?workspace=${encodeURIComponent(session.workspaceId)}&session=${encodeURIComponent(session.id)}`,
    // One notification per session: a newer event replaces the older one.
    tag: `session:${session.id}`,
  };
  let sent = 0;
  for (const device of devices)
    if (await sendPush(store, device.endpoint, payload)) sent++;
  return sent;
}
