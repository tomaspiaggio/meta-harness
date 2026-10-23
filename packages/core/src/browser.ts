export interface BrowserIdentity {
  id: string;
  workspaceId: string;
  name: string;
  workerId: string | null;
  status: string;
  mode: "agent" | "human" | "paused";
  generation: number;
  leaseUntil: number | null;
  userPublicKey: string | null;
  expiresAt: number | null;
  lastUrl: string | null;
  frame: string | null;
  frameAt: number | null;
  error: string | null;
  stateCipher: string | null;
  updatedAt: number;
}
export interface BrowserCommand {
  id: string;
  browserId: string;
  turnId: string | null;
  turnGeneration: number | null;
  browserGeneration: number;
  action: string;
  arguments: string;
  status: string;
  result: string | null;
  error: string | null;
  createdAt: number;
  completedAt: number | null;
}
export interface BrowserAssignment {
  command: BrowserCommand;
  identity: BrowserIdentity;
  stateKey: string;
}

export const chromeConnectionInstructions =
  "Connect your existing Chrome: open chrome://inspect/#remote-debugging in Chrome, enable remote debugging, then retry and click Allow in Chrome. This uses your current logins; no separate browser or website sign-in is created.";

/** A failed command alone is not evidence that an external action never ran. */
export function browserCommandNotStarted(
  command: Pick<BrowserCommand, "status" | "result" | "error">,
): boolean {
  if (command.status !== "failed") return false;
  // Compatibility for the original connection error, thrown before any action.
  if (command.error === chromeConnectionInstructions) return true;
  try {
    return JSON.parse(command.result ?? "null")?.execution === "not_started";
  } catch {
    return false;
  }
}
