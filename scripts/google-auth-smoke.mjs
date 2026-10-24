import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { HarnessStore } from "../packages/storage/src/application.ts";

const base = process.env.HARNESS_URL,
  directory = process.env.HARNESS_SMOKE_DATA_DIR;
assert.ok(
  base &&
    ["127.0.0.1", "localhost"].includes(new URL(base).hostname) &&
    new URL(base).port !== "3000",
  "Use an isolated Google-auth fixture",
);
assert.ok(directory && basename(directory).includes("fixture"));
const headers = { "Content-Type": "application/json", origin: base };
const token = (await readFile(join(directory, "admin-token"), "utf8")).trim();
const status = await fetch(`${base}/api/auth/status`).then((r) => r.json());
assert.equal(status.mode, "google");
for (const extra of [{}, { authorization: `Bearer ${token}` }]) {
  const response = await fetch(`${base}/api/workers`, { headers: extra });
  assert.equal(response.status, 401);
}
assert.equal(
  (
    await fetch(`${base}/api/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({ token }),
    })
  ).status,
  403,
);
for (const path of [
  "/.well-known/workflow/v1/flow",
  "/api/auth/sign-up/email",
  "/api/auth/callback/github",
])
  assert.equal((await fetch(base + path)).status, 404);
const start = await fetch(`${base}/api/auth/sign-in/social`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    provider: "google",
    callbackURL: "/",
    errorCallbackURL: "/login",
  }),
});
assert.equal(start.status, 200);
assert.match(start.headers.get("cache-control"), /no-store/);
const url = new URL((await start.json()).url);
assert.equal(url.origin, "https://accounts.google.com");
assert.equal(
  url.searchParams.get("redirect_uri"),
  `${base}/api/auth/callback/google`,
);
assert.ok(url.searchParams.get("code_challenge"));
assert.equal(
  (
    await fetch(`${base}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { ...headers, origin: "https://attacker.invalid" },
      body: JSON.stringify({ provider: "google" }),
    })
  ).status,
  403,
);
const store = new HarnessStore(join(directory, "harness.sqlite"));
await store.ready;
const worker = await store.createWorker("Google auth fixture worker");
try {
  const response = await fetch(`${base}/api/worker?action=report`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-worker-id": worker.id,
      authorization: `Bearer ${worker.token}`,
    },
    body: JSON.stringify({
      report: {
        hostname: "google-fixture",
        providers: ["demo"],
        labels: [],
        maxAgents: 1,
        memoryBudgetMiB: 4096,
        cpuSlots: 2,
        maxBuilds: 1,
        maxBrowsers: 0,
        availableMemoryMiB: 8192,
        reserveMemoryMiB: 512,
        loadPerCpu: 0,
        maxLoadPerCpu: 2,
        draining: false,
      },
    }),
  });
  assert.equal(
    response.status,
    200,
    "Worker auth remains independent from Google owner auth",
  );
} finally {
  await store.revokeWorker(worker.id);
  await store.close();
}
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".data/browser-cache");
const require = createRequire(import.meta.url);
const { chromium } = require(
  require.resolve("patchright", { paths: [resolve("packages/browser")] }),
);
const run = promisify(execFile),
  session = `google-login-${crypto.randomUUID().slice(0, 8)}`;
const cli = (...args) =>
  run("agent-browser", ["--session", session, ...args], {
    env: {
      ...process.env,
      AGENT_BROWSER_EXECUTABLE_PATH: chromium.executablePath(),
    },
  });
try {
  await cli("open", `${base}/login`);
  await cli("wait", 'button:has-text("Continue with Google")');
  const { stdout } = await cli(
    "eval",
    'Boolean(document.querySelector("input[aria-label=\\"Access token\\"]"))',
  );
  assert.equal(stdout.trim(), "false");
} finally {
  await cli("close").catch(() => {});
}
console.log(
  "Google HTTP/UI smoke passed: Google-only login, PKCE/callback URL, no token bypass, scoped worker auth, origin checks and private Workflow gateway. No live Google account used.",
);
