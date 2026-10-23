import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RuntimeInput } from "@harness/core";
import { commandFor } from "./index";
import { claudeUserMessage, inputPrompt } from "./input";

test("native image input preserves bytes and file references; harness tools use per-attempt bearer identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-multimodal-"));
  try {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBW0AAAAASUVORK5CYII=",
      "base64",
    );
    const path = join(root, "image.png");
    await writeFile(path, bytes);
    const input: RuntimeInput = {
      prompt: "Describe the image",
      instructions: "Use shared decisions",
      directory: root,
      signal: new AbortController().signal,
      session: {
        id: "session",
        workspaceId: "tech",
        provider: "claude",
        title: "Image",
        nativeId: null,
        createdAt: 0,
      },
      emit() {},
      attachments: [
        {
          id: "image",
          sessionId: "session",
          name: "image.png",
          path,
          mediaType: "image/png",
          size: bytes.length,
          hash: createHash("sha256").update(bytes).digest("hex"),
          objectKey: "private/image",
          createdAt: 0,
        },
      ],
    };
    const message = await claudeUserMessage(input);
    assert.ok(Array.isArray(message.message.content));
    const image = message.message.content.find((part) => part.type === "image");
    assert.ok(image && image.source.type === "base64");
    assert.equal(image.source.data, bytes.toString("base64"));
    assert.match(inputPrompt(input), /image.png/);
    assert.doesNotMatch(inputPrompt(input), /private\/image/);
    await writeFile(path, "corrupt");
    await assert.rejects(claudeUserMessage(input), /integrity/);
    const tools = {
      url: "https://control.example/api/tools",
      token: "not-on-command-line",
    };
    for (const provider of ["claude", "codex"] as const) {
      const command = commandFor(provider, null, tools);
      assert.match(command.args.join(" "), /harness/);
      assert.doesNotMatch(command.args.join(" "), /not-on-command-line/);
    }
    assert.ok(
      !commandFor("claude", null).args.includes("--bare"),
      "subscription authentication remains available by default",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex CLI receives native image arguments and the same explicit attachment manifest", async () => {
  const { chmod } = await import("node:fs/promises");
  const { createRuntime } = await import("./index");
  const root = await mkdtemp(join(tmpdir(), "harness-codex-image-"));
  const original = process.env.CODEX_BIN;
  try {
    const capture = join(root, "capture.json");
    const executable = join(root, "fake-codex");
    await writeFile(
      executable,
      `#!/usr/bin/env node\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),input:fs.readFileSync(0,'utf8')}));console.log(JSON.stringify({type:'thread.started',thread_id:'image-thread'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Image fixture accepted'}}));console.log(JSON.stringify({type:'turn.completed'}));\n`,
    );
    await chmod(executable, 0o700);
    process.env.CODEX_BIN = executable;
    const path = join(root, "image.png");
    const bytes = Buffer.from("image fixture");
    await writeFile(path, bytes);
    const events: unknown[] = [];
    const input: RuntimeInput = {
      prompt: "Describe",
      instructions: "Fixture",
      directory: root,
      signal: new AbortController().signal,
      session: {
        id: "session",
        workspaceId: "tech",
        provider: "codex",
        title: "Images",
        nativeId: null,
        createdAt: 0,
      },
      emit: (event) => {
        events.push(event);
      },
      attachments: [
        {
          id: "image",
          sessionId: "session",
          name: "image.png",
          path,
          mediaType: "image/png",
          size: bytes.length,
          hash: createHash("sha256").update(bytes).digest("hex"),
          objectKey: "private/image",
          createdAt: 0,
        },
      ],
    };
    await createRuntime("codex").run(input);
    const { readFile } = await import("node:fs/promises");
    const captured = JSON.parse(await readFile(capture, "utf8"));
    assert.equal(captured.args[captured.args.indexOf("--image") + 1], path);
    assert.match(captured.input, /image.png/);
    assert.ok(
      events.some(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "text",
      ),
    );
  } finally {
    if (original === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = original;
    await rm(root, { recursive: true, force: true });
  }
});
