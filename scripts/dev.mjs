import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway } from "./gateway.mjs";

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
  HARNESS_BROWSER_STREAM_URL: `http://127.0.0.1:${process.env.PORT ?? 3000}`,
};
const bindHost = process.env.HARNESS_BIND_HOST ?? "0.0.0.0";
const network = !["127.0.0.1", "localhost", "::1"].includes(bindHost);
// Keep Workflow callbacks private behind a loopback HTTPS proxy as well.
const gatewayEnabled = true; // Live browser WebSockets terminate in this existing launcher.
let privatePort = Number(process.env.PORT ?? 3000);
let gateway;
if (gatewayEnabled) {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  privatePort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  gateway = createGateway(privatePort, { development: !production });
  await new Promise((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(Number(process.env.PORT ?? 3000), bindHost, resolve);
  });
}
if (network || process.env.HARNESS_REQUIRE_AUTH === "1") {
  try {
    writeFileSync(
      join(directory, "admin-token"),
      randomBytes(32).toString("base64url"),
      { mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
const children = [];
let stopping = false;
let exitCode = 0;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  process.exitCode = code;
  gateway?.close();
  gateway?.closeAllConnections();
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
      "--port",
      String(privatePort),
    ],
  ],
  ["worker", join(root, "apps/worker"), ["--import", "tsx", "src/index.ts"]],
]) {
  if (
    name === "worker" &&
    (process.env.HARNESS_RUN_WORKER === "0" ||
      process.argv.includes("--control-only"))
  )
    continue;
  const child = spawn(process.execPath, args, {
    cwd,
    env: {
      ...env,
      PORT: String(privatePort),
      ...(gatewayEnabled
        ? { WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${privatePort}` }
        : {}),
    },
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
  `Data: ${directory}\nUI: http://${network ? bindHost : "127.0.0.1"}:${env.PORT ?? 3000}${network ? " (use HTTPS through your private proxy)" : ""}`,
);
