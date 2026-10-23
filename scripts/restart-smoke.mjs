import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "meta-restart-"));
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  HARNESS_DATA_DIR: directory,
  PORT: String(port),
  WORKFLOW_TARGET_WORLD: "local",
  WORKFLOW_LOCAL_DATA_DIR: join(directory, "workflow"),
  WORKFLOW_LOCAL_BASE_URL: base,
  NEXT_TELEMETRY_DISABLED: "1",
  HARNESS_MEMORY_RESERVE_MIB: "0",
  HARNESS_MAX_LOAD_PER_CPU: "10000",
  HARNESS_PROVIDERS: "demo",
};
const children = [];
let logs = "";
function launch(cwd, args) {
  const child = spawn(process.execPath, args, {
    cwd,
    env,
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
function web() {
  return launch(join(root, "apps/web"), [
    require.resolve("next/dist/bin/next", { paths: [join(root, "apps/web")] }),
    "start",
    "--hostname",
    "127.0.0.1",
  ]);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once("exit", resolve));
  process.kill(-child.pid, "SIGTERM");
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
async function until(fn, label) {
  for (let i = 0; i < 100; i++) {
    const result = await fn().catch(() => null);
    if (result) return result;
    await delay(200);
  }
  throw new Error(`Timed out: ${label}\n${logs}`);
}
async function request(path, body) {
  const response = await fetch(
    `${base}/api/${path}`,
    body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
}
try {
  const firstWeb = web();
  await until(async () => await request("state"), "first startup");
  const session = await request("sessions", {
    workspaceId: "tech",
    title: "Restart gate",
    provider: "demo",
  });
  const input = {
    id: crypto.randomUUID(),
    sessionId: session.id,
    prompt: "Survive a control-plane restart.",
  };
  await request("turns", input);
  const queued = await until(async () => {
    const state = await request(`state?workspace=tech&session=${session.id}`);
    const turn = state.turns[0];
    return turn?.status === "queued" && turn.runId ? turn : null;
  }, "workflow dispatch without a worker");
  // Stop after the workflow dispatched, before any agent process executed.
  await stop(firstWeb);
  const secondWeb = web();
  await until(async () => await request("state"), "restart");
  launch(join(root, "apps/worker"), ["--import", "tsx", "src/index.ts"]);
  await until(async () => {
    const state = await request(`state?workspace=tech&session=${session.id}`);
    const turn = state.turns[0];
    assert.equal(turn.id, input.id);
    return turn.status === "completed" && turn.generation === 1;
  }, "saved turn completion");
  await until(async () => {
    const record = JSON.parse(
      await readFile(
        join(directory, "workflow/runs", `${queued.runId}.json`),
        "utf8",
      ),
    );
    return record.status === "completed";
  }, "original workflow replay after restart");
  // Duplicate submission after restart must not execute again.
  const duplicate = await request("turns", input);
  assert.equal(duplicate.status, "completed");
  assert.equal(duplicate.generation, 1);
  await stop(secondWeb);
  console.log(
    "Restart gate passed: queued turn and original workflow recovered; execution happened once.",
  );
} finally {
  for (const child of children) await stop(child);
  await rm(directory, { recursive: true, force: true });
}
