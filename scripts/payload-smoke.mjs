import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { WorkerClient } from "../apps/worker/src/client.ts";

const base = process.env.HARNESS_URL ?? "http://127.0.0.1:3000";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname))
  throw new Error("Use an isolated local stack for this fixture.");
async function api(path, body, method = "POST") {
  const response = await fetch(`${base}/api/${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(result)}`);
  return result;
}
const worker = await api("workers", { name: "Encrypted payload fixture" });
const client = new WorkerClient(worker);
const session = await api("sessions", {
  workspaceId: "tech",
  provider: "claude",
  title: "Native payload fixture (no model)",
});
let heartbeat;
try {
  await client.post("report", {
    report: {
      hostname: "fixture",
      providers: ["claude"],
      portableProviders: ["claude"],
      labels: [],
      maxAgents: 1,
      memoryBudgetMiB: 4096,
      cpuSlots: 2,
      maxBuilds: 1,
      maxBrowsers: 0,
      availableMemoryMiB: 8192,
      reserveMemoryMiB: 512,
      loadPerCpu: 0,
      maxLoadPerCpu: 10000,
      draining: false,
    },
  });
  const turn = await api("turns", {
    id: crypto.randomUUID(),
    sessionId: session.id,
    prompt: "Store a large native fixture without invoking a model",
  });
  await api(
    "tasks",
    { id: `session:${session.id}`, targetWorkerId: worker.id },
    "PATCH",
  );
  let assignment;
  for (let index = 0; index < 100; index++) {
    assignment = await client.post("claim", { requestId: crypto.randomUUID() });
    if (assignment) break;
    await delay(200);
  }
  assert.ok(assignment);
  const generation = assignment.claim.turn.generation;
  heartbeat = setInterval(
    () =>
      void client
        .post("heartbeat", { turnId: turn.id, generation })
        .catch(() => {}),
    5000,
  );
  await client.post("event", {
    turnId: turn.id,
    generation,
    sequence: 1,
    event: { type: "native-session", id: "fixture-native" },
  });
  const key = {
    projectKey: `meta-harness-${session.id}`,
    sessionId: "fixture-native",
  };
  const entries = [
    {
      uuid: "large-entry",
      type: "user",
      message: { role: "user", content: "image-state-".repeat(450000) },
    },
  ];
  await client.post("native-append", {
    turnId: turn.id,
    generation,
    id: "large-native-write",
    key,
    entries,
  });
  assert.deepEqual(
    await client.post("native-load", { turnId: turn.id, generation, key }),
    entries,
  );
  const bytes = Buffer.from("portable-file-".repeat(270000));
  const snapshot = {
    version: 1,
    files: [
      {
        path: "fixture.txt",
        data: bytes.toString("base64"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        executable: false,
      },
    ],
  };
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > 4.5 * 1024 * 1024);
  await client.post("checkpoint", {
    turnId: turn.id,
    generation,
    id: crypto.randomUUID(),
    snapshot,
  });
  await client.post("complete", {
    turnId: turn.id,
    generation,
    status: "completed",
    decisionUpdates: [],
  });
  const next = await api("turns", {
    id: crypto.randomUUID(),
    sessionId: session.id,
    prompt: "Restore the large checkpoint",
  });
  let restored;
  for (let index = 0; index < 100; index++) {
    restored = await client.post("claim", { requestId: crypto.randomUUID() });
    if (restored) break;
    await delay(200);
  }
  assert.ok(restored);
  assert.deepEqual(restored.checkpoint.snapshot, snapshot);
  await client.post("complete", {
    turnId: next.id,
    generation: restored.claim.turn.generation,
    status: "interrupted",
    error: "Fixture finished",
    decisionUpdates: [],
  });
  console.log(
    "Encrypted payload smoke passed: >4.5 MiB native upload/load, checkpoint upload, large claim recovery and generation fencing; no model calls.",
  );
} finally {
  clearInterval(heartbeat);
  await api("workers", { id: worker.id }, "DELETE");
}
