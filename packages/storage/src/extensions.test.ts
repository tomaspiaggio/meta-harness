import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  eventMessage,
  parseExtensionManifest,
  parseExtensionRunResult,
} from "@harness/core/extensions";
import type { WorkerRecord, WorkerReport } from "@harness/core/scheduling";
import { Pool } from "pg";
import { HarnessStore } from "./application";
import { connectPostgres } from "./database";

const report: WorkerReport = {
  hostname: "pi",
  providers: ["demo", "codex"],
  labels: ["arm64", "deno"],
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
const manifest = {
  id: "inbox",
  name: "Inbox",
  description: "Watches an inbox.",
  version: "1.0.0",
  runtime: "deno",
  permissions: { net: ["api.example.com"] },
  config: {
    properties: {
      user: { type: "string", title: "User" },
      token: { type: "string", title: "Token", secret: true },
      limit: { type: "integer", title: "Limit", default: 10 },
    },
    required: ["user", "token", "limit"],
  },
  triggers: [
    { name: "poll", type: "cron", cron: "*/5 * * * *" },
    { name: "push", type: "webhook" },
  ],
};
const code = "export default async function run(ctx) { ctx.emit([]); }";
const ok = (events: unknown[], set: Record<string, unknown> = {}) =>
  parseExtensionRunResult({ events, state: { set }, logs: "ran" });

async function claimed(store: HarnessStore, worker: WorkerRecord) {
  const assignment = await store.extensions.claim(worker);
  assert.ok(assignment);
  return assignment;
}
/** SQLite always; PostgreSQL too when a test database is configured. */
const backends: [string, () => Promise<HarnessStore>][] = [
  ["SQLite", async () => new HarnessStore(":memory:")],
  ...(process.env.HARNESS_TEST_DATABASE_URL
    ? [["PostgreSQL", postgresStore] as [string, () => Promise<HarnessStore>]]
    : []),
];
async function postgresStore() {
  const url = String(process.env.HARNESS_TEST_DATABASE_URL);
  const schema = `harness_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();
  const isolated = new URL(url);
  isolated.searchParams.set("options", `-c search_path=${schema}`);
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
  return new HarnessStore(await connectPostgres(isolated.toString()));
}
async function setup(open: () => Promise<HarnessStore>) {
  const store = await open();
  await store.ready;
  const worker = await store.createWorker("pi");
  await store.reportWorker(worker.id, report);
  const record = async () => {
    const found = (await store.listWorkers()).find(
      (item) => item.id === worker.id,
    );
    assert.ok(found);
    return found;
  };
  return { store, worker, record };
}

test("manifests are checked before anything is stored", () => {
  assert.equal(parseExtensionManifest(manifest).triggers[0].type, "cron");
  assert.equal(
    parseExtensionManifest(manifest).config.properties.token.secret,
    true,
  );
  for (const [change, message] of [
    [{ id: "Bad ID" }, /lowercase/],
    [{ permissions: { net: ["*"] } }, /exact host/],
    [{ permissions: { net: ["http://api.example.com"] } }, /exact host/],
    [{ triggers: [] }, /at least one trigger/],
    [{ triggers: [{ name: "x", type: "cron", cron: "* *" }] }, /five-field/],
    [{ timeoutSeconds: 900 }, /1–300/],
    [{ config: { properties: {}, required: ["missing"] } }, /declared/],
  ] as const)
    assert.throws(
      () => parseExtensionManifest({ ...manifest, ...change }),
      message,
    );
  assert.throws(
    () => parseExtensionRunResult({ events: Array(101).fill({}) }),
    /at most 100/,
  );
  assert.match(
    eventMessage({ name: "Inbox" }, "poll", [
      {
        title: "A reply",
        text: "Hi",
        url: "https://example.com/1",
        type: "reply",
      },
    ]),
    /^\[Inbox · poll\] 1 new event\n\n### A reply \(reply\)\nHi\nhttps:\/\/example.com\/1$/,
  );
});

for (const [backend, open] of backends) {
  test(`${backend}: a proposal runs only after approval and with its settings filled in`, async () => {
    const { store, record } = await setup(open);
    try {
      const first = await store.extensions.propose({
        manifest,
        code,
        proposedBy: "session:x",
      });
      assert.equal(first.status, "proposed");
      // Proposing the same code again does not add a revision.
      assert.equal(
        (
          await store.extensions.propose({
            manifest,
            code,
            proposedBy: "owner",
          })
        ).revision,
        first.revision,
      );
      let extension = await store.extensions.get("inbox");
      assert.equal(extension.activeRevision, null);
      assert.equal(extension.enabled, false);
      await assert.rejects(
        store.extensions.configure("inbox", { enabled: true }),
        /Approve a revision/,
      );
      await assert.rejects(
        store.extensions.enqueue("inbox", "poll"),
        /no approved revision/,
      );

      extension = await store.extensions.decide("inbox", 1, "approve");
      assert.equal(extension.activeRevision, 1);
      assert.equal(extension.enabled, true);
      // The integer setting has a default; the other two are missing.
      assert.deepEqual(extension.missing, ["user", "token"]);
      await assert.rejects(
        store.extensions.enqueue("inbox", "poll"),
        /settings first: user, token/,
      );
      extension = await store.extensions.configure("inbox", {
        config: { user: "tom" },
        secrets: { sealed: "sealed-blob", names: ["token"] },
      });
      assert.deepEqual(extension.missing, []);
      assert.deepEqual(extension.secretNames, ["token"]);
      assert.equal(
        await store.extensions.sealedSecrets("inbox"),
        "sealed-blob",
      );

      // A timer is armed on the first tick and fires once due.
      const now = Date.UTC(2026, 10, 2, 10, 1);
      await store.extensions.tick(now);
      assert.equal((await store.extensions.runs("inbox")).length, 0);
      await store.extensions.tick(Date.UTC(2026, 10, 2, 10, 5));
      // A second control instance ticking the same moment does not double it.
      await store.extensions.tick(Date.UTC(2026, 10, 2, 10, 5));
      const runs = await store.extensions.runs("inbox");
      assert.equal(runs.length, 1);
      assert.equal(runs[0].trigger, "poll");

      // A worker without the runtime label never gets it.
      const other = await store.createWorker("mac");
      await store.reportWorker(other.id, { ...report, labels: ["arm64"] });
      const mac = (await store.listWorkers()).find(
        (item) => item.id === other.id,
      );
      assert.ok(mac);
      assert.equal(await store.extensions.claim(mac), null);
      const assignment = await store.extensions.claim(await record());
      assert.ok(assignment);
      assert.equal(assignment.code, code);
      assert.equal(assignment.secrets, "sealed-blob");
      assert.deepEqual(assignment.config, { user: "tom" });
    } finally {
      await store.close();
    }
  });

  test(`${backend}: new events reach subscribed sessions once; a failed run changes nothing`, async () => {
    const { store, worker, record } = await setup(open);
    try {
      await store.extensions.propose({ manifest, code, proposedBy: "owner" });
      await store.extensions.decide("inbox", 1, "approve");
      await store.extensions.configure("inbox", {
        config: { user: "tom" },
        secrets: { sealed: "x", names: ["token"] },
      });
      const replies = await store.createSession(
        "business",
        "Replies",
        "claude",
      );
      const planner = await store.createSession("business", "Plan", "claude");
      await store.extensions.subscribe({
        extensionId: "inbox",
        sessionId: replies.id,
        createdBy: "owner",
      });
      await store.extensions.subscribe({
        extensionId: "inbox",
        sessionId: planner.id,
        types: ["mention"],
        createdBy: "owner",
      });

      await store.extensions.enqueue("inbox", "poll");
      let assignment = await claimed(store, await record());
      // One run per extension at a time, so state stays consistent.
      await store.extensions.enqueue("inbox", "push", { body: "{}" });
      assert.equal(await store.extensions.claim(await record()), null);
      const outcome = await store.extensions.complete(
        worker.id,
        assignment.run.id,
        ok(
          [
            { key: "1", type: "reply", title: "First reply", text: "Hello" },
            { key: "2", type: "mention", title: "Mentioned you" },
            { key: "2", type: "mention", title: "Duplicate in the same run" },
          ],
          { cursor: "2" },
        ),
      );
      assert.equal(outcome.events, 2);
      assert.equal(outcome.turns.length, 2);
      const [delivered] = await store.listTurns(replies.id);
      assert.match(delivered.prompt, /2 new events/);
      assert.match(delivered.prompt, /First reply/);
      const [planned] = await store.listTurns(planner.id);
      assert.match(planned.prompt, /1 new event/);
      assert.doesNotMatch(planned.prompt, /First reply/);
      assert.deepEqual(await store.extensions.deliveryForTurn(delivered.id), {
        extensionId: "inbox",
        runId: assignment.run.id,
        events: 2,
      });
      assert.deepEqual(await store.extensions.state("inbox"), { cursor: "2" });
      // Completing twice is refused.
      await assert.rejects(
        store.extensions.complete(worker.id, assignment.run.id, ok([])),
        /no longer assigned/,
      );

      // The webhook run sees the saved state; events it already sent are dropped.
      assignment = await claimed(store, await record());
      assert.equal(assignment.run.trigger, "push");
      assert.deepEqual(assignment.state, { cursor: "2" });
      assert.deepEqual(assignment.request, { body: "{}" });
      const repeat = await store.extensions.complete(
        worker.id,
        assignment.run.id,
        ok([{ key: "1", title: "First reply" }]),
      );
      assert.deepEqual(repeat, { events: 0, turns: [] });
      assert.equal((await store.listTurns(replies.id)).length, 1);

      // A run that throws keeps the old state and sends nothing.
      await store.extensions.enqueue("inbox", "poll");
      assignment = await claimed(store, await record());
      await store.extensions.complete(worker.id, assignment.run.id, {
        ...ok([{ key: "3", title: "Lost" }], { cursor: "3" }),
        error: "Error: boom",
      });
      assert.deepEqual(await store.extensions.state("inbox"), { cursor: "2" });
      assert.equal((await store.extensions.runs("inbox"))[0].status, "failed");
      assert.equal((await store.extensions.events("inbox")).length, 2);

      // A worker that goes quiet loses the run after its timeout.
      await store.extensions.enqueue("inbox", "poll");
      assignment = await claimed(store, await record());
      await store.extensions.tick(Date.now() + 120000);
      assert.match(
        (await store.extensions.runs("inbox"))[0].error ?? "",
        /stopped responding/,
      );

      // Deleting a subscribed session removes its subscription.
      await store.deleteSession(planner.id);
      assert.deepEqual(
        (await store.extensions.subscriptions({ extensionId: "inbox" })).map(
          (item) => item.sessionId,
        ),
        [replies.id],
      );
      // A new approved revision cancels runs queued for the old one.
      await store.extensions.enqueue("inbox", "push", { body: "late" });
      await store.extensions.propose({
        manifest: { ...manifest, version: "1.1.0" },
        code,
        proposedBy: "owner",
      });
      await store.extensions.decide("inbox", 2, "approve");
      assert.equal((await store.extensions.runs("inbox"))[0].status, "skipped");
      // Rolling back to the first revision is an approval of it.
      assert.equal(
        (await store.extensions.decide("inbox", 1, "approve")).activeRevision,
        1,
      );
      await store.extensions.configure("inbox", { enabled: false });
      await store.extensions.remove("inbox");
      assert.deepEqual(await store.extensions.list(), []);
    } finally {
      await store.close();
    }
  });
}
