import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeEvent, RuntimeInput } from "@harness/core";
import type { NativeSessionEntry } from "@harness/core/native-store";
import { runClaudeSdk } from "./claude-sdk";

test("Claude SDK normalizes transcript keys across directories without changing the auth directory", async () => {
  const entries = new Map<string, NativeSessionEntry[]>();
  const events: RuntimeEvent[] = [];
  const input: RuntimeInput = {
    session: {
      id: "harness-session",
      workspaceId: "tech",
      title: "Disposable",
      provider: "claude",
      nativeId: null,
      model: "opus",
      createdAt: 0,
    },
    directory: "/mac/session",
    prompt: "Remember this.",
    instructions: "Test",
    signal: new AbortController().signal,
    emit: (event) => {
      events.push(event);
    },
    sessionStore: {
      async append(key, batch) {
        entries.set(JSON.stringify(key), batch);
      },
      async load(key) {
        return entries.get(JSON.stringify(key)) ?? null;
      },
    },
  };
  const transcript = [
    { type: "user", uuid: "message-1", message: "remembered fact" },
  ];
  let closed = 0;
  await runClaudeSdk(input, ({ options }) => ({
    async *[Symbol.asyncIterator]() {
      assert.equal(options.model, "opus");
      assert.equal(
        options.env?.CLAUDE_CONFIG_DIR,
        process.env.CLAUDE_CONFIG_DIR,
      );
      assert.equal(options.env?.HARNESS_WORKER_TOKEN_FILE, undefined);
      assert.deepEqual(options.allowedTools, ["Edit(./DECISION_UPDATES.json)"]);
      if (!options.sessionStore) throw new Error("Missing store");
      await options.sessionStore.append(
        { projectKey: "-mac-session", sessionId: "native-id" },
        transcript,
      );
      yield { type: "system", subtype: "init", session_id: "native-id" };
      yield { type: "result", subtype: "success", session_id: "native-id" };
    },
    close() {
      closed++;
    },
  }));
  assert.equal(entries.size, 1);
  assert.equal(
    [...entries.keys()][0],
    JSON.stringify({
      projectKey: "meta-harness-harness-session",
      sessionId: "native-id",
    }),
  );
  await runClaudeSdk(
    {
      ...input,
      directory: "/pi/session",
      session: { ...input.session, nativeId: "native-id", model: "haiku" },
    },
    ({ options }) => ({
      async *[Symbol.asyncIterator]() {
        assert.equal(options.resume, "native-id");
        assert.equal(options.model, "haiku");
        if (!options.sessionStore) throw new Error("Missing store");
        assert.deepEqual(
          await options.sessionStore.load({
            projectKey: "-pi-session",
            sessionId: "native-id",
          }),
          transcript,
        );
        yield { type: "result", subtype: "success", session_id: "native-id" };
      },
      close() {
        closed++;
      },
    }),
  );
  assert.equal(closed, 2);
  assert.ok(
    events.some(
      (event) => event.type === "native-session" && event.id === "native-id",
    ),
  );
});
test("a failed mirror cannot be reported as a portable successful turn", async () => {
  let closed = false;
  await assert.rejects(
    runClaudeSdk(
      {
        session: {
          id: "test",
          workspaceId: "tech",
          title: "Test",
          provider: "claude",
          nativeId: null,
          createdAt: 0,
        },
        directory: "/test",
        prompt: "Test",
        instructions: "Test",
        signal: new AbortController().signal,
        emit: () => {},
        sessionStore: {
          async append() {},
          async load() {
            return null;
          },
        },
      },
      () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "result", subtype: "success" };
          yield {
            type: "system",
            subtype: "mirror_error",
            error: "storage unavailable",
          };
        },
        close() {
          closed = true;
        },
      }),
    ),
    /persistence failed/,
  );
  assert.equal(closed, true);
});
