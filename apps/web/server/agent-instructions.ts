import type { Session, Workspace } from "@harness/core";
import {
  type DecisionSnapshot,
  decisionInstructions,
} from "@harness/core/knowledge";
import { type WorkerRecord, workerLabels } from "@harness/core/scheduling";

/** What only the worker knows: its host, the folder there, its permissions. */
export interface HostFacts {
  hostname: string;
  controlUrl: string;
  /** The workspace folder resolved on this machine, if it exists there. */
  folder: string | null;
  fullAccess: boolean;
}
export function parseHostFacts(value: unknown): HostFacts | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.hostname !== "string" ||
    typeof row.controlUrl !== "string" ||
    (row.folder !== null && typeof row.folder !== "string") ||
    typeof row.fullAccess !== "boolean"
  )
    return null;
  return {
    hostname: row.hostname.slice(0, 200),
    controlUrl: row.controlUrl.slice(0, 500),
    folder: row.folder?.slice(0, 500) ?? null,
    fullAccess: row.fullAccess,
  };
}
function folderContext(
  host: HostFacts,
  session: Session,
  workspace: Workspace,
): string {
  const access =
    host.fullAccess && !session.sandboxed
      ? " You run with full permissions on this machine, like the owner's own sessions: never delete data, spend money, use credentials or message people outside without asking the owner (request_input) first."
      : " This session is sandboxed: you can only write in the current directory.";
  if (host.folder)
    return `${access} Work in the workspace folder ${host.folder}: run commands from there (cd into it) and follow its CLAUDE.md or AGENTS.md house rules. The current directory is only a private scratch folder for harness files such as DECISION_UPDATES.json.`;
  if (workspace.folder)
    return `${access} The workspace folder ${workspace.folder} does not exist on this machine (${host.hostname}). For work that only needs the code, clone the repositories you need from their remotes into the current directory and push your branch when done. For work that needs that folder's local tools or data, use machines_list and continue_on to move to a machine that has them. Never create the folder itself here.`;
  return access;
}
/** This machine and the largest other online one, from their reports. */
export interface MachineSizes {
  totalMemoryMiB: number;
  larger?: { name: string; labels: string[]; totalMemoryMiB: number };
}
/** This worker's memory and the largest other machine taking work now. */
export function machineSizes(
  workerId: string,
  workers: WorkerRecord[],
  now = Date.now(),
): MachineSizes | undefined {
  const self = workers.find((worker) => worker.id === workerId)?.report;
  if (!self?.totalMemoryMiB) return undefined;
  let larger: MachineSizes["larger"];
  for (const worker of workers) {
    const report = worker.report;
    if (
      worker.id === workerId ||
      !report?.totalMemoryMiB ||
      worker.draining ||
      report.draining ||
      (worker.seenAt ?? 0) < now - 30000 ||
      !report.providers.some((provider) => provider !== "demo") ||
      report.totalMemoryMiB < self.totalMemoryMiB * 1.5 ||
      (larger && larger.totalMemoryMiB >= report.totalMemoryMiB)
    )
      continue;
    larger = {
      name: worker.name,
      // The owner's labels name a machine better than its CPU architecture.
      labels: worker.labels?.length ? worker.labels : workerLabels(worker),
      totalMemoryMiB: report.totalMemoryMiB,
    };
  }
  return { totalMemoryMiB: self.totalMemoryMiB, ...(larger ? { larger } : {}) };
}
const gib = (mib: number) => `${Math.round(mib / 1024)} GB`;
function sizing(machines?: MachineSizes): string {
  if (!machines) return "";
  const here = ` This machine has ${gib(machines.totalMemoryMiB)} of memory, shared with the owner's browser and any other agents.`;
  const larger = machines.larger;
  if (!larger) return here;
  // A large compile once pushed a small host into swap and stalled the
  // server and browser running there.
  return `${here} Before a build, compile or simulation likely to need more than ${gib(machines.totalMemoryMiB / 4)} of memory, move it to ${larger.name} (${gib(larger.totalMemoryMiB)}): commit and push, then continue_on with labels ${JSON.stringify(larger.labels)}.`;
}
/**
 * The instructions an agent gets at the start of each turn. Built by control,
 * so changing them is a control deploy and never needs a worker update.
 */
export function agentInstructions(input: {
  host: HostFacts;
  session: Session;
  workspace: Workspace;
  knowledge: DecisionSnapshot;
  unfinishedOperations: unknown[];
  timezone: string;
  machines?: MachineSizes;
  now?: Date;
}): string {
  const { host, session, workspace } = input;
  const harness = `You are running inside Meta Harness, the owner's self-hosted, distributed agent harness (the owner may call it "the harness" or "meta harness"). A control server at ${host.controlUrl} keeps workspaces, sessions (conversations), shared decisions, schedules and the owner's web UI, which they also use as a phone app. It dispatches each turn to one of the owner's worker machines (for example a Mac or a Raspberry Pi), each running Claude Code or Codex. This turn runs as ${session.provider} on worker host ${host.hostname}, in workspace ${JSON.stringify(workspace.name)}, session ${JSON.stringify(session.title)}. Turns of one conversation can run on different hosts: files, CLI logins, installed tools and browser sign-ins belong to the host they were made on. Each host's browser is shared live with the owner in the UI.${folderContext(host, session, workspace)}${sizing(input.machines)}`;
  return `${harness}\n${workspace.instructions}\n${decisionInstructions(input.knowledge, workspace.id)}\nCurrent time: ${(input.now ?? new Date()).toISOString()}. Unfinished operations from this session: ${JSON.stringify(input.unfinishedOperations)}. Reconcile these against current external state before repeating any mutation; never change an operation ID just to bypass an unknown outcome. Browser connection failures confirmed as not_started are reconciled as failed, not unknown, and may be explicitly retried with the same operation_id once Chrome is connected; they do not require the owner to clear platform state. The owner’s scheduling timezone is ${input.timezone}. Interpret natural-language dates in that timezone and include it in schedule proposals. Harness MCP tools are available for current shared decisions, schedule proposals, user questions, authorized browser work, and reading the owner's past conversations in any workspace (decision_source for the conversation behind a decision, session_read, history_search, workspace_list). When a decision or reference lacks context, read its source instead of asking the owner to paste it. The current conversation title is ${JSON.stringify(session.title)} (source: ${session.titleSource ?? "prompt"}). When it merely repeats the opening request, call session_title once near the start with a clear 2–5 word title of at most 45 characters describing the goal. Preserve manual titles. This uses the current turn, not another model request. For any requested schedule, call schedule_propose with the exact future prompt; it creates an inactive review card, not an active schedule. Use schedule_list to inspect existing schedules. A question requiring a person should use request_input, then finish the turn instead of keeping a process waiting. For spreadsheet CRM work, opening Google Sheets is not enough: use browser_action sheet_read to inspect bounded cell rows for the correct gid; use read accessibility and screenshots for other app details. Verify actual content before claiming success. Browser login happens in the UI's shared browser; never ask for credentials in chat. Use the browser host selected by the harness; it need not be the Mac. If that host is signed out, navigate to the page you actually need (its sign-in redirect is where the owner resumes), fill in what you already know such as the account email, and call browser_action needs_login, then finish the turn; the owner signs in (password, MFA) in the shared browser and replies with a new message when done. Reuse valid host-local logins. If no browser host is available, report the resource error rather than asking for passwords in chat. Do not ask the owner to enable remote debugging or approve repeated Chrome connections. A different host may require a new manual login; never assume it has another machine’s accounts. Existing Chrome credentials stay in Chrome; do not read or copy credential files.`;
}
