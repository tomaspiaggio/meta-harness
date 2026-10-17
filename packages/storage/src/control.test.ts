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

test("Claude native transcripts deduplicate UUIDs and enable transfer only at a complete checkpoint", () => {
  const store = new ControlStore(":memory:");
  try {
    const mac = enroll(store, "mac");
    const pi = enroll(store, "pi");
    store.reportWorker(mac.id, {
      ...report,
      portableProviders: ["demo", "claude"],
    });
    store.reportWorker(pi.id, {
      ...report,
      portableProviders: ["demo", "claude"],
    });
    const work = task(store, "portable-claude", 0, "claude");
    const first = store.claimForWorker(mac.id);
    assert.ok(first);
    const { id, generation } = first.claim.turn;
    const key = {
      projectKey: `meta-harness-${work.sessionId}`,
      sessionId: "native-claude",
    };
    const entries = [
      { type: "user", uuid: "entry-1", message: "remember a fact" },
    ];
    store.appendNative(mac.id, id, generation, "batch-1", key, entries);
    store.appendNative(mac.id, id, generation, "batch-1", key, entries);
    store.appendNative(mac.id, id, generation, "batch-2", key, entries);
    assert.deepEqual(store.loadNative(mac.id, id, generation, key), entries);
    assert.throws(
      () => store.loadNative(pi.id, id, generation, key),
      /another worker/,
    );
    assert.throws(
      () =>
        store.appendNative(mac.id, id, generation, "batch-3", key, [
          { ...entries[0], message: "changed" },
        ]),
      /UUID reused/,
    );
    store.appendNative(
      mac.id,
      id,
      generation,
      "subagent",
      { ...key, subpath: "subagents/agent-1" },
      [{ type: "assistant", uuid: "sub-1" }],
    );
    assert.deepEqual(store.nativeSubkeys(mac.id, id, generation, key), [
      "subagents/agent-1",
    ]);
    store.saveCheckpoint(mac.id, id, generation, "native-checkpoint", {
      version: 1,
      files: [],
    });
    store.completeWorkerTurn(mac.id, id, generation, "completed");
    store.createTurn("native-follow-up", work.sessionId, "Continue elsewhere.");
    store.enqueue("native-follow-up");
    const second = store.claimForWorker(pi.id);
    assert.equal(second?.claim.turn.id, "native-follow-up");
    assert.ok(second);
    assert.deepEqual(
      store.loadNative(
        pi.id,
        second.claim.turn.id,
        second.claim.turn.generation,
        key,
      ),
      entries,
    );
    assert.throws(
      () =>
        store.loadNative(
          pi.id,
          second.claim.turn.id,
          second.claim.turn.generation,
          { ...key, projectKey: "another-project" },
        ),
      /outside/,
    );
  } finally {
    store.close();
  }
});

test("a newer transcript invalidates a file checkpoint and blocks native relocation", () => {
  const store = new ControlStore(":memory:");
  try {
    const mac = enroll(store, "mac");
    const pi = enroll(store, "pi");
    store.reportWorker(pi.id, { ...report, portableProviders: ["claude"] });
    const work = task(store, "partial-native", 0, "claude");
    const first = store.claimForWorker(mac.id);
    assert.ok(first);
    const { id, generation } = first.claim.turn;
    const key = {
      projectKey: `meta-harness-${work.sessionId}`,
      sessionId: "partial-claude",
    };
    store.appendNative(mac.id, id, generation, "first", key, [
      { type: "user", uuid: "one" },
    ]);
    store.saveCheckpoint(mac.id, id, generation, "before-late-write", {
      version: 1,
      files: [],
    });
    store.appendNative(mac.id, id, generation, "second", key, [
      { type: "assistant", uuid: "two" },
    ]);
    assert.throws(
      () => store.completeWorkerTurn(mac.id, id, generation, "completed"),
      /advanced/,
    );
    store.completeWorkerTurn(
      mac.id,
      id,
      generation,
      "failed",
      "Needs reconciliation",
    );
    store.createTurn("reconcile", work.sessionId, "Inspect and reconcile.");
    store.enqueue("reconcile");
    assert.equal(store.claimForWorker(pi.id), null);
    assert.equal(store.claimForWorker(mac.id)?.claim.turn.id, "reconcile");
  } finally {
    store.close();
  }
});

test("provider cooldowns hold affected queued work while other providers continue", () => {
  const store = new ControlStore(":memory:");
  try {
    const worker = enroll(store);
    task(store, "limited", 0, "claude");
    const active = store.claimForWorker(worker.id);
    assert.ok(active);
    store.coolDownProvider(
      worker.id,
      active.claim.turn.id,
      active.claim.turn.generation,
      Date.now() + 60_000,
      "Usage limit",
    );
    store.completeWorkerTurn(
      worker.id,
      active.claim.turn.id,
      active.claim.turn.generation,
      "failed",
      "Usage limit",
    );
    const held = task(store, "queued-claude", 10, "claude");
    const available = task(store, "available-demo");
    assert.equal(
      store.claimForWorker(worker.id)?.claim.session.id,
      available.sessionId,
    );
    assert.match(
      store.listTasks().find((item) => item.id === held.id)?.waitingReason ??
        "",
      /provider reset/,
    );
  } finally {
    store.close();
  }
});
