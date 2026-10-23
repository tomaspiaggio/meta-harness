import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HarnessStore } from "./application";

test("owner edits, withdrawals and restoration append history, reject stale revisions, and survive a deleted source workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-decision-edit-"));
  const store = new HarnessStore(join(root, "fixture.sqlite"));
  try {
    await store.ready;
    await store.importSharedDecision(
      { key: "business.price", content: "$173", expectedRevision: 0 },
      "business",
    );
    await store.editSharedDecision({
      key: "business.price",
      content: "$200",
      expectedRevision: 1,
    });
    await assert.rejects(
      store.editSharedDecision({
        key: "business.price",
        content: "wrong",
        expectedRevision: 1,
      }),
      /changed to revision/,
    );
    await store.editSharedDecision({
      key: "business.price",
      content: null,
      expectedRevision: 2,
    });
    const withdrawn = (await store.getSharedDecisions()).decisions[0];
    assert.equal(withdrawn.content, null);
    assert.equal(withdrawn.revision, 3);
    await store.deleteWorkspace("business");
    await store.editSharedDecision({
      key: "business.price",
      content: "$250",
      expectedRevision: 3,
    });
    const history = await store
      .databaseConnection()
      .prepare(
        "SELECT content FROM decision_history WHERE key = ? ORDER BY revision",
      )
      .all("business.price");
    assert.deepEqual(
      history.map((row) => row.content),
      ["$173", "$200", null, "$250"],
    );
    assert.equal(
      (await store.getSharedDecisions()).decisions[0].workspaceId,
      "business",
    );
    await assert.rejects(
      store.editSharedDecision({
        key: "missing",
        content: "x",
        expectedRevision: 0,
      }),
      /not found/,
    );
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("agent title suggestions can improve generated fallback titles and never overwrite a manual title", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-title-"));
  const store = new HarnessStore(join(root, "fixture.sqlite"));
  try {
    await store.ready;
    const session = await store.createSession(
      "tech",
      "i want to configure a schedule",
      "demo",
    );
    await store.generatedTitle(session.id, "Schedule weekdays CRM");
    await store.generatedTitle(session.id, "Weekday CRM review", true);
    assert.equal(
      (await store.getSession(session.id)).title,
      "Weekday CRM review",
    );
    await store.renameSession(session.id, "My chosen name");
    await store.generatedTitle(session.id, "Automated overwrite", true);
    assert.equal((await store.getSession(session.id)).title, "My chosen name");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
