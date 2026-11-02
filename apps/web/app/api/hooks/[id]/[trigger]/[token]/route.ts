import { timingSafeEqual } from "node:crypto";
import { HarnessError } from "@harness/core";
import { MAX_WEBHOOK_BYTES } from "@harness/core/extensions";
import { failure } from "../../../../../../server/http";
import { getStore } from "../../../../../../server/store";

type Context = {
  params: Promise<{ id: string; trigger: string; token: string }>;
};
/** Headers a sender may use to prove itself; cookies never reach a script. */
const SKIPPED = new Set(["cookie", "host", "connection", "content-length"]);
/**
 * Public ingress for an extension's webhook trigger. The secret path is the
 * credential; the request is stored and a worker runs the script with it.
 */
export async function POST(request: Request, context: Context) {
  try {
    const { id, trigger, token } = await context.params;
    const store = (await getStore()).extensions;
    const extension = await store.get(id).catch(() => null);
    const expected = Buffer.from(extension?.webhookToken ?? "");
    const actual = Buffer.from(token);
    if (
      !extension ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new HarnessError("Not found.", 404);
    if (
      !extension.manifest?.triggers.some(
        (item) => item.name === trigger && item.type === "webhook",
      )
    )
      throw new HarnessError("Not found.", 404);
    if (Number(request.headers.get("content-length") ?? 0) > MAX_WEBHOOK_BYTES)
      throw new HarnessError("Request too large.", 413);
    const body = await request.text();
    if (Buffer.byteLength(body) > MAX_WEBHOOK_BYTES)
      throw new HarnessError("Request too large.", 413);
    const headers: Record<string, string> = {};
    for (const [name, value] of request.headers)
      if (!SKIPPED.has(name) && Object.keys(headers).length < 50)
        headers[name] = value.slice(0, 2000);
    const run = await store.enqueue(id, trigger, {
      method: request.method,
      query: Object.fromEntries(new URL(request.url).searchParams),
      headers,
      body,
    });
    return Response.json({ ok: true, run: run?.id ?? null }, { status: 202 });
  } catch (error) {
    return failure(error);
  }
}
