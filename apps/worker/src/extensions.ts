import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type ExtensionRunResult,
  MAX_RUN_LOGS,
} from "@harness/core/extensions";
import type { ExtensionAssignment } from "@harness/storage/extensions";
import type { WorkerClient } from "./client";

/** Deno runs extension scripts with only the hosts their manifest names. */
export function denoBinary(): string | null {
  const candidates = [
    process.env.HARNESS_DENO,
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, "deno")),
    join(homedir(), ".deno", "bin", "deno"),
    "/opt/homebrew/bin/deno",
    "/usr/local/bin/deno",
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; try the next place.
    }
  }
  return null;
}

const MARKER = "\u0000harness-result\u0000";
/**
 * Loads the extension, gives it its context, and prints one result line.
 * Console output becomes the run's log, so stdout carries only the result.
 */
const RUNNER = `import run from "./extension.ts";
const MARKER = ${JSON.stringify(MARKER)};
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const logs = [];
let size = 0;
const log = (...args) => {
  const line = args.map((item) => typeof item === "string" ? item : Deno.inspect(item, { depth: 4 })).join(" ");
  size += line.length + 1;
  logs.push(line);
  while (size > ${MAX_RUN_LOGS} && logs.length > 1) size -= logs.shift().length + 1;
};
for (const name of ["log", "info", "warn", "error", "debug"]) console[name] = log;
const events = [];
const current = new Map(Object.entries(input.state));
const set = {};
const deleted = new Set();
const context = {
  trigger: input.trigger,
  request: input.request,
  config: input.config,
  signal: AbortSignal.timeout(input.timeoutMs),
  emit(event) {
    for (const item of Array.isArray(event) ? event : [event]) events.push(item);
  },
  state: {
    get: (key) => (current.has(key) ? structuredClone(current.get(key)) : undefined),
    set(key, value) {
      const copy = JSON.parse(JSON.stringify(value ?? null));
      current.set(key, copy);
      set[key] = copy;
      deleted.delete(key);
    },
    delete(key) {
      current.delete(key);
      delete set[key];
      deleted.add(key);
    },
  },
  log,
};
let error = null;
try {
  if (typeof run !== "function") throw new Error("The extension must export a default function.");
  await run(context);
} catch (caught) {
  error = caught instanceof Error ? (caught.stack ?? caught.message) : String(caught);
}
const result = JSON.stringify({ events, state: { set, delete: [...deleted] }, logs: logs.join("\\n"), error });
await Deno.stdout.write(new TextEncoder().encode(MARKER + result + "\\n"));
`;

/** Runs one script in a fresh folder; never throws, failures are results. */
export async function runExtension(
  deno: string,
  cache: string,
  assignment: ExtensionAssignment,
  config: Record<string, string | number | boolean>,
  signal: AbortSignal,
): Promise<ExtensionRunResult> {
  const { manifest, run } = assignment;
  const folder = join(cache, "extensions", "runs", run.id);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, "extension.ts"), assignment.code, { mode: 0o600 });
  writeFileSync(join(folder, "runner.ts"), RUNNER, { mode: 0o600 });
  const timeoutMs = manifest.timeoutSeconds * 1000;
  const args = [
    "run",
    "--quiet",
    "--no-prompt",
    "--no-config",
    "--no-lock",
    "--v8-flags=--max-old-space-size=256",
    // No --allow-net at all denies the network; an empty list would allow it.
    ...(manifest.permissions.net.length
      ? [`--allow-net=${manifest.permissions.net.join(",")}`]
      : []),
    join(folder, "runner.ts"),
  ];
  const failed = (error: string, logs = ""): ExtensionRunResult => ({
    events: [],
    state: { set: {}, delete: [] },
    logs,
    error,
  });
  try {
    return await new Promise<ExtensionRunResult>((resolve) => {
      const child = spawn(deno, args, {
        cwd: folder,
        // Nothing from the worker's environment reaches the script.
        env: {
          DENO_DIR: join(cache, "extensions", "deno"),
          DENO_NO_UPDATE_CHECK: "1",
          NO_COLOR: "1",
          PATH: process.env.PATH ?? "",
          HOME: folder,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const limit = 4 * 1024 * 1024;
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < limit) stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-MAX_RUN_LOGS);
      });
      const kill = () => child.kill("SIGKILL");
      const timer = setTimeout(kill, timeoutMs + 5000);
      signal.addEventListener("abort", kill, { once: true });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve(failed(`Could not start Deno: ${error.message}`));
      });
      child.on("close", (code, killed) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", kill);
        const at = stdout.lastIndexOf(MARKER);
        if (at >= 0)
          try {
            const result = JSON.parse(
              stdout.slice(at + MARKER.length).trim(),
            ) as ExtensionRunResult;
            resolve({
              ...result,
              logs: [result.logs, stderr.trim()].filter(Boolean).join("\n"),
            });
            return;
          } catch {
            // Fall through to a failed result below.
          }
        resolve(
          failed(
            killed === "SIGKILL"
              ? signal.aborted
                ? "The worker stopped while the script ran."
                : `The script ran past its ${manifest.timeoutSeconds}s limit.`
              : `The script exited with code ${code} before finishing.`,
            stderr.trim(),
          ),
        );
      });
      child.stdin.end(
        JSON.stringify({
          trigger: {
            name: run.trigger,
            type:
              manifest.triggers.find((item) => item.name === run.trigger)
                ?.type ?? "manual",
          },
          request: assignment.request,
          config,
          state: assignment.state,
          timeoutMs,
        }),
      );
    });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * Takes extension runs one at a time beside the agent lanes. A script is small
 * and short, so one lane is enough; `busy` lets an update wait for it.
 */
export async function extensionLane(input: {
  client: WorkerClient;
  deno: string;
  cache: string;
  signal: AbortSignal;
  paused: () => boolean;
  busy: (delta: 1 | -1) => void;
  pollMs: number;
  idlePollMs: number;
}): Promise<void> {
  let idle = input.pollMs;
  while (!input.signal.aborted) {
    if (!input.paused())
      try {
        input.busy(1);
        try {
          const claimed = await input.client.post<{
            assignment: ExtensionAssignment;
            config: Record<string, string | number | boolean>;
          } | null>("extension-claim", { requestId: crypto.randomUUID() });
          if (claimed) {
            idle = input.pollMs;
            const result = await runExtension(
              input.deno,
              input.cache,
              claimed.assignment,
              claimed.config,
              input.signal,
            );
            await input.client.post("extension-complete", {
              runId: claimed.assignment.run.id,
              result,
            });
            console.log(
              `Extension ${claimed.assignment.run.extensionId} (${claimed.assignment.run.trigger}): ${result.error ? "failed" : `${result.events.length} event(s)`}`,
            );
            continue;
          }
        } finally {
          input.busy(-1);
        }
      } catch (error) {
        console.error(
          `Extension lane: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    await delay(idle, undefined, { signal: input.signal }).catch(() => {});
    idle = Math.min(input.idlePollMs, idle * 2);
  }
}
