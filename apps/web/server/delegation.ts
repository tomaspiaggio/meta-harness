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

/**
 * How the planner keeps the goals on the owner's home page. The owner reads
 * them to know what is going on without following the conversations.
 */
export const GOAL_RULES =
  'A goal is an outcome the owner would recognise and name, such as "First circuit board" or "Expert and customer meetings": usually one to five active per workspace. Never make a goal per task, gate, review round or routine check; those are how you get there. Write every field for someone outside the project, like a report to a client: plain words that say what each thing is, never IDs, ticket or step codes, PR numbers, commit hashes, file paths or internal names. Track a goal with steps (questions to answer or milestones, in order) or with targets (counts toward numbers you set, such as meetings booked this week; change them as plans change and say why in target_note). Mark a step done only once you accepted its result, and give its answer in one short sentence: the owner reads the answer, not the question. Set eta only while a long run (a validation, simulation, eval or long build) is going, estimated from how long similar runs took on that machine (a Raspberry Pi is slower than a Mac); never estimate coding. Every update needs change: one plain sentence on what moved, which becomes the goal\'s history. Record the decisions made along the way and who made them. Mark the goal done when finished, next when planned but waiting (with starts_when), dropped when abandoned.';

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
  if (!link)
    return claim.session.role === "planner"
      ? `[Meta Harness: you are the planner of workspace "${claim.workspace.name}", the owner's main conversation here. Answer directly what you can. For work that is long, parallel, or needs another agent or machine, split it into tasks for worker sessions with session_send: reuse a worker that fits (task_list, workspace_list) or create one with new_worker (a short title and, if it matters, the agent). Workers report back here; review their results, keep the plan moving and close tasks. Only you notify the owner, so their turns stay quiet: call notify_owner when the owner should know something now, and request_input for a decision only they can make. Keep this workspace's goals current on the owner's home page (goal_list, goal_set): create one when the owner asks for something that takes several steps or a long run, link each new task to its goal (goal_id in session_send), and update the goal when a result is accepted, the plan changes or a long run starts or ends. ${GOAL_RULES} ${OWNER_ONLY}]`
      : null;
  if (link.role === "report") {
    const worker = await store.getSession(link.toSessionId);
    return `[Meta Harness: this message is the automatic report from session "${worker.title}" (${worker.id}) on task ${link.delegationId}, which you gave it (round ${link.round}). Review it against what you asked and the plan. Then either send feedback, an answer or the next step with session_send and task_id ${link.delegationId}; close it with task_close when the result is acceptable; or hand out new work. If this moves one of the workspace's goals, update it with goal_set. Keep work moving without the owner. ${OWNER_ONLY} Reports and the turns that handle them do not notify the owner: if a worker asked something, answer it yourself when you can. Call notify_owner (one line) only when the owner should know now: the overall goal is done, something blocks the plan, or you made an important decision for them; use request_input for a question only they can answer. End your reply with a short summary for the owner of where the overall plan stands.]`;
  }
  const planner = await store.getSession(link.fromSessionId);
  return `[Meta Harness: this is ${link.role === "task" ? "a task" : link.role === "continue" ? "your own continuation of task" : "feedback or an answer on task"} ${link.delegationId} from session "${planner.title}" (${planner.id}), a planning session acting for the owner (round ${link.round}). Treat it as the owner's request. Work on it without waiting for anyone. If something is unclear, make the most reasonable assumption, note it, and continue; if you need an answer to continue at all, call task_report with status "question" and end your turn: the planning session answers, and asks the owner only if it cannot. Do not ask the owner yourself (no request_input): what needs the owner (purchases or payments, deleting data or other irreversible actions, credentials, messages to people outside) goes in that task_report question too, and the planning session asks them. Otherwise a reasonable decision that keeps work moving beats waiting; record the decisions you make on the owner's behalf. Use your own subagents for parallel work; do not hand work to other sessions. To coordinate with another session directly (agree an interface, ask what it changed), send it a session_note instead of asking the planning session to relay. Call task_report with status "progress" at meaningful checkpoints. When you finish, call task_report with status "done" (or "blocked") before ending the turn. ${REPORT_RULES}]`;
}

/** Results of finished task turns go back to the session that gave the task. */
export async function deliverDelegationReports() {
  const store = await getStore();
  let posted = 0;
  for (const turnId of await store.pendingDelegationReports())
    if (await store.deliverDelegationReport(turnId)) posted++;
  if (posted) await flushDispatch();
}
