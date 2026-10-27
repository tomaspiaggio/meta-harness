import { setTimeout as delay } from "node:timers/promises";
import {
  decryptPayload,
  encryptPayload,
  INLINE_PAYLOAD_BYTES,
  payloadHash,
} from "@harness/checkpoints/transport";
import { HarnessError } from "@harness/core";
export interface WorkerIdentity {
  id: string;
  token: string;
  serverUrl: string;
}
export class WorkerClient {
  /** `retryMs` stays below the control's 3-minute turn lease. */
  constructor(
    private identity: WorkerIdentity,
    private retryMs = 150000,
  ) {
    const url = new URL(identity.serverUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error("Control URL must be a bare origin.");
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
          process.env.HARNESS_ALLOW_INSECURE_HTTP === "1")
      )
    )
      throw new Error(
        "Remote workers require HTTPS. Plain HTTP can be explicitly enabled on a trusted private network.",
      );
  }
  async post<T>(action: string, body: unknown = {}): Promise<T> {
    const original = body as Record<string, unknown>;
    const serialized = JSON.stringify(body);
    if (
      (action === "checkpoint" || action === "native-append") &&
      Buffer.byteLength(serialized) > INLINE_PAYLOAD_BYTES
    ) {
      const encrypted = encryptPayload(Buffer.from(serialized));
      const prepared = await this.post<{
        token: string;
        upload: { url: string; headers: Record<string, string> };
      }>("payload-prepare", {
        turnId: original.turnId,
        generation: original.generation,
        kind: action,
        key: encrypted.key,
        hash: encrypted.hash,
        size: encrypted.size,
      });
      const target = new URL(prepared.upload.url, this.identity.serverUrl);
      const response = await fetch(target, {
        method: "PUT",
        headers: {
          ...prepared.upload.headers,
          ...(target.origin === new URL(this.identity.serverUrl).origin
            ? {
                "x-worker-id": this.identity.id,
                authorization: `Bearer ${this.identity.token}`,
                "x-payload-grant": prepared.token,
              }
            : {}),
        },
        body: encrypted.data,
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok)
        throw new Error(`Worker payload upload failed (${response.status}).`);
      body = {
        turnId: original.turnId,
        generation: original.generation,
        payload: prepared.token,
      };
    }
    let lastError: unknown;
    // Claims are polled anyway; a running turn rides out a control stall
    // (restart, overloaded host) within its 3-minute lease.
    const started = Date.now();
    const patience = action === "claim" ? 0 : this.retryMs;
    for (
      let attempt = 0;
      attempt < 3 || Date.now() - started < patience;
      attempt++
    ) {
      try {
        const response = await fetch(
          `${this.identity.serverUrl.replace(/\/$/, "")}/api/worker?action=${encodeURIComponent(action)}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-worker-id": this.identity.id,
              authorization: `Bearer ${this.identity.token}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(
              [
                "claim",
                "checkpoint",
                "native-load",
                "native-append",
                "payload-prepare",
              ].includes(action)
                ? 60000
                : 5000,
            ),
          },
        );
        const result = await response.json();
        if (!response.ok) {
          const error = new HarnessError(
            typeof result === "object" &&
              result !== null &&
              "error" in result &&
              typeof result.error === "string"
              ? result.error
              : `Control request failed (${response.status}).`,
            response.status,
          );
          if (response.status < 500) throw error;
          lastError = error;
        } else {
          if (
            result &&
            typeof result === "object" &&
            "payloadDownload" in result
          ) {
            const transfer = result.payloadDownload as {
              url?: string;
              token: string;
              key: string;
              hash: string;
              size: number;
              turnId: string;
              generation: number;
            };
            const bytes = transfer.url
              ? await boundedBytes(
                  await fetch(transfer.url, {
                    signal: AbortSignal.timeout(120000),
                  }),
                  transfer.size,
                )
              : await this.bytes(
                  "payload-read",
                  {
                    payload: transfer.token,
                    turnId: transfer.turnId,
                    generation: transfer.generation,
                  },
                  transfer.size,
                );
            if (
              bytes.length !== transfer.size ||
              payloadHash(bytes) !== transfer.hash
            )
              throw new Error("Worker payload integrity check failed.");
            return JSON.parse(
              Buffer.from(decryptPayload(bytes, transfer.key)).toString("utf8"),
            ) as T;
          }
          return result as T;
        }
      } catch (error) {
        if (error instanceof HarnessError && error.status < 500) throw error;
        lastError = error;
      }
      await delay(Math.min(250 * (attempt + 1), 5000));
    }
    throw lastError;
  }
  async bytes(
    action: string,
    body: unknown,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const response = await fetch(
      `${this.identity.serverUrl}/api/worker?action=${encodeURIComponent(action)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-worker-id": this.identity.id,
          authorization: `Bearer ${this.identity.token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok)
      throw new Error(`Attachment download failed (${response.status}).`);
    return boundedBytes(response, maxBytes);
  }
}
export async function boundedBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes)
    throw new Error("Download exceeds its byte limit.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty download.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > maxBytes) {
      await reader.cancel();
      throw new Error("Download exceeds its byte limit.");
    }
    chunks.push(part.value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
