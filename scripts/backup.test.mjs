import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { backupName, expired } from "./backup.mjs";

const HOUR = 3600000;
const DAY = 24 * HOUR;

test("retention keeps hourly for 2 days, daily for 30 days and weekly for 26 weeks", () => {
  const now = Date.parse("2026-10-25T12:30:00Z");
  const names = [];
  for (let at = now - 300 * DAY; at <= now; at += HOUR)
    names.push(backupName(at));
  const gone = new Set(expired(names, now));
  const kept = names.filter((name) => !gone.has(name));
  const ages = kept.map(
    (name) =>
      now -
      Date.parse(
        name.replace(
          /^meta-harness-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z.*$/,
          "$1-$2-$3T$4:$5:00Z",
        ),
      ),
  );
  assert.equal(ages.filter((age) => age < 2 * DAY).length, 48);
  const daily = ages.filter((age) => age >= 2 * DAY && age < 30 * DAY);
  assert.ok(daily.length >= 27 && daily.length <= 28, `${daily.length} daily`);
  const weekly = ages.filter((age) => age >= 30 * DAY);
  assert.ok(
    weekly.length >= 21 && weekly.length <= 23,
    `${weekly.length} weekly`,
  );
  assert.ok(ages.every((age) => age < 26 * 7 * DAY));
  assert.deepEqual(expired(["notes.txt", backupName(now)], now), []);
});

const gpg = spawnSync("gpg", ["--version"]).status === 0;
test("a backup is a consistent snapshot only the owner's key can open", {
  skip: !gpg,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "backup-test-"));
  try {
    const data = join(root, "control");
    mkdirSync(join(data, "workflow"), { recursive: true });
    writeFileSync(join(data, "workflow", "run.json"), "{}");
    writeFileSync(join(data, "encryption-key"), "fixture-key");
    const database = new DatabaseSync(join(data, "harness.sqlite"));
    database.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept')",
    );
    const extra = join(root, "control.env");
    writeFileSync(extra, "SECRET=fixture");
    // The owner's key pair; the backup host only ever gets the public half.
    const owner = join(root, "owner");
    mkdirSync(owner, { mode: 0o700 });
    // "default" makes a signing key plus an encryption subkey.
    execFileSync(
      "gpg",
      [
        "--homedir",
        owner,
        "--batch",
        "--passphrase",
        "",
        "--quick-generate-key",
        "Backup Test <backup@test.invalid>",
        "default",
        "default",
        "never",
      ],
      { stdio: "ignore" },
    );
    const key = join(root, "public.asc");
    writeFileSync(
      key,
      execFileSync("gpg", ["--homedir", owner, "--armor", "--export"]),
    );
    // rclone stand-in backed by a local folder.
    const remote = join(root, "remote");
    mkdirSync(remote);
    const rclone = join(root, "rclone");
    writeFileSync(
      rclone,
      `#!/bin/sh
case "$1" in
  copyto) cp "$2" "${remote}/$(basename "$3")" ;;
  lsf) ls "${remote}" ;;
  deletefile) rm "${remote}/$(basename "$2")" ;;
esac
`,
    );
    chmodSync(rclone, 0o755);
    const env = {
      ...process.env,
      HARNESS_DATA_DIR: data,
      HARNESS_BACKUP_KEY: key,
      HARNESS_BACKUP_REMOTE: "fixture:backups",
      HARNESS_BACKUP_RCLONE: rclone,
      HARNESS_BACKUP_EXTRA: extra,
    };
    execFileSync(process.execPath, [join(import.meta.dirname, "backup.mjs")], {
      env,
      stdio: "pipe",
    });
    database.close();
    const [file] = readdirSync(remote);
    assert.match(file, /^meta-harness-\d{8}T\d{4}Z\.tar\.gz\.gpg$/);
    assert.ok(!readFileSync(join(remote, file)).includes("fixture-key"));
    const status = JSON.parse(
      readFileSync(join(data, "backup-status.json"), "utf8"),
    );
    assert.equal(status.lastFile, file);
    assert.equal(status.error, null);
    // Restore with the private key.
    const restore = join(root, "restore");
    mkdirSync(restore);
    execFileSync(
      "gpg",
      [
        "--homedir",
        owner,
        "--batch",
        "--output",
        join(restore, "c.tar.gz"),
        "--decrypt",
        join(remote, file),
      ],
      { stdio: "ignore" },
    );
    execFileSync("tar", ["-xzf", join(restore, "c.tar.gz"), "-C", restore]);
    const restored = new DatabaseSync(
      join(restore, "control", "harness.sqlite"),
    );
    assert.equal(restored.prepare("SELECT v FROM t").get().v, "kept");
    restored.close();
    assert.equal(
      readFileSync(join(restore, "control", "encryption-key"), "utf8"),
      "fixture-key",
    );
    assert.equal(
      readFileSync(join(restore, "control", "extra", "control.env"), "utf8"),
      "SECRET=fixture",
    );
    // A failure is recorded without losing the last good backup.
    const failed = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "backup.mjs")],
      { env: { ...env, HARNESS_BACKUP_RCLONE: join(root, "missing") } },
    );
    assert.notEqual(failed.status, 0);
    const after = JSON.parse(
      readFileSync(join(data, "backup-status.json"), "utf8"),
    );
    assert.equal(after.lastFile, file);
    assert.ok(after.error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
