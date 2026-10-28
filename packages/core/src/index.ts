import type { RuntimeAttachment } from "./attachments";
import type { NativeSessionStore } from "./native-store";
/** Engine-independent, JSON-serializable contracts. Keep Node and SDKs out. */
export const providers = ["demo", "codex", "claude"] as const;
export type Provider = (typeof providers)[number];
export type TurnStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";
export interface Workspace {
  id: string;
  name: string;
  instructions: string;
  /** Folder agents work in, on machines that have it, e.g. ~/Projects/litho. */
  folder?: string | null;
}
export interface Session {
  model?: string | null;
  id: string;
  workspaceId: string;
  title: string;
  titleSource?: "prompt" | "manual" | "generated";
  unreadCount?: number;
  needsInputCount?: number;
  attentionSequence?: number;
  lastActivityAt?: number;
  provider: Provider;
  nativeId: string | null;
  ownerWorkerId?: string | null;
  /** Comma-separated labels a machine needs to run this session. */
  requiredLabels?: string | null;
  /** 1 keeps this session's agent in the restricted sandbox. */
  sandboxed?: number;
  /** "planner": the workspace's main conversation, which hands out work. */
  role?: string | null;
  createdAt: number;
}
export interface Turn {
  model?: string | null;
  id: string;
  sessionId: string;
  prompt: string;
  status: TurnStatus;
  runId: string | null;
  workerId: string | null;
  generation: number;
  leaseUntil: number | null;
  output: string;
  error: string | null;
  stopRequestedAt?: number | null;
  interruptsTurnId?: string | null;
  /** Labels only this turn needs, set when an agent continues elsewhere. */
  requiredLabels?: string | null;
  /** Why the agent moved this step, shown to the owner. */
  placementReason?: string | null;
  createdAt: number;
}
export interface ClaimedTurn {
  turn: Turn;
  session: Session;
  workspace: Workspace;
}
export interface RuntimeInput {
  attachments?: RuntimeAttachment[];
  tools?: { url: string; token: string };
  identity?: { uid: number; gid: number; home: string };
  environment?: Record<string, string>;
  /** The workspace folder on this machine, when it exists here. */
  workingFolder?: string;
  turnId?: string;
  sessionStore?: NativeSessionStore;
  session: Session;
  prompt: string;
  instructions: string;
  directory: string;
  signal: AbortSignal;
  emit: (event: RuntimeEvent) => void | Promise<void>;
}
export type RuntimeEvent =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "native-session";
      id: string;
    }
  | {
      type: "checkpoint";
    };
export interface AgentRuntime {
  run(input: RuntimeInput): Promise<void>;
}
export class ProviderUnavailableError extends Error {
  constructor(
    public readonly provider: Provider,
    public readonly retryAt: number,
    message: string,
  ) {
    super(message);
  }
}
export type ExecutionSink = Pick<
  TurnStore,
  "appendOutput" | "saveNativeId" | "finish"
> & {
  providerUnavailable?(
    provider: Provider,
    retryAt: number,
    reason: string,
  ): Promise<void> | void;
};
/** Activities/steps call this port; they do not own persistence or execution. */
export interface TurnStore {
  enqueue(turnId: string): void | Promise<void>;
  getTurn(turnId: string): Turn | Promise<Turn>;
  claim(
    workerId: string,
    now: number,
    leaseMs: number,
  ): ClaimedTurn | null | Promise<ClaimedTurn | null>;
  heartbeat(
    turnId: string,
    generation: number,
    now: number,
    leaseMs: number,
  ): boolean | Promise<boolean>;
  appendOutput(
    turnId: string,
    generation: number,
    text: string,
  ): void | Promise<void>;
  saveNativeId(
    turnId: string,
    generation: number,
    nativeId: string,
  ): void | Promise<void>;
  finish(
    turnId: string,
    generation: number,
    status: "completed" | "failed" | "interrupted",
    error?: string,
  ): void | Promise<void>;
}
export function isTerminal(status: TurnStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "interrupted"
  );
}
export async function enqueueTurn(
  store: TurnStore,
  turnId: string,
): Promise<void> {
  await store.enqueue(turnId);
}
export async function readTurnOutcome(store: TurnStore, turnId: string) {
  const turn = await store.getTurn(turnId);
  return {
    id: turn.id,
    status: turn.status,
    terminal: isTerminal(turn.status),
  };
}
/** No retry here: the runtime may already have produced external effects. */
export async function executeTurn(
  store: ExecutionSink,
  claim: ClaimedTurn,
  runtime: AgentRuntime,
  directory: string,
  signal: AbortSignal,
  checkpoint?: () => Promise<void>,
  sessionStore?: NativeSessionStore,
  context: Pick<
    RuntimeInput,
    "attachments" | "environment" | "tools" | "identity" | "workingFolder"
  > = {},
): Promise<void> {
  const { turn, session, workspace } = claim;
  try {
    await runtime.run({
      ...context,
      turnId: turn.id,
      sessionStore,
      session: { ...session, model: turn.model ?? null },
      prompt: turn.prompt,
      instructions: workspace.instructions,
      directory,
      signal,
      async emit(event) {
        if (event.type === "native-session") {
          await store.saveNativeId(turn.id, turn.generation, event.id);
        } else if (event.type === "text") {
          await store.appendOutput(turn.id, turn.generation, event.text);
        } else {
          await checkpoint?.();
        }
      },
    });
    // A runtime may return normally while its cooperative stop is being handled.
    if (signal.aborted) throw signal.reason ?? new Error("Execution stopped.");
    await store.finish(turn.id, turn.generation, "completed");
  } catch (error) {
    if (error instanceof ProviderUnavailableError)
      await store.providerUnavailable?.(
        error.provider,
        error.retryAt,
        error.message,
      );
    await store.finish(
      turn.id,
      turn.generation,
      signal.aborted ? "interrupted" : "failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}
export class HarnessError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}
export function requiredText(
  value: unknown,
  name: string,
  max = 20000,
): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new HarnessError(`${name} must contain 1–${max} characters.`);
  }
  return value.trim();
}
export function parseProvider(value: unknown): Provider {
  if (value === "demo" || value === "codex" || value === "claude") return value;
  throw new HarnessError("Choose demo, codex, or claude.");
}
