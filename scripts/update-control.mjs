#!/usr/bin/env node
// Updates the control server to a commit on main, from outside the server.
//
// Control starts this as a transient systemd unit (POST /api/version or the
// control_update tool), so restarting the server doesn't stop it. It runs from
// the current release, which is a git worktree:
//
//   node <release>/scripts/update-control.mjs --commit <sha> --url http://127.0.0.1:3000
//
// 1. Fetch origin/main and refuse commits that aren't on it.
// 2. If another machine can run agents, pause this host's worker and wait for
//    its turns: building beside running turns once stalled the server.
// 3. Install and build releases/<commit> at low priority.
// 4. Back up the database, point the user units at the new release, restart
//    the server and check /api/version. If it doesn't come back on the new
//    build within 3 minutes, restore the units and restart the old release.
// 5. Unpause the worker, whatever happened.
//
// Progress goes to <HARNESS_DATA_DIR>/control-update.json; one update runs at
// a time (control-update.lock). Settings: HARNESS_DATA_DIR (required),
// HARNESS_UPDATE_UNITS (default meta-harness-control.service,
// meta-harness-backup.service; the first is the server), and
// HARNESS_DEPLOYMENTS_DIR (default <data dir>/../deployments).
import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const READY = ".harness-control-ready";
export const sameCommit = (a, b) =>
  !!a &&
  !!b &&
  a.length >= 7 &&
  b.length >= 7 &&
  (a.startsWith(b) || b.startsWith(a));

/** Replaces one release path with another in a unit file's text. */
export function retarget(text, from, to) {
  const pattern = new RegExp(
    `${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[/\\s"']|$)`,
    "gm",
  );
  return text.replace(pattern, to);
}

