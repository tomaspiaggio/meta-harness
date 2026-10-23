import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executeTurn } from "@harness/core";
import { parseModel } from "@harness/core/models";
import { HarnessStore } from "./application";

test("agent defaults persist; per-session changes preserve native identity and immutable running/queued model choices", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-models-"));
  let store = new HarnessStore(join(root, "state.sqlite"));
  try {
    await store.ready;
    const old = await store.createSession("tech", "Old session", "claude");
    await store.setAgentDefaults({
      provider: "codex",
      models: { claude: "opus", codex: "gpt-6.1-sol" },
    });
    assert.equal((await store.getSession(old.id)).model, null);
    const inherited = await store.createSession("tech", "New default");
    assert.equal(inherited.provider, "codex");
    assert.equal(inherited.model, "gpt-6.1-sol");
    const session = await store.createSession("tech", "Claude", "claude");
    assert.equal(session.model, "opus");
    const worker = await store.createWorker("Fixture");
    await store.reportWorker(worker.id, {
      hostname: "fixture",
      providers: ["claude"],
      labels: [],
      maxAgents: 1,
      memoryBudgetMiB: 4096,
      cpuSlots: 2,
      maxBuilds: 1,
      maxBrowsers: 0,
      availableMemoryMiB: 8192,
      reserveMemoryMiB: 0,
      loadPerCpu: 0,
      maxLoadPerCpu: 100,
      draining: false,
    });
    await store.createTurn("first", session.id, "First model");
    await store.enqueue("first");
    const first = await store.claimForWorker(worker.id);
    assert.ok(first);
    await store.applyWorkerEvent(
      worker.id,
      "first",
      first.claim.turn.generation,
      1,
      { type: "native-session", id: "same-native-session" },
    );
    await store.setSessionModel(session.id, "haiku");
    assert.equal((await store.getTurn("first")).model, "opus");
    await store.createTurn("second", session.id, "Next model");
    await store.enqueue("second");
    await store.setSessionModel(session.id, "sonnet");
    assert.equal(
      (await store.getSession(session.id)).nativeId,
      "same-native-session",
    );
    assert.equal((await store.getTurn("second")).model, "haiku");
    await store.completeWorkerTurn(
      worker.id,
      "first",
      first.claim.turn.generation,
      "completed",
    );
    const second = await store.claimForWorker(worker.id);
    assert.ok(second);
    assert.equal(second.claim.session.model, "sonnet");
    let actualModel: string | null | undefined;
    await executeTurn(
      { async appendOutput() {}, async saveNativeId() {}, async finish() {} },
      second.claim,
      {
        async run(input) {
          actualModel = input.session.model;
          assert.equal(input.session.nativeId, "same-native-session");
        },
      },
      root,
      new AbortController().signal,
    );
    assert.equal(
      actualModel,
      "haiku",
      "execution must use the queued turn's frozen model, even when session settings changed later",
    );
    await assert.rejects(
      store.setSessionModel(session.id, "gpt-6.1-sol"),
      /other agent/,
    );
    await store.close();
    store = new HarnessStore(join(root, "state.sqlite"));
    await store.ready;
    assert.equal((await store.agentDefaults()).provider, "codex");
    assert.equal((await store.getSession(session.id)).model, "sonnet");
    assert.equal((await store.getTurn("second")).model, "haiku");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("model configuration rejects command-like values and invalid providers but allows exact custom model IDs", () => {
  assert.equal(parseModel("claude", "claude-opus-4-6"), "claude-opus-4-6");
  assert.equal(parseModel("codex", "gpt-6.1-sol"), "gpt-6.1-sol");
  assert.throws(() =>
    parseModel("claude", "opus --permission-mode bypassPermissions"),
  );
  assert.throws(() => parseModel("codex", "opus"), /other agent/);
  assert.throws(() => parseModel("demo", "gpt-6.1-sol"));
});
