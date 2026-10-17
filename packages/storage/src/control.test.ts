import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkerReport } from "@harness/core/scheduling";
import { ControlStore } from "./control";

const report: WorkerReport = {
  hostname: "bench",
  providers: ["demo", "claude"],
  labels: [],
  maxAgents: 3,
  memoryBudgetMiB: 4096,
  cpuSlots: 4,
  maxBuilds: 1,
  maxBrowsers: 1,
  availableMemoryMiB: 8192,
  reserveMemoryMiB: 1024,
  loadPerCpu: 0.1,
  maxLoadPerCpu: 1,
  draining: false,
};
const task = (
  store: ControlStore,
  id: string,
  priority = 0,
  provider: "demo" | "claude" = "demo",
) => {
  const result = store.createTask({
    id,
    workspaceId: "tech",
    title: id,
    objective: `Investigate ${id}`,
    provider,
    profile: "standard",
    priority,
  });
  for (const turn of store.pendingDispatch()) store.enqueue(turn);
  return result;
};
const enroll = (store: ControlStore, name = "worker") => {
  const identity = store.createWorker(name);
  store.reportWorker(identity.id, report);
  return identity;
};

test("tasks are durable and idempotent; priorities and pause control admission", () => {
  const store = new ControlStore(":memory:");
  try {
    const worker = enroll(store);
    const low = task(store, "low", -10);
    const high = task(store, "high", 10);
    assert.equal(task(store, "high", 10).sessionId, high.sessionId);
    store.updateTask(high.id, { paused: true });
    assert.equal(
      store.claimForWorker(worker.id)?.claim.session.id,
      low.sessionId,
    );
    assert.equal(
      store.listTasks().find((item) => item.id === high.id)?.status,
      "paused",
    );
    store.updateTask(high.id, { paused: false });
    assert.equal(
      store.claimForWorker(worker.id)?.claim.session.id,
      high.sessionId,
    );
  } finally {
    store.close();
  }
});

test("lost claim and event acknowledgements cannot duplicate execution or output", () => {
  const store = new ControlStore(":memory:");
  try {
    const worker = enroll(store);
    task(store, "one");
    task(store, "two");
    const first = store.claimForWorker(worker.id, Date.now(), "stable-claim");
    assert.ok(first);
    const retry = store.claimForWorker(worker.id, Date.now(), "stable-claim");
    assert.equal(retry?.claim.turn.id, first.claim.turn.id);
    const { id, generation } = first.claim.turn;
    store.applyWorkerEvent(worker.id, id, generation, 1, {
      type: "text",
      text: "only once",
    });
    store.applyWorkerEvent(worker.id, id, generation, 1, {
      type: "text",
      text: "only once",
    });
    assert.equal(store.getTurn(id).output, "only once");
    assert.throws(
      () =>
        store.applyWorkerEvent(worker.id, id, generation, 1, {
          type: "text",
          text: "different",
        }),
      /different content/,
    );
    assert.throws(
      () =>
        store.applyWorkerEvent(worker.id, id, generation, 3, {
          type: "text",
          text: "skipped",
        }),
      /out of order/,
    );
  } finally {
    store.close();
  }
});

test("worker credentials and ownership are scoped independently", () => {
  const store = new ControlStore(":memory:");
  try {
    const first = enroll(store);
    const second = enroll(store);
    store.authenticateWorker(first.id, first.token);
    assert.throws(
      () => store.authenticateWorker(first.id, second.token),
      /credential/,
    );
    task(store, "private");
    const claim = store.claimForWorker(first.id);
    assert.ok(claim);
    assert.throws(
      () =>
        store.applyWorkerEvent(
          second.id,
          claim.claim.turn.id,
          claim.claim.turn.generation,
          1,
          { type: "text", text: "foreign" },
        ),
      /another worker/,
    );
    store.revokeWorker(first.id);
    assert.throws(
      () => store.authenticateWorker(first.id, first.token),
      /credential/,
    );
  } finally {
    store.close();
  }
});