async function main() {
  const option = (name) => {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const target = option("commit") ?? "";
  const base = option("url") ?? "http://127.0.0.1:3000";
  const dataDir = process.env.HARNESS_DATA_DIR;
  if (!/^[0-9a-f]{7,40}$/.test(target)) throw new Error("Use --commit <sha>.");
  if (!dataDir) throw new Error("Set HARNESS_DATA_DIR.");
  const current = resolve(
    option("release") ?? dirname(dirname(fileURLToPath(import.meta.url))),
  );
  const releases = dirname(current);
  const statusFile = join(dataDir, "control-update.json");
  const lockFile = join(dataDir, "control-update.lock");
  const units = (
    process.env.HARNESS_UPDATE_UNITS ??
    "meta-harness-control.service,meta-harness-backup.service"
  )
    .split(",")
    .map((unit) => unit.trim())
    .filter(Boolean);
  const unitDir = join(homedir(), ".config", "systemd", "user");
  const deployments = resolve(
    process.env.HARNESS_DEPLOYMENTS_DIR ?? join(dataDir, "..", "deployments"),
  );
  const started = Date.now();
  let state = {};
  try {
    state = JSON.parse(readFileSync(statusFile, "utf8"));
  } catch {}
  const status = (phase, extra = {}) => {
    // Each phase replaces the previous phase's message.
    const { message: _previous, ...kept } = state;
    state = {
      ...kept,
      target,
      from: basename(current),
      status: phase,
      startedAt: started,
      updatedAt: Date.now(),
      ...extra,
    };
    writeFileSync(`${statusFile}.tmp`, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(`${statusFile}.tmp`, statusFile);
    console.log(
      `[update-control] ${phase}${extra.message ? `: ${extra.message}` : ""}`,
    );
  };
  try {
    writeFileSync(lockFile, String(process.pid), { flag: "wx" });
  } catch {
    const pid = Number(readFileSync(lockFile, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (alive) throw new Error(`Another update (pid ${pid}) is running.`);
    writeFileSync(lockFile, String(process.pid));
  }
  const version = async () => {
    try {
      const response = await fetch(`${base}/api/version`, {
        signal: AbortSignal.timeout(5000),
      });
      return (await response.json()).build;
    } catch {
      return undefined;
    }
  };
  const waitFor = async (build, ms) => {
    for (const until = Date.now() + ms; Date.now() < until; ) {
      if (sameCommit(await version(), build)) return true;
      await delay(3000);
    }
    return false;
  };
  const db = new DatabaseSync(join(dataDir, "harness.sqlite"));
  db.exec("PRAGMA busy_timeout = 10000");
  let paused = null;
  try {
    status("preparing");
    const before = await version();
    const git = (...args) =>
      run("git", ["-C", current, ...args], { timeout: 300000 }).then((result) =>
        result.stdout.trim(),
      );
    await git("fetch", "--quiet", "origin", "main");
    const main = await git("rev-parse", "FETCH_HEAD");
    let commit;
    try {
      commit = await git("rev-parse", "--verify", `${target}^{commit}`);
    } catch {
      throw new Error(`Commit ${target} was not found on origin/main.`);
    }
    try {
      await git("merge-base", "--is-ancestor", commit, main);
    } catch {
      throw new Error(`Commit ${target} is not on origin/main.`);
    }
    if (sameCommit(before, commit)) {
      status("done", {
        message: `Already running ${before}.`,
        finishedAt: Date.now(),
      });
      return;
    }
    const name = commit.slice(0, 7);
    const release = join(releases, name);

    // Pause this host's worker only while another machine can run agents.
    const workers = db
      .prepare(
        "SELECT id, report, seenAt, draining FROM workers WHERE tokenHash != ''",
      )
      .all()
      .map((row) => ({
        ...row,
        report: row.report ? JSON.parse(row.report) : null,
      }));
    const live = (worker) =>
      !worker.draining &&
      !worker.report?.draining &&
      Number(worker.seenAt) > Date.now() - 30000 &&
      worker.report?.providers?.some((provider) => provider !== "demo");
    const local = workers.find(
      (worker) => !worker.draining && worker.report?.hostname === hostname(),
    );
    if (
      local &&
      workers.some((worker) => worker.id !== local.id && live(worker))
    ) {
      db.prepare("UPDATE workers SET draining = 1 WHERE id = ?").run(local.id);
      paused = local.id;
      status("waiting", {
        message: "Waiting for this host's running turns before building.",
      });
      for (const until = Date.now() + 4 * 3600 * 1000; ; ) {
        const { n } = db
          .prepare(
            "SELECT count(*) AS n FROM turns WHERE workerId = ? AND status IN ('running', 'stopping')",
          )
          .get(local.id);
        if (!n) break;
        if (Date.now() > until)
          throw new Error("This host's turns didn't finish within 4 hours.");
        await delay(15000);
      }
    }

    status("building", { release: name });
    if (!existsSync(join(release, READY))) {
      if (existsSync(release)) {
        await git("worktree", "remove", "--force", release).catch(() =>
          rmSync(release, { recursive: true, force: true }),
        );
        await git("worktree", "prune");
      }
      await git("worktree", "add", "--detach", release, commit);
      const low =
        platform() === "linux"
          ? ["nice", "-n", "15", "ionice", "-c", "3"]
          : ["nice", "-n", "15"];
      for (const step of [
        ["pnpm", "install", "--frozen-lockfile"],
        // Turborepo shares its cache across worktrees: a release whose web
        // inputs didn't change would reuse the previous build, commit included.
        ["pnpm", "build", "--force"],
      ])
        try {
          await run(low[0], [...low.slice(1), ...step], {
            cwd: release,
            timeout: 45 * 60 * 1000,
            maxBuffer: 64 * 1024 * 1024,
          });
        } catch (error) {
          throw new Error(
            `${step.join(" ")} failed: ${String(error.stderr || error.stdout || error.message).slice(-1500)}`,
          );
        }
      writeFileSync(join(release, READY), `${new Date().toISOString()}\n`);
    }

    status("switching");
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\..*/, "")
      .replace("T", "-");
    const backup = join(deployments, `${stamp}-${name}`);
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    db.exec(
      `VACUUM INTO '${join(backup, "harness.sqlite").replaceAll("'", "''")}'`,
    );
    const changed = [];
    for (const unit of units) {
      const file = join(unitDir, unit);
      if (!existsSync(file)) continue;
      const text = readFileSync(file, "utf8");
      const next = retarget(text, current, release);
      if (next === text) continue;
      copyFileSync(file, join(backup, unit));
      writeFileSync(file, next);
      changed.push(unit);
    }
    if (!changed.includes(units[0]))
      throw new Error(
        `${units[0]} doesn't run from ${current}; nothing was switched.`,
      );
    const systemctl = (...args) =>
      run("systemctl", ["--user", ...args], { timeout: 120000 });
    await systemctl("daemon-reload");
    status("restarting", { backup });
    await systemctl("restart", units[0]);
    if (!(await waitFor(name, 180000))) {
      for (const unit of changed)
        copyFileSync(join(backup, unit), join(unitDir, unit));
      await systemctl("daemon-reload");
      await systemctl("restart", units[0]);
      const back = await waitFor(before, 180000);
      status(back ? "rolled-back" : "failed", {
        message: back
          ? `The new server didn't come up on ${name} within 3 minutes; restored ${before}.`
          : `Neither ${name} nor ${before} came up. Check journalctl --user -u ${units[0]}.`,
        finishedAt: Date.now(),
      });
      process.exitCode = 1;
      return;
    }
    const journal = join(dataDir, "..", "current-deployment.json");
    if (existsSync(journal)) {
      const record = JSON.parse(readFileSync(journal, "utf8"));
      Object.assign(record, {
        release: name,
        releasePath: release,
        unitBackups: backup,
        updatedAt: new Date().toISOString(),
      });
      writeFileSync(journal, `${JSON.stringify(record, null, 2)}\n`);
    }
    status("done", { message: `Running ${name}.`, finishedAt: Date.now() });
  } catch (error) {
    status("failed", {
      message: String(error.message ?? error).slice(0, 2000),
      finishedAt: Date.now(),
    });
    process.exitCode = 1;
  } finally {
    if (paused)
      db.prepare("UPDATE workers SET draining = 0 WHERE id = ?").run(paused);
    db.close();
    rmSync(lockFile, { force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
