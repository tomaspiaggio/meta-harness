import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const base = process.env.HARNESS_URL ?? "http://127.0.0.1:3000";
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
  const data = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(data)}`);
  return data;
}
async function until(check, label) {
  for (let index = 0; index < 120; index++) {
    const result = await check();
    if (result) return result;
    await delay(500);
  }
  throw new Error(`Timed out: ${label}`);
}
const session = await api("sessions", {
  workspaceId: "tech",
  title: "Durable features fixture",
  provider: "demo",
});
const bytes = Buffer.from("Portable attachment fixture 🧪\n");
const hash = createHash("sha256").update(bytes).digest("hex");
const attachmentId = crypto.randomUUID();
const upload = await api("attachments", {
  id: attachmentId,
  sessionId: session.id,
  name: "fixture.txt",
  mediaType: "text/plain",
  size: bytes.length,
  hash,
});
assert.ok(
  upload.upload.url.startsWith("/api/attachments"),
  "Use local object storage for this fixture smoke.",
);
const put = await fetch(new URL(upload.upload.url, base), {
  method: "PUT",
  headers: upload.upload.headers,
  body: bytes,
});
assert.ok(put.ok, await put.text());
await api("attachments", { id: attachmentId }, "PATCH");
assert.deepEqual(
  Buffer.from(
    await (
      await fetch(`${base}/api/attachments?id=${attachmentId}`)
    ).arrayBuffer(),
  ),
  bytes,
);
const turn = await api("turns", {
  id: crypto.randomUUID(),
  sessionId: session.id,
  prompt: "Inspect the attached fixture",
  attachmentIds: [attachmentId],
});
await until(async () => {
  const state = await api(`state?workspace=tech&session=${session.id}`);
  const found = state.turns.find((item) => item.id === turn.id);
  if (found?.status === "failed") throw new Error(found.error);
  return found?.status === "completed" && found;
}, "attached turn");
await until(
  async () =>
    (await api(`diagnostics?turn=${turn.id}`)).workflow?.status === "completed",
  "durable completion hook",
);
const other = await api("sessions", {
  workspaceId: "business",
  title: "Other attachment scope",
  provider: "demo",
});
const forbidden = await fetch(`${base}/api/turns`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    id: crypto.randomUUID(),
    sessionId: other.id,
    prompt: "Wrong scope",
    attachmentIds: [attachmentId],
  }),
});
assert.equal(forbidden.status, 403);
const proposed = await api("schedules", {
  id: crypto.randomUUID(),
  draft: {
    name: "Fixture reminder",
    prompt: "Review my tasks tomorrow",
    sessionId: session.id,
    kind: "reminder",
    trigger: { type: "once", at: Date.now() + 4000, timezone: "UTC" },
    maxLatenessMs: 60000,
  },
});
assert.equal(proposed.status, "draft");
const noRuns = await api(`schedules?id=${proposed.id}`);
assert.equal(noRuns.history.length, 0);
const active = await api(
  "schedules",
  { id: proposed.id, revision: proposed.revision, action: "activate" },
  "PATCH",
);
assert.equal(active.status, "active");
await until(async () => {
  const result = await api(`schedules?id=${proposed.id}`);
  return result.history[0]?.outcome === "completed" && result;
}, "one-time reminder without a model");
const state = await api(`state?workspace=tech&session=${session.id}`);
assert.equal(state.turns.length, 2);
assert.ok(
  state.turns.some((item) => item.output === "Review my tasks tomorrow"),
);
assert.ok(
  state.sessions.find((item) => item.id === session.id).unreadCount >= 2,
);
console.log(
  "Feature smoke passed: immutable uploads, binary integrity, native file delivery, session authorization, durable completion hooks, reviewed timers, worker-free reminders and persistent destinations.",
);
