import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ControlStore } from "../packages/storage/src/control.ts";

// Explicitly opt-in: this test makes two small real Claude requests.
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "meta-claude-portability-"));
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  HARNESS_DATA_DIR: directory,
  PORT: String(port),
  HARNESS_BIND_HOST: "127.0.0.1",
  HARNESS_REQUIRE_AUTH: "0",
  WORKFLOW_TARGET_WORLD: "local",
  WORKFLOW_LOCAL_DATA_DIR: join(directory, "workflow"),
  WORKFLOW_LOCAL_BASE_URL: base,
  HARNESS_CLAUDE_RUNTIME: "sdk",
  HARNESS_PROVIDERS: "claude",
  HARNESS_CONCURRENCY: "1",
  HARNESS_TURN_TIMEOUT_MS: "45000",
  HARNESS_MEMORY_RESERVE_MIB: "0",
  HARNESS_MEMORY_BUDGET_MIB: "2048",
  HARNESS_MAX_LOAD_PER_CPU: "10000",
  HARNESS_CLAUDE_TOOLS: "none",
  HARNESS_CLAUDE_MODEL: process.env.HARNESS_CLAUDE_MODEL ?? "haiku",
  HARNESS_CLAUDE_MAX_BUDGET_USD: "0.1",
  NEXT_TELEMETRY_DISABLED: "1",
};
const store = new ControlStore(join(directory, "harness.sqlite"));
const mac = store.createWorker("Claude bench Mac");
const pi = store.createWorker("Claude bench Pi");
const children = [];
let logs = "";
function launch(cwd, args, extra = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...env, ...extra },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    logs = (logs + chunk).slice(-12000);
  });
  child.stderr.on("data", (chunk) => {
    logs = (logs + chunk).slice(-12000);
  });
  child.on("error", (error) => {
    logs += error.message;
  });
  children.push(child);
  return child;
}
async function until(fn, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await delay(200);
  }
  throw new Error(`Timed out: ${label}\n${logs}`);
}
async function request(path, body, method = "POST") {
  const response = await fetch(
    `${base}/api/${path}`,
    body
      ? {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data));
  return data;
}
async function terminal(sessionId) {
  const turn = await until(async () => {
    const state = await request(`state?workspace=tech&session=${sessionId}`);
    const current = state.turns.at(-1);
    return current &&
      ["completed", "failed", "interrupted"].includes(current.status)
      ? current
      : null;
  }, "Claude turn");
  if (turn.status !== "completed")
    throw new Error(`Claude compatibility blocked: ${turn.error}`);
  return turn;
}
try {
  for (const identity of [mac, pi])
    await writeFile(
      join(directory, `${identity.id}.json`),
      JSON.stringify({ ...identity, serverUrl: base }),
      { mode: 0o600 },
    );
  launch(join(root, "apps/web"), [
    require.resolve("next/dist/bin/next", { paths: [join(root, "apps/web")] }),
    "start",
    "--hostname",
    "127.0.0.1",
  ]);
  await until(() => request("state"), "control startup", 15000);
  const nonce = `ORBIT-${crypto.randomUUID().slice(0, 8)}`;
  const task = await request("tasks", {
    id: crypto.randomUUID(),
    workspaceId: "tech",
    title: "Disposable Claude portability test",
    objective: `Remember the token ${nonce}. Reply with exactly STORED. Do not use tools.`,
    provider: "claude",
    profile: "standard",
    priority: 0,
  });
  const source = join(directory, "mac-cache/sessions", task.sessionId);
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "portable.txt"), nonce);
  const worker = (identity, cache) =>
    launch(join(root, "apps/worker"), ["--import", "tsx", "src/index.ts"], {
      HARNESS_CONTROL_URL: base,
      HARNESS_WORKER_TOKEN_FILE: join(directory, `${identity.id}.json`),
      HARNESS_WORKER_DATA_DIR: join(directory, cache),
    });
  worker(mac, "mac-cache");
  const first = await terminal(task.sessionId);
  const nativeId = store.getSession(task.sessionId).nativeId;
  assert.ok(store.getCheckpoint(task.sessionId));
  await request(
    "tasks",
    { kind: "worker", id: mac.id, draining: true },
    "PATCH",
  );
  worker(pi, "pi-cache");
  await request("turns", {
    id: crypto.randomUUID(),
    sessionId: task.sessionId,
    prompt:
      "What token did I ask you to remember? Reply with that token only. Do not use tools.",
  });
  const second = await terminal(task.sessionId);
  assert.equal(first.workerId, mac.id);
  assert.equal(second.workerId, pi.id);
  assert.equal(store.getSession(task.sessionId).nativeId, nativeId);
  assert.ok(
    second.output.includes(nonce),
    "Native history did not preserve the remembered token.",
  );
  assert.equal(
    await readFile(
      join(directory, "pi-cache/sessions", task.sessionId, "portable.txt"),
      "utf8",
    ),
    nonce,
  );
  console.log(
    "Claude portability passed: same native session, new worker/cwd, remembered context, restored execution file.",
  );
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = new Promise((resolve) => child.once("exit", resolve));
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, 4000);
    await closed;
    clearTimeout(timer);
  }
  store.close();
  await rm(directory, { recursive: true, force: true });
}
