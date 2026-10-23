import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

if (process.env.HARNESS_LIVE_CODEX_TOOLS !== "1")
  throw new Error(
    "Explicitly set HARNESS_LIVE_CODEX_TOOLS=1: this test uses live model quota.",
  );
const base = process.env.HARNESS_URL;
if (!base || !["127.0.0.1", "localhost"].includes(new URL(base).hostname))
  throw new Error(
    "Set HARNESS_URL to an isolated local stack with a Codex worker.",
  );
async function api(path, body, method = "POST") {
  const response = await fetch(
    `${base}/api/${path}`,
    body
      ? {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
}
const workspace = await api("workspaces", {
  name: "Native tool compatibility fixture",
  instructions:
    "Isolated test. Only create an inactive schedule and a session title. Never activate a schedule or access external services.",
});
const session = await api("sessions", {
  workspaceId: workspace.id,
  title: "i want to configure a schedule every weekday",
  provider: "codex",
  model: process.env.HARNESS_LIVE_CODEX_MODEL ?? "gpt-6-luna",
});
const turn = await api("turns", {
  id: crypto.randomUUID(),
  sessionId: session.id,
  prompt:
    'Use the harness MCP tools, without shell commands: call session_title with title "Weekday CRM review" and schedule_propose with name "Fixture weekday review", prompt "Review fixture CRM and calendar; do not contact people", kind "agent", trigger {"type":"cron","expression":"0 8 * * 1-5","timezone":"America/Los_Angeles"}. Do not activate anything. Then finish with a brief confirmation.',
});
console.log(
  `Fixture session ${session.id}; two live Codex turns, inactive draft only.`,
);
let state;
for (let i = 0; i < 150; i++) {
  state = await api(`state?workspace=${workspace.id}&session=${session.id}`);
  const current = state.turns.find((item) => item.id === turn.id);
  if (["failed", "interrupted"].includes(current.status))
    throw new Error(current.error);
  if (current.status === "completed") break;
  await delay(1000);
}
assert.equal(
  state.turns.find((item) => item.id === turn.id)?.status,
  "completed",
);
assert.equal(
  state.sessions.find((item) => item.id === session.id)?.title,
  "Weekday CRM review",
);
const schedules = (await api(`schedules?session=${session.id}`)).schedules;
assert.equal(schedules.length, 1);
assert.equal(schedules[0].status, "draft");
assert.equal(schedules[0].trigger.expression, "0 8 * * 1-5");
assert.equal(schedules[0].trigger.timezone, "America/Los_Angeles");
assert.equal(schedules[0].sessionId, session.id);
const nativeId = state.sessions.find(
  (item) => item.id === session.id,
)?.nativeId;
assert.ok(nativeId, "The continuation must resume a real native thread");
const followup = await api("turns", {
  id: crypto.randomUUID(),
  sessionId: session.id,
  prompt: `Call schedule_list, then update the existing inactive draft using schedule_propose with id ${JSON.stringify(schedules[0].id)}, revision ${schedules[0].revision}, name "Fixture weekday review", prompt "Review updated fixture CRM and calendar; do not contact people", kind "agent", and trigger {"type":"cron","expression":"0 8 * * 1-5","timezone":"America/Los_Angeles"}. Do not activate or create a second schedule.`,
});
for (let i = 0; i < 150; i++) {
  state = await api(`state?workspace=${workspace.id}&session=${session.id}`);
  const current = state.turns.find((item) => item.id === followup.id);
  if (["failed", "interrupted"].includes(current.status))
    throw new Error(current.error);
  if (current.status === "completed") break;
  await delay(1000);
}
assert.equal(
  state.turns.find((item) => item.id === followup.id)?.status,
  "completed",
);
assert.equal(
  state.sessions.find((item) => item.id === session.id)?.nativeId,
  nativeId,
);
const resumed = (await api(`schedules?session=${session.id}`)).schedules;
assert.equal(resumed.length, 1);
assert.equal(resumed[0].id, schedules[0].id);
assert.equal(resumed[0].revision, schedules[0].revision + 1);
assert.equal(resumed[0].status, "draft");
assert.match(resumed[0].prompt, /updated fixture/);
console.log(
  "Live native tools passed for new and resumed native threads: schedule proposal/list/revision, stable native ID, inactive review draft and suggested title. Fixture records retained; no schedule activated.",
);
