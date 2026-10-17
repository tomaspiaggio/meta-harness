import { setTimeout as delay } from "node:timers/promises";
import { HarnessError } from "@harness/core";

export interface WorkerIdentity {
  id: string;
  token: string;
  serverUrl: string;
}

export class WorkerClient {
  constructor(private identity: WorkerIdentity) {
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
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(
          `${this.identity.serverUrl.replace(/\/$/, "")}/api/worker/${action}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-worker-id": this.identity.id,
              authorization: `Bearer ${this.identity.token}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5000),
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
        } else return result as T;
      } catch (error) {
        if (error instanceof HarnessError && error.status < 500) throw error;
        lastError = error;
      }
      await delay(250 * (attempt + 1));
    }
    throw lastError;
  }
}
