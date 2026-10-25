import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BrowserAssignment } from "@harness/core/browser";
import { BrowserBroker, browserTool } from "../../../apps/web/server/browser";
import { HarnessStore } from "./application";

test("browser placement uses an available host when personal Chrome is offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-personal-browser-"));
  const store = new HarnessStore(join(root, "db.sqlite"));
  await store.ready;
  try {
    const managed = await store.createWorker("Managed browser");
    const personal = await store.createWorker("Personal Chrome");
    const report = {
      hostname: "fixture",
      providers: ["demo" as const],
      labels: [],
      maxAgents: 1,
      memoryBudgetMiB: 4096,
      cpuSlots: 2,
      maxBuilds: 1,
      maxBrowsers: 3,
      availableMemoryMiB: 8192,
      reserveMemoryMiB: 512,
      loadPerCpu: 0,
      maxLoadPerCpu: 2,
      draining: false,
      browserHost: true,
    };
    await store.reportWorker(managed.id, {
      ...report,
      browserBackend: "managed",
    });
    await store.reportWorker(personal.id, {
      ...report,
      browserBackend: "personal-chrome",
    });
    const broker = new BrowserBroker(store);
    await store
      .databaseConnection()
      .prepare("UPDATE workers SET seenAt = 1 WHERE id = ?")
      .run(personal.id);
    assert.equal((await broker.ensure("tech")).workerId, managed.id);
    await store.reportWorker(personal.id, {
      ...report,
      browserBackend: "personal-chrome",
    });
    assert.equal((await broker.ensure("tech")).workerId, managed.id);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("browser host loss prefers the task worker, fences old commands and keeps logins host-local", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-browser-host-loss-"));
  const store = new HarnessStore(join(root, "db.sqlite"));
  await store.ready;
  try {
    const mac = await store.createWorker("Mac");
    const pi = await store.createWorker("Pi");
    const report = {
      hostname: "fixture",
      providers: ["demo" as const],
      labels: [],
      maxAgents: 1,
      memoryBudgetMiB: 4096,
      cpuSlots: 2,
      maxBuilds: 1,
      maxBrowsers: 3,
      availableMemoryMiB: 8192,
      reserveMemoryMiB: 512,
      loadPerCpu: 0,
      maxLoadPerCpu: 2,
      draining: false,
      browserHost: true,
      browserBackend: "managed" as const,
      browserExtensionReady: true,
    };
    await store.reportWorker(mac.id, report);
    await store.reportWorker(pi.id, report);
    const broker = new BrowserBroker(store);
    const session = await store.createSession(
      "fundraising",
      "Pi login",
      "demo",
    );
    await store.createTurn("pi-login", session.id, "Open my account");
    await store.enqueue("pi-login");
    const claimed = await store.claimForWorker(pi.id);
    assert.ok(claimed);
    const grant = {
      workerId: pi.id,
      turnId: "pi-login",
      generation: claimed.claim.turn.generation,
      expiresAt: Date.now() + 60000,
      purpose: "tools" as const,
    };
    const status = await browserTool(grant, { action: "status" }, store);
    assert.equal((status.result as { workerId: string }).workerId, pi.id);
    const reading = browserTool(grant, { action: "read" }, store);
    let loginCommand: BrowserAssignment | undefined;
    for (let attempt = 0; !loginCommand && attempt < 100; attempt++) {
      loginCommand = (await broker.poll(pi.id)).assignments[0];
      if (!loginCommand) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert(loginCommand);
    await broker.complete(
      pi.id,
      loginCommand.command.id,
      loginCommand.identity.generation,
      {
        status: "needs_login",
        login: "rejected",
        url: "https://accounts.google.com/v3/signin/rejected",
      },
    );
    const readResult = await reading;
    assert.equal(
      (readResult.result as { status: string }).status,
      "needs_login",
    );
    // Repeated model requests use the same pending input, rather than spawning turns.
    await browserTool(grant, { action: "needs_login" }, store);
    const requests = await store.inputsForSession(session.id);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].kind, "browser-login");
    // A new message moves on: the card does not linger in the session.
    await store.submitMessage("owner-moves-on", session.id, "Never mind");
    assert.equal((await store.inputsForSession(session.id)).length, 0);
    // Both hosts are healthy; the Pi task should use its own browser.
    assert.equal((await broker.ensure("tech", pi.id)).workerId, pi.id);
    let identity = await broker.ensure("business", mac.id);
    assert.equal(identity.workerId, mac.id);
    await broker.command("old-pending", identity.id, "read", {});
    await store
      .databaseConnection()
      .prepare(
        "UPDATE browser_identities SET stateCipher = ?, lastUrl = ?, frame = ?, frameAt = ? WHERE id = ?",
      )
      .run(
        "mac-private-state",
        "https://example.com/private",
        "old-frame",
        Date.now(),
        identity.id,
      );
    const oldGeneration = identity.generation;
    await store.reportWorker(mac.id, {
      ...report,
      browserBackend: "extension",
      browserExtensionReady: false,
    });
    // The old lease is still fresh, but the extension is disconnected.
    identity = await broker.ensure("business", pi.id);
    assert.equal(identity.workerId, pi.id);
    assert.ok(identity.generation > oldGeneration);
    assert.equal(identity.stateCipher, null);
    assert.equal(identity.lastUrl, null);
    assert.equal(identity.frame, null);
    assert.equal(identity.frameAt, null);
    const old = await store
      .databaseConnection()
      .prepare("SELECT * FROM browser_commands WHERE id = ?")
      .get("old-pending");
    assert.equal(old?.status, "failed");
    assert.equal(JSON.parse(String(old?.result)).execution, "not_started");
    await assert.rejects(
      broker.complete(mac.id, "old-pending", oldGeneration, {}),
      /expired/,
    );
    await broker.command("pi-running", identity.id, "read", {});
    await broker.poll(pi.id);
    // Reconnecting the Mac does not steal the healthy Pi browser mid-task.
    await store.reportWorker(mac.id, report);
    assert.equal((await broker.ensure("business", mac.id)).workerId, pi.id);
    await store
      .databaseConnection()
      .prepare("UPDATE workers SET seenAt = 1 WHERE id = ?")
      .run(pi.id);
    identity = await broker.ensure("business", mac.id);
    assert.equal(identity.workerId, mac.id);
    const interrupted = await store
      .databaseConnection()
      .prepare("SELECT status FROM browser_commands WHERE id = ?")
      .get("pi-running");
    assert.equal(interrupted?.status, "unknown_outcome");
    // A healthy but idle old host does not pin a new task to the Mac.
    await store.reportWorker(pi.id, report);
    assert.equal((await broker.ensure("business", pi.id)).workerId, pi.id);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("browser broker fences host ownership, excludes model capture during takeover and resumes one persistent conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-browser-broker-"));
  const store = new HarnessStore(join(root, "db.sqlite"));
  await store.ready;
  process.env.HARNESS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  try {
    const worker = await store.createWorker("browser fixture");
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
    const session = await store.createSession("business", "Browser", "demo");
    const other = await store.createSession("tech", "Other", "demo");
    const broker = new BrowserBroker(store);
    assert.equal((await store.resourcePolicy("business")).browser, true);
    await store.saveResourcePolicy("business", {
      capacity: "personal",
      browser: false,
      secrets: [],
    });
    assert.equal((await store.resourcePolicy("business")).browser, true);
    let browser = await broker.ensure("business");
    await broker.command("navigate", browser.id, "navigate", {
      url: "https://example.com/",
    });
    const work = await broker.poll(worker.id);
    assert.equal(work.assignments.length, 1);
    assert.equal(work.assignments[0].command.id, "navigate");
    assert.equal(
      Buffer.from(work.assignments[0].stateKey, "base64").length,
      32,
    );
    const user = createECDH("prime256v1");
    user.generateKeys();
    browser = await broker.takeover(
      browser.id,
      user.getPublicKey().toString("base64"),
    );
    await assert.rejects(
      broker.complete(worker.id, "navigate", browser.generation - 1, {
        image: "stale",
      }),
      /expired/,
    );
    await assert.rejects(
      broker.command("agent-during-login", browser.id, "screenshot", {}),
      /control|paused|manual/i,
    );
    await broker.command("manual", browser.id, "manual", {});
    await broker.poll(worker.id);
    await assert.rejects(
      broker.complete(worker.id, "manual", browser.generation, {
        frame: {
          iv: randomBytes(12).toString("base64"),
          publicKey: user.getPublicKey().toString("base64"),
          ciphertext: "opaque",
        },
        text: "password",
      }),
      /encrypted/,
    );
    await broker.complete(worker.id, "manual", browser.generation, {
      frame: {
        iv: randomBytes(12).toString("base64"),
        publicKey: user.getPublicKey().toString("base64"),
        ciphertext: randomBytes(30).toString("base64"),
      },
      width: 1280,
      height: 800,
    });
    await assert.rejects(
      broker.returnControl(browser.id, browser.generation, other.id),
      /workspace/i,
    );
    const previousGeneration = browser.generation;
    await broker.returnControl(
      browser.id,
      previousGeneration,
      session.id,
      true,
    );
    await broker.returnControl(
      browser.id,
      previousGeneration,
      session.id,
      true,
    );
    assert.equal((await store.listTurns(session.id)).length, 1);
    assert.equal((await broker.get(browser.id)).mode, "agent");
    assert.equal((await broker.get(browser.id)).frame, null);
    const inspecting = await broker.takeover(
      browser.id,
      user.getPublicKey().toString("base64"),
    );
    await broker.returnControl(browser.id, inspecting.generation, session.id);
    await broker.returnControl(browser.id, inspecting.generation, session.id);
    assert.equal(
      (await store.listTurns(session.id)).length,
      1,
      "releasing control does not send a message",
    );
    // An abandoned takeover hands the browser back to the agent instead of
    // leaving it paused for as long as the host keeps its lease.
    const abandoned = await broker.takeover(
      browser.id,
      user.getPublicKey().toString("base64"),
    );
    await store
      .databaseConnection()
      .prepare("UPDATE browser_identities SET expiresAt = ? WHERE id = ?")
      .run(Date.now() - 1, browser.id);
    await broker.expire();
    const expired = await broker.get(browser.id);
    assert.equal(expired.mode, "agent");
    assert.ok(expired.generation > abandoned.generation);
    // An idle release keeps the last page, so reopening resumes there.
    await store
      .databaseConnection()
      .prepare("UPDATE browser_identities SET lastUrl = ? WHERE id = ?")
      .run("https://example.com/needs-login", browser.id);
    await broker.release(worker.id, browser.id, expired.generation);
    assert.equal((await broker.get(browser.id)).workerId, null);
    assert.equal(
      (await broker.ensure("business")).lastUrl,
      "https://example.com/needs-login",
    );
  } finally {
    delete process.env.HARNESS_ENCRYPTION_KEY;
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("ephemeral workers are scoped to one turn, expire, and revocation invalidates existing tool grants", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-worker-grant-"));
  const store = new HarnessStore(join(root, "db.sqlite"));
  await store.ready;
  try {
    const session = await store.createSession("tech", "Scope", "demo");
    await store.saveResourcePolicy("tech", {
      capacity: "fallback",
      browser: false,
      secrets: [],
    });
    await store.createTurn("first", session.id, "First");
    await store.createTurn("second", session.id, "Second");
    await store.enqueue("first");
    await store.enqueue("second");
    const worker = await store.createEphemeralWorker(
      "sandbox",
      "first",
      Date.now() + 60000,
    );
    await store.reportWorker(worker.id, {
      hostname: "fixture",
      providers: ["demo"],
      labels: ["sandbox"],
      maxAgents: 1,
      memoryBudgetMiB: 4096,
      cpuSlots: 2,
      maxBuilds: 1,
      maxBrowsers: 0,
      availableMemoryMiB: 8192,
      reserveMemoryMiB: 512,
      loadPerCpu: 0,
      maxLoadPerCpu: 2,
      draining: false,
    });
    const claim = await store.claimForWorker(worker.id);
    assert.ok(claim);
    await store.assertAssignment(
      worker.id,
      "first",
      claim.claim.turn.generation,
    );
    await store.revokeWorker(worker.id);
    await assert.rejects(
      store.assertAssignment(worker.id, "first", claim.claim.turn.generation),
      /revoked|expired/,
    );
    await assert.rejects(
      store.authenticateWorker(worker.id, worker.token),
      /credential/,
    );
    const expiring = await store.createEphemeralWorker(
      "expires",
      "second",
      Date.now() + 60000,
    );
    await store
      .databaseConnection()
      .prepare("UPDATE worker_grants SET expiresAt = 1 WHERE workerId = ?")
      .run(expiring.id);
    await assert.rejects(
      store.authenticateWorker(expiring.id, expiring.token),
      /expired/,
    );
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("logical browser operation IDs survive explicit follow-up without crossing sessions or repeating unknown effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-operation-"));
  const store = new HarnessStore(join(root, "db.sqlite"));
  await store.ready;
  try {
    const worker = await store.createWorker("fixture");
    await store.reportWorker(worker.id, {
      hostname: "fixture",
      providers: ["demo"],
      labels: [],
      maxAgents: 1,
      memoryBudgetMiB: 4096,
      cpuSlots: 2,
      maxBuilds: 1,
      maxBrowsers: 0,
      availableMemoryMiB: 8192,
      reserveMemoryMiB: 512,
      loadPerCpu: 0,
      maxLoadPerCpu: 2,
      draining: false,
    });
    const session = await store.createSession("tech", "Operation", "demo");
    await store.createTurn("op-one", session.id, "Send");
    await store.enqueue("op-one");
    const first = await store.claimForWorker(worker.id);
    assert.ok(first);
    const args = { action: "click", selector: "send" };
    assert.equal(
      (
        await store.operation(
          worker.id,
          "op-one",
          first.claim.turn.generation,
          "send-once",
          args,
          { operationKey: "logical-send", action: "click" },
        )
      ).state,
      "new",
    );
    await store.operationOutcome(
      "send-once",
      "unknown_outcome",
      null,
      "Receipt lost",
    );
    await store.completeWorkerTurn(
      worker.id,
      "op-one",
      first.claim.turn.generation,
      "interrupted",
    );
    await store.createTurn("op-two", session.id, "Reconcile");
    await store.enqueue("op-two");
    const next = await store.claimForWorker(worker.id);
    assert.ok(next);
    assert.equal(
      (
        await store.operation(
          worker.id,
          "op-two",
          next.claim.turn.generation,
          "send-once",
          { selector: "send", action: "click" },
        )
      ).state,
      "unknown_outcome",
      "object key order does not turn a retry into a new action",
    );
    assert.equal((await store.unfinishedOperations(session.id)).length, 1);
    await assert.rejects(
      store.operation(
        worker.id,
        "op-two",
        next.claim.turn.generation,
        "send-once",
        { action: "click", selector: "other" },
      ),
      /different arguments/,
    );
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