test("a lost Demo attempt restores the checkpoint output and fences the old generation", () => {
  const store = new ControlStore(":memory:");
  try {
    const mac = enroll(store, "mac");
    const pi = enroll(store, "pi");
    const work = task(store, "checkpointed");
    const first = store.claimForWorker(mac.id);
    assert.ok(first);
    const { id, generation } = first.claim.turn;
    store.applyWorkerEvent(mac.id, id, generation, 1, {
      type: "native-session",
      id: "native-demo",
    });
    store.applyWorkerEvent(mac.id, id, generation, 2, {
      type: "text",
      text: "durable",
    });
    store.saveCheckpoint(mac.id, id, generation, "checkpoint-1", {
      version: 1,
      files: [],
    });
    store.applyWorkerEvent(mac.id, id, generation, 3, {
      type: "text",
      text: "not-checkpointed",
    });
    store.recoverExpired(Date.now() + 60_000);
    assert.equal(store.getTurn(id).output, "durable");
    assert.throws(
      () =>
        store.applyWorkerEvent(mac.id, id, generation, 4, {
          type: "text",
          text: "stale",
        }),
      /ownership/,
    );
    const next = store.claimForWorker(pi.id);
    assert.equal(next?.claim.session.id, work.sessionId);
    assert.equal(next?.checkpoint?.id, "checkpoint-1");
    assert.equal(next?.claim.session.nativeId, "native-demo");
    assert.ok(next);
    store.completeWorkerTurn(
      pi.id,
      id,
      next.claim.turn.generation,
      "completed",
    );
    store.completeWorkerTurn(
      pi.id,
      id,
      next.claim.turn.generation,
      "completed",
    );
    assert.equal(store.getTurn(id).status, "completed");
  } finally {
    store.close();
  }
});

test("native agent interruptions never replay, and continuation remains on its original worker", () => {
  const store = new ControlStore(":memory:");
  try {
    const mac = enroll(store, "mac");
    const pi = enroll(store, "pi");
    const work = task(store, "native", 0, "claude");
    const attempt = store.claimForWorker(mac.id);
    assert.ok(attempt);
    store.applyWorkerEvent(
      mac.id,
      attempt.claim.turn.id,
      attempt.claim.turn.generation,
      1,
      { type: "native-session", id: "claude-native" },
    );
    store.recoverExpired(Date.now() + 60_000);
    assert.equal(store.getTurn(attempt.claim.turn.id).status, "interrupted");
    assert.equal(store.claimForWorker(pi.id), null);
    store.createTurn(
      "follow-up",
      work.sessionId,
      "Continue after inspecting partial work.",
    );
    store.enqueue("follow-up");
    assert.equal(store.claimForWorker(pi.id), null);
    assert.match(
      store
        .listTasks()
        .find((item) => item.id === work.id)
        ?.workers.find((item) => item.workerId === pi.id)?.reason ?? "",
      /pinned/,
    );
    assert.equal(store.claimForWorker(mac.id)?.claim.turn.id, "follow-up");
  } finally {
    store.close();
  }
});

test("unavailable heavy work does not block an eligible light task", () => {
  const store = new ControlStore(":memory:");
  try {
    const worker = enroll(store);
    store.reportWorker(worker.id, {
      ...report,
      memoryBudgetMiB: 128,
      maxAgents: 1,
    });
    const heavy = store.createTask({
      id: "build",
      title: "Build",
      objective: "Build something",
      workspaceId: "tech",
      provider: "demo",
      profile: "build",
      priority: 10,
    });
    const light = task(store, "light");
    assert.equal(
      store.claimForWorker(worker.id)?.claim.session.id,
      light.sessionId,
    );
    assert.match(
      store.listTasks().find((item) => item.id === heavy.id)?.waitingReason ??
        "",
      /slots|reservations/,
    );
  } finally {
    store.close();
  }
});
