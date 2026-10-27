import { isTerminal, type TurnStatus } from "@harness/core";
import { BRIEF_HOUR, localTime, previousDay } from "@harness/core/briefs";
import { BRIEF_KIT_GUIDE } from "../lib/brief-kit";
import { flushDispatch } from "./dispatcher";
import { getStore } from "./store";

function briefPrompt(day: string, timeZone: string, digest: string) {
  return `Write the daily briefs for ${day} (${timeZone}): a short, visual record of what was done in each workspace that day and why.

For each workspace in the digest below, call brief_publish once with:
- day: "${day}" and that workspace_id.
- title: the day's main work as a headline, at most 80 characters, no date.
- highlights: 3–5 short phrases, each under 90 characters, outcome first (for example "Merged the placement scheduler" or "Chose Rust for firmware: one toolchain").
- html: the full brief, described below.
- sources: the session_id and decision_key values you drew from.

Lead with outcomes, then the decisions or reasons that made the work necessary, then what is next or blocked. Be generous with structure and diagrams, but keep the words short: this is a brief someone skims in a minute, and later material for an investor update. Use only what happened; read more with session_read, decision_source or history_search when the digest is thin, and never invent results. If a workspace's day was only trivial or failed turns, skip it and say so in your reply.

${BRIEF_KIT_GUIDE}

When done, reply with one line per workspace: its title, or why it was skipped.

# Digest of ${day}

${digest}`;
}
/** Starts the brief for a day; `force` rewrites a day that already has one. */
export async function startBrief(
  day: string,
  force = false,
): Promise<{
  status: "started" | "running" | "exists" | "no-activity";
  turnId?: string;
  sessionId?: string;
}> {
  const store = await getStore();
  const run = await store.briefRun(day);
  if (
    run?.turnId &&
    run.turnStatus &&
    !isTerminal(run.turnStatus as TurnStatus)
  )
    return { status: "running", turnId: run.turnId };
  if (run && !force) return { status: "exists" };
  const activity = await store.briefActivity(day);
  const turns = activity.reduce((sum, item) => sum + item.turns, 0);
  if (!turns) {
    if (!run) await store.setBriefRun(day, "skipped", null, 0);
    return { status: "no-activity" };
  }
  if (!force && !(await store.claimBriefRun(day, turns)))
    return { status: "exists" };
  const session = await store.briefSession();
  const turnId = run ? `brief:${day}:${Date.now()}` : `brief:${day}`;
  await store.createTurn(
    turnId,
    session.id,
    briefPrompt(day, store.ownerTimeZone(), await store.briefDigest(day)),
  );
  await store.setBriefRun(day, "started", turnId, turns);
  await flushDispatch();
  return { status: "started", turnId, sessionId: session.id };
}
/** Nightly: after the local brief hour, write yesterday's brief once. */
export async function dispatchBriefs() {
  const store = await getStore();
  const now = localTime(Date.now(), store.ownerTimeZone());
  if (now.hour < BRIEF_HOUR) return;
  await startBrief(previousDay(now.day));
}
