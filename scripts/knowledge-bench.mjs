import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Fixtures by default. --live opts into five real model turns in an isolated DB.
const live = process.argv.includes("--live");
const provider =
  process.argv.find((arg) => arg.startsWith("--provider="))?.split("=")[1] ??
  "codex";
assert.ok(["codex", "claude"].includes(provider));
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "meta-knowledge-bench-"));
const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const fixture = join(directory, "provider.cjs");
await writeFile(
  fixture,
  `#!/usr/bin/env node
const fs=require('node:fs');
let input=''; process.stdin.on('data',b=>input+=b); process.stdin.on('end',()=>{
 const prompt=input.split('User instruction:\\n').at(-1);
 const data=fs.readFileSync('SHARED_DECISIONS.md','utf8');
 const price=prompt.match(/price is \\$(\\d+)/)?.[1];
 let answer;
 if(price){
  const rev=Number(data.match(/business\\.pilot-price \\(revision (\\d+)\\)/)?.[1]??0);
  fs.writeFileSync('DECISION_UPDATES.json',JSON.stringify([{key:'business.pilot-price',content:'Business pilot price is $'+price+'.',expectedRevision:rev}]));
  answer='Recorded $'+price;
 } else {
  const current=data.match(/price is \\$(\\d+)/)?.[1];
  if(!current || !input.includes('price is $'+current)) throw new Error('Fresh decisions were not injected into this turn');
  answer='The pilot price is $'+current+' [business.pilot-price].';
 }
 const claude=process.argv.includes('--print');
 const events=claude?[{type:'system',subtype:'init',session_id:'fixture-native'},{type:'assistant',message:{content:[{type:'text',text:answer}]}},{type:'result',subtype:'success'}]:[{type:'thread.started',thread_id:'fixture-native'},{type:'item.completed',item:{type:'agent_message',text:answer}},{type:'turn.completed'}];
 for(const event of events) console.log(JSON.stringify(event));
});
`,
  { mode: 0o700 },
);
let processHandle;
let logs = "";
const env = {
  ...process.env,
  HARNESS_DATA_DIR: directory,
  PORT: String(port),
  HARNESS_BIND_HOST: "127.0.0.1",
  HARNESS_REQUIRE_AUTH: "0",
  HARNESS_PROVIDERS: provider,
  HARNESS_CONCURRENCY: "1",
  HARNESS_MEMORY_RESERVE_MIB: "0",
  HARNESS_CLAUDE_RUNTIME: "cli",
  HARNESS_TURN_TIMEOUT_MS: "60000",
  WORKFLOW_TARGET_WORLD: "local",
  NEXT_TELEMETRY_DISABLED: "1",
  ...(live ? {} : { CODEX_BIN: fixture, CLAUDE_BIN: fixture }),
};
async function start() {
  processHandle = spawn(process.execPath, ["scripts/dev.mjs", "--production"], {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const pipe of [processHandle.stdout, processHandle.stderr])
    pipe.on("data", (chunk) => {
      logs = (logs + chunk).slice(-18000);
    });
  await until(
    async () => {
      const r = await fetch(`${base}/api/state`);
      return r.ok;
    },
    "startup",
    20000,
  );
}
async function stop() {
  if (!processHandle || processHandle.exitCode !== null) return;
  const closed = new Promise((resolve) => processHandle.once("exit", resolve));
  try {
    processHandle.kill("SIGTERM");
  } catch {}
  const timer = setTimeout(() => {
    try {
      process.kill(-processHandle.pid, "SIGKILL");
    } catch {}
  }, 7000);
  await closed;
  clearTimeout(timer);
}
async function until(fn, label, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    await delay(200);
  }
  throw new Error(`Timed out: ${label}\n${logs}`);
}
async function api(path, body) {
  const r = await fetch(
    `${base}/api/${path}`,
    body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  const result = await r.json();
  assert.ok(r.ok, JSON.stringify(result));
  return result;
}
async function turn(session, prompt) {
  const id = crypto.randomUUID();
  await api("turns", { id, sessionId: session.id, prompt });
  const result = await until(async () => {
    const state = await api(
      `state?workspace=${session.workspaceId}&session=${session.id}`,
    );
    const t = state.turns.find((t) => t.id === id);
    return t && ["completed", "failed", "interrupted"].includes(t.status)
      ? t
      : null;
  }, "knowledge turn");
  assert.equal(result.status, "completed", `${result.error}\n${logs}`);
  return result;
}
try {
  await start();
  const tech = await api("sessions", {
    workspaceId: "tech",
    title: "Disposable knowledge publisher",
    provider,
  });
  const business = await api("sessions", {
    workspaceId: "business",
    title: "Disposable knowledge reader",
    provider,
  });
  const first = await turn(tech, "Business pilot price is $173");
  assert.equal(
    first.publications.length,
    1,
    "Provider did not publish a shared record.",
  );
  assert.match(first.publications[0].content, /173/);
  const read = await turn(business, "what was the pilot price");
  assert.match(read.output, /173/);
  const update = await turn(tech, "Business pilot price is $219");
  assert.equal(update.publications.length, 1);
  assert.equal(update.publications[0].revision, 2);
  const refreshed = await turn(business, "what was the pilot price");
  assert.match(refreshed.output, /219/);
  await stop();
  await start();
  const restored = await turn(business, "what was the pilot price");
  assert.match(restored.output, /219/);
  const snapshot = await api("decisions");
  assert.equal(snapshot.decisions.length, 1);
  assert.equal(snapshot.decisions[0].revision, 2);
  console.log(
    `Shared knowledge passed (${live ? "LIVE" : "fixture"} ${provider}): Tech publishes $173; Business knows it without hints; same sessions update to $219; control+worker restart preserves the latest value.`,
  );
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true });
}
