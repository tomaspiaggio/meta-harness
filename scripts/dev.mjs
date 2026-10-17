import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
process.chdir(root);
if (existsSync(".env")) process.loadEnvFile(".env");
const directory = resolve(process.env.HARNESS_DATA_DIR ?? join(root, ".data"));
mkdirSync(directory, { recursive: true, mode: 0o700 });
const production = process.argv.includes("--production");
const env = {
  ...process.env,
  HARNESS_DATA_DIR: directory,
  // Set explicitly: withWorkflow otherwise replaces the data directory with .next/.
  WORKFLOW_TARGET_WORLD: process.env.WORKFLOW_TARGET_WORLD ?? "local",
  WORKFLOW_LOCAL_DATA_DIR: join(directory, "workflow"),
  NEXT_TELEMETRY_DISABLED: "1",
};
const children = [];
let stopping = false;
let exitCode = 0;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* Already exited. */
    }
  }
  const timer = setTimeout(() => {
    for (const child of children) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }
  }, 5000);
  timer.unref();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop());
for (const [name, cwd, args] of [
  [
    "web",
    join(root, "apps/web"),
    [
      require.resolve("next/dist/bin/next", {
        paths: [join(root, "apps/web")],
      }),
      production ? "start" : "dev",
      "--hostname",
      "127.0.0.1",
    ],
  ],
  ["worker", join(root, "apps/worker"), ["--import", "tsx", "src/index.ts"]],
]) {
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: "inherit",
    detached: true,
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(`${name}: ${error.message}`);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) {
      console.error(`${name} exited (${code}). Stopping local services.`);
      stop(code || 1);
    }
    if (children.every((p) => p.exitCode !== null || p.signalCode !== null))
      process.exitCode = exitCode;
  });
}
console.log(
  `Data: ${directory}\nLocal UI: http://127.0.0.1:${env.PORT ?? 3000}`,
);
