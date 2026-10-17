import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WorkerIdentity } from "./client";

export async function workerIdentity(): Promise<WorkerIdentity> {
  const serverUrl =
    process.env.HARNESS_CONTROL_URL ??
    `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  const configured = process.env.HARNESS_WORKER_TOKEN_FILE;
  if (configured) {
    const parsed = JSON.parse(readFileSync(configured, "utf8"));
    if (typeof parsed.id !== "string" || typeof parsed.token !== "string")
      throw new Error("Invalid worker credential file.");
    return {
      ...parsed,
      serverUrl:
        process.env.HARNESS_CONTROL_URL ?? parsed.serverUrl ?? serverUrl,
    };
  }
  if (process.env.HARNESS_CONTROL_URL)
    throw new Error(
      "Set HARNESS_WORKER_TOKEN_FILE when connecting to a control plane.",
    );
  const { ControlStore } = await import("@harness/storage/control");
  const directory = resolve(process.env.HARNESS_DATA_DIR ?? "../../.data");
  const path = join(directory, "local-worker.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed.id !== "string" || typeof parsed.token !== "string")
      throw new Error("Invalid local worker credential.");
    return { ...parsed, serverUrl };
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const store = new ControlStore(join(directory, "harness.sqlite"));
  try {
    const identity = { ...store.createWorker("Local worker"), serverUrl };
    writeFileSync(path, JSON.stringify(identity), { flag: "wx", mode: 0o600 });
    return identity;
  } finally {
    store.close();
  }
}
