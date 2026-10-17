import { HarnessError } from "@harness/core";

export function localRequest(request: Request): void {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (
    !host ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    (origin && new URL(origin).host !== host) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  ) {
    throw new HarnessError(
      "This local install only accepts same-origin loopback requests.",
      403,
    );
  }
}

export async function jsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  localRequest(request);
  if (Number(request.headers.get("content-length") ?? 0) > 32_768)
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
    if (bytes > 32_768) {
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
