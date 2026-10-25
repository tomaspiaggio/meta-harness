import type { ClaimedTurn } from "@harness/core";
import type { HarnessStore } from "@harness/storage/application";
import { flushDispatch } from "./dispatcher";
import { getStore } from "./store";

/**
 * How a worker writes a report. The reader is the planning session and, later,
 * the owner, who did not follow the work and is often reading on a phone.
 */
export const REPORT_RULES =
  "Write the report for someone who did not follow your work and is missing context: start with the outcome in one or two sentences; then what changed and where (files, branches, PRs, commands, links); the decisions you made on the owner's behalf and why, so they can be revisited; what you verified and how, and what you did not; open questions and risks; and what you would do next. Explain terms and numbers instead of assuming the reader knows them. Prefer short sections and concrete facts over narration.";

// When the owner must be asked, everything else is decided by the agents.
const OWNER_ONLY =
  "Ask the owner (request_input) only for purchases or payments, deleting data or other destructive or irreversible actions, credentials, sending messages to people outside on the owner's behalf, or a question no agent can answer from the conversations, decisions and files available. The owner is often unavailable: a reasonable decision that keeps work moving beats waiting. Record the decisions you make on the owner's behalf so they can be reviewed and reverted.";

/** Instructions added to a task, feedback or report turn when a worker claims it. */
export async function delegationInstructions(
  store: HarnessStore,
  claim: ClaimedTurn,
): Promise<string | null> {
  const note = await store.noteForTurn(claim.turn.id);
  if (note) {
    const sender = await store
      .getSession(note.fromSessionId)
      .catch(() => ({ title: "a deleted session", id: note.fromSessionId }));
    return `[Meta Harness: this is a note from session "${sender.title}" (${sender.id}), another of the owner's sessions, to coordinate; it is not a new task from the owner. Act on it as far as it concerns your work. Reply with session_note to ${sender.id} only if it asks something or needs your answer; do not reply just to acknowledge. If it unblocks a task you are working on, continue that task and report with task_report as usual.]`;
  }
  const link = await store.delegationForTurn(claim.turn.id);
  if (!link) return null;
  if (link.role === "report") {
    const worker = await store.getSession(link.toSessionId);
    return `[Meta Harness: this message is the automatic report from session "${worker.title}" (${worker.id}) on task ${link.delegationId}, which you gave it (round ${link.round}). Review it against what you asked and the plan. Then either send feedback, an answer or the next step with session_send and task_id ${link.delegationId}; close it with task_close when the result is acceptable; or hand out new work. Keep work moving without the owner. ${OWNER_ONLY} End your reply with a short summary for the owner of where the overall plan stands.]`;
  }
  const planner = await store.getSession(link.fromSessionId);
  return `[Meta Harness: this is ${link.role === "task" ? "a task" : link.role === "continue" ? "your own continuation of task" : "feedback or an answer on task"} ${link.delegationId} from session "${planner.title}" (${planner.id}), a planning session acting for the owner (round ${link.round}). Treat it as the owner's request. Work on it without waiting for anyone. If something is unclear, make the most reasonable assumption, note it, and continue; if you need an answer to continue at all, call task_report with status "question" and end your turn: the planning session answers, and asks the owner only if it cannot. ${OWNER_ONLY} Use your own subagents for parallel work; do not hand work to other sessions. To coordinate with another session directly (agree an interface, ask what it changed), send it a session_note instead of asking the planning session to relay. Call task_report with status "progress" at meaningful checkpoints. When you finish, call task_report with status "done" (or "blocked") before ending the turn. ${REPORT_RULES}]`;
}

/** Results of finished task turns go back to the session that gave the task. */
export async function deliverDelegationReports() {
  const store = await getStore();
  let posted = 0;
  for (const turnId of await store.pendingDelegationReports())
    if (await store.deliverDelegationReport(turnId)) posted++;
  if (posted) await flushDispatch();
}
