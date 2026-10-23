import { HarnessError } from "@harness/core";
import { googleAuthEnabled, googleOwnerConfig } from "./google-auth";
import { hosted, publicOrigin } from "./hosted-auth";
import { authorizeAdmin } from "./security";
export async function localRequest(request: Request): Promise<void> {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (
    !host ||
    (!hosted() &&
      !googleAuthEnabled() &&
      ["localhost", "127.0.0.1", "::1"].includes(
        process.env.HARNESS_BIND_HOST ?? "127.0.0.1",
      ) &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ||
    (origin &&
      (googleAuthEnabled()
        ? origin !== googleOwnerConfig().origin
        : hosted()
          ? origin !== publicOrigin()
          : new URL(origin).host !== host)) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  ) {
    throw new HarnessError(
      "This local install only accepts same-origin loopback requests.",
      403,
    );
  }
  await authorizeAdmin(request);
}
export async function jsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  await localRequest(request);
  return await readJson(request);
}
export async function readJson(
  request: Request,
  maxBytes = 32768,
): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes)
    throw new HarnessError("Request too large.", 413);
  // Bound even chunked input before parsing JSON.
  const reader = request.body?.getReader();
  if (!reader) throw new HarnessError("Expected a JSON object.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new HarnessError("Request too large.", 413);
    }
    chunks.push(value);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HarnessError("Expected valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HarnessError("Expected a JSON object.");
  return value as Record<string, unknown>;
}
export function failure(error: unknown): Response {
  if (error instanceof HarnessError)
    return Response.json({ error: error.message }, { status: error.status });
  console.error(error);
  return Response.json(
    {
      error:
        "The local service could not complete this request. Check the terminal.",
    },
    { status: 500 },
  );
}
