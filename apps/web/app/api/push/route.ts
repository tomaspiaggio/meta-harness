import { HarnessError, requiredText } from "@harness/core";
import { failure, jsonBody, localRequest } from "../../../server/http";
import { pushKeys, sendPush } from "../../../server/push";
import { getStore } from "../../../server/store";

/** Notification settings for this device: the app passes its endpoint. */
export async function GET(request: Request) {
  try {
    await localRequest(request);
    const endpoint = new URL(request.url).searchParams.get("endpoint");
    const store = await getStore();
    const device = endpoint ? await store.pushSubscription(endpoint) : null;
    return Response.json(
      {
        publicKey: pushKeys().publicKey,
        devices: (await store.pushSubscriptions()).length,
        device: device && {
          label: device.label,
          results: device.results,
          lastSentAt: device.lastSentAt,
          error: device.error,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    const store = await getStore();
    const endpoint = requiredText(body.endpoint, "Push endpoint", 1000);
    if (body.action === "subscribe") {
      const keys = (body.keys ?? {}) as Record<string, unknown>;
      const device = await store.savePushSubscription({
        endpoint,
        p256dh: String(keys.p256dh ?? ""),
        auth: String(keys.auth ?? ""),
        label: String(body.label ?? "This device"),
        ...(typeof body.results === "boolean" ? { results: body.results } : {}),
      });
      return Response.json({ results: device.results });
    }
    if (body.action === "unsubscribe") {
      await store.removePushSubscription(endpoint);
      return Response.json({ ok: true });
    }
    if (body.action === "test") {
      const sent = await sendPush(store, endpoint, {
        title: "Meta Harness",
        body: "Notifications are on for this device.",
        url: "/settings",
        tag: "test",
      });
      if (!sent)
        throw new HarnessError(
          (await store.pushSubscription(endpoint))?.error ??
            "This device is no longer subscribed. Turn notifications on again.",
          409,
        );
      return Response.json({ ok: true });
    }
    throw new HarnessError("Unsupported notification action.");
  } catch (error) {
    return failure(error);
  }
}
