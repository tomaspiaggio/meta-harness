import { HarnessError, requiredText } from "@harness/core";
import { BrowserBroker } from "../../../server/browser";
import { failure, localRequest } from "../../../server/http";
import { encryptionKey } from "../../../server/keys";
import { getStore } from "../../../server/store";

export const dynamic = "force-dynamic";
/** Internal auth decision used by the launcher's WebSocket relay. Never a CDP proxy. */
export async function GET(request: Request) {
  try {
    const store = await getStore();
    const query = new URL(request.url).searchParams;
    if (query.get("role") === "worker") {
      const workerId = request.headers.get("x-worker-id") ?? "";
      await store.authenticateWorker(
        workerId,
        request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
      );
      return Response.json({ role: "worker", workerId });
    }
    await localRequest(request);
    const browser = await new BrowserBroker(store).get(
      requiredText(query.get("browser"), "Browser ID", 100),
    );
    if (!browser.workerId || (browser.leaseUntil ?? 0) <= Date.now())
      throw new HarnessError(
        "Browser host is offline. Reopen the view to reconnect.",
        409,
      );
    const publicKey = requiredText(
      query.get("key"),
      "View encryption key",
      100,
    );
    if (Buffer.from(publicKey, "base64").length !== 65)
      throw new HarnessError("Invalid view key.");
    if (
      browser.mode !== "agent" &&
      (browser.mode !== "human" ||
        browser.userPublicKey !== publicKey ||
        (browser.expiresAt ?? 0) <= Date.now())
    )
      throw new HarnessError(
        "This browser is controlled in another view or needs a new takeover.",
        409,
      );
    const worker = (await store.listWorkers()).find(
      (w) => w.id === browser.workerId,
    );
    if (worker?.report?.browserBackend !== "managed")
      throw new HarnessError(
        "This worker needs the managed-browser update. Extension streams are no longer used.",
        409,
      );
    return Response.json(
      {
        role: "viewer",
        browserId: browser.id,
        workerId: browser.workerId,
        generation: browser.generation,
        mode: browser.mode,
        publicKey,
        assignment: {
          identity: browser,
          stateKey: encryptionKey(`browser:${browser.id}`),
          command: { id: "live-view", action: "manual", arguments: "{}" },
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
