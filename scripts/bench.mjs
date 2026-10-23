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

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "meta-distributed-bench-"));
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
  NEXT_TELEMETRY_DISABLED: "1",
};
const store = new ControlStore(join(directory, "harness.sqlite"));
const mac = await store.createWorker("Bench Mac");
const pi = await store.createWorker("Bench Pi");
const identities = new Map([
  [mac.id, mac],
  [pi.id, pi],
]);
for (const identity of identities.values())
  await writeFile(
    join(directory, `${identity.id}.json`),
    JSON.stringify({ ...identity, serverUrl: base }),
    { mode: 0o600 },
  );
const children = [];
let logs = "";
function launch(cwd, args, overrides = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...env, ...overrides },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    logs = (logs + chunk).slice(-18000);
  });
  child.stderr.on("data", (chunk) => {
    logs = (logs + chunk).slice(-18000);
  });
  child.on("error", (error) => {
    logs += error.message;
  });
  children.push(child);
  return child;
}
function worker(identity) {
  return launch(
    join(root, "apps/worker"),
    ["--import", "tsx", "src/index.ts"],
    {
      HARNESS_CONTROL_URL: base,
      HARNESS_WORKER_TOKEN_FILE: join(directory, `${identity.id}.json`),
      HARNESS_WORKER_DATA_DIR: join(directory, `cache-${identity.id}`),
      HARNESS_PROVIDERS: "demo",
      HARNESS_CONCURRENCY: "1",
      HARNESS_MEMORY_BUDGET_MIB: "128",
      HARNESS_MEMORY_RESERVE_MIB: "0",
      HARNESS_MAX_LOAD_PER_CPU: "10000",
      HARNESS_DEMO_DELAY_MS: "1200",
      HARNESS_POLL_MS: "100",
    },
  );
}
async function stop(child, signal = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once("exit", resolve));
  process.kill(-child.pid, signal);
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 4000);
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}
async function until(fn, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error(
    `Timed out: ${label}${lastError ? ` (${lastError.message})` : ""}\n${logs}`,
  );
}
async function request(path, body, method = "POST", headers = {}) {
  const response = await fetch(`${base}/api/${path}`, {
    method: body ? method : "GET",
    headers: { "content-type": "application/json", ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(result)}`);
  return result;
}
const taskInput = (title, profile = "standard", priority = 0) => ({
  id: crypto.randomUUID(),
  workspaceId: "tech",
  title,
  objective: `Disposable bench: ${title}`,
  provider: "demo",
  profile,
  priority,
});
const results = [];
try {
  launch(join(root, "apps/web"), [
    require.resolve("next/dist/bin/next", { paths: [join(root, "apps/web")] }),
    "start",
    "--hostname",
    "127.0.0.1",
  ]);
  await until(async () => await request("state"), "control startup");
  let macProcess = worker(mac);
  await until(
    async () =>
      (await store.listWorkers()).find((item) => item.id === mac.id)?.report,
    "Mac registration",
  );
  const heavy = await request(
    "tasks",
    taskInput("Heavy task waits", "build", 10),
  );
  const moving = await request(
    "tasks",
    taskInput("Checkpointed investigation"),
  );
  const first = await until(async () => {
    const checkpoint = await store.getCheckpoint(moving.sessionId);
    const turn = (await store.listTurns(moving.sessionId))[0];
    return checkpoint && turn.status === "running" ? turn : null;
  }, "first durable checkpoint");
  assert.equal(first.workerId, mac.id);
  assert.match(
    (await store.listTasks()).find((item) => item.id === heavy.id)
      .waitingReason,
    /reservations|slots/,
  );
  console.log(
    "PASS resource admission: heavy work waits while eligible light work starts",
  );
  results.push("resource admission without head-of-line blocking");
  const killedAt = Date.now();
  await stop(macProcess, "SIGKILL");
  worker(pi);
  const recovered = await until(
    async () => {
      const turn = await store.getTurn(first.id);
      if (turn.status === "failed" || turn.status === "interrupted")
        throw new Error(turn.error);
      return turn.status === "completed" ? turn : null;
    },
    "Pi takeover after Mac lease expires",
    55000,
  );
  const recoveryMs = Date.now() - killedAt;
  assert.equal(recovered.workerId, pi.id);
  assert.ok(recovered.generation > first.generation);
  assert.equal(
    (recovered.output.match(/Local worker connected/g) ?? []).length,
    1,
  );
  assert.equal((recovered.output.match(/You said:/g) ?? []).length, 1);
  assert.equal(
    (recovered.output.match(/This is the demo runtime/g) ?? []).length,
    1,
  );
  const restored = JSON.parse(
    await readFile(
      join(
        directory,
        `cache-${pi.id}`,
        "sessions",
        moving.sessionId,
        ".harness-demo-state.json",
      ),
      "utf8",
    ),
  );
  assert.equal(restored.next, 3);
  const stale = await fetch(`${base}/api/worker/event`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-id": mac.id,
      authorization: `Bearer ${mac.token}`,
    },
    body: JSON.stringify({
      turnId: first.id,
      generation: first.generation,
      sequence: 99,
      event: { type: "text", text: "stale" },
    }),
  });
  assert.equal(stale.status, 409);
  console.log(
    `PASS abrupt handoff: checkpoint + files restored on Pi in ${recoveryMs}ms; stale Mac rejected`,
  );
  results.push(
    "abrupt worker loss and checkpoint recovery",
    "stale-generation rejection",
  );
  await request(
    "tasks",
    { kind: "worker", id: pi.id, draining: true },
    "PATCH",
  );
  macProcess = worker(mac);
  const nextInput = {
    id: crypto.randomUUID(),
    sessionId: moving.sessionId,
    prompt: "Continue this disposable investigation on the Mac.",
  };
  await request("turns", nextInput);
  await request("turns", nextInput);
  const continued = await until(async () => {
    const turn = await store.getTurn(nextInput.id);
    return turn.status === "completed" ? turn : null;
  }, "planned between-turn transfer");
  assert.equal(continued.workerId, mac.id);
  assert.equal(continued.generation, 1);
  assert.equal(
    (await store.getSession(moving.sessionId)).nativeId,
    (await store.getCheckpoint(moving.sessionId)).nativeId,
  );
  console.log(
    "PASS planned handoff: draining Pi routes continuation to Mac; duplicate submission executes once",
  );
  results.push("planned handoff via drain", "duplicate submission");
  const wrongToken = await fetch(`${base}/api/worker/claim`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-id": pi.id,
      authorization: `Bearer ${mac.token}`,
    },
    body: JSON.stringify({ requestId: crypto.randomUUID() }),
  });
  assert.equal(wrongToken.status, 401);
  results.push("worker credential isolation");
  const report = {
    passed: true,
    runtime: "demo",
    realHardware: false,
    scenarios: results,
    recoveryMs,
    recordedAt: new Date().toISOString(),
  };
  await mkdir(join(root, ".data/bench"), { recursive: true });
  await writeFile(
    join(root, ".data/bench/latest.json"),
    JSON.stringify(report, null, 2),
  );
  console.log("Distributed bench passed. Report: .data/bench/latest.json");
} finally {
  for (const child of children.reverse()) await stop(child);
  await store.close();
  await rm(directory, { recursive: true, force: true });
}
