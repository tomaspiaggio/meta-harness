import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(root, ".data/dev-login-fixture-"));
const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const base = `http://localhost:${port}`;
const require = createRequire(import.meta.url);
const { chromium } = require(
  require.resolve("patchright", { paths: [resolve(root, "packages/browser")] }),
);
const session = `dev-login-${port}`;
const run = promisify(execFile);
const cli = (...args) =>
  run("agent-browser", ["--session", session, ...args], {
    env: {
      ...process.env,
      AGENT_BROWSER_EXECUTABLE_PATH: chromium.executablePath(),
    },
    maxBuffer: 1024 * 1024,
  });
const evaluate = async (js) =>
  JSON.parse((await cli("eval", js)).stdout.trim());
let logs = "";
const child = spawn(process.execPath, ["scripts/dev.mjs"], {
  cwd: root,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    HARNESS_DATA_DIR: directory,
    HARNESS_AUTH: "google",
    HARNESS_PUBLIC_URL: base,
    GOOGLE_CLIENT_ID: "fixture-client",
    GOOGLE_CLIENT_SECRET: "fixture-secret",
    BETTER_AUTH_SECRET: "fixture-secret-longer-than-thirty-two-characters",
    HARNESS_OWNER_EMAILS: "owner@example.test",
    HARNESS_BIND_HOST: "127.0.0.1",
    HARNESS_BROWSER_ENABLED: "0",
    HARNESS_RUN_WORKER: "1",
    HARNESS_PROVIDERS: "demo",
    HARNESS_IDLE_POLL_MS: "1000",
    HARNESS_POLL_MS: "1000",
    PORT: String(port),
  },
});
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (bytes) => {
    logs = (logs + bytes).slice(-20000);
  });
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    const response = await fetch(`${base}/api/auth/status`).catch(() => null);
    if (response?.ok) {
      ready = true;
      break;
    }
    await delay(200);
  }
  assert(ready, "Development fixture failed to start");
  await cli("open", `${base}/login`);
  let enabled = false;
  for (let i = 0; i < 50; i++) {
    enabled = await evaluate(
      `Boolean([...document.querySelectorAll('button')].find(b=>b.textContent.includes('Continue with Google')&&!b.disabled))`,
    ).catch(() => false);
    if (enabled) break;
    await delay(100);
  }
  assert(enabled, "Login never hydrated into an enabled Google button");
  const marker = await evaluate(
    `(()=>{window.__loginProbe=crypto.randomUUID();window.__statusReads=0;const original=window.fetch;window.fetch=function(...args){if(String(args[0]).includes('/api/auth/status'))window.__statusReads++;return original.apply(this,args)};return window.__loginProbe})()`,
  );
  await delay(8000);
  assert.equal(
    await evaluate("window.__loginProbe"),
    marker,
    "Idle login reloaded while the worker was polling",
  );
  assert.equal(
    await evaluate("window.__statusReads"),
    0,
    "Idle login remounted and repeated authentication checks",
  );
  assert(
    (logs.match(/action=report.*200/g) ?? []).length >= 1,
    "Fixture must exercise enrolled-worker reports",
  );
  await cli("screenshot", `/tmp/${session}.png`);
  console.log(
    JSON.stringify({
      passed: true,
      idleReloads: 0,
      extraAuthChecks: 0,
      screenshot: `/tmp/${session}.png`,
    }),
  );
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await cli("close").catch(() => {});
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 5000);
  await exited;
  clearTimeout(timer);
}
