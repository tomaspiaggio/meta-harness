import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HarnessError } from "@harness/core";
import { COMMIT, sameCommit } from "@harness/core/scheduling";
import { dataDirectory } from "@harness/storage";

export interface ControlUpdate {
  target: string;
  from?: string;
  status: string;
  requestedBy?: string;
  message?: string;
  release?: string;
  startedAt?: number;
  updatedAt?: number;
  finishedAt?: number;
}
const statusFile = () => join(dataDirectory(), "control-update.json");
/** The last control update, as scripts/update-control.mjs records it. */
export function controlUpdateStatus(): ControlUpdate | null {
  try {
    return JSON.parse(readFileSync(statusFile(), "utf8"));
  } catch {
    return null;
  }
}
const running = (update: ControlUpdate | null) =>
  !!update && !["done", "failed", "rolled-back"].includes(update.status);
/** The release folder this server runs from: it holds the update script. */
function releaseRoot(): string {
  for (let folder = process.cwd(); ; folder = dirname(folder)) {
    if (existsSync(join(folder, "scripts", "update-control.mjs")))
      return folder;
    if (dirname(folder) === folder)
      throw new HarnessError("This server can't find its release folder.", 500);
  }
}
function hasSystemd(): boolean {
  try {
    execFileSync("systemd-run", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
/**
 * Starts updating this server to a commit on main. The work runs in its own
 * systemd unit, so the restart it performs doesn't cut it off.
 */
export function startControlUpdate(
  target: unknown,
  requestedBy: string,
): ControlUpdate {
  const commit = typeof target === "string" ? target.trim() : "";
  if (!COMMIT.test(commit))
    throw new HarnessError("Give a commit: 7 to 40 lowercase hex digits.");
  if (sameCommit(process.env.HARNESS_BUILD, commit))
    throw new HarnessError(`The server already runs ${commit}.`, 409);
  const previous = controlUpdateStatus();
  if (
    running(previous) &&
    Date.now() - (previous?.updatedAt ?? 0) < 60 * 60 * 1000
  )
    throw new HarnessError(
      `An update to ${previous?.target} is already ${previous?.status}.`,
      409,
    );
  if (!hasSystemd() && process.env.HARNESS_CONTROL_UPDATE !== "detached")
    throw new HarnessError(
      "Server updates need systemd (user units) on the control host.",
      501,
    );
  const root = releaseRoot();
  const update: ControlUpdate = {
    target: commit,
    status: "requested",
    requestedBy: requestedBy.slice(0, 200),
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  writeFileSync(statusFile(), `${JSON.stringify(update, null, 2)}\n`, {
    mode: 0o600,
  });
  // The launcher's public port, not this Next process's private one.
  const url = process.env.HARNESS_BROWSER_STREAM_URL ?? "http://127.0.0.1:3000";
  const script = join(root, "scripts", "update-control.mjs");
  const env: Record<string, string> = {
    HARNESS_DATA_DIR: dataDirectory(),
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
    ...(process.env.HARNESS_UPDATE_UNITS
      ? { HARNESS_UPDATE_UNITS: process.env.HARNESS_UPDATE_UNITS }
      : {}),
  };
  const args = [script, "--commit", commit, "--url", url];
  const child =
    process.env.HARNESS_CONTROL_UPDATE === "detached"
      ? spawn(process.execPath, args, {
          cwd: root,
          env: env as NodeJS.ProcessEnv,
          detached: true,
          stdio: "ignore",
        })
      : spawn(
          "systemd-run",
          [
            "--user",
            "--collect",
            `--unit=meta-harness-update-${Date.now()}`,
            "--property=Nice=10",
            `--working-directory=${root}`,
            ...Object.entries(env).map(
              ([key, value]) => `--setenv=${key}=${value}`,
            ),
            process.execPath,
            ...args,
          ],
          { stdio: "ignore", detached: true },
        );
  child.unref();
  return update;
}
