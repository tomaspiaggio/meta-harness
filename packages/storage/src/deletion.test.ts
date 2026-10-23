import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HarnessStore } from "./application";

test("confirmed resource deletion cascades dependent state, fences workers, and preserves published shared knowledge", async () => {
  const store = new HarnessStore(":memory:");
  await store.ready;
  try {
    const workspace = await store.createWorkspace(
      "Disposable",
      "Deletion fixture",
    );
    const one = await store.createSession(workspace.id, "First", "demo");
    const two = await store.createSession(workspace.id, "Second", "demo");
    const survivor = await store.createSession("business", "Keep", "demo");
    await store.createTurn("deleted-turn", one.id, "Work");
    await store.enqueue("deleted-turn");
    const worker = await store.createWorker("Worker");
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
      reserveMemoryMiB: 0,
      loadPerCpu: 0,
      maxLoadPerCpu: 100,
      draining: false,
    });
    const assignment = await store.claimForWorker(worker.id);
    assert.ok(assignment);
    const generation = assignment.claim.turn.generation;
    const db = store.databaseConnection();
    await db
      .prepare("UPDATE turns SET runId = ? WHERE id = ?")
      .run("run-fixture", "deleted-turn");
    await db
      .prepare(
        "INSERT INTO workflow_waiters(runId,turnId,createdAt) VALUES (?,?,?)",
      )
      .run("waiter-fixture", "deleted-turn", Date.now());
    await db
      .prepare(
        "INSERT INTO decision_history(key,content,revision,workspaceId,sessionId,turnId,updatedAt) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        "pilot.price",
        "173",
        1,
        workspace.id,
        one.id,
        "deleted-turn",
        Date.now(),
      );
    await db
      .prepare(
        "INSERT INTO browser_identities(id,workspaceId,name,updatedAt) VALUES (?,?,?,?)",
      )
      .run("browser-fixture", workspace.id, "Browser", Date.now());
    await db
      .prepare(
        "INSERT INTO browser_commands(id,browserId,turnId,browserGeneration,action,arguments,createdAt) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        "command",
        "browser-fixture",
        "deleted-turn",
        1,
        "read",
        "{}",
        Date.now(),
      );
    await db
      .prepare(
        "INSERT INTO attachments(id,sessionId,name,mediaType,size,hash,objectKey,createdAt) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        "file",
        one.id,
        "fixture.txt",
        "text/plain",
        0,
        "hash",
        "attachments/file",
        Date.now(),
      );
    await db
      .prepare("INSERT INTO turn_attachments VALUES (?,?)")
      .run("deleted-turn", "file");
    await store.requestInput(
      "question",
      one.id,
      "deleted-turn",
      "question",
      "Answer?",
    );
    await store.draftSchedule("schedule", {
      sessionId: one.id,
      name: "Review",
      prompt: "Review",
      kind: "agent",
      trigger: { type: "once", at: Date.now() + 60000 },
    });
    await db
      .prepare(
        "INSERT INTO schedule_wakes(id,scheduleId,revision,dueAt,runId,createdAt) VALUES (?,?,?,?,?,?)",
      )
      .run(
        "wake",
        "schedule",
        1,
        Date.now() + 60000,
        "timer-fixture",
        Date.now(),
      );
    const ephemeral = await store.createEphemeralWorker(
      "Ephemeral",
      "deleted-turn",
      Date.now() + 60000,
    );
    await db
      .prepare(
        "INSERT INTO sandbox_jobs(id,turnId,workerId,sandboxId,status,expiresAt,createdAt) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        "sandbox",
        "deleted-turn",
        ephemeral.id,
        "sandbox-fixture",
        "running",
        Date.now() + 60000,
        Date.now(),
      );
    await store.deleteSession(one.id);
    await store.deleteSession(one.id); // A lost acknowledgement is safe to retry.
    await assert.rejects(store.getSession(one.id), /not found/);
    await assert.rejects(
      store.assertAssignment(worker.id, "deleted-turn", generation),
      /not found/,
    );
    await assert.rejects(
      store.authenticateWorker(ephemeral.id, ephemeral.token),
      /credential/,
    );
    assert.equal((await store.getSession(two.id)).id, two.id);
    const decisions = await store.getSharedDecisions();
    assert.equal(decisions.decisions[0]?.content, "173");
    assert.equal(decisions.decisions[0]?.sessionId, null);
    for (const table of [
      "turns",
      "tasks",
      "schedules",
      "attachments",
      "turn_attachments",
      "input_requests",
      "workflow_waiters",
      "sandbox_jobs",
      "worker_grants",
      "browser_commands",
    ])
      assert.equal(
        Number(
          (await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get())
            ?.count,
        ),
        0,
        table,
      );
    assert.deepEqual(
      (
        await db.prepare("SELECT kind FROM cleanup_jobs ORDER BY kind").all()
      ).map((x) => x.kind),
      ["object", "run", "run", "run", "sandbox"],
    );
    await store.deleteWorkspace(workspace.id);
    await assert.rejects(store.getSession(two.id), /not found/);
    await assert.rejects(store.getWorkspace(workspace.id), /not found/);
    assert.equal(
      Number(
        (
          await db
            .prepare("SELECT COUNT(*) AS count FROM browser_identities")
            .get()
        )?.count,
      ),
      0,
    );
    assert.ok(
      (await store.workerCleanup(worker.id)).some((item) => item.id === one.id),
    );
    await store.acknowledgeCleanup(worker.id, "session", one.id);
    assert.ok(
      !(await store.workerCleanup(worker.id)).some(
        (item) => item.id === one.id,
      ),
    );
    assert.equal((await store.getSession(survivor.id)).id, survivor.id);
  } finally {
    await store.close();
  }
});

test("deleted default workspaces, including the final workspace, stay deleted after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-delete-restart-"));
  const path = join(directory, "state.sqlite");
  let store = new HarnessStore(path);
  try {
    await store.ready;
    for (const workspace of await store.listWorkspaces())
      await store.deleteWorkspace(workspace.id);
    assert.deepEqual(await store.listWorkspaces(), []);
    await store.close();
    store = new HarnessStore(path);
    await store.ready;
    assert.deepEqual(await store.listWorkspaces(), []);
    await store.createWorkspace("New start", "A new workspace");
    assert.equal((await store.listWorkspaces()).length, 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
