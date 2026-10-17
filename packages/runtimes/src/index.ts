import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentRuntime,
  Provider,
  RuntimeEvent,
  RuntimeInput,
} from "@harness/core";

type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null
    ? (value as JsonRecord)
    : {};
}

/** Parse only display text and native IDs; never persist raw credential-bearing events. */
export function decodeEvent(
  provider: "codex" | "claude",
  value: unknown,
): RuntimeEvent[] {
  const event = record(value);
  const events: RuntimeEvent[] = [];
  if (provider === "codex") {
    if (
      event.type === "thread.started" &&
      typeof event.thread_id === "string"
    ) {
      events.push({ type: "native-session", id: event.thread_id });
    }
    const item = record(event.item);
    if (
      event.type === "item.completed" &&
      item.type === "agent_message" &&
      typeof item.text === "string"
    ) {
      events.push({ type: "text", text: `${item.text}\n\n` });
    }
    if (event.type === "turn.failed" || event.type === "error") {
      const error = record(event.error);
      throw new Error(
        String(error.message ?? event.message ?? "Codex turn failed."),
      );
    }
  } else {
    if (typeof event.session_id === "string")
      events.push({ type: "native-session", id: event.session_id });
    if (event.type === "assistant") {
      const content = record(event.message).content;
      if (Array.isArray(content)) {
        for (const value of content) {
          const block = record(value);
          if (block.type === "text" && typeof block.text === "string") {
            events.push({ type: "text", text: `${block.text}\n\n` });
          }
        }
      }
    }
    if (event.type === "result" && event.is_error) {
      throw new Error(
        typeof event.result === "string" ? event.result : "Claude turn failed.",
      );
    }
  }
  return events;
}

export function commandFor(
  provider: "codex" | "claude",
  nativeId: string | null,
) {
  if (provider === "codex") {
    return {
      bin: process.env.CODEX_BIN ?? "codex",
      args: [
        "exec",
        ...(nativeId ? ["resume", nativeId] : []),
        "--json",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "-c",
        'approval_policy="never"',
        "-c",
        'sandbox_mode="workspace-write"',
        "-",
      ],
    };
  }
  return {
    bin: process.env.CLAUDE_BIN ?? "claude",
    args: [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "dontAsk",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      ...(nativeId ? ["--resume", nativeId] : []),
    ],
  };
}

async function runCli(
  provider: "codex" | "claude",
  input: RuntimeInput,
): Promise<void> {
  input.signal.throwIfAborted();
  const command = commandFor(provider, input.session.nativeId);
  const child = spawn(command.bin, command.args, {
    cwd: input.directory,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: { ...process.env, NO_COLOR: "1" },
  });
  let stderr = "";
  let spawnError: Error | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      /* Already exited. */
    }
  };
  const stop = () => {
    kill("SIGTERM");
    killTimer ??= setTimeout(() => kill("SIGKILL"), 2000);
    killTimer.unref();
  };
  const closed = new Promise<number | null>((resolve) => {
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", resolve);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  child.stdin.on("error", () => {
    /* Exit status carries broken-pipe failures. */
  });
  input.signal.addEventListener("abort", stop, { once: true });
  if (input.signal.aborted) stop();
  child.stdin.end(
    `Workspace instructions:\n${input.instructions}\n\nUser instruction:\n${input.prompt}`,
  );
  let buffer = "";
  let completed = false;
  const consume = (line: string) => {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(
        `${provider} emitted invalid JSON. Check the installed CLI version.`,
      );
    }
    const event = record(value);
    if (
      provider === "codex"
        ? event.type === "turn.completed"
        : event.type === "result" && !event.is_error
    ) {
      completed = true;
    }
    for (const event of decodeEvent(provider, value)) input.emit(event);
  };
  try {
    child.stdout.setEncoding("utf8");
    for await (const chunk of child.stdout) {
      buffer += chunk;
      if (buffer.length > 1024 * 1024)
        throw new Error("Provider event exceeded 1 MiB.");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    consume(buffer);
    const code = await closed;
    input.signal.throwIfAborted();
    if (spawnError)
      throw new Error(`Cannot launch ${provider}: ${spawnError.message}`);
    if (code !== 0)
      throw new Error(
        `${provider} exited with ${code}: ${stderr.slice(-2000)}`,
      );
    if (!completed)
      throw new Error(`${provider} exited without a completed turn event.`);
  } finally {
    stop();
    await closed;
    input.signal.removeEventListener("abort", stop);
    if (killTimer) clearTimeout(killTimer);
  }
}

export function createRuntime(provider: Provider): AgentRuntime {
  if (provider === "demo") {
    return {
      async run(input) {
        input.emit({
          type: "native-session",
          id: input.session.nativeId ?? crypto.randomUUID(),
        });
        for (const text of [
          "Local worker connected.\n\n",
          `You said: ${input.prompt}\n\n`,
          "This is the demo runtime. Choose Codex or Claude in a new session to run a real agent.",
        ]) {
          await delay(150, undefined, { signal: input.signal });
          input.emit({ type: "text", text });
        }
      },
    };
  }
  return { run: (input) => runCli(provider, input) };
}
