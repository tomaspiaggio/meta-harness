import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

// Exercise Next dev itself: a no-reload assertion misses static-path analysis
// repeatedly launching fresh Node processes for the polling worker endpoint.
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".data"), { recursive: true });
const directory = await mkdtemp(join(root, ".data/dev-idle-"));
const trace = join(directory, "static-paths.log");
const preload = join(directory, "trace.cjs");
await writeFile(trace, "");
await writeFile(
  preload,
  `const Module = require('node:module');
const fs = require('node:fs');
const original = Module._load;
Module._load = function(request, parent, isMain) {
  const value = original.apply(this, arguments);
  if (request.endsWith('/static-paths-worker.js')) return { ...value,
    loadStaticPaths: async (...args) => {
      fs.appendFileSync(${JSON.stringify(trace)}, args[0].pathname + '\\n');
      return value.loadStaticPaths(...args);
    }
  };
  return value;
};
`,
);
const probe = createServer();
await new Promise((done) => probe.listen(0, "127.0.0.1", done));
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const session = `harness-idle-${port}`;
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(root, ".data/browser-cache");
process.env.PLAYWRIGHT_SKIP_BROWSER_GC = "1";
const require = createRequire(import.meta.url);
const loaded = await import(
  pathToFileURL(
    require.resolve("patchright", { paths: [join(root, "packages/browser")] }),
  ).href
);
const { chromium } = loaded.default ?? loaded;
const browserEnv = {
  ...process.env,
  AGENT_BROWSER_EXECUTABLE_PATH:
    process.env.AGENT_BROWSER_EXECUTABLE_PATH ?? chromium.executablePath(),
};
const run = promisify(execFile);
const browser = (...args) =>
  run("agent-browser", ["--session", session, ...args], { env: browserEnv });
let logs = "";
const child = spawn(process.execPath, ["scripts/dev.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
    DATABASE_URL: "",
    DIRECT_URL: "",
    HARNESS_HOSTED: "0",
    HARNESS_SANDBOX_ENABLED: "0",
    TELEGRAM_BOT_TOKEN: "",
    HARNESS_TITLE_API_KEY: "",
    HARNESS_DATA_DIR: directory,
    HARNESS_PROVIDERS: "demo",
    HARNESS_BROWSER_ENABLED: "0",
    HARNESS_RUN_WORKER: "1",
    HARNESS_BIND_HOST: "127.0.0.1",
    HARNESS_REQUIRE_AUTH: "0",
    HARNESS_IDLE_POLL_MS: "1000",
    HARNESS_POLL_MS: "1000",
    HARNESS_DEMO_DELAY_MS: "100",
    WORKFLOW_TARGET_WORLD: "local",
    PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
child.stdout.on("data", (chunk) => {
  logs = (logs + chunk).slice(-15000);
});
child.stderr.on("data", (chunk) => {
  logs = (logs + chunk).slice(-15000);
});
let opened = false;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/workers`);
      if (r.ok && (await r.json()).some((w) => w.report)) {
        ready = true;
        break;
      }
    } catch {}
    await delay(200);
  }
  assert.ok(ready, logs);
  await browser("open", base);
  opened = true;
  await browser(
    "fill",
    '[aria-label="Your instruction"]',
    "Keep this draft while the worker polls",
  );
  await delay(1500);
  await writeFile(trace, "");
  const post = async (path, body) => {
    const response = await fetch(`${base}/api/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  };
  const conversation = await post("sessions", {
    workspaceId: "business",
    title: "Development checkpoint regression",
    provider: "demo",
  });
  const turn = await post("turns", {
    id: crypto.randomUUID(),
    sessionId: conversation.id,
    prompt: "Exercise runtime writes without source changes",
  });
  await delay(7000);
  const state = await fetch(
    `${base}/api/state?workspace=business&session=${conversation.id}`,
  ).then((response) => response.json());
  assert.equal(
    state.turns.find((item) => item.id === turn.id)?.status,
    "completed",
    logs,
  );
  assert.ok(
    (logs.match(/action=claim.*200/g) ?? []).length >= 3,
    "The fixture must exercise repeated successful worker polls",
  );
  const analyses = (await readFile(trace, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(
    analyses.filter((path) => path.startsWith("/api/worker")),
    [],
    "Idle worker polling must not launch Next static-path analysis processes",
  );
  const { stdout } = await browser(
    "get",
    "value",
    '[aria-label="Your instruction"]',
  );
  assert.equal(stdout.trim(), "Keep this draft while the worker polls");
  console.log(
    "Dev idle gate passed: repeated worker polls and a completed checkpointed turn launched no worker static-path analysis processes; headless agent-browser retained the draft.",
  );
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  if (opened) await browser("close").catch(() => {});
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((done) => child.once("exit", done)),
    delay(6000, undefined, { ref: false }),
  ]);
  if (child.exitCode === null && child.signalCode === null)
    process.kill(-child.pid, "SIGKILL");
  await rm(directory, { recursive: true, force: true });
}
