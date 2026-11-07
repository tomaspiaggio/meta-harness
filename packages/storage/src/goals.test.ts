import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGoalChange } from "@harness/core/goals";
import { HarnessStore } from "./application";
import { deleteResource } from "./deletion";

const goal = {
  title: "First circuit board",
  summary: "Design the first circuit board and get a quote",
  why: "Turns the board's cost into a number.",
  steps: [
    { label: "Draw the circuit", status: "working" },
    { label: "Get a quote", status: "todo" },
  ],
  change: "Started from the chip's pin list",
  decisions: [{ text: "Ten layers, for solid power planes", by: "Planner" }],
};

test("goals keep their history, people and the owner's open questions", async () => {
  const store = new HarnessStore(":memory:");
  try {
    const planner = await store.createSession("tech", "Planner", "demo");
    const worker = await store.createSession("tech", "Board design", "demo");
    const created = await store.goals.create(
      "goal-1",
      "tech",
      planner.id,
      parseGoalChange(goal),
      1000,
    );
    // A retried create returns the first goal instead of a second one.
    assert.equal(
      (
        await store.goals.create(
          "goal-1",
          "tech",
          planner.id,
          parseGoalChange(goal),
          2000,
        )
      ).createdAt,
      1000,
    );
    await assert.rejects(
      store.goals.update(
        created.id,
        "other",
        parseGoalChange({ change: "x" }, created),
      ),
      /another workspace/,
    );
    const turn = await store.createTurn("ask", planner.id, "plan it");
    const delegation = (
      await store.sendDelegation({
        turnId: "task:board",
        callerTurnId: turn.id,
        message: "Draw the circuit",
        toSessionId: worker.id,
      })
    ).delegation;
    await store.goals.link("task", delegation.id, created.id);
    await store.requestInput(
      "input-login",
      worker.id,
      null,
      "browser-login",
      "Sign in to the board maker",
    );
    const [need] = await store.goals.needs();
    assert.equal(need.goalId, created.id, "a worker's question joins its goal");
    assert.deepEqual(
      (await store.goals.people(created)).map((person) => [
        person.title,
        person.planner,
        person.working,
      ]),
      [
        ["Planner", true, false],
        ["Board design", false, true],
      ],
    );
    const finished = await store.goals.update(
      created.id,
      "tech",
      parseGoalChange(
        {
          status: "done",
          steps: [
            { label: "Draw the circuit", status: "done", answer: "Drawn." },
            { label: "Get a quote", status: "done", answer: "$1,200 for 5." },
          ],
          change: "Quote received",
        },
        created,
      ),
      5000,
    );
    assert.equal(finished.finishedAt, 5000);
    assert.deepEqual(
      (await store.goals.events(created.id)).map((event) => [
        event.kind,
        event.done,
        event.total,
      ]),
      [
        ["started", 0, 2],
        ["decision", 0, 2],
        ["finished", 2, 2],
      ],
    );
    assert.equal((await store.goals.list({ endedSince: 6000 })).length, 0);
    assert.equal((await store.goals.list({ endedSince: 4000 })).length, 1);
    await deleteResource(store.databaseConnection(), "session", planner.id);
    await assert.rejects(store.goals.get(created.id), /not found/);
    assert.deepEqual(await store.goals.eventsSince(0), []);
  } finally {
    await store.close();
  }
});
