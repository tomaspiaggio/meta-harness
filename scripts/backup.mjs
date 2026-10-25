// Encrypted off-site backup of the control plane, run hourly by a systemd user
// timer. It snapshots SQLite while control keeps running, bundles the state
// needed to restore it, encrypts it to the owner's public key (this host cannot
// read its own backups) and uploads it with rclone. Retention keeps hourly
// copies for 2 days, daily for 30 days and weekly for 26 weeks.
//
// Environment:
//   HARNESS_DATA_DIR          control state directory
//   HARNESS_BACKUP_KEY        owner's armored public key file
//   HARNESS_BACKUP_REMOTE     rclone destination, e.g. "drive:Meta Harness backups"
//   HARNESS_BACKUP_RCLONE     rclone binary (default "rclone")
//   HARNESS_BACKUP_EXTRA      extra files to include, separated by ":"
//                             (e.g. the control env file with its auth secret)
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const PREFIX = "meta-harness-";
const SUFFIX = ".tar.gz.gpg";
const HOUR = 3600000;
const DAY = 24 * HOUR;

export function backupName(now) {
  const stamp = new Date(now).toISOString().slice(0, 16).replace(/[-:]/g, "");
  return `${PREFIX}${stamp}Z${SUFFIX}`;
}

function parse(name) {
  const match = name.match(/^meta-harness-(\d{8})T(\d{4})Z\.tar\.gz\.gpg$/);
  if (!match) return null;
  const [, date, time] = match;
  return Date.parse(
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T${time.slice(0, 2)}:${time.slice(2)}:00Z`,
  );
}

/** Backups to delete: everything outside the hourly, daily and weekly windows. */
export function expired(names, now) {
  const backups = names
    .map((name) => ({ name, at: parse(name) }))
    .filter((backup) => backup.at !== null)
    .sort((a, b) => b.at - a.at);
  const keep = new Set();
  const days = new Set();
  const weeks = new Set();
  for (const backup of backups) {
    const age = now - backup.at;
    const day = Math.floor(backup.at / DAY);
    const week = Math.floor((day + 3) / 7); // Weeks start on Monday.
    if (age < 2 * DAY) keep.add(backup.name);
    else if (age < 30 * DAY && !days.has(day)) keep.add(backup.name);
    else if (age < 26 * 7 * DAY && !weeks.has(week)) keep.add(backup.name);
    days.add(day);
    weeks.add(week);
  }
  return backups
    .filter((backup) => !keep.has(backup.name))
    .map((backup) => backup.name);
}

function writeStatus(directory, status) {
  const path = join(directory, "backup-status.json");
  writeFileSync(`${path}.tmp`, JSON.stringify(status, null, 2), {
    mode: 0o600,
  });
  renameSync(`${path}.tmp`, path);
}

function readStatus(directory) {
  try {
    return JSON.parse(
      readFileSync(join(directory, "backup-status.json"), "utf8"),
    );
  } catch {
    return {};
  }
}

async function main() {
  const directory = resolve(process.env.HARNESS_DATA_DIR ?? ".data");
  const key = process.env.HARNESS_BACKUP_KEY;
  const remote = process.env.HARNESS_BACKUP_REMOTE;
  const rclone = process.env.HARNESS_BACKUP_RCLONE ?? "rclone";
  if (!key || !remote)
    throw new Error("Set HARNESS_BACKUP_KEY and HARNESS_BACKUP_REMOTE.");
  const previous = readStatus(directory);
  const startedAt = Date.now();
  // The staging copy holds plaintext secrets: private directory, always removed.
  const work = mkdtempSync(join(tmpdir(), "meta-harness-backup-"));
  try {
    const stage = join(work, "control");
    mkdirSync(stage, { mode: 0o700 });
    const database = new DatabaseSync(join(directory, "harness.sqlite"));
    try {
      database.exec("PRAGMA busy_timeout = 10000");
      database.prepare("VACUUM INTO ?").run(join(stage, "harness.sqlite"));
    } finally {
      database.close();
    }
    for (const entry of [
      "workflow",
      "objects",
      "encryption-key",
      "admin-token",
      "google-resource-client.json",
    ])
      if (existsSync(join(directory, entry)))
        cpSync(join(directory, entry), join(stage, entry), { recursive: true });
    const extra = (process.env.HARNESS_BACKUP_EXTRA ?? "")
      .split(":")
      .filter(Boolean);
    if (extra.length) {
      mkdirSync(join(stage, "extra"), { mode: 0o700 });
      for (const file of extra)
        cpSync(file, join(stage, "extra", basename(file)));
    }
    const name = backupName(startedAt);
    const archive = join(work, "control.tar.gz");
    const output = join(work, name);
    execFileSync("tar", ["-czf", archive, "-C", work, "control"]);
    // A throwaway keyring: only the owner's public key, nothing persisted.
    const keyring = join(work, "gnupg");
    mkdirSync(keyring, { mode: 0o700 });
    execFileSync(
      "gpg",
      [
        "--homedir",
        keyring,
        "--batch",
        "--yes",
        "--trust-model",
        "always",
        "--recipient-file",
        key,
        "--output",
        output,
        "--encrypt",
        archive,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    rmSync(archive);
    execFileSync(rclone, ["copyto", output, `${remote}/${name}`], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const names = execFileSync(rclone, ["lsf", "--files-only", remote], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    const stale = expired(names, startedAt);
    for (const old of stale)
      execFileSync(rclone, ["deletefile", `${remote}/${old}`], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    writeStatus(directory, {
      lastAttemptAt: startedAt,
      lastSuccessAt: Date.now(),
      lastFile: name,
      bytes: statSync(output).size,
      kept: names.length - stale.length,
      remote,
      error: null,
    });
    console.log(`Backed up ${name}; pruned ${stale.length}.`);
  } catch (error) {
    const stderr = error?.stderr?.toString().trim();
    writeStatus(directory, {
      ...previous,
      lastAttemptAt: startedAt,
      remote,
      error: (stderr || error?.message || "Backup failed.").slice(0, 400),
    });
    throw error;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
