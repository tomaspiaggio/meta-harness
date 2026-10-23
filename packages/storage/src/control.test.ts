import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
const task = async (
  store: ControlStore,
  id: string,
  priority = 0,
  provider: "demo" | "claude" = "demo",
) => {
  const result = await store.createTask({
    id,
    workspaceId: "tech",
    title: id,
    objective: `Investigate ${id}`,
    provider,
    profile: "standard",
    priority,
  });
  for (const turn of await store.pendingDispatch()) await store.enqueue(turn);
  return result;
};
const enroll = async (store: ControlStore, name = "worker") => {
  const identity = await store.createWorker(name);
  await store.reportWorker(identity.id, report);
  return identity;
};
test("tasks are durable and idempotent; priorities and pause control admission", async () => {
  const store = new ControlStore(":memory:");
  try {
    const worker = await enroll(store);
    const low = await task(store, "low", -10);
    const high = await task(store, "high", 10);
    assert.equal((await task(store, "high", 10)).sessionId, high.sessionId);
    await store.updateTask(high.id, { paused: true });
    assert.equal(
      (await store.claimForWorker(worker.id))?.claim.session.id,
      low.sessionId,
    );
    assert.equal(
      (await store.listTasks()).find((item) => item.id === high.id)?.status,
      "paused",
    );
    await store.updateTask(high.id, { paused: false });
    assert.equal(
      (await store.claimForWorker(worker.id))?.claim.session.id,
      high.sessionId,
    );
  } finally {
    await store.close();
  }
});
test("lost claim and event acknowledgements cannot duplicate execution or output", async () => {
  const store = new ControlStore(":memory:");
  try {
    const worker = await enroll(store);
    await task(store, "one");
    await task(store, "two");
    const first = await store.claimForWorker(
      worker.id,
      Date.now(),
      "stable-claim",
    );
    assert.ok(first);
    const retry = await store.claimForWorker(
      worker.id,
      Date.now(),
      "stable-claim",
    );
    assert.equal(retry?.claim.turn.id, first.claim.turn.id);
    const { id, generation } = first.claim.turn;
    await store.applyWorkerEvent(worker.id, id, generation, 1, {
      type: "text",
      text: "only once",
    });
    await store.applyWorkerEvent(worker.id, id, generation, 1, {
      type: "text",
      text: "only once",
    });
    assert.equal((await store.getTurn(id)).output, "only once");
    await assert.rejects(
      async () =>
        await store.applyWorkerEvent(worker.id, id, generation, 1, {
          type: "text",
          text: "different",
        }),
      /different content/,
    );
    await assert.rejects(
      async () =>
        await store.applyWorkerEvent(worker.id, id, generation, 3, {
          type: "text",
          text: "skipped",
        }),
      /out of order/,
    );
  } finally {
    await store.close();
  }
});
test("worker credentials and ownership are scoped independently", async () => {
  const store = new ControlStore(":memory:");
  try {
    const first = await enroll(store);
    const second = await enroll(store);
    await store.authenticateWorker(first.id, first.token);
    await assert.rejects(
      async () => await store.authenticateWorker(first.id, second.token),
      /credential/,
    );
    await task(store, "private");
    const claim = await store.claimForWorker(first.id);
    assert.ok(claim);
    await assert.rejects(
      async () =>
        await store.applyWorkerEvent(
          second.id,
          claim.claim.turn.id,
          claim.claim.turn.generation,
          1,
          { type: "text", text: "foreign" },
        ),
      /another worker/,
    );
    await store.revokeWorker(first.id);
    await assert.rejects(
      async () => await store.authenticateWorker(first.id, first.token),
      /credential/,
    );
  } finally {
    await store.close();
  }
});
test("a lost Demo attempt restores the checkpoint output and fences the old generation", async () => {
  const store = new ControlStore(":memory:");
  try {
    const mac = await enroll(store, "mac");
    const pi = await enroll(store, "pi");
    const work = await task(store, "checkpointed");
    const first = await store.claimForWorker(mac.id);
    assert.ok(first);
    const { id, generation } = first.claim.turn;
    await store.applyWorkerEvent(mac.id, id, generation, 1, {
      type: "native-session",
      id: "native-demo",
    });
    await store.applyWorkerEvent(mac.id, id, generation, 2, {
      type: "text",
      text: "durable",
    });
    await store.saveCheckpoint(mac.id, id, generation, "checkpoint-1", {
      version: 1,
      files: [],
    });
    await store.applyWorkerEvent(mac.id, id, generation, 3, {
      type: "text",
      text: "not-checkpointed",
    });
    await store.recoverExpired(Date.now() + 60000);
    assert.equal((await store.getTurn(id)).output, "durable");
    await assert.rejects(
      async () =>
        await store.applyWorkerEvent(mac.id, id, generation, 4, {
          type: "text",
          text: "stale",
        }),
      /ownership/,
    );
    const next = await store.claimForWorker(pi.id);
    assert.equal(next?.claim.session.id, work.sessionId);
    assert.equal(next?.checkpoint?.id, "checkpoint-1");
    assert.equal(next?.claim.session.nativeId, "native-demo");
    assert.ok(next);
    await store.completeWorkerTurn(
      pi.id,
      id,
      next.claim.turn.generation,
      "completed",
    );
    await store.completeWorkerTurn(
      pi.id,
      id,
      next.claim.turn.generation,
      "completed",
    );
    assert.equal((await store.getTurn(id)).status, "completed");
  } finally {
    await store.close();
  }
});
test("native agent interruptions never replay, and continuation remains on its original worker", async () => {
  const store = new ControlStore(":memory:");
  try {
    const mac = await enroll(store, "mac");
    const pi = await enroll(store, "pi");
    const work = await task(store, "native", 0, "claude");
    const attempt = await store.claimForWorker(mac.id);
    assert.ok(attempt);
    await store.applyWorkerEvent(
      mac.id,
      attempt.claim.turn.id,
      attempt.claim.turn.generation,
      1,
      { type: "native-session", id: "claude-native" },
    );
    await store.recoverExpired(Date.now() + 60000);
    assert.equal(
      (await store.getTurn(attempt.claim.turn.id)).status,
      "interrupted",
    );
    assert.equal(await store.claimForWorker(pi.id), null);
    await store.createTurn(
      "follow-up",
      work.sessionId,
      "Continue after inspecting partial work.",
    );
    await store.enqueue("follow-up");
    assert.equal(await store.claimForWorker(pi.id), null);
    assert.match(
      (await store.listTasks())
        .find((item) => item.id === work.id)
        ?.workers.find((item) => item.workerId === pi.id)?.reason ?? "",
      /pinned/,
    );
    assert.equal(
      (await store.claimForWorker(mac.id))?.claim.turn.id,
      "follow-up",
    );
  } finally {
    await store.close();
  }
});
test("unavailable heavy work does not block an eligible light task", async () => {
  const store = new ControlStore(":memory:");
  try {
    const worker = await enroll(store);
    await store.reportWorker(worker.id, {
      ...report,
      memoryBudgetMiB: 128,
      maxAgents: 1,
    });
    const heavy = await store.createTask({
      id: "build",
      title: "Build",
      objective: "Build something",
      workspaceId: "tech",
      provider: "demo",
      profile: "build",
      priority: 10,
    });
    const light = await task(store, "light");
    assert.equal(
      (await store.claimForWorker(worker.id))?.claim.session.id,
      light.sessionId,
    );
    assert.match(
      (await store.listTasks()).find((item) => item.id === heavy.id)
        ?.waitingReason ?? "",
      /slots|reservations/,
    );
  } finally {
    await store.close();
  }
});
test("Claude native transcripts deduplicate UUIDs and enable transfer only at a complete checkpoint", async () => {
  const store = new ControlStore(":memory:");
  try {
    const mac = await enroll(store, "mac");
    const pi = await enroll(store, "pi");
    await store.reportWorker(mac.id, {
      ...report,
      portableProviders: ["demo", "claude"],
    });
    await store.reportWorker(pi.id, {
      ...report,
      portableProviders: ["demo", "claude"],
    });
    const work = await task(store, "portable-claude", 0, "claude");
    const first = await store.claimForWorker(mac.id);
    assert.ok(first);
    const { id, generation } = first.claim.turn;
    const key = {
      projectKey: `meta-harness-${work.sessionId}`,
      sessionId: "native-claude",
    };
    const entries = [
      { type: "user", uuid: "entry-1", message: "remember a fact" },
    ];
    await store.appendNative(mac.id, id, generation, "batch-1", key, entries);
    await store.appendNative(mac.id, id, generation, "batch-1", key, entries);
    await store.appendNative(mac.id, id, generation, "batch-2", key, entries);
    assert.deepEqual(
      await store.loadNative(mac.id, id, generation, key),
      entries,
    );
    await assert.rejects(
      async () => await store.loadNative(pi.id, id, generation, key),
      /another worker/,
    );
    await assert.rejects(
      async () =>
        await store.appendNative(mac.id, id, generation, "batch-3", key, [
          { ...entries[0], message: "changed" },
        ]),
      /UUID reused/,
    );
    await store.appendNative(
      mac.id,
      id,
      generation,
      "subagent",
      { ...key, subpath: "subagents/agent-1" },
      [{ type: "assistant", uuid: "sub-1" }],
    );
    assert.deepEqual(await store.nativeSubkeys(mac.id, id, generation, key), [
      "subagents/agent-1",
    ]);
    await store.saveCheckpoint(mac.id, id, generation, "native-checkpoint", {
      version: 1,
      files: [],
    });
    await store.completeWorkerTurn(mac.id, id, generation, "completed");
    await store.createTurn(
      "native-follow-up",
      work.sessionId,
      "Continue elsewhere.",
    );
    await store.enqueue("native-follow-up");
    const second = await store.claimForWorker(pi.id);
    assert.equal(second?.claim.turn.id, "native-follow-up");
    assert.ok(second);
    assert.deepEqual(
      await store.loadNative(
        pi.id,
        second.claim.turn.id,
        second.claim.turn.generation,
        key,
      ),
      entries,
    );
    await assert.rejects(
      async () =>
        await store.loadNative(
          pi.id,
          second.claim.turn.id,
          second.claim.turn.generation,
          { ...key, projectKey: "another-project" },
        ),
      /outside/,
    );
  } finally {
    await store.close();
  }
});
test("a newer transcript invalidates a file checkpoint and blocks native relocation", async () => {
  const store = new ControlStore(":memory:");
  try {
    const mac = await enroll(store, "mac");
    const pi = await enroll(store, "pi");
    await store.reportWorker(pi.id, {
      ...report,
      portableProviders: ["claude"],
    });
    const work = await task(store, "partial-native", 0, "claude");
    const first = await store.claimForWorker(mac.id);
    assert.ok(first);
    const { id, generation } = first.claim.turn;
    const key = {
      projectKey: `meta-harness-${work.sessionId}`,
      sessionId: "partial-claude",
    };
    await store.appendNative(mac.id, id, generation, "first", key, [
      { type: "user", uuid: "one" },
    ]);
    await store.saveCheckpoint(mac.id, id, generation, "before-late-write", {
      version: 1,
      files: [],
    });
    await store.appendNative(mac.id, id, generation, "second", key, [
      { type: "assistant", uuid: "two" },
    ]);
    await assert.rejects(
      async () =>
        await store.completeWorkerTurn(mac.id, id, generation, "completed"),
      /advanced/,
    );
    await store.completeWorkerTurn(
      mac.id,
      id,
      generation,
      "failed",
      "Needs reconciliation",
    );
    await store.createTurn(
      "reconcile",
      work.sessionId,
      "Inspect and reconcile.",
    );
    await store.enqueue("reconcile");
    assert.equal(await store.claimForWorker(pi.id), null);
    assert.equal(
      (await store.claimForWorker(mac.id))?.claim.turn.id,
      "reconcile",
    );
  } finally {
    await store.close();
  }
});
test("provider cooldowns hold affected queued work while other providers continue", async () => {
  const store = new ControlStore(":memory:");
  try {
    const worker = await enroll(store);
    await task(store, "limited", 0, "claude");
    const active = await store.claimForWorker(worker.id);
    assert.ok(active);
    await store.coolDownProvider(
      worker.id,
      active.claim.turn.id,
      active.claim.turn.generation,
      Date.now() + 60000,
      "Usage limit",
    );
    await store.completeWorkerTurn(
      worker.id,
      active.claim.turn.id,
      active.claim.turn.generation,
      "failed",
      "Usage limit",
    );
    const held = await task(store, "queued-claude", 10, "claude");
    const available = await task(store, "available-demo");
    assert.equal(
      (await store.claimForWorker(worker.id))?.claim.session.id,
      available.sessionId,
    );
    assert.match(
      (await store.listTasks()).find((item) => item.id === held.id)
        ?.waitingReason ?? "",
      /provider reset/,
    );
  } finally {
    await store.close();
  }
});
test("chat sessions expose the same admission reason as tasks", async () => {
  const store = new ControlStore(":memory:");
  try {
    const worker = await enroll(store);
    const session = await store.createSession("business", "Chat", "claude");
    const turnId = crypto.randomUUID();
    await store.createTurn(turnId, session.id, "Who are you?");
    assert.equal(
      await store.waitingReason(turnId),
      "Waiting for workflow dispatch",
    );
    await store.enqueue(turnId);
    await store.reportWorker(worker.id, { ...report, availableMemoryMiB: 126 });
    assert.equal(await store.claimForWorker(worker.id), null);
    assert.match(
      (await store.waitingReason(turnId)) ?? "",
      /126 MiB.*1536 MiB/,
    );
    await store.reportWorker(worker.id, report);
    assert.match((await store.waitingReason(turnId)) ?? "", /eligible worker/);
    assert.ok(await store.claimForWorker(worker.id));
    assert.equal(await store.waitingReason(turnId), null);
  } finally {
    await store.close();
  }
});
test("chat turns appear on the task board and retain one task across follow-ups", async () => {
  const store = new ControlStore(":memory:");
  try {
    const session = await store.createSession(
      "business",
      "Conversation",
      "claude",
    );
    const id = crypto.randomUUID();
    await store.createTurn(id, session.id, "First instruction");
    await store.createTurn(id, session.id, "First instruction");
    const board = await store.listTasks();
    assert.equal(board.length, 1);
    assert.equal(board[0].sessionId, session.id);
    assert.equal(board[0].objective, "First instruction");
    assert.equal(board[0].waitingReason, "Waiting for workflow dispatch");
  } finally {
    await store.close();
  }
});
test("existing conversations are added to the task board without changing their turns", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meta-chat-backfill-"));
  const path = join(directory, "harness.sqlite");
  let store = new ControlStore(path);
  try {
    const session = await store.createSession(
      "business",
      "Existing chat",
      "claude",
    );
    const id = crypto.randomUUID();
    const original = await store.createTurn(
      id,
      session.id,
      "Original instruction",
    );
    await store.close();
    const old = new DatabaseSync(path);
    old.exec("DELETE FROM tasks");
    old.close();
    store = new ControlStore(path);
    assert.equal((await store.listTasks())[0].sessionId, session.id);
    assert.deepEqual(await store.getTurn(id), original);
    await store.close();
    store = new ControlStore(path);
    assert.equal((await store.listTasks()).length, 1);
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent lease reconcilers recover a Demo turn exactly once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-recovery-race-"));
  const path = join(directory, "harness.sqlite");
  const first = new ControlStore(path);
  const second = new ControlStore(path);
  try {
    const worker = await enroll(first);
    await task(first, "recovery-race");
    const assignment = await first.claimForWorker(worker.id);
    assert.ok(assignment);
    const turn = assignment.claim.turn;
    const recovered = await Promise.all([
      first.recoverExpired(Date.now() + 60000),
      second.recoverExpired(Date.now() + 60000),
    ]);
    assert.equal(recovered[0] + recovered[1], 1);
    assert.equal(
      (await first.getTurn(turn.id)).generation,
      turn.generation + 1,
    );
    assert.equal((await second.getTurn(turn.id)).status, "queued");
  } finally {
    await first.close();
    await second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
