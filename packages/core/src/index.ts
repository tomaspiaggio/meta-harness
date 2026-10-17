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
}

export interface Session {
  id: string;
  workspaceId: string;
  title: string;
  provider: Provider;
  nativeId: string | null;
  createdAt: number;
}

export interface Turn {
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
  createdAt: number;
}

export interface ClaimedTurn {
  turn: Turn;
  session: Session;
  workspace: Workspace;
}

export interface RuntimeInput {
  turnId?: string;
  session: Session;
  prompt: string;
  instructions: string;
  directory: string;
  signal: AbortSignal;
  emit: (event: RuntimeEvent) => void | Promise<void>;
}

export type RuntimeEvent =
  | { type: "text"; text: string }
  | { type: "native-session"; id: string }
  | { type: "checkpoint" };

export interface AgentRuntime {
  run(input: RuntimeInput): Promise<void>;
}

/** Activities/steps call this port; they do not own persistence or execution. */
export interface TurnStore {
  enqueue(turnId: string): void;
  getTurn(turnId: string): Turn;
  claim(workerId: string, now: number, leaseMs: number): ClaimedTurn | null;
  heartbeat(
    turnId: string,
    generation: number,
    now: number,
    leaseMs: number,
  ): boolean;
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

export function enqueueTurn(store: TurnStore, turnId: string): void {
  store.enqueue(turnId);
}

export function readTurnOutcome(store: TurnStore, turnId: string) {
  const turn = store.getTurn(turnId);
  return {
    id: turn.id,
    status: turn.status,
    terminal: isTerminal(turn.status),
  };
}

/** No retry here: the runtime may already have produced external effects. */
export async function executeTurn(
  store: Pick<TurnStore, "appendOutput" | "saveNativeId" | "finish">,
  claim: ClaimedTurn,
  runtime: AgentRuntime,
  directory: string,
  signal: AbortSignal,
  checkpoint?: () => Promise<void>,
): Promise<void> {
  const { turn, session, workspace } = claim;
  try {
    await runtime.run({
      turnId: turn.id,
      session,
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
    await store.finish(turn.id, turn.generation, "completed");
  } catch (error) {
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
  max = 20_000,
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
