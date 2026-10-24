import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromeConnectionInstructions } from "@harness/core/browser";
import { BrowserBroker, browserTool } from "../../../apps/web/server/browser";
import { HarnessStore } from "./application";

test("a Chrome connection failure can retry the same logical operation without erasing history; ambiguous clicks cannot", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-browser-recovery-"));
  const store = new HarnessStore(join(root, "db.sqlite"));
  await store.ready;
  process.env.HARNESS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  try {
    const worker = await store.createWorker("Browser recovery fixture");
    await store.reportWorker(worker.id, {
      hostname: "fixture",
      providers: ["demo"],
      labels: [],
      maxAgents: 1,
      memoryBudgetMiB: 4096,
      cpuSlots: 2,
      maxBuilds: 1,
      maxBrowsers: 1,
      availableMemoryMiB: 8192,
      reserveMemoryMiB: 512,
      loadPerCpu: 0,
      maxLoadPerCpu: 2,
      draining: false,
      browserHost: true,
    });
    const session = await store.createSession("business", "Recovery", "demo");
    await store.createTurn(
      "recovery",
      session.id,
      "Check the existing account",
    );
    await store.enqueue("recovery");
    const claim = await store.claimForWorker(worker.id);
    assert.ok(claim);
    let grant = {
      workerId: worker.id,
      turnId: "recovery",
      generation: claim.claim.turn.generation,
      expiresAt: Date.now() + 60000,
      purpose: "tools" as const,
    };
    const broker = new BrowserBroker(store);
    const nextCommand = async () => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const work = await broker.poll(worker.id);
        if (work.assignments.length) return work.assignments[0];
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("Browser tool never dispatched a command");
    };
    const args = {
      action: "click",
      operation_id: "crm-check",
      selector: "#open-crm",
    };
    const first = browserTool(grant, args, store);
    const rejected = assert.rejects(first, /Connect your existing Chrome/);
    const failed = await nextCommand();
    await broker.complete(
      worker.id,
      failed.command.id,
      failed.identity.generation,
      { execution: "not_started" },
      undefined,
      "Connect your existing Chrome",
    );
    await rejected;
    assert.deepEqual(await store.unfinishedOperations(session.id), []);
    const ledger = await store
      .databaseConnection()
      .prepare("SELECT * FROM operation_ledger WHERE id = ?")
      .get(failed.command.id);
    assert.equal(
      ledger?.state,
      "failed",
      "Confirmed pre-execution failure is not overwritten by catch",
    );
    // Reproduce the legacy data corruption visible in the owner's screenshot.
    await store
      .databaseConnection()
      .prepare(
        "UPDATE browser_commands SET result = NULL, error = ? WHERE id = ?",
      )
      .run(chromeConnectionInstructions, failed.command.id);
    await store
      .databaseConnection()
      .prepare(
        "UPDATE operation_ledger SET state = 'unknown_outcome', receipt = ? WHERE id = ?",
      )
      .run(
        JSON.stringify({
          operationKey: args.operation_id,
          action: "click",
          browserId: failed.identity.id,
        }),
        failed.command.id,
      );
    assert.deepEqual(
      await store.unfinishedOperations(session.id),
      [],
      "The exact legacy connection failure is reconciled automatically",
    );
    assert.equal(
      (
        await store
          .databaseConnection()
          .prepare("SELECT error FROM operation_ledger WHERE id = ?")
          .get(failed.command.id)
      )?.error,
      chromeConnectionInstructions,
    );
    await store.completeWorkerTurn(
      worker.id,
      grant.turnId,
      grant.generation,
      "failed",
      "Chrome was not connected",
    );
    await store.createTurn(
      "retry",
      session.id,
      "Chrome is connected; try again",
    );
    await store.enqueue("retry");
    const retryClaim = await store.claimForWorker(worker.id);
    assert.ok(retryClaim);
    const oldGrant = grant;
    grant = {
      ...grant,
      turnId: "retry",
      generation: retryClaim.claim.turn.generation,
    };
    await assert.rejects(
      browserTool(oldGrant, args, store),
      /ownership|expired/i,
    );
    const retry = browserTool(grant, args, store);
    const next = await nextCommand();
    assert.notEqual(
      next.command.id,
      failed.command.id,
      "Physical attempt IDs differ while the logical ID is stable",
    );
    await broker.complete(
      worker.id,
      next.command.id,
      next.identity.generation,
      { url: "https://example.com/crm", title: "Existing account" },
    );
    assert.deepEqual((await retry).result, {
      url: "https://example.com/crm",
      title: "Existing account",
    });
    assert.equal(
      (
        await store
          .databaseConnection()
          .prepare("SELECT status FROM browser_commands WHERE id = ?")
          .get(failed.command.id)
      )?.status,
      "failed",
      "Prior failed command is preserved",
    );

    const click = {
      action: "click",
      operation_id: "send-once",
      selector: "button",
    };
    const send = browserTool(grant, click, store);
    const sendRejected = assert.rejects(send, /Result lost/);
    const uncertain = await nextCommand();
    await broker.complete(
      worker.id,
      uncertain.command.id,
      uncertain.identity.generation,
      null,
      undefined,
      "Result lost after click",
    );
    await sendRejected;
    const replay = await browserTool(grant, click, store);
    assert.equal(
      (replay.result as { status: string }).status,
      "unknown_outcome",
    );
    assert.equal((await broker.poll(worker.id)).assignments.length, 0);
    assert.equal((await store.unfinishedOperations(session.id)).length, 1);
  } finally {
    delete process.env.HARNESS_ENCRYPTION_KEY;
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
