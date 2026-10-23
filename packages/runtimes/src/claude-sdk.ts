import { spawn } from "node:child_process";
import {
  type Options,
  query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeInput } from "@harness/core";
import { runtimeEnvironment } from "./environment";
import { decodeEvent } from "./index";
import { claudeUserMessage, inputPrompt } from "./input";

/** Loaded only for active Claude turns with an external native-session store. */
type QueryFactory = (input: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncIterable<unknown> & {
  close(): void;
};
export async function runClaudeSdk(
  input: RuntimeInput,
  startQuery: QueryFactory = query,
): Promise<void> {
  input.signal.throwIfAborted();
  if (!input.sessionStore)
    throw new Error("Claude SDK requires a native session store.");
  const sessionStore = input.sessionStore;
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal.reason);
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  const env = {
    ...Object.fromEntries(
      Object.keys(process.env).map((key) => [key, undefined]),
    ),
    ...runtimeEnvironment("claude", process.env, input.environment),
    ...(input.identity
      ? {
          HOME: input.identity.home,
          CLAUDE_CONFIG_DIR: `${input.identity.home}/.claude`,
        }
      : {}),
  };
  const budget =
    process.env.HARNESS_CLAUDE_MAX_BUDGET_USD === undefined
      ? undefined
      : Number(process.env.HARNESS_CLAUDE_MAX_BUDGET_USD);
  if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0))
    throw new Error("Invalid Claude turn budget.");
  const response = startQuery({
    prompt: input.attachments?.length
      ? (async function* () {
          yield await claudeUserMessage(input);
        })()
      : `Current execution directory: ${input.directory}\nUse paths relative to this directory; paths from a previous machine may differ.\n\n${inputPrompt(input)}`,
    options: {
      cwd: input.directory,
      ...(input.identity
        ? {
            spawnClaudeCodeProcess: (
              options: import("@anthropic-ai/claude-agent-sdk").SpawnOptions,
            ) =>
              spawn(options.command, options.args, {
                cwd: options.cwd,
                env: options.env,
                stdio: ["pipe", "pipe", "pipe"],
                uid: input.identity?.uid,
                gid: input.identity?.gid,
                signal: options.signal,
              }),
          }
        : {}),
      abortController: controller,
      // Namespace by harness session, while the SDK can materialize a different cwd.
      // Ordinary host auth preserves its config directory/Keychain identity;
      // the opt-in Linux UID path instead uses a private API-auth home.
      sessionStore: {
        append: (key, entries) =>
          sessionStore.append(
            { ...key, projectKey: `meta-harness-${input.session.id}` },
            entries,
          ),
        load: (key) =>
          sessionStore.load({
            ...key,
            projectKey: `meta-harness-${input.session.id}`,
          }),
        listSubkeys: (key) =>
          sessionStore.listSubkeys?.({
            ...key,
            projectKey: `meta-harness-${input.session.id}`,
          }) ?? Promise.resolve([]),
      },
      sessionStoreFlush: "eager",
      resume: input.session.nativeId ?? undefined,
      permissionMode: "dontAsk",
      allowedTools: [
        "Edit(./DECISION_UPDATES.json)",
        ...(input.tools ? ["mcp__harness__*"] : []),
      ],
      settingSources: [],
      mcpServers: input.tools
        ? {
            harness: {
              type: "http",
              url: input.tools.url,
              headers: { Authorization: `Bearer ${input.tools.token}` },
            },
          }
        : {},
      strictMcpConfig: true,
      model: input.session.model ?? process.env.HARNESS_CLAUDE_MODEL,
      maxBudgetUsd: budget,
      tools: process.env.HARNESS_CLAUDE_TOOLS === "none" ? [] : undefined,
      env,
    },
  });
  let completed = false;
  try {
    for await (const value of response) {
      if (!value || typeof value !== "object")
        throw new Error("Claude emitted an invalid event.");
      const message = value as Record<string, unknown>;
      if (message.type === "system" && message.subtype === "mirror_error")
        throw new Error(
          `Claude native-state persistence failed: ${message.error}`,
        );
      for (const event of decodeEvent("claude", message))
        await input.emit(event);
      if (message.type === "result") {
        if (message.subtype !== "success")
          throw new Error(`Claude ended with ${message.subtype}.`);
        completed = true;
      }
    }
    input.signal.throwIfAborted();
    if (!completed)
      throw new Error("Claude exited without completing its turn.");
  } finally {
    response.close();
    input.signal.removeEventListener("abort", abort);
  }
}
