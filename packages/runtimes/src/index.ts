import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type AgentRuntime,
  type Provider,
  ProviderUnavailableError,
  type RuntimeEvent,
  type RuntimeInput,
} from "@harness/core";
import { imageTypes } from "@harness/core/attachments";
import { parseModel } from "@harness/core/models";
import { runtimeEnvironment } from "./environment";
import { claudeUserMessage, inputPrompt } from "./input";

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
    const limits = record(event.rate_limit_info);
    if (
      event.type === "rate_limit_event" &&
      limits.status === "rejected" &&
      limits.overageStatus !== "allowed" &&
      limits.overageStatus !== "allowed_warning"
    ) {
      const reset =
        typeof limits.resetsAt === "number"
          ? limits.resetsAt * (limits.resetsAt < 1e12 ? 1000 : 1)
          : Date.now() + 5 * 60000;
      throw new ProviderUnavailableError(
        "claude",
        Math.max(
          Date.now() + 1000,
          Math.min(reset, Date.now() + 7 * 24 * 60 * 60000),
        ),
        "Claude provider usage limit reached.",
      );
    }
    if (event.type === "assistant" && event.error === "rate_limit")
      throw new ProviderUnavailableError(
        "claude",
        Date.now() + 5 * 60000,
        "Claude provider usage limit reached; reset time was not supplied.",
      );
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
/**
 * Agents run with full permissions, like the owner's own `claude
 * --dangerously-skip-permissions`. A worker can opt back into the sandbox, and
 * isolated Linux workers always keep it.
 */
