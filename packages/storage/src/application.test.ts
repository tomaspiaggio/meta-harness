import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nextOccurrence } from "@harness/core/automations";
import { HarnessStore } from "./application";
import { LocalObjects, sha256 } from "./objects";

async function fixture(
  run: (store: HarnessStore, root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "harness-application-"));
  const store = new HarnessStore(join(root, "state.sqlite"));
  await store.ready;
  try {
    await run(store, root);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}
test("schedule approval fences stale timers; duplicates reuse one persistent session and reminders need no worker", () =>
  fixture(async (store) => {
    const session = await store.createSession("business", "Morning", "demo");
    const at = Date.now() + 60000;
    const draft = {
      name: "Review CRM",
      prompt: "Summarize my CRM tasks",
      sessionId: session.id,
      kind: "reminder",
      trigger: { type: "once", at },
      maxLatenessMs: 86400000,
    };
    const one = await store.draftSchedule("crm", draft);
    assert.equal(one.status, "draft");
    assert.equal(one.nextAt, null);
    assert.equal(
      (await store.draftSchedule("crm", draft)).revision,
      1,
      "retrying proposal is idempotent",
    );
    assert.equal(await store.scheduledOccurrence("crm", 1, at, at), null);
    const active = await store.changeSchedule("crm", 1, "activate");
    await assert.rejects(store.changeSchedule("crm", 1, "activate"), /changed/);
    const occurrence = await store.scheduledOccurrence(
      "crm",
      active.revision,
      at,
      at,
    );
    assert.ok(occurrence?.turnId);
    assert.deepEqual(
      await store.scheduledOccurrence("crm", active.revision, at, at),
      occurrence,
    );
    const turn = await store.getTurn(occurrence.turnId);
    assert.equal(turn.sessionId, session.id);
    assert.equal(turn.status, "completed");
    assert.equal(turn.output, draft.prompt);
    assert.equal((await store.listTurns(session.id)).length, 1);
    assert.ok(
      (await store.claimNotifications()).some(
        (item) => item.referenceId === turn.id,
      ),
    );
    assert.equal(
      (await store.listSessions("business")).find(
        (item) => item.id === session.id,
      )?.unreadCount,
      1,
    );
  }));
test("recurring reviews coalesce overlapping work and edited drafts invalidate old occurrences", () =>
  fixture(async (store) => {
    const session = await store.createSession("tech", "Recurring", "demo");
    const draft = await store.draftSchedule("review", {
      name: "Review",
      prompt: "Review tasks",
      sessionId: session.id,
      kind: "agent",
      trigger: {
        type: "cron",
        expression: "* * * * *",
        timezone: "America/Los_Angeles",
      },
    });
    let active = await store.changeSchedule(
      draft.id,
      draft.revision,
      "activate",
    );
    assert.ok(active.nextAt);
    const first = await store.scheduledOccurrence(
      active.id,
      active.revision,
      active.nextAt,
      active.nextAt,
    );
    assert.ok(first?.turnId);
    active = await store.getSchedule(active.id);
    assert.ok(active.nextAt);
    const second = await store.scheduledOccurrence(
      active.id,
      active.revision,
      active.nextAt,
      active.nextAt,
    );
    assert.equal(second?.outcome, "skipped");
    assert.equal((await store.listTurns(session.id)).length, 1);
    const edited = await store.draftSchedule(
      active.id,
      { ...active, prompt: "Changed review" },
      active.revision,
    );
    assert.equal(edited.status, "draft");
    assert.equal(
      await store.scheduledOccurrence(
        active.id,
        active.revision,
        active.nextAt + 60000,
        active.nextAt + 60000,
      ),
      null,
    );
  }));
test("weekday cron retains local morning across daylight saving transition", () => {
  const trigger = {
    type: "cron" as const,
    expression: "0 9 * * 1-5",
    timezone: "America/Los_Angeles",
  };
  const next = nextOccurrence(trigger, Date.parse("2026-10-30T16:01:00Z"));
  assert.ok(next);
  assert.equal(new Date(next).toISOString(), "2026-11-02T17:00:00.000Z");
});
test("attachment receipt, association and object integrity are enforced independently of paths", () =>
  fixture(async (store, root) => {
    const one = await store.createSession("tech", "Files", "demo");
    const two = await store.createSession("business", "Other", "demo");
    const bytes = new Uint8Array([0, 255, 13, 10, 128]);
    const attachment = {
      id: "image-1",
      sessionId: one.id,
      name: "binary.dat",
      mediaType: "application/octet-stream",
      size: bytes.length,
      hash: sha256(bytes),
      objectKey: "attachments/image-1",
      createdAt: Date.now(),
    };
    const objects = new LocalObjects(join(root, "objects"));
    await objects.put(attachment.objectKey, bytes, attachment.mediaType);
    assert.deepEqual(await objects.get(attachment.objectKey, 10), bytes);
    await assert.rejects(objects.get("../state.sqlite", 100));
    await assert.rejects(objects.get(attachment.objectKey, 1));
    await store.addAttachment(attachment);
    await assert.rejects(
      store.submitMessage("not-ready", one.id, "Inspect", [attachment.id]),
      /ready|upload/i,
    );
    await store.confirmAttachment(attachment.id);
    await assert.rejects(
      store.submitMessage("wrong-session", two.id, "Inspect", [attachment.id]),
      /session/i,
    );
    await store.submitMessage("files", one.id, "Inspect", [attachment.id]);
    await store.submitMessage("files", one.id, "Inspect", [attachment.id]);
    assert.equal((await store.attachmentsForTurn("files")).length, 1);
    await assert.rejects(
      store.submitMessage("files", one.id, "Different", [attachment.id]),
      /reused|different|match/i,
    );
  }));
test("owner sessions are hashed, expire and revoke; automatic titles respect manual names", () =>
  fixture(async (store) => {
    await store.createOwnerSession("opaque", "owner", Date.now() + 60000);
    assert.equal((await store.ownerSession("opaque"))?.ownerId, "owner");
    await store.revokeOwnerSession("opaque");
    assert.equal(await store.ownerSession("opaque"), undefined);
    const session = await store.createSession("tech", "Initial", "demo");
    await store.renameSession(session.id, "My title");
    await store.generatedTitle(session.id, "Automatic");
    assert.equal((await store.getSession(session.id)).title, "My title");
  }));
