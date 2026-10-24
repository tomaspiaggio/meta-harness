import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { mintAttemptGrant } from "../apps/web/server/grants.ts";
import { HarnessStore } from "../packages/storage/src/application.ts";

const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "meta-harness-mcp-fixture-"));
process.env.HARNESS_DATA_DIR = directory;
const port = 3211,
  base = `http://127.0.0.1:${port}`;
let version = 1,
  calls = 0,
  mode = "normal",
  hangStarted = () => {};
const external = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, "Bearer fixture-only-secret");
  if (req.method === "DELETE") {
    res.writeHead(200).end();
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += String(chunk);
  const message = JSON.parse(raw);
  const send = (result) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  };
  if (message.method === "initialize") {
    res.setHeader("mcp-session-id", "fixture-session");
    send({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "1" },
    });
    return;
  }
  if (message.method === "notifications/initialized") {
    res.writeHead(202).end();
    return;
  }
  if (message.method === "tools/list") {
    send({
      tools: [
        {
          name: "update",
          description: "Fixture update action",
          inputSchema: {
            type: "object",
            properties: {
              value: { type: version === 1 ? "string" : "number" },
            },
            required: ["value"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: {
              stored: { type: version === 1 ? "string" : "number" },
            },
            required: ["stored"],
          },
          annotations: { readOnlyHint: true },
        },
      ],
    });
    return;
  }
  if (message.method === "tools/call") {
    calls++;
    if (mode === "disconnect") {
      req.socket.destroy();
      return;
    }
    if (mode === "hang") {
      hangStarted();
      return;
    }
    send({
      structuredContent: { stored: message.params.arguments.value },
      content: [
        {
          type: "text",
          text: `stored ${message.params.arguments.value}; fixture-only-secret`,
        },
      ],
    });
    return;
  }
  res.writeHead(400).end();
});
await new Promise((resolve) => external.listen(0, "127.0.0.1", resolve));
const externalAddress = external.address();
assert.ok(externalAddress && typeof externalAddress !== "string");
const endpoint = `http://127.0.0.1:${externalAddress.port}/mcp`;
const env = {
  ...process.env,
  PORT: String(port),
  // This isolated fixture deliberately exercises local owner access.
  HARNESS_BIND_HOST: "127.0.0.1",
  HARNESS_AUTH: "local",
  HARNESS_REQUIRE_AUTH: "0",
  HARNESS_PUBLIC_URL: base,
  HARNESS_DATA_DIR: directory,
  HARNESS_SECRET_BINDINGS: JSON.stringify({
    "fixture-auth": "JOB_SECRET_MCP_FIXTURE",
  }),
  JOB_SECRET_MCP_FIXTURE: "Bearer fixture-only-secret",
  HARNESS_POLL_MS: "200",
  NEXT_TELEMETRY_DISABLED: "1",
};
let logs = "";
const control = spawn(process.execPath, ["scripts/dev.mjs", "--production"], {
  cwd: root,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
for (const stream of [control.stdout, control.stderr])
  stream.on("data", (chunk) => {
    logs = (logs + String(chunk)).slice(-65536);
  });
let store;
async function api(path, body) {
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
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(result)}`);
  return result;
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (control.exitCode !== null) throw new Error(logs);
    try {
      const response = await fetch(`${base}/api/integrations`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(200);
  }
  assert.ok(ready, logs);
  const added = await api("integrations/mcp", {
    label: "Fixture MCP",
    config: {
      endpoint,
      allowPrivate: true,
      headerRefs: { authorization: "fixture-auth" },
    },
  });
  const connection = added.connection;
  let definition = added.definition,
    bindingRevision;
  async function bind(enabled = true) {
    const result = await api("integrations", {
      action: "binding",
      expectedRevision: bindingRevision,
      binding: {
        workspaceId: "tech",
        connectionId: connection.id,
        revision: crypto.randomUUID(),
        connectionRevision: connection.revision,
        integrationRevision: definition.revision,
        enabled,
        toolIds: ["update"],
        constraints: {},
      },
    });
    bindingRevision = result.revision;
  }
  assert.doesNotMatch(JSON.stringify(added), /fixture-only-secret/);
  await bind();
  store = new HarnessStore(join(directory, "harness.sqlite"));
  await store.ready;
  async function grant(workspaceId) {
    const worker = await store.createWorker("MCP fixture");
    await store.reportWorker(worker.id, {
      hostname: "fixture",
      providers: ["demo"],
      labels: [],
      maxAgents: 1,
      memoryBudgetMiB: 4096,
      cpuSlots: 2,
      maxBuilds: 1,
      maxBrowsers: 1,
      availableMemoryMiB: 8192,
      reserveMemoryMiB: 1024,
      loadPerCpu: 0,
      maxLoadPerCpu: 1,
      draining: false,
    });
    const task = await store.databaseConnection().transaction(async () => {
      const t = await store.createTask({
        id: crypto.randomUUID(),
        workspaceId,
        title: "MCP fixture",
        objective: "Fixture only",
        provider: "demo",
        profile: "standard",
        priority: 0,
      });
      await store.updateTask(t.id, { targetWorkerId: worker.id });
      return t;
    });
    const turn = (await store.listTurns(task.sessionId))[0];
    assert.ok(turn);
    await store.enqueue(turn.id);
    const claimed = await store.claimForWorker(worker.id);
    assert.ok(claimed);
    const generation = claimed.claim.turn.generation;
    return {
      token: mintAttemptGrant(worker.id, turn.id, generation),
      workerId: worker.id,
      turnId: turn.id,
      generation,
      sessionId: task.sessionId,
    };
  }
  const identity = await grant("tech"),
    other = await grant("business");
  async function mcp(identity, method, params = {}) {
    const response = await fetch(`${base}/api/tools`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${identity.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        params,
      }),
    });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result.result;
  }
  const listed = await mcp(identity, "tools/list");
  const descriptor = listed.tools.find((t) =>
    t.description.includes("Fixture update action"),
  );
  assert.ok(descriptor);
  assert.ok(descriptor.name.length <= 64);
  assert.equal(
    descriptor.inputSchema.properties.arguments.properties.value.type,
    "string",
  );
  assert.equal(
    (await mcp(other, "tools/list")).tools.some(
      (t) => t.name === descriptor.name,
    ),
    false,
  );
  const call = (operation_id, value = "one", extra = {}) =>
    mcp(identity, "tools/call", {
      name: descriptor.name,
      arguments: { operation_id, arguments: { value }, ...extra },
    });
  assert.equal(
    (
      await mcp(other, "tools/call", {
        name: descriptor.name,
        arguments: {
          operation_id: "wrong-workspace",
          arguments: { value: "one" },
        },
      })
    ).isError,
    true,
  );
  assert.equal(calls, 0);
  const first = await call("same-id");
  assert.ok(!first.isError);
  assert.deepEqual(first.structuredContent, { stored: "one" });
  assert.doesNotMatch(JSON.stringify(first), /fixture-only-secret/);
  assert.deepEqual(await call("same-id"), first);
  assert.equal(calls, 1);
  assert.equal((await call("same-id", "different")).isError, true);
  assert.equal(calls, 1);
  mode = "disconnect";
  assert.equal((await call("ambiguous")).isError, true);
  assert.equal(
    (await call("ambiguous", "one", { retry_unstarted: true })).isError,
    true,
  );
  assert.equal(calls, 2);
  mode = "normal";
  version = 2;
  assert.equal((await call("stale-schema")).isError, true);
  assert.equal(calls, 2);
  definition = await api("integrations", {
    action: "discover",
    connectionId: connection.id,
    expectedRevision: connection.revision,
  });
  assert.equal(
    (await mcp(identity, "tools/list")).tools.some(
      (t) => t.name === descriptor.name,
    ),
    false,
  );
  await bind();
  assert.ok(!(await call("accepted-new-schema", 123)).isError);
  assert.equal(calls, 3);
  mode = "hang";
  const started = new Promise((resolve) => {
    hangStarted = resolve;
  });
  const running = call("revoked-in-flight", 42);
  await started;
  await bind(false);
  assert.equal((await running).isError, true);
  assert.equal(calls, 4);
  const unfinished = await store.unfinishedOperations(identity.sessionId);
  assert.ok(unfinished.some((o) => o.state === "unknown_outcome"));
  assert.doesNotMatch(JSON.stringify(unfinished), /fixture-only-secret/);
  await store.requestStop(identity.turnId);
  await assert.rejects(async () => {
    await mcp(identity, "tools/list");
  });
  for (const who of [identity, other])
    await store.finish(who.turnId, who.generation, "interrupted");
  const snapshot = await api("integrations/mcp");
  assert.equal(snapshot[0].status, "ready");
  assert.doesNotMatch(JSON.stringify(snapshot), /fixture-only-secret/);
  await api("integrations", {
    action: "delete",
    connectionId: connection.id,
    expectedRevision: connection.revision,
  });
  assert.equal((await api("integrations")).connections.length, 0);
  assert.equal((await api("integrations/mcp")).length, 0);
  const smoke = spawn(process.execPath, ["scripts/smoke.mjs"], {
    cwd: root,
    env: { ...env, HARNESS_URL: base },
    stdio: "inherit",
  });
  assert.equal(await new Promise((resolve) => smoke.once("exit", resolve)), 0);
  console.log(
    "MCP fixture smoke passed: discovery, bindings, gateway schemas/calls, workspace denial, secrets, receipts, ambiguous effects, schema acceptance, revocation, stop, cleanup and full local workflow smoke.",
  );
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await store?.close();
  control.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => control.once("exit", resolve)),
    delay(7000),
  ]);
  external.closeAllConnections();
  await new Promise((resolve) => external.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