export function fullAccess(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.HARNESS_AGENT_PERMISSIONS !== "sandboxed" &&
    env.HARNESS_ISOLATE_AGENTS !== "1"
  );
}
export function commandFor(
  provider: "codex" | "claude",
  nativeId: string | null,
  tools?: RuntimeInput["tools"],
  model?: string | null,
  workingFolder?: string,
  full = fullAccess(),
) {
  const selectedModel = parseModel(provider, model);
  if (provider === "codex") {
    return {
      bin: process.env.CODEX_BIN ?? "codex",
      args: [
        "exec",
        ...(nativeId ? ["resume", nativeId] : []),
        "--json",
        ...(selectedModel ? ["--model", selectedModel] : []),
        "--skip-git-repo-check",
        "--ignore-user-config",
        "-c",
        'approval_policy="never"',
        "-c",
        full
          ? 'sandbox_mode="danger-full-access"'
          : 'sandbox_mode="workspace-write"',
        // Agents clone repositories, call gh and install packages; Linux
        // workspace-write otherwise has no network at all.
        "-c",
        "sandbox_workspace_write.network_access=true",
        ...(tools
          ? [
              "-c",
              `mcp_servers.harness.url=${JSON.stringify(tools.url)}`,
              "-c",
              'mcp_servers.harness.bearer_token_env_var="HARNESS_TOOL_TOKEN"',
              "-c",
              'mcp_servers.harness.default_tools_approval_mode="approve"',
            ]
          : []),
        "-",
      ],
    };
  }
  return {
    bin: process.env.CLAUDE_BIN ?? "claude",
    args: [
      "--print",
      ...(selectedModel ? ["--model", selectedModel] : []),
      ...(process.env.HARNESS_CLAUDE_BARE === "1"
        ? ["--bare"]
        : ["--setting-sources", "", "--disable-slash-commands"]),
      "--verbose",
      "--output-format",
      "stream-json",
      ...(full
        ? ["--dangerously-skip-permissions"]
        : [
            "--permission-mode",
            "dontAsk",
            "--allowedTools",
            "Edit(./DECISION_UPDATES.json)",
            ...(tools ? ["mcp__harness__*"] : []),
          ]),
      ...(workingFolder ? ["--add-dir", workingFolder] : []),
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({
        mcpServers: tools
          ? {
              harness: {
                type: "http",
                url: tools.url,
                headers: {
                  Authorization: "Bearer " + "$" + "{HARNESS_TOOL_TOKEN}",
                },
              },
            }
          : {},
      }),
      ...(nativeId ? ["--resume", nativeId] : []),
    ],
  };
}
async function runCli(
  provider: "codex" | "claude",
  input: RuntimeInput,
): Promise<void> {
  input.signal.throwIfAborted();
  const command = commandFor(
    provider,
    input.session.nativeId,
    input.tools,
    input.session.model ??
      (provider === "claude"
        ? process.env.HARNESS_CLAUDE_MODEL
        : process.env.HARNESS_CODEX_MODEL),
    input.workingFolder,
    fullAccess() && !input.session.sandboxed,
  );
  if (provider === "claude" && process.env.HARNESS_CLAUDE_CHROME === "1")
    command.args.push("--chrome");
  const images = (input.attachments ?? []).filter((file) =>
    imageTypes.has(file.mediaType),
  );
  if (provider === "codex")
    for (const image of images)
      command.args.splice(command.args.length - 1, 0, "--image", image.path);
  if (provider === "claude" && images.length)
    command.args.push("--input-format", "stream-json");
  const child = spawn(command.bin, command.args, {
    cwd: input.directory,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    ...(input.identity
      ? { uid: input.identity.uid, gid: input.identity.gid }
      : {}),
    env: {
      ...runtimeEnvironment(provider, process.env, input.environment),
      // Load the working folder's CLAUDE.md like a project's own.
      ...(input.workingFolder
        ? { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" }
        : {}),
      ...(input.identity
        ? {
            HOME: input.identity.home,
            XDG_CONFIG_HOME: join(input.identity.home, ".config"),
            XDG_DATA_HOME: join(input.identity.home, ".local/share"),
            CODEX_HOME: join(input.identity.home, ".codex"),
            CLAUDE_CONFIG_DIR: join(input.identity.home, ".claude"),
          }
        : {}),
      ...(input.tools ? { HARNESS_TOOL_TOKEN: input.tools.token } : {}),
    },
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
    provider === "claude" && images.length
      ? `${JSON.stringify(await claudeUserMessage(input))}\n`
      : inputPrompt(input),
  );
  let buffer = "";
  let completed = false;
  const consume = async (line: string) => {
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
    for (const event of decodeEvent(provider, value)) await input.emit(event);
  };
  try {
    child.stdout.setEncoding("utf8");
    for await (const chunk of child.stdout) {
      buffer += chunk;
      if (buffer.length > 1024 * 1024)
        throw new Error("Provider event exceeded 1 MiB.");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        await consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    await consume(buffer);
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
        await input.emit({
          type: "native-session",
          id: input.session.nativeId ?? crypto.randomUUID(),
        });
        const messages = [
          "Local worker connected.\n\n",
          `You said: ${input.prompt}\n\n`,
          "This is the demo runtime. Choose Codex or Claude in a new session to run a real agent.",
        ];
        const path = join(input.directory, ".harness-demo-state.json");
        let next = 0;
        try {
          const saved = JSON.parse(await readFile(path, "utf8"));
          if (
            saved.turnId === input.turnId &&
            Number.isInteger(saved.next) &&
            saved.next >= 0 &&
            saved.next <= messages.length
          )
            next = saved.next;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ENOENT"
          )
            throw error;
        }
        const delayMs = Number(process.env.HARNESS_DEMO_DELAY_MS ?? 150);
        if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60000)
          throw new Error("Invalid Demo delay.");
        for (let index = next; index < messages.length; index++) {
          await delay(delayMs, undefined, { signal: input.signal });
          await input.emit({ type: "text", text: messages[index] });
          await writeFile(
            path,
            JSON.stringify({ turnId: input.turnId, next: index + 1 }),
            { mode: 0o600 },
          );
          await input.emit({ type: "checkpoint" });
        }
      },
    };
  }
  return {
    async run(input) {
      if (provider === "claude" && input.sessionStore) {
        const { runClaudeSdk } = await import("./claude-sdk");
        return runClaudeSdk(input);
      }
      return await runCli(provider, input);
    },
  };
}
