import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseLabels,
  type WorkerReport,
  workerLabels,
} from "@harness/core/scheduling";
import { HarnessStore } from "./application";

const report: WorkerReport = {
  hostname: "bench",
  providers: ["demo", "codex"],
  labels: ["arm64"],
  maxAgents: 1,
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
async function setup() {
  const store = new HarnessStore(":memory:");
  await store.ready;
  const mac = await store.createWorker("mac");
  const pi = await store.createWorker("pi");
  await store.reportWorker(mac.id, { ...report, browserHost: true });
  await store.reportWorker(pi.id, report);
  const session = await store.createSession("tech", "Chip", "codex");
  return { store, mac, pi, session };
}
async function queue(store: HarnessStore, id: string, sessionId: string) {
  await store.createTurn(id, sessionId, `Message ${id}`);
  await store.enqueue(id);
}
async function finish(
  store: HarnessStore,
  workerId: string,
  turnId: string,
  generation: number,
  nativeId?: string,
) {
  if (nativeId)
    await store.applyWorkerEvent(workerId, turnId, generation, 1, {
      type: "native-session",
      id: nativeId,
    });
  await store.applyWorkerEvent(workerId, turnId, generation, 2, {
    type: "text",
    text: `Reply to ${turnId}`,
  });
  await store.completeWorkerTurn(workerId, turnId, generation, "completed");
}

test("labels are normalized, and machines offer their agents and browser", () => {
  assert.deepEqual(parseLabels("ASAP7, mac  asap7"), ["asap7", "mac"]);
  assert.throws(() => parseLabels(["has space"]), /not a valid label/);
  assert.throws(() => parseLabels(["-dash"]), /not a valid label/);
  assert.deepEqual(
    workerLabels({
      id: "w",
      name: "mac",
      seenAt: 0,
      draining: 0,
      report: { ...report, browserHost: true },
      labels: ["asap7"],
    }),
    ["codex", "browser", "arm64", "asap7"],
  );
});

test("a session that requires labels runs only on machines that have them", async () => {
  const { store, mac, pi, session } = await setup();
  try {
    await store.setSessionLabels(session.id, ["asap7"]);
    await queue(store, "one", session.id);
    assert.equal(await store.claimForWorker(pi.id), null);
    assert.equal(await store.claimForWorker(mac.id), null);
    assert.match(
      String(await store.waitingReason("one")),
      /Needs a machine labelled asap7/,
    );
    await store.setWorkerLabels(mac.id, "asap7");
    assert.equal(await store.claimForWorker(pi.id), null);
    assert.equal((await store.claimForWorker(mac.id))?.claim.turn.id, "one");
    // Clearing the labels lets any machine take it again.
    assert.equal(
      (await store.setSessionLabels(session.id, [])).requiredLabels,
      null,
    );
  } finally {
    await store.close();
  }
});

test("a conversation moves to another machine when its machine is off, with the conversation so far", async () => {
  const { store, mac, pi, session } = await setup();
  try {
    const now = Date.now();
    await queue(store, "one", session.id);
    const first = await store.claimForWorker(mac.id, now);
    assert.ok(first);
    await finish(
      store,
      mac.id,
      "one",
      first.claim.turn.generation,
      "thread-mac",
    );
    assert.equal(await store.conversationSoFar("one"), null);

    // While the Mac is online and free, the conversation waits for it.
    await queue(store, "two", session.id);
    assert.equal(await store.claimForWorker(pi.id, now), null);

    // The Mac goes quiet: the Pi takes over with a fresh agent.
    const later = now + 60000;
    await store.reportWorker(pi.id, report, later);
    const moved = await store.claimForWorker(pi.id, later);
    assert.equal(moved?.claim.turn.id, "two");
    assert.equal(moved?.claim.session.nativeId, null);
    const earlier = String(await store.conversationSoFar("two"));
    assert.match(earlier, /Message one/);
    assert.match(earlier, /Reply to one/);
    assert.doesNotMatch(earlier, /Message two/);

    // The Pi is now its home; the old native thread is not resumed anywhere.
    await finish(store, pi.id, "two", moved.claim.turn.generation, "thread-pi");
    const after = await store.getSession(session.id);
    assert.equal(after.nativeId, "thread-pi");
    assert.equal(after.ownerWorkerId, pi.id);
  } finally {
    await store.close();
  }
});

test("a busy home machine keeps its conversation for two minutes, then another takes it", async () => {
  const { store, mac, pi, session } = await setup();
  try {
    const now = Date.now();
    await queue(store, "one", session.id);
    const first = await store.claimForWorker(mac.id, now);
    assert.ok(first);
    await finish(
      store,
      mac.id,
      "one",
      first.claim.turn.generation,
      "thread-mac",
    );
    // Another conversation fills the Mac's only slot.
    const other = await store.createSession("tech", "Other", "codex");
    await queue(store, "busy", other.id);
    assert.equal(
      (await store.claimForWorker(mac.id, now))?.claim.turn.id,
      "busy",
    );

    await queue(store, "two", session.id);
    assert.equal(await store.claimForWorker(pi.id, now), null);
    assert.match(String(await store.waitingReason("two")), /up to 2 minutes/);
    // Two minutes later the Mac is still busy, so the Pi continues it.
    await store
      .databaseConnection()
      .prepare(
        "UPDATE turns SET createdAt = createdAt - 180000 WHERE id = 'two'",
      )
      .run();
    assert.equal(
      (await store.claimForWorker(pi.id, now))?.claim.turn.id,
      "two",
    );
  } finally {
    await store.close();
  }
});
