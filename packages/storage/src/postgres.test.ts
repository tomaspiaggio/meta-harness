import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import { HarnessStore } from "./application";
import { connectPostgres, postgresSql } from "./database";

test("Postgres SQL keeps values bound, literals unchanged, and aggregate MAX distinct", () => {
  assert.equal(
    postgresSql(
      "SELECT MAX(sequence), MAX(retryAt, ?), 'retryAt ? MAX(x,y)' FROM turns WHERE sessionId = ?",
    ),
    'SELECT MAX(sequence), GREATEST("retryAt", $1), \'retryAt ? MAX(x,y)\' FROM turns WHERE "sessionId" = $2',
  );
});

test("Prisma/PostgreSQL coordinates independent clients and preserves publication, stop and read transactions", {
  skip: !process.env.HARNESS_TEST_DATABASE_URL,
}, async () => {
  const url = process.env.HARNESS_TEST_DATABASE_URL;
  assert.ok(url);
  const schema = `harness_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  const isolated = new URL(url);
  isolated.searchParams.set("options", `-c search_path=${schema}`);
  let first: HarnessStore | undefined;
  let second: HarnessStore | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const setup = new Pool({ connectionString: isolated.toString(), max: 1 });
    try {
      const directory = new URL("../prisma/migrations/", import.meta.url);
      for (const name of (await readdir(directory)).sort()) {
        if (!/^\d/.test(name)) continue;
        await setup.query(
          await readFile(new URL(`${name}/migration.sql`, directory), "utf8"),
        );
      }
    } finally {
      await setup.end();
    }
    first = new HarnessStore(await connectPostgres(isolated.toString()));
    await first.ready;
    second = new HarnessStore(await connectPostgres(isolated.toString()));
    await second.ready;
    const report = {
      hostname: "fixture",
      providers: ["claude"] as const,
      labels: [],
      maxAgents: 2,
      memoryBudgetMiB: 8192,
      cpuSlots: 4,
      maxBuilds: 1,
      maxBrowsers: 1,
      availableMemoryMiB: 16384,
      reserveMemoryMiB: 512,
      loadPerCpu: 0,
      maxLoadPerCpu: 1,
      draining: false,
    };
    const workers = await Promise.all([
      first.createWorker("one"),
      second.createWorker("two"),
    ]);
    for (const worker of workers)
      await first.reportWorker(worker.id, { ...report, providers: ["claude"] });
    const session = await first.createSession(
      "tech",
      "Postgres transactions",
      "claude",
    );
    await first.setAgentDefaults({
      provider: "claude",
      models: { claude: "opus", codex: "gpt-6.1-sol" },
    });
    assert.equal((await second.agentDefaults()).models.claude, "opus");
    await first.setSessionModel(session.id, "opus");
    await first.createTurn("one", session.id, "Remember the pilot price");
    await first.createTurn("two", session.id, "Check it again");
    await second.setSessionModel(session.id, "haiku");
    assert.equal((await first.getSession(session.id)).model, "haiku");
    assert.equal((await second.getTurn("one")).model, "opus");
    assert.equal((await second.getTurn("two")).model, "opus");
    await first.enqueue("one");
    await first.enqueue("two");
    const claims = await Promise.all([
      first.claimForWorker(workers[0].id),
      second.claimForWorker(workers[1].id),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const claim = claims.find(Boolean);
    assert.ok(claim);
    const { id, generation, workerId } = claim.claim.turn;
    assert.ok(workerId);
    await first.readWorkerDecisions(workerId, id, generation);
    await second.applyWorkerEvent(workerId, id, generation, 1, {
      type: "text",
      text: "UTF-8: €173",
    });
    await first.completeWorkerTurn(
      workerId,
      id,
      generation,
      "completed",
      undefined,
      [{ key: "business.price", content: "$173", expectedRevision: 0 }],
    );
    await second.completeWorkerTurn(workerId, id, generation, "completed");
    assert.equal((await second.getSharedDecisions()).decisions[0].revision, 1);
    await second.editSharedDecision({
      key: "business.price",
      content: "$200",
      expectedRevision: 1,
    });
    await assert.rejects(
      first.editSharedDecision({
        key: "business.price",
        content: "stale",
        expectedRevision: 1,
      }),
      /changed to revision/,
    );
    await first.editSharedDecision({
      key: "business.price",
      content: null,
      expectedRevision: 2,
    });
    assert.equal(
      (await second.getSharedDecisions()).decisions[0].content,
      null,
    );
    await second.editSharedDecision({
      key: "business.price",
      content: "$173",
      expectedRevision: 3,
    });
    const cursor = (await second.getSession(session.id)).attentionSequence ?? 0;
    const next = await first.claimForWorker(workerId);
    assert.ok(next);
    await second.requestStop("two");
    assert.equal(
      (
        await first.heartbeatWorkerTurn(
          workerId,
          "two",
          next.claim.turn.generation,
        )
      ).stopRequested,
      true,
    );
    await first.completeWorkerTurn(
      workerId,
      "two",
      next.claim.turn.generation,
      "completed",
    );
    await second.markSessionRead(session.id, cursor);
    assert.equal((await first.getSession(session.id)).unreadCount, 1);
    assert.equal((await first.getTurn("one")).output, "UTF-8: €173");
    assert.equal((await first.getTurn("two")).status, "interrupted");
    assert.equal((await second.listTasks())[0].sessionId, session.id);
    await first.revokeWorker(workerId);
    const identity = workers.find((worker) => worker.id === workerId);
    assert.ok(identity);
    await assert.rejects(async () => {
      assert.ok(second);
      await second.authenticateWorker(workerId, identity.token);
    }, /credential/);
    await first.deleteWorkspace("tech");
    await assert.rejects(second.getSession(session.id), /not found/);
    assert.equal(
      (await second.getSharedDecisions()).decisions[0]?.content,
      "$173",
    );
    assert.equal(
      (await second.getSharedDecisions()).decisions[0]?.sessionId,
      null,
    );
    assert.ok(
      !(await second.listWorkspaces()).some(
        (workspace) => workspace.id === "tech",
      ),
    );
  } finally {
    await first?.close();
    await second?.close();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test("SQLite export imports into fresh PostgreSQL with stable identities, contents, ordering and sequences", {
  skip: !process.env.HARNESS_TEST_DATABASE_URL,
}, async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { HarnessStore } = await import("./application");
  const { exportSqlite, importPostgres } = await import("./transfer");
  const url = process.env.HARNESS_TEST_DATABASE_URL;
  assert.ok(url);
  const admin = new Pool({ connectionString: url, max: 1 });
  const schema = `harness_transfer_${crypto.randomUUID().replaceAll("-", "")}`;
  const isolated = new URL(url);
  isolated.searchParams.set("options", `-c search_path=${schema}`);
  const root = await mkdtemp(join(tmpdir(), "harness-transfer-"));
  let target: InstanceType<typeof HarnessStore> | undefined;
  try {
    const source = new HarnessStore(join(root, "source.sqlite"));
    await source.ready;
    const session = await source.createSession(
      "business",
      "Transfer fixture",
      "demo",
    );
    await source.createTurn(
      "source-turn",
      session.id,
      "The pilot price is $173 🧪",
    );
    await source.requestStop("source-turn");
    await source.renameSession(session.id, "Keep this title");
    await source.draftSchedule("source-schedule", {
      name: "Morning",
      prompt: "Review tasks",
      sessionId: session.id,
      kind: "agent",
      trigger: {
        type: "cron",
        expression: "0 9 * * 1-5",
        timezone: "America/Los_Angeles",
      },
    });
    await source.close();
    const exported = exportSqlite(join(root, "source.sqlite"));
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const setup = new Pool({ connectionString: isolated.toString(), max: 1 });
    try {
      const directory = new URL("../prisma/migrations/", import.meta.url);
      for (const name of (await readdir(directory)).sort())
        if (/^\d/.test(name))
          await setup.query(
            await readFile(new URL(`${name}/migration.sql`, directory), "utf8"),
          );
    } finally {
      await setup.end();
    }
    const broken = structuredClone(exported);
    const brokenTurn = broken.tables.find((table) => table.name === "turns")
      ?.rows[0];
    assert.ok(brokenTurn);
    brokenTurn.sessionId = "missing-session";
    const { createHash } = await import("node:crypto");
    broken.checksum = createHash("sha256")
      .update(JSON.stringify(broken.tables))
      .digest("hex");
    await assert.rejects(
      importPostgres(broken, isolated.toString()),
      "partial failed import rolls back every table",
    );
    const imported = await importPostgres(exported, isolated.toString());
    assert.equal(imported.checksum, exported.checksum);
    target = new HarnessStore(await connectPostgres(isolated.toString()));
    await target.ready;
    assert.equal(
      (await target.getSession(session.id)).title,
      "Keep this title",
    );
    assert.equal(
      (await target.getTurn("source-turn")).prompt,
      "The pilot price is $173 🧪",
    );
    assert.equal((await target.getSchedule("source-schedule")).status, "draft");
    await target.createTurn("after-import", session.id, "Continue");
    assert.deepEqual(
      (await target.listTurns(session.id)).map((item) => item.id),
      ["source-turn", "after-import"],
    );
    await assert.rejects(
      importPostgres(exported, isolated.toString()),
      /not empty/,
    );
    assert.equal(
      exportSqlite(join(root, "source.sqlite")).checksum,
      exported.checksum,
      "source remains untouched",
    );
  } finally {
    await target?.close();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
    await rm(root, { recursive: true, force: true });
  }
});
