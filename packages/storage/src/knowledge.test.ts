import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkerReport } from "@harness/core/scheduling";
import { ControlStore } from "./control";

const report: WorkerReport = {
  hostname: "test",
  providers: ["codex"],
  labels: [],
  maxAgents: 3,
  memoryBudgetMiB: 4096,
  cpuSlots: 4,
  maxBuilds: 1,
  maxBrowsers: 1,
  availableMemoryMiB: 8192,
  reserveMemoryMiB: 1024,
  loadPerCpu: 0,
  maxLoadPerCpu: 1,
  draining: false,
};
async function claim(
  store: ControlStore,
  workerId: string,
  workspaceId: string,
  sessionId?: string,
) {
  const session =
    sessionId ??
    (await store.createSession(workspaceId, "Knowledge", "codex")).id;
  const id = crypto.randomUUID();
  await store.createTurn(id, session, "Check shared decisions");
  await store.enqueue(id);
  const assignment = await store.claimForWorker(workerId);
  assert.ok(assignment);
  return assignment.claim;
}
test("decisions cross workspaces and refresh resumed sessions; completion is idempotent", async () => {
  const store = new ControlStore(":memory:");
  try {
    const worker = await store.createWorker("test");
    await store.reportWorker(worker.id, report);
    const tech = await claim(store, worker.id, "tech");
    assert.equal(
      (
        await store.readWorkerDecisions(
          worker.id,
          tech.turn.id,
          tech.turn.generation,
        )
      ).decisions.length,
      0,
    );
    await store.completeWorkerTurn(
      worker.id,
      tech.turn.id,
      tech.turn.generation,
      "completed",
      undefined,
      [
        {
          key: "business.pilot-price",
          content: "The Business pilot price is $173.",
          expectedRevision: 0,
        },
      ],
    );
    const business = await claim(store, worker.id, "business");
    const first = await store.readWorkerDecisions(
      worker.id,
      business.turn.id,
      business.turn.generation,
    );
    assert.equal(
      first.decisions[0].content,
      "The Business pilot price is $173.",
    );
    assert.equal(first.decisions[0].workspaceId, "tech");
    await store.completeWorkerTurn(
      worker.id,
      business.turn.id,
      business.turn.generation,
      "completed",
    );
    const update = await claim(store, worker.id, "tech", tech.session.id);
    await store.readWorkerDecisions(
      worker.id,
      update.turn.id,
      update.turn.generation,
    );
    const changes = [
      {
        key: "business.pilot-price",
        content: "The Business pilot price is $219.",
        expectedRevision: 1,
      },
    ];
    await store.completeWorkerTurn(
      worker.id,
      update.turn.id,
      update.turn.generation,
      "completed",
      undefined,
      changes,
    );
    await store.completeWorkerTurn(
      worker.id,
      update.turn.id,
      update.turn.generation,
      "completed",
      undefined,
      changes,
    );
    const resumed = await claim(
      store,
      worker.id,
      "business",
      business.session.id,
    );
    const current = await store.readWorkerDecisions(
      worker.id,
      resumed.turn.id,
      resumed.turn.generation,
    );
    assert.equal(current.decisions[0].revision, 2);
    assert.match(current.decisions[0].content ?? "", /219/);
  } finally {
    await store.close();
  }
});
test("concurrent stale updates and old ownership cannot change accepted decisions", async () => {
  const store = new ControlStore(":memory:");
  try {
    const worker = await store.createWorker("test");
    await store.reportWorker(worker.id, report);
    const a = await claim(store, worker.id, "tech"),
      b = await claim(store, worker.id, "business");
    for (const c of [a, b])
      await store.readWorkerDecisions(worker.id, c.turn.id, c.turn.generation);
    await store.completeWorkerTurn(
      worker.id,
      a.turn.id,
      a.turn.generation,
      "completed",
      undefined,
      [{ key: "price", content: "173", expectedRevision: 0 }],
    );
    await assert.rejects(
      async () =>
        await store.completeWorkerTurn(
          worker.id,
          b.turn.id,
          b.turn.generation,
          "completed",
          undefined,
          [{ key: "price", content: "219", expectedRevision: 0 }],
        ),
      /changed.*revision/i,
    );
    assert.equal((await store.getTurn(b.turn.id)).status, "running");
    assert.equal(
      (await store.getSharedDecisions()).decisions[0].content,
      "173",
    );
    await assert.rejects(
      async () =>
        await store.readWorkerDecisions(
          worker.id,
          a.turn.id,
          a.turn.generation,
        ),
      /ownership/i,
    );
    await assert.rejects(
      async () =>
        await store.readWorkerDecisions(
          "different-worker",
          b.turn.id,
          b.turn.generation,
        ),
      /another worker/i,
    );
  } finally {
    await store.close();
  }
});
test("withdrawals supersede old values and a conflicting batch rolls back every update", async () => {
  const store = new ControlStore(":memory:");
  try {
    const worker = await store.createWorker("test");
    await store.reportWorker(worker.id, report);
    await store.importSharedDecision(
      { key: "price", content: "173", expectedRevision: 0 },
      "tech",
    );
    const withdrawal = await claim(store, worker.id, "tech");
    await store.readWorkerDecisions(
      worker.id,
      withdrawal.turn.id,
      withdrawal.turn.generation,
    );
    await store.completeWorkerTurn(
      worker.id,
      withdrawal.turn.id,
      withdrawal.turn.generation,
      "completed",
      undefined,
      [{ key: "price", content: null, expectedRevision: 1 }],
    );
    const reader = await claim(store, worker.id, "business");
    assert.equal(
      (
        await store.readWorkerDecisions(
          worker.id,
          reader.turn.id,
          reader.turn.generation,
        )
      ).decisions[0].content,
      null,
    );
    await assert.rejects(
      async () =>
        await store.completeWorkerTurn(
          worker.id,
          reader.turn.id,
          reader.turn.generation,
          "completed",
          undefined,
          [
            {
              key: "unrelated",
              content: "Must roll back",
              expectedRevision: 0,
            },
            { key: "price", content: "Bad revision", expectedRevision: 99 },
          ],
        ),
      /consumed revision/,
    );
    assert.equal((await store.getSharedDecisions()).decisions.length, 1);
    assert.equal((await store.getSharedDecisions()).decisions[0].revision, 2);
    await store.completeWorkerTurn(
      worker.id,
      reader.turn.id,
      reader.turn.generation,
      "failed",
      "conflict",
    );
    assert.equal((await store.decisionsForTurn(reader.turn.id)).length, 0);
  } finally {
    await store.close();
  }
});
