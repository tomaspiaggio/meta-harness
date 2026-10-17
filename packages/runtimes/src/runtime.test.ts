import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RuntimeEvent, RuntimeInput } from "@harness/core";
import { ProviderUnavailableError } from "@harness/core";
import { commandFor, createRuntime, decodeEvent } from "./index";

test("Codex and Claude events normalize text and preserve native identity", () => {
  assert.deepEqual(
    decodeEvent("codex", { type: "thread.started", thread_id: "thread-1" }),
    [{ type: "native-session", id: "thread-1" }],
  );
  assert.deepEqual(
    decodeEvent("codex", {
      type: "item.completed",
      item: { type: "agent_message", text: "hello" },
    }),
    [{ type: "text", text: "hello\n\n" }],
  );
  assert.deepEqual(
    decodeEvent("codex", {
      type: "item.completed",
      item: { type: "command_execution", aggregated_output: "secret" },
    }),
    [],
  );
  assert.deepEqual(
    decodeEvent("claude", {
      type: "assistant",
      session_id: "claude-1",
      message: { content: [{ type: "text", text: "hello" }] },
    }),
    [
      { type: "native-session", id: "claude-1" },
      { type: "text", text: "hello\n\n" },
    ],
  );
  assert.throws(
    () =>
      decodeEvent("claude", {
        type: "result",
        is_error: true,
        result: "denied",
      }),
    /denied/,
  );
  assert.throws(
    () =>
      decodeEvent("codex", {
        type: "turn.failed",
        error: { message: "offline" },
      }),
    /offline/,
  );
});

test("continuation uses an explicit native ID and never bypasses permissions", () => {
  for (const provider of ["claude", "codex"] as const) {
    const command = commandFor(provider, "specific-native-session");
    assert.ok(command.args.includes("specific-native-session"));
    assert.ok(!command.args.some((arg) => arg.includes("dangerously")));
    assert.ok(!command.args.includes("--last"));
  }
});

test("structured provider limits become a cooldown rather than successful assistant output", () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 300;
  assert.throws(
    () =>
      decodeEvent("claude", {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt },
      }),
    (error) =>
      error instanceof ProviderUnavailableError &&
      error.retryAt === resetsAt * 1000,
  );
  assert.throws(
    () => decodeEvent("claude", { type: "assistant", error: "rate_limit" }),
    ProviderUnavailableError,
  );
  assert.deepEqual(
    decodeEvent("claude", {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning" },
    }),
    [],
  );
});

function input(
  directory: string,
  events: RuntimeEvent[],
  signal = new AbortController().signal,
): RuntimeInput {
  return {
    directory,
    signal,
    prompt: "hello",
    instructions: "test",
    emit: (event) => {
      events.push(event);
    },
    session: {
      id: "test",
      workspaceId: "tech",
      title: "Test",
      provider: "codex",
      nativeId: null,
      createdAt: Date.now(),
    },
  };
}

test("CLI adapter consumes JSONL and treats clean exit without completion as interrupted work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meta-runtime-"));
  const bin = join(dir, "fake codex");
  const original = process.env.CODEX_BIN;
  try {
    process.env.CODEX_BIN = bin;
    writeFileSync(
      bin,
      '#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on("end", () => {\nconsole.log(JSON.stringify({type:"thread.started",thread_id:"saved-id"}));\nconsole.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"hello"}}));\nconsole.log(JSON.stringify({type:"turn.completed"}));\n});\n',
    );
    chmodSync(bin, 0o700);
    const events: RuntimeEvent[] = [];
    await createRuntime("codex").run(input(dir, events));
    assert.deepEqual(events, [
      { type: "native-session", id: "saved-id" },
      { type: "text", text: "hello\n\n" },
    ]);
    writeFileSync(bin, "#!/usr/bin/env node\nprocess.stdin.resume();\n");
    await assert.rejects(
      createRuntime("codex").run(input(dir, [])),
      /without a completed turn/,
    );
  } finally {
    if (original === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancellation terminates a live CLI process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meta-abort-"));
  const bin = join(dir, "fake-codex");
  const original = process.env.CODEX_BIN;
  const controller = new AbortController();
  try {
    writeFileSync(
      bin,
      "#!/usr/bin/env node\nprocess.stdin.resume(); setInterval(() => {}, 1000);\n",
    );
    chmodSync(bin, 0o700);
    process.env.CODEX_BIN = bin;
    const timer = setTimeout(
      () => controller.abort(new Error("cancelled")),
      100,
    );
    try {
      await assert.rejects(
        createRuntime("codex").run(input(dir, [], controller.signal)),
        /cancelled/,
      );
    } finally {
      clearTimeout(timer);
    }
  } finally {
    if (original === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = original;
    rmSync(dir, { recursive: true, force: true });
  }
});
