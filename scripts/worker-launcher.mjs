#!/usr/bin/env node
// Runs a worker from a release folder and lets it update itself.
//
// Layout of a release root (for example ~/Library/Application Support/meta-harness
// or ~/.local/share/meta-harness/worker):
//   repo.git/           bare clone of the repository; releases are its worktrees
//   releases/<commit>/  one installed release per commit
//   state.json          { current, previous?, pending?, lastFailure? }
//   launcher.mjs        a copy of this file; the service runs it
//
// The worker prepares a new release itself (see prepareRelease) and switches
// to it with switchRelease, then exits with RESTART. This launcher exits too,
// and systemd or launchd starts it again on the new release. If the new
// release exits with an error twice, or doesn't reach control within
// CONFIRM_MS, the launcher goes back to the previous release on its own.
//
// Self-contained on purpose: the service runs a copy outside any checkout.
// Install once:  node scripts/worker-launcher.mjs install <root> <commit>
import { execFile, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

/** Exit code a worker uses to ask for a restart into the current release. */
export const RESTART = 75;
/** A new release must reach control within this time, or it is rolled back. */
export const CONFIRM_MS = 5 * 60 * 1000;
const READY = ".harness-release-ready";
const run = promisify(execFile);

export function readState(root) {
  return JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
}
export function writeState(root, state) {
  const file = join(root, "state.json");
  writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(`${file}.tmp`, file);
}
/** The state after the worker process exits, rolling back a failed release. */
export function afterExit(state, { code, timedOut = false, now = Date.now() }) {
  const pending = state.pending;
  if (code === RESTART || !pending || pending.target !== state.current)
    return state;
  const failures = pending.failures + 1;
  if (failures < 2 && !timedOut)
    return { ...state, pending: { ...pending, failures } };
  return {
    current: pending.from,
    ...(state.previous && state.previous !== pending.from
      ? { previous: state.previous }
      : {}),
    lastFailure: {
      target: pending.target,
      at: now,
      reason: timedOut
        ? "the new release did not reach control within 5 minutes"
        : `the new release exited with code ${code} twice`,
    },
  };
}
/** Makes a prepared release current; the launcher confirms or rolls it back. */
export function switchRelease(root, name, now = Date.now()) {
  const state = readState(root);
  writeState(root, {
    current: name,
    previous: state.current,
    pending: { target: name, from: state.current, failures: 0, at: now },
  });
}
/**
 * Called by a worker once it has reached control: keeps the release, installs
 * its launcher for the next start, and removes releases older than the
 * previous one.
 */
export function confirmRelease(root, name) {
  const state = readState(root);
  if (state.pending?.target !== name) return false;
  const { pending, ...rest } = state;
  writeState(root, { ...rest, current: name, previous: pending.from });
  const source = join(root, "releases", name, "scripts", "worker-launcher.mjs");
  if (existsSync(source)) {
    copyFileSync(source, join(root, "launcher.mjs.tmp"));
    renameSync(join(root, "launcher.mjs.tmp"), join(root, "launcher.mjs"));
  }
  const keep = new Set([name, pending.from]);
  for (const entry of readdirSync(join(root, "releases")))
    if (!keep.has(entry))
      void run("git", [
        "-C",
        join(root, "repo.git"),
        "worktree",
        "remove",
        "--force",
        join(root, "releases", entry),
      ]).catch(() =>
        rmSync(join(root, "releases", entry), { recursive: true, force: true }),
      );
  return true;
}
/**
 * Installs the release for a commit on the remote's main branch and returns its
 * folder name. Idempotent: a finished release is reused, a half-installed one
 * is redone. Refuses commits that aren't on main.
 */
export async function prepareRelease(
  root,
  target,
  { install = ["pnpm", "install", "--frozen-lockfile"], branch = "main" } = {},
) {
  if (!/^[0-9a-f]{7,40}$/.test(target))
    throw new Error("Give a commit: 7 to 40 lowercase hex digits.");
  const repo = join(root, "repo.git");
  const git = (...args) =>
    run("git", ["-C", repo, ...args], { timeout: 300000 }).then((result) =>
      result.stdout.trim(),
    );
  await git("fetch", "--quiet", "origin", branch);
  const main = await git("rev-parse", "FETCH_HEAD");
  let commit;
  try {
    commit = await git("rev-parse", "--verify", `${target}^{commit}`);
  } catch {
    throw new Error(`Commit ${target} was not found on origin/${branch}.`);
  }
  try {
    await git("merge-base", "--is-ancestor", commit, main);
  } catch {
    throw new Error(
      `Commit ${target} is not on origin/${branch}; only merged commits are deployed.`,
    );
  }
  const name = commit.slice(0, 12);
  const folder = join(root, "releases", name);
  if (existsSync(join(folder, READY))) return name;
  mkdirSync(join(root, "releases"), { recursive: true });
  if (existsSync(folder)) {
    await git("worktree", "remove", "--force", folder).catch(() =>
      rmSync(folder, { recursive: true, force: true }),
    );
    await git("worktree", "prune");
  }
  await git("worktree", "add", "--detach", folder, commit);
  try {
    const [command, ...args] = install;
    await run(command, args, {
      cwd: folder,
      timeout: 15 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    await git("worktree", "remove", "--force", folder).catch(() => {});
    throw new Error(
      `Installing ${name} failed: ${String(error.stderr || error.message).slice(-800)}`,
    );
  }
  writeFileSync(join(folder, READY), `${new Date().toISOString()}\n`);
  return name;
}
/** One-time setup of a release root, from this checkout's origin. */
export async function installRoot(root, target, options = {}) {
  root = resolve(root);
  mkdirSync(join(root, "releases"), { recursive: true, mode: 0o700 });
  if (!existsSync(join(root, "repo.git"))) {
    const here = dirname(dirname(fileURLToPath(import.meta.url)));
    const origin =
      options.origin ??
      (
        await run("git", ["-C", here, "remote", "get-url", "origin"])
      ).stdout.trim();
    await run("git", [
      "clone",
      "--bare",
      "--quiet",
      origin,
      join(root, "repo.git"),
    ]);
  }
  const name = await prepareRelease(root, target, options);
  copyFileSync(
    join(root, "releases", name, "scripts", "worker-launcher.mjs"),
    join(root, "launcher.mjs"),
  );
  writeState(root, { current: name });
  return name;
}
/** Runs the current release's worker until it exits, then exits likewise. */
function launch(root) {
  let state = readState(root);
  const exists = (name) =>
    !!name && existsSync(join(root, "releases", name, READY));
  if (!exists(state.current)) {
    if (!exists(state.previous))
      throw new Error(`Release ${state.current} is missing in ${root}.`);
    console.error(
      `Release ${state.current} is missing; using ${state.previous}.`,
    );
    state = { current: state.previous };
    writeState(root, state);
  }
  const startedAt = Date.now();
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: join(root, "releases", state.current, "apps", "worker"),
    env: {
      ...process.env,
      HARNESS_RELEASE_ROOT: root,
      HARNESS_RELEASE: state.current,
    },
    stdio: "inherit",
  });
  let stopping = false;
  let timedOut = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      stopping = true;
      child.kill(signal);
    });
  // A new release that never reaches control is as broken as one that crashes.
  const watchdog = setInterval(() => {
    let current;
    try {
      current = readState(root);
    } catch {
      return;
    }
    if (current.pending?.target !== state.current) clearInterval(watchdog);
    else if (Date.now() - startedAt > CONFIRM_MS) {
      timedOut = true;
      clearInterval(watchdog);
      child.kill("SIGTERM");
    }
  }, 10000);
  child.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
  child.on("exit", (code) => {
    clearInterval(watchdog);
    if (stopping) process.exit(code ?? 0);
    const before = readState(root);
    const after = afterExit(before, { code, timedOut });
    if (after !== before) {
      writeState(root, after);
      if (after.lastFailure && after.current !== before.current)
        console.error(
          `Rolled back to ${after.current}: ${after.lastFailure.reason}.`,
        );
    }
    // Non-zero, so systemd's Restart=on-failure starts the launcher again.
    process.exit(code === RESTART ? RESTART : code || 1);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, root, commit] = process.argv.slice(2);
  if (command === "install") {
    if (!root || !commit) {
      console.error("Usage: worker-launcher.mjs install <root> <commit>");
      process.exit(2);
    }
    const name = await installRoot(root, commit);
    console.log(
      `Installed ${name} in ${resolve(root)}. Run the worker with: ${process.execPath} ${join(resolve(root), "launcher.mjs")}`,
    );
  } else launch(dirname(fileURLToPath(import.meta.url)));
}
