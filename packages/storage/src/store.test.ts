import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executeTurn } from "@harness/core";
import { SqliteStore } from "./index";

function setup() {
  const store = new SqliteStore(":memory:");
  const session = store.createSession("tech", "Test", "demo");
  return { store, session };
}

test("submission is idempotent and permits only one active turn per session", () => {
  const { store, session } = setup();
  try {
    const turn = store.createTurn("one", session.id, "hello");
    assert.deepEqual(store.createTurn("one", session.id, "hello"), turn);
    store.attachRun("one", "accepted-before-local-queue-restart");
    assert.deepEqual(
      store.pendingDispatch(),
      ["one"],
      "pending outbox must survive an acknowledged dispatch that never executed",
    );
    assert.throws(
      () => store.createTurn("one", session.id, "different"),
      /different input/,
    );
    assert.throws(
      () => store.createTurn("two", session.id, "next"),
      /active turn/,
    );
    assert.equal(
      store.claim("worker", Date.now(), 30_000),
      null,
      "pending outbox is not executable",
    );
    store.enqueue(turn.id);
    store.enqueue(turn.id);
    const claim = store.claim("worker", Date.now(), 30_000);
    assert.ok(claim);
    assert.equal(store.claim("other", Date.now(), 30_000), null);
    store.finish(turn.id, claim.turn.generation, "completed");
    store.enqueue(turn.id);
    assert.equal(
      store.getTurn(turn.id).status,
      "completed",
      "redelivery must not replay completed work",
    );
    assert.equal(store.createTurn("two", session.id, "next").status, "pending");
  } finally {
    store.close();
  }
});

test("expired ownership rejects old writes and requires explicit continuation", () => {
  const { store, session } = setup();
  try {
    store.createTurn("one", session.id, "hello");
    store.enqueue("one");
    const claim = store.claim("worker", Date.now(), 30_000);
    assert.ok(claim);
    store.appendOutput("one", claim.turn.generation, "partial result");
    assert.equal(store.recoverExpired(Date.now() + 60_000), 1);
    assert.equal(store.getTurn("one").status, "interrupted");
    assert.equal(store.getTurn("one").output, "partial result");
    assert.throws(
      () => store.appendOutput("one", claim.turn.generation, "stale"),
      /ownership/,
    );
    assert.throws(
      () => store.saveNativeId("one", claim.turn.generation, "stale-id"),
      /ownership/,
    );
    assert.throws(
      () => store.finish("one", claim.turn.generation, "completed"),
      /ownership/,
    );
    assert.equal(
      store.heartbeat("one", claim.turn.generation, Date.now(), 30_000),
      false,
    );
    assert.equal(
      store.claim("replacement", Date.now(), 30_000),
      null,
      "no automatic agent retry",
    );
  } finally {
    store.close();
  }
});

test("SQLite survives reopening and coordinates independent connections", () => {
  const dir = mkdtempSync(join(tmpdir(), "meta-store-"));
  const path = join(dir, "test.sqlite");
  const first = new SqliteStore(path);
  const second = new SqliteStore(path);
  try {
    const session = first.createSession("business", "Persisted", "codex");
    first.createTurn("durable", session.id, "hello");
    first.enqueue("durable");
    const claim = second.claim("second", Date.now(), 30_000);
    assert.ok(claim);
    assert.equal(first.claim("first", Date.now(), 30_000), null);
    second.saveNativeId("durable", claim.turn.generation, "native-123");
    second.appendOutput("durable", claim.turn.generation, "saved output");
    second.finish("durable", claim.turn.generation, "completed");
    assert.equal(first.getSession(session.id).nativeId, "native-123");
    const reopened = new SqliteStore(path);
    try {
      assert.equal(reopened.getTurn("durable").output, "saved output");
    } finally {
      reopened.close();
    }
  } finally {
    first.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary execution functions save native state and fail without retrying runtime effects", async () => {
  const { store, session } = setup();
  try {
    store.createTurn("failure", session.id, "hello");
    store.enqueue("failure");
    const claim = store.claim("worker", Date.now(), 30_000);
    assert.ok(claim);
    let calls = 0;
    await executeTurn(
      store,
      claim,
      {
        async run(input) {
          calls++;
          input.emit({ type: "native-session", id: "resume-me" });
          input.emit({ type: "text", text: "partial" });
          throw new Error("lost connection after effect");
        },
      },
      "/unused",
      new AbortController().signal,
    );
    assert.equal(calls, 1);
    assert.equal(store.getTurn("failure").status, "failed");
    assert.equal(store.getTurn("failure").output, "partial");
    assert.equal(store.getSession(session.id).nativeId, "resume-me");
  } finally {
    store.close();
  }
});

test("output persistence has a fixed bound", () => {
  const { store, session } = setup();
  try {
    store.createTurn("bounded", session.id, "hello");
    store.enqueue("bounded");
    const claim = store.claim("worker", Date.now(), 30_000);
    assert.ok(claim);
    assert.throws(
      () =>
        store.appendOutput(
          "bounded",
          claim.turn.generation,
          "x".repeat(262145),
        ),
      /exceeded/,
    );
    assert.equal(store.getTurn("bounded").output, "");
    assert.throws(
      () =>
        store.appendOutput(
          "bounded",
          claim.turn.generation,
          "🌱".repeat(70_000),
        ),
      /exceeded/,
    );
  } finally {
    store.close();
  }
});
