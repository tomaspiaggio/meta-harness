import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const base = process.env.HARNESS_URL ?? "http://127.0.0.1:3000";
const fixtureDirectory = process.env.HARNESS_SMOKE_DATA_DIR;
const ownerHeaders = {};
if (fixtureDirectory) {
  assert(
    /fixture/.test(basename(fixtureDirectory)) &&
      ["localhost", "127.0.0.1"].includes(new URL(base).hostname) &&
      new URL(base).port !== "3000",
    "Authenticated smoke uses an isolated local fixture",
  );
  const file = join(fixtureDirectory, "admin-token");
  if (existsSync(file))
    ownerHeaders.authorization = `Bearer ${readFileSync(file, "utf8").trim()}`;
}

async function request(path, body, method = "POST") {
  const response = await fetch(
    `${base}/api/${path}`,
    body
      ? {
          method,
          headers: { ...ownerHeaders, "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : { headers: ownerHeaders },
  );
  const data = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(data)}`);
  return data;
}
const session = await request("sessions", {
  workspaceId: "tech",
  title: "Local smoke test",
  provider: "demo",
});
for (const prompt of [
  "Check the local workflow bridge.",
  "Continue the saved session.",
]) {
  const input = { id: crypto.randomUUID(), sessionId: session.id, prompt };
  const first = await request("turns", input);
  const duplicate = await request("turns", input);
  assert.equal(first.id, duplicate.id);
  let completed;
  for (let attempt = 0; attempt < 90; attempt++) {
    const state = await request(`state?workspace=tech&session=${session.id}`);
    const turn = state.turns.find((turn) => turn.id === first.id);
    if (["failed", "interrupted"].includes(turn?.status))
      throw new Error(turn.error);
    if (turn?.status === "completed" && turn.runId) {
      completed = turn;
      break;
    }
    await delay(1000);
  }
  assert.ok(
    completed,
    "Turn did not complete through Workflow + worker within 90s.",
  );
  assert.match(completed.output, /Local worker connected/);
  assert.equal(completed.generation, 1);
  console.log(`Passed: ${completed.id} through workflow ${completed.runId}`);
}
const state = await request(`state?workspace=tech&session=${session.id}`);
assert.equal(state.turns.length, 2);
assert.ok(state.sessions.find((s) => s.id === session.id).nativeId);
assert.ok(state.turns.every((turn) => turn.waitingReason === null));
const board = await request("tasks");
assert.equal(
  board.tasks.find((task) => task.sessionId === session.id)?.status,
  "completed",
);
const badOrigin = await fetch(`${base}/api/turns`, {
  method: "POST",
  headers: {
    ...ownerHeaders,
    "content-type": "application/json",
    origin: "https://example.com",
  },
  body: "{}",
});
assert.equal(badOrigin.status, 403);
// Keep these model-free: all work stays in this smoke session's Demo runtime.
const renamed = await request(
  "sessions",
  { id: session.id, title: "Workflow smoke controls" },
  "PATCH",
);
assert.equal(renamed.titleSource, "manual");
const before = state.sessions.find((item) => item.id === session.id);
assert.equal(before.unreadCount, 2);
await request(
  "sessions",
  { id: session.id, action: "read", throughSequence: before.attentionSequence },
  "PATCH",
);
const third = {
  id: crypto.randomUUID(),
  sessionId: session.id,
  prompt: "Exercise interrupt and follow-up.",
};
await request("turns", third);
let running;
for (let attempt = 0; attempt < 100; attempt++) {
  const current = await request(`state?workspace=tech&session=${session.id}`);
  running = current.turns.find((turn) => turn.id === third.id);
  if (running?.status === "running") break;
  assert.ok(
    !["failed", "interrupted", "completed"].includes(running?.status),
    "Demo completed before stop test; use HARNESS_DEMO_DELAY_MS=2500 if needed",
  );
  await delay(100);
}
assert.equal(running?.status, "running");
const feedback = {
  id: crypto.randomUUID(),
  sessionId: session.id,
  prompt: "Continue with this correction.",
  interruptsTurnId: third.id,
};
await request("turns", feedback);
assert.equal((await request("turns", feedback)).id, feedback.id);
const cancelled = {
  id: crypto.randomUUID(),
  sessionId: session.id,
  prompt: "Cancel this queued message.",
};
await request("turns", cancelled);
assert.equal(
  (await request("turns", { id: cancelled.id }, "PATCH")).status,
  "interrupted",
);
let final;
for (let attempt = 0; attempt < 120; attempt++) {
  final = await request(`state?workspace=tech&session=${session.id}`);
  const original = final.turns.find((turn) => turn.id === third.id);
  const followup = final.turns.find((turn) => turn.id === feedback.id);
  assert.ok(
    !["failed", "interrupted"].includes(followup?.status),
    followup?.error,
  );
  if (followup?.status === "running")
    assert.equal(
      original?.status,
      "interrupted",
      "follow-up must wait for stop acknowledgment",
    );
  if (followup?.status === "completed") break;
  await delay(500);
}
assert.equal(
  final.turns.find((turn) => turn.id === third.id)?.status,
  "interrupted",
);
assert.equal(
  final.turns.find((turn) => turn.id === feedback.id)?.status,
  "completed",
);
assert.equal(
  final.turns.find((turn) => turn.id === cancelled.id)?.generation,
  0,
);
assert.equal(
  final.sessions.find((item) => item.id === session.id)?.unreadCount,
  3,
);
assert.equal(
  (
    await request(
      "sessions",
      {
        id: session.id,
        action: "read",
        throughSequence: before.attentionSequence,
      },
      "PATCH",
    )
  ).unreadCount,
  3,
  "stale read acknowledgment must preserve newer results",
);
const forbiddenStop = await fetch(`${base}/api/turns`, {
  method: "PATCH",
  headers: {
    ...ownerHeaders,
    "content-type": "application/json",
    origin: "https://example.com",
  },
  body: JSON.stringify({ id: feedback.id }),
});
assert.equal(forbiddenStop.status, 403);
console.log(
  "Local smoke passed: workflows, continuation, duplicate input, stop delivery, queued feedback, queued cancellation, manual titles, unread cursors, and origin rejection.",
);
