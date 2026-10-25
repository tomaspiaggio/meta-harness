import assert from "node:assert/strict";
import { test } from "node:test";
import { HarnessStore, MAX_DELEGATION_ROUNDS } from "./application";

async function finish(store: HarnessStore, turnId: string, output = "") {
  await store
    .databaseConnection()
    .prepare("UPDATE turns SET status = 'completed', output = ? WHERE id = ?")
    .run(output, turnId);
}

test("a planning session hands out work, gets reports back and sends feedback", async () => {
  const store = new HarnessStore(":memory:");
  await store.ready;
  try {
    const planner = await store.createSession("business", "Planner", "claude");
    const chip = await store.createSession("tech", "Chip", "codex");
    const plan = await store.submitMessage("plan", planner.id, "Plan the week");

    const { delegation, turn: task } = await store.sendDelegation({
      turnId: "task:1",
      callerTurnId: plan.id,
      toSessionId: chip.id,
      message: "## Close timing\nAdd the pipeline stages.",
    });
    assert.equal(task.sessionId, chip.id);
    assert.equal(delegation.title, "Close timing");
    assert.equal((await store.delegationForTurn(task.id))?.role, "task");
    // Retrying the same tool call does not send the task twice.
    const again = await store.sendDelegation({
      turnId: "task:1",
      callerTurnId: plan.id,
      toSessionId: chip.id,
      message: "## Close timing\nAdd the pipeline stages.",
    });
    assert.equal(again.delegation.id, delegation.id);
    assert.equal((await store.listTurns(chip.id)).length, 1);

    // A worker on a task cannot hand work further.
    await assert.rejects(
      store.sendDelegation({
        turnId: "task:nested",
        callerTurnId: task.id,
        toSessionId: planner.id,
        message: "Do part of it",
      }),
      /subagents/,
    );

    // Progress is visible right away and does not wake the planner.
    await store.reportDelegation(task.id, "progress", "Merge node done.");
    assert.deepEqual(await store.pendingDelegationReports(), []);
    const [working] = await store.delegationsForSession(planner.id);
    assert.equal(working.progress, "Merge node done.");
    assert.equal(working.to.title, "Chip");

    // The final report goes back when the turn ends, exactly once.
    await store.reportDelegation(task.id, "done", "Both stages added.");
    await finish(store, task.id, "raw output");
    assert.deepEqual(await store.pendingDelegationReports(), [task.id]);
    const report = await store.deliverDelegationReport(task.id);
    assert.ok(report);
    assert.equal(report.sessionId, planner.id);
    assert.match(report.prompt, /Report from "Chip".*: done/);
    assert.match(report.prompt, /Both stages added/);
    assert.equal(await store.deliverDelegationReport(task.id), null);
    assert.equal((await store.delegationForTurn(report.id))?.role, "report");

    // The planner rejects the work and sends feedback from the report turn.
    const { turn: feedback, delegation: second } = await store.sendDelegation({
      turnId: "task:2",
      callerTurnId: report.id,
      delegationId: delegation.id,
      message: "The slow corner is missing. Rerun it.",
    });
    assert.equal(second.rounds, 2);
    assert.equal((await store.delegationForTurn(feedback.id))?.role, "reply");

    // Without a report, the worker's final message goes back instead.
    await finish(store, feedback.id, "Reran the slow corner: 702 MHz.");
    const fallback = await store.deliverDelegationReport(feedback.id);
    assert.match(String(fallback?.prompt), /: finished/);
    assert.match(String(fallback?.prompt), /702 MHz/);

    // Back and forth is capped so a task cannot loop forever.
    for (let round = 3; round <= MAX_DELEGATION_ROUNDS; round++)
      await store.sendDelegation({
        turnId: `task:${round}`,
        callerTurnId: report.id,
        delegationId: delegation.id,
        message: `Round ${round}`,
      });
    await assert.rejects(
      store.sendDelegation({
        turnId: "task:over",
        callerTurnId: report.id,
        delegationId: delegation.id,
        message: "Once more",
      }),
      /task_close/,
    );

    // Closed tasks stop reporting.
    await store.closeDelegation(delegation.id, planner.id, "accepted");
    await finish(store, `task:${MAX_DELEGATION_ROUNDS}`);
    assert.equal(
      await store.deliverDelegationReport(`task:${MAX_DELEGATION_ROUNDS}`),
      null,
    );
    const [closed] = await store.delegationsForSession(chip.id);
    assert.equal(closed.state, "accepted");
  } finally {
    await store.close();
  }
});

test("a worker's question to the owner reaches the planner, and the answer stays on the task", async () => {
  const store = new HarnessStore(":memory:");
  await store.ready;
  try {
    const planner = await store.createSession("business", "Planner", "claude");
    const runtime = await store.createSession("tech", "Runtime", "codex");
    const plan = await store.submitMessage("plan", planner.id, "Plan");
    const { turn: task } = await store.sendDelegation({
      turnId: "task:a",
      callerTurnId: plan.id,
      toSessionId: runtime.id,
      message: "Publish the package",
    });
    const input = await store.requestInput(
      "input-1",
      runtime.id,
      task.id,
      "question",
      "May I pay for the npm org?",
    );
    await finish(store, task.id);
    const report = await store.deliverDelegationReport(task.id);
    assert.match(String(report?.prompt), /waiting-on-owner/);
    assert.match(String(report?.prompt), /npm org/);

    await store.answerInput(input.id, "Yes, up to $10.");
    const link = await store.delegationForTurn(`input:${input.id}`);
    assert.equal(link?.role, "reply");
    await finish(store, `input:${input.id}`, "Paid and published.");
    assert.match(
      String(
        (await store.deliverDelegationReport(`input:${input.id}`))?.prompt,
      ),
      /Paid and published/,
    );

    // Deleting the worker session removes its tasks from the planner too.
    const { deleteResource } = await import("./deletion");
    await deleteResource(store.databaseConnection(), "session", runtime.id);
    assert.deepEqual(await store.delegationsForSession(planner.id), []);
  } finally {
    await store.close();
  }
});
