import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decisionSource,
  listWorkspacesWithSessions,
  readSession,
  searchHistory,
} from "../../../apps/web/server/history";
import { HarnessStore } from "./application";

test("agents can read the conversation behind a decision across workspaces", async () => {
  const store = new HarnessStore(":memory:");
  await store.ready;
  try {
    const source = await store.createSession("business", "Ideation", "demo");
    const reader = await store.createSession("tech", "Review", "demo");
    const db = store.databaseConnection();
    for (let index = 1; index <= 8; index++) {
      await store.createTurn(`t${index}`, source.id, `owner message ${index}`);
      await db
        .prepare("UPDATE turns SET output = ?, createdAt = ? WHERE id = ?")
        .run(
          index === 5
            ? "We agreed agent-to-agent meeting negotiation weighs purpose and time budget."
            : `agent reply ${index}`,
          1000 + index,
          `t${index}`,
        );
    }
    await db
      .prepare(
        "INSERT INTO decision_history(key, content, revision, workspaceId, sessionId, turnId, updatedAt) VALUES (?, ?, 1, 'business', ?, 't5', 1)",
      )
      .run("inter-harness.direction", "Exploratory direction", source.id);

    const found = (await decisionSource(store, {
      key: "inter-harness.direction",
      limit: 4,
    })) as unknown as {
      conversation: { session: { title: string }; turns: { turnId: string }[] };
    };
    assert.equal(found.conversation.session.title, "Ideation");
    assert.deepEqual(
      found.conversation.turns.map((turn) => turn.turnId),
      ["t3", "t4", "t5", "t6"],
      "Centered on the writing turn",
    );

    const page = await readSession(store, { session_id: source.id, limit: 3 });
    assert.deepEqual(
      page.turns.map((turn) => turn.turnId),
      ["t6", "t7", "t8"],
    );
    assert.equal(page.totalTurns, 8);
    const older = await readSession(store, {
      session_id: source.id,
      limit: 3,
      before: page.olderPage?.before,
    });
    assert.deepEqual(
      older.turns.map((turn) => turn.turnId),
      ["t3", "t4", "t5"],
    );

    const search = await searchHistory(store, { query: "Meeting Negotiation" });
    assert.equal(search.matches[0]?.turnId, "t5");
    assert.match(String(search.matches[0]?.excerpt), /meeting negotiation/);

    const workspaces = await listWorkspacesWithSessions(store);
    assert.ok(
      workspaces.some((workspace) =>
        workspace.sessions.some((item) => item.session_id === reader.id),
      ),
    );

    await assert.rejects(
      readSession(store, { session_id: "missing" }),
      /no longer exists/,
    );
    await assert.rejects(
      decisionSource(store, { key: "unknown.key" }),
      /No decision/,
    );
  } finally {
    await store.close();
  }
});
