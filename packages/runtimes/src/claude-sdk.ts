import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeInput } from "@harness/core";
import { decodeEvent } from "./index";

/** Loaded only for active Claude turns with an external native-session store. */
type QueryFactory = (input: {
  prompt: string;
  options: Options;
}) => AsyncIterable<unknown> & { close(): void };

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
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("HARNESS_") && !key.startsWith("WORKFLOW_"),
    ),
  );
  const budget =
    process.env.HARNESS_CLAUDE_MAX_BUDGET_USD === undefined
      ? undefined
      : Number(process.env.HARNESS_CLAUDE_MAX_BUDGET_USD);
  if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0))
    throw new Error("Invalid Claude turn budget.");
  const response = startQuery({
    prompt: `Current execution directory: ${input.directory}\nUse paths relative to this directory; paths from a previous machine may differ.\n\nWorkspace instructions:\n${input.instructions}\n\nUser instruction:\n${input.prompt}`,
    options: {
      cwd: input.directory,
      abortController: controller,
      // Namespace by harness session, while the SDK can materialize a different cwd.
      // Do not force CLAUDE_CONFIG_DIR: that can change macOS Keychain identity.
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
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      model: process.env.HARNESS_CLAUDE_MODEL,
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
