import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executeTurn } from "@harness/core";
import type { WorkerReport } from "@harness/core/scheduling";
import { ControlStore } from "./control";

const report: WorkerReport = {
  hostname: "fixture",
  providers: ["claude", "demo"],
  labels: [],
  maxAgents: 3,
  memoryBudgetMiB: 8192,
  cpuSlots: 4,
  maxBuilds: 1,
  maxBrowsers: 1,
  availableMemoryMiB: 16384,
  reserveMemoryMiB: 1024,
  loadPerCpu: 0,
  maxLoadPerCpu: 1,
  draining: false,
};
async function worker(store: ControlStore) {
  const identity = await store.createWorker("fixture");
  await store.reportWorker(identity.id, report);
  return identity.id;
}
test("independent workers preserve FIFO even when later messages dispatch first", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-controls-"));
  const path = join(directory, "control.sqlite");
  const first = new ControlStore(path);
  const second = new ControlStore(path);
  try {
    const one = await worker(first);
    const two = await worker(second);
    const session = await first.createSession("tech", "Queue", "claude");
    await first.createTurn("a", session.id, "First");
    await first.createTurn("b", session.id, "Feedback");
    assert.equal(
      (await first.listTasks())[0].turnId,
      "a",
      "board controls target the first waiting message",
    );
    await first.enqueue("b");
    assert.equal(await second.claimForWorker(two), null);
    await first.enqueue("a");
    const claim = await second.claimForWorker(two);
    assert.ok(claim);
    assert.equal(claim.claim.turn.id, "a");
    assert.equal(await first.claimForWorker(one), null);
    assert.match((await first.waitingReason("b")) ?? "", /preceding/);
    await second.completeWorkerTurn(
      two,
      "a",
      claim.claim.turn.generation,
      "completed",
    );
    assert.equal((await first.claimForWorker(one))?.claim.turn.id, "b");
  } finally {
    await first.close();
    await second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("stop persists across restart, waits for acknowledgment, and wins a completion race", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-stop-"));
  const path = join(directory, "control.sqlite");
  let store = new ControlStore(path);
  try {
    const id = await worker(store);
    const session = await store.createSession("tech", "Stop", "claude");
    await store.createTurn("running", session.id, "Work");
    await store.enqueue("running");
    const assignment = await store.claimForWorker(id);
    assert.ok(assignment);
    const generation = assignment.claim.turn.generation;
    await store.applyWorkerEvent(id, "running", generation, 1, {
      type: "text",
      text: "partial",
    });
    const stopped = await store.requestStop("running");
    assert.equal(stopped.status, "running", "not acknowledged yet");
    assert.ok(stopped.stopRequestedAt);
    await store.close();
    store = new ControlStore(path);
    assert.equal(
      (await store.heartbeatWorkerTurn(id, "running", generation))
        .stopRequested,
      true,
    );
    await store.completeWorkerTurn(
      id,
      "running",
      generation,
      "completed",
      undefined,
      [{ key: "must.not.publish", content: "stopped", expectedRevision: 0 }],
    );
    assert.equal((await store.getTurn("running")).status, "interrupted");
    assert.equal((await store.getTurn("running")).output, "partial");
    assert.equal((await store.getSharedDecisions()).decisions.length, 0);
    await store.completeWorkerTurn(id, "running", generation, "completed");
    await assert.rejects(
      async () =>
        await store.applyWorkerEvent(id, "running", generation, 2, {
          type: "text",
          text: "late",
        }),
      /ownership/,
    );
    assert.equal((await store.requestStop("running")).status, "interrupted");
    assert.equal(await store.claimForWorker(id), null);
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("interrupt-and-send is atomic, idempotent and cannot target another session", async () => {
  const store = new ControlStore(":memory:");
  try {
    const session = await store.createSession("tech", "Feedback", "claude");
    const other = await store.createSession("tech", "Other", "claude");
    await store.createTurn("first", session.id, "Work");
    await store.createTurn("foreign", other.id, "Work");
    await assert.rejects(
      async () =>
        await store.createTurn("bad", session.id, "Correction", "foreign"),
      /another session/,
    );
    await assert.rejects(async () => await store.getTurn("bad"), /not found/);
    assert.equal((await store.getTurn("foreign")).stopRequestedAt, null);
    const next = await store.createTurn(
      "next",
      session.id,
      "Correction",
      "first",
    );
    assert.equal((await store.getTurn("first")).status, "interrupted");
    assert.deepEqual(
      await store.createTurn("next", session.id, "Correction", "first"),
      next,
    );
    await assert.rejects(
      async () => await store.createTurn("next", session.id, "Correction"),
      /different input/,
    );
  } finally {
    await store.close();
  }
});
test("explicitly stopped Demo work is not recovered after its worker disappears", async () => {
  const store = new ControlStore(":memory:");
  try {
    const id = await worker(store);
    const session = await store.createSession("tech", "Demo", "demo");
    await store.createTurn("demo", session.id, "Work");
    await store.enqueue("demo");
    await store.claimForWorker(id);
    await store.requestStop("demo");
    await store.recoverExpired(Date.now() + 240000);
    assert.equal((await store.getTurn("demo")).status, "interrupted");
    assert.equal(await store.claimForWorker(id), null);
  } finally {
    await store.close();
  }
});
test("manual names are validated, persisted and reflected on the task board", async () => {
  const store = new ControlStore(":memory:");
  try {
    const session = await store.createSession("tech", "Long prompt", "claude");
    await store.createTurn("rename", session.id, "Work");
    assert.equal(
      (await store.renameSession(session.id, "  Pilot pricing  ")).titleSource,
      "manual",
    );
    assert.equal((await store.getSession(session.id)).title, "Pilot pricing");
    assert.equal((await store.listTasks())[0].title, "Pilot pricing");
    await assert.rejects(
      async () => await store.renameSession(session.id, " "),
      /Title/,
    );
  } finally {
    await store.close();
  }
});
test("a cooperative runtime returning after abort cannot complete successfully", async () => {
  const store = new ControlStore(":memory:");
  try {
    const session = await store.createSession("tech", "Abort", "claude");
    await store.createTurn("abort", session.id, "Work");
    await store.enqueue("abort");
    const claim = await store.claim("fixture", Date.now(), 30000);
    assert.ok(claim);
    const controller = new AbortController();
    await executeTurn(
      store,
      claim,
      {
        async run() {
          controller.abort(new Error("Stopped"));
        },
      },
      "/unused",
      controller.signal,
    );
    assert.equal((await store.getTurn("abort")).status, "interrupted");
  } finally {
    await store.close();
  }
});
test("unread cursors survive restart and cannot clear a result arriving after the viewed snapshot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-unread-"));
  const path = join(directory, "control.sqlite");
  let store = new ControlStore(path);
  try {
    const id = await worker(store);
    const session = await store.createSession("tech", "Read later", "claude");
    const other = await store.createSession(
      "tech",
      "Another session",
      "claude",
    );
    await store.createTurn("first", session.id, "Work");
    await store.enqueue("first");
    const claim = await store.claimForWorker(id);
    assert.ok(claim);
    await store.completeWorkerTurn(
      id,
      "first",
      claim.claim.turn.generation,
      "completed",
    );
    const viewed = (await store.getSession(session.id)).attentionSequence ?? 0;
    assert.equal((await store.getSession(session.id)).unreadCount, 1);
    assert.equal((await store.listSessions("tech"))[0].id, session.id);
    await store.createTurn("second", session.id, "Next");
    await store.requestStop("second");
    await store.markSessionRead(session.id, viewed);
    assert.equal((await store.getSession(session.id)).unreadCount, 1);
    await store.close();
    store = new ControlStore(path);
    assert.equal((await store.getSession(session.id)).unreadCount, 1);
    await store.markSessionRead(session.id, 0);
    assert.equal(
      (await store.getSession(session.id)).unreadCount,
      1,
      "old device must not regress the cursor",
    );
    assert.equal((await store.getSession(other.id)).unreadCount, 0);
    await store.markSessionRead(session.id, Number.MAX_SAFE_INTEGER);
    assert.equal((await store.getSession(session.id)).unreadCount, 0);
    await store.createTurn("third", session.id, "After read");
    await store.requestStop("third");
    assert.equal(
      (await store.getSession(session.id)).unreadCount,
      1,
      "future cursors are bounded to existing results",
    );
    await assert.rejects(
      async () => await store.markSessionRead(session.id, -1),
      /cursor/,
    );
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
