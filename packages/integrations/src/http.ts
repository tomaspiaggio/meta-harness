import { HarnessError } from "@harness/core";

export type HttpFetch = typeof fetch;
/** Never include provider bodies/URLs in errors: these can contain credentials or user data. */
export async function boundedResponse(response: Response, maxBytes = 1_048_576): Promise<string> {
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await response.body?.cancel();
    throw new HarnessError("Google response exceeds the read limit.", 413);
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new HarnessError("Google response exceeds the read limit.", 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export async function googleJson(response: Response): Promise<Record<string, unknown>> {
  const text = await boundedResponse(response);
  if (!response.ok) {
    throw new HarnessError(
      response.status === 401 ? "Google access expired. Reconnect this account." : response.status === 403 ? "Google denied access. Check granted scopes and file access." : response.status === 429 ? "Google rate limit reached. Try again later." : "Google could not complete this read. Try again later.",
      response.status === 401 || response.status === 403 ? 403 : 502,
    );
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HarnessError("Google returned an invalid response.", 502);
  }
}
export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const string = (value: unknown): string => typeof value === "string" ? value : "";
