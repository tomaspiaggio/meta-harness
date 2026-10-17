import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const base = process.env.HARNESS_URL ?? "http://127.0.0.1:3000";
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
const badOrigin = await fetch(`${base}/api/turns`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin: "https://example.com",
  },
  body: "{}",
});
assert.equal(badOrigin.status, 403);
console.log(
  "Local smoke passed: persisted turns, continuation, duplicate submission, origin rejection.",
);
