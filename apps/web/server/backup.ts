import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDirectory } from "@harness/storage";
import { sendPush } from "./push";
import { getStore } from "./store";

/** Written by scripts/backup.mjs after every hourly run. */
export interface BackupStatus {
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastFile?: string;
  bytes?: number;
  kept?: number;
  remote?: string;
  error?: string | null;
}

// Hourly backups: three missed hours means the timer or the upload is broken.
const OVERDUE_MS = 3 * 3600000;

function read<T>(name: string): T | null {
  try {
    return JSON.parse(readFileSync(join(dataDirectory(), name), "utf8"));
  } catch {
    return null;
  }
}

export function backupStatus() {
  const status = read<BackupStatus>("backup-status.json");
  if (!status) return null;
  return {
    ...status,
    overdue:
      !status.lastSuccessAt || Date.now() - status.lastSuccessAt > OVERDUE_MS,
  };
}

/**
 * Tell the owner's devices once per outage: a failing upload or a timer that
 * stopped. The next alert waits for a successful backup in between.
 */
export async function alertBackups() {
  const status = backupStatus();
  if (!status || (!status.error && !status.overdue)) return;
  const incident = String(status.lastSuccessAt ?? "never");
  const path = join(dataDirectory(), "backup-alert.json");
  if (read<{ incident: string }>("backup-alert.json")?.incident === incident)
    return;
  const store = await getStore();
  for (const device of await store.pushSubscriptions())
    await sendPush(store, device.endpoint, {
      title: "Backups are failing",
      body: status.error
        ? status.error.slice(0, 160)
        : "No backup in the last 3 hours.",
      url: "/settings",
      tag: "backup",
    });
  writeFileSync(path, JSON.stringify({ incident, at: Date.now() }), {
    mode: 0o600,
  });
}
