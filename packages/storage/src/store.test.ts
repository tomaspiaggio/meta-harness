import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executeTurn } from "@harness/core";
import { SqliteStore } from "./index";

async function setup() {
  const store = new SqliteStore(":memory:");
  const session = await store.createSession("tech", "Test", "demo");
  return { store, session };
}
test("submission is idempotent and serializes queued messages per session", async () => {
  const { store, session } = await setup();
  try {
    const turn = await store.createTurn("one", session.id, "hello");
    assert.deepEqual(await store.createTurn("one", session.id, "hello"), turn);
    await store.attachRun("one", "accepted-before-local-queue-restart");
    assert.deepEqual(
      await store.pendingDispatch(),
      ["one"],
      "pending outbox must survive an acknowledged dispatch that never executed",
    );
    await assert.rejects(
      async () => await store.createTurn("one", session.id, "different"),
      /different input/,
    );
    assert.equal(
      (await store.createTurn("two", session.id, "next")).status,
      "pending",
    );
    assert.equal(
      await store.claim("worker", Date.now(), 30000),
      null,
      "pending outbox is not executable",
    );
    await store.enqueue(turn.id);
    await store.enqueue(turn.id);
    const claim = await store.claim("worker", Date.now(), 30000);
    assert.ok(claim);
    assert.equal(await store.claim("other", Date.now(), 30000), null);
    await store.finish(turn.id, claim.turn.generation, "completed");
    await store.enqueue(turn.id);
    assert.equal(
      (await store.getTurn(turn.id)).status,
      "completed",
      "redelivery must not replay completed work",
    );
    assert.equal(
      (await store.createTurn("two", session.id, "next")).status,
      "pending",
    );
  } finally {
    await store.close();
  }
});
test("expired ownership rejects old writes and requires explicit continuation", async () => {
  const { store, session } = await setup();
  try {
    await store.createTurn("one", session.id, "hello");
    await store.enqueue("one");
    const claim = await store.claim("worker", Date.now(), 30000);
    assert.ok(claim);
    await store.appendOutput("one", claim.turn.generation, "partial result");
    assert.equal(await store.recoverExpired(Date.now() + 60000), 1);
    assert.equal((await store.getTurn("one")).status, "interrupted");
    assert.equal((await store.getTurn("one")).output, "partial result");
    await assert.rejects(
      async () =>
        await store.appendOutput("one", claim.turn.generation, "stale"),
      /ownership/,
    );
    await assert.rejects(
      async () =>
        await store.saveNativeId("one", claim.turn.generation, "stale-id"),
      /ownership/,
    );
    await assert.rejects(
      async () => await store.finish("one", claim.turn.generation, "completed"),
      /ownership/,
    );
    assert.equal(
      await store.heartbeat("one", claim.turn.generation, Date.now(), 30000),
      false,
    );
    assert.equal(
      await store.claim("replacement", Date.now(), 30000),
      null,
      "no automatic agent retry",
    );
  } finally {
    await store.close();
  }
});
test("SQLite survives reopening and coordinates independent connections", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meta-store-"));
  const path = join(dir, "test.sqlite");
  const first = new SqliteStore(path);
  const second = new SqliteStore(path);
  try {
    const session = await first.createSession("business", "Persisted", "codex");
    await first.createTurn("durable", session.id, "hello");
    await first.enqueue("durable");
    const claim = await second.claim("second", Date.now(), 30000);
    assert.ok(claim);
    assert.equal(await first.claim("first", Date.now(), 30000), null);
    await second.saveNativeId("durable", claim.turn.generation, "native-123");
    await second.appendOutput("durable", claim.turn.generation, "saved output");
    await second.finish("durable", claim.turn.generation, "completed");
    assert.equal((await first.getSession(session.id)).nativeId, "native-123");
    const reopened = new SqliteStore(path);
    try {
      assert.equal((await reopened.getTurn("durable")).output, "saved output");
    } finally {
      await reopened.close();
    }
  } finally {
    await first.close();
    await second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("ordinary execution functions save native state and fail without retrying runtime effects", async () => {
  const { store, session } = await setup();
  try {
    await store.createTurn("failure", session.id, "hello");
    await store.enqueue("failure");
    const claim = await store.claim("worker", Date.now(), 30000);
    assert.ok(claim);
    let calls = 0;
    await executeTurn(
      store,
      claim,
      {
        async run(input) {
          calls++;
          await input.emit({ type: "native-session", id: "resume-me" });
          await input.emit({ type: "text", text: "partial" });
          throw new Error("lost connection after effect");
        },
      },
      "/unused",
      new AbortController().signal,
    );
    assert.equal(calls, 1);
    assert.equal((await store.getTurn("failure")).status, "failed");
    assert.equal((await store.getTurn("failure")).output, "partial");
    assert.equal((await store.getSession(session.id)).nativeId, "resume-me");
  } finally {
    await store.close();
  }
});
test("output persistence has a fixed bound", async () => {
  const { store, session } = await setup();
  try {
    await store.createTurn("bounded", session.id, "hello");
    await store.enqueue("bounded");
    const claim = await store.claim("worker", Date.now(), 30000);
    assert.ok(claim);
    await assert.rejects(
      async () =>
        await store.appendOutput(
          "bounded",
          claim.turn.generation,
          "x".repeat(262145),
        ),
      /exceeded/,
    );
    assert.equal((await store.getTurn("bounded")).output, "");
    await assert.rejects(
      async () =>
        await store.appendOutput(
          "bounded",
          claim.turn.generation,
          "🌱".repeat(70000),
        ),
      /exceeded/,
    );
  } finally {
    await store.close();
  }
});
