import assert from "node:assert/strict";
import { test } from "node:test";
import { HarnessStore } from "./application";

test("every workspace gets one planner, adopting an existing Planner session", async () => {
  const store = new HarnessStore(":memory:");
  await store.ready;
  try {
    const existing = await store.createSession("tech", "planner", "claude");
    await store.submitMessage("old", existing.id, "Earlier planning");
    await store.briefSession();
    await Promise.all([store.ensurePlanners(), store.ensurePlanners()]);
    const planners = (await Promise.all(
      (
        await store.listWorkspaces()
      ).map(async (workspace) => ({
        workspace: workspace.id,
        planners: (
          await store.listSessions(workspace.id)
        ).filter((session) => session.role === "planner"),
      })),
    )) as { workspace: string; planners: { id: string; title: string }[] }[];
    for (const { workspace, planners: found } of planners)
      assert.equal(found.length, workspace === "briefs" ? 0 : 1, workspace);
    const tech = planners.find((item) => item.workspace === "tech");
    assert.equal(tech?.planners[0].id, existing.id, "adopted, history kept");
    const business = planners.find((item) => item.workspace === "business");
    assert.equal(business?.planners[0].title, "Planner");
    // A workspace created later gets its own on the next pass.
    const fresh = await store.createWorkspace("Litho", "Chip work");
    await store.ensurePlanners();
    assert.equal(
      (await store.listSessions(fresh.id)).filter(
        (session) => session.role === "planner",
      ).length,
      1,
    );
    await assert.rejects(
      store
        .databaseConnection()
        .prepare("UPDATE sessions SET role = 'planner' WHERE id = ?")
        .run((await store.createSession("tech", "Second", "codex")).id),
      /UNIQUE/,
    );
  } finally {
    await store.close();
  }
});

test("an empty session can switch agents; workers and busy sessions are known", async () => {
  const store = new HarnessStore(":memory:");
  await store.ready;
  try {
    await store.ensurePlanners();
    const [planner] = (await store.listSessions("tech")).filter(
      (session) => session.role === "planner",
    );
    const switched = await store.setSessionProvider(
      planner.id,
      "codex",
      "gpt-6.1-terra",
    );
    assert.equal(switched.provider, "codex");
    assert.equal(switched.model, "gpt-6.1-terra");
    const plan = await store.submitMessage("plan", planner.id, "Plan");
    await assert.rejects(
      store.setSessionProvider(planner.id, "claude", null),
      /fixed after the first message/,
    );
    const worker = await store.createSession("tech", "Worker", "codex");
    await store.sendDelegation({
      turnId: "task:w",
      callerTurnId: plan.id,
      toSessionId: worker.id,
      message: "Do it",
    });
    const activity = await store.sessionActivity();
    assert.deepEqual(activity.workers, [worker.id]);
    assert.ok(activity.busy.includes(worker.id));
  } finally {
    await store.close();
  }
});
