import { HarnessError, requiredText } from "./index";

/**
 * Goals are what the owner asked for, as they would name it: a few per
 * workspace, kept by the planner, shown on the home page. Tasks are the
 * planner's way of getting there and stay out of sight.
 */
export const GOAL_STATUSES = ["active", "next", "done", "dropped"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export const STEP_STATUSES = [
  "done",
  "review",
  "working",
  "waiting",
  "todo",
  "postponed",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** A question to answer or a milestone to reach, in the owner's words. */
export interface GoalStep {
  label: string;
  status: StepStatus;
  /** For a done step: what came out of it, in one short sentence. */
  answer?: string;
  /** A sentence or two more, shown on the goal's page. */
  detail?: string;
}
/** A count toward a number the planner sets, such as meetings this week. */
export interface GoalTarget {
  label: string;
  current: number;
  target: number;
  note?: string;
}
export interface Goal {
  id: string;
  workspaceId: string;
  /** The planner that keeps this goal. */
  sessionId: string;
  /** A name readable at a glance, ideally 3–5 words. */
  title: string;
  /** The goal in one sentence. */
  summary: string;
  why: string;
  status: GoalStatus;
  /** What is happening right now, in one line. */
  now: string;
  /** When the long run going on now should finish. */
  etaAt: number | null;
  /** For a goal that waits: when it starts. */
  startsWhen: string;
  steps: GoalStep[];
  targets: GoalTarget[];
  targetNote: string;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}
export type GoalEventKind = "started" | "progress" | "decision" | "finished";
export interface GoalEvent {
  id: string;
  goalId: string;
  kind: GoalEventKind;
  text: string;
  /** Who made a decision: the owner, the planner or an agent. */
  by: string;
  /** Progress when the event happened, as "4 of 11" parts. */
  done: number;
  total: number;
  at: number;
}
export interface GoalProgress {
  done: number;
  review: number;
  working: number;
  total: number;
  /** 0–1, for the bar. */
  fraction: number;
}
export function goalProgress(
  goal: Pick<Goal, "steps" | "targets">,
): GoalProgress {
  if (goal.targets.length) {
    const fraction =
      goal.targets.reduce(
        (sum, target) =>
          sum + Math.min(target.current / Math.max(target.target, 1), 1),
        0,
      ) / goal.targets.length;
    const done = goal.targets.filter(
      (target) => target.current >= target.target,
    ).length;
    return {
      done,
      review: 0,
      working: 0,
      total: goal.targets.length,
      fraction,
    };
  }
  // A postponed step no longer counts toward the goal.
  const counted = goal.steps.filter((step) => step.status !== "postponed");
  const count = (status: StepStatus) =>
    counted.filter((step) => step.status === status).length;
  const done = count("done");
  return {
    done,
    review: count("review"),
    working: count("working"),
    total: counted.length,
    fraction: counted.length ? done / counted.length : 0,
  };
}

// Internal references the owner has no context for. Agents keep them among
// themselves; anything shown to the owner says what they mean instead.
const REFERENCES: [RegExp, string][] = [
  [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    "an ID",
  ],
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i, "a commit hash"],
  [/(^|[\s(])#\d+\b/, "a PR or issue number"],
  [/\b(PR|MR)\s?\d+\b/, "a PR number"],
  [/\b[A-Z]{1,4}-\d{3,}\b/, "a ticket code"],
  [/\b(task|input|proposal|note|continue)[-:][0-9a-z]{6,}\b/i, "a task ID"],
  [/\b[a-z0-9]+\.[a-z0-9]+(-[a-z0-9]+)+\b/, "a decision key"],
  [/\br\d+\b/, "a revision number"],
  [/\S+\/\S+\.(md|ts|tsx|js|mjs|py|csv|json|ya?ml|sv|v|txt)\b/, "a file path"],
];
/** Text for the owner: plain words, no internal references. */
export function plainText(value: unknown, name: string, max: number): string {
  const text = requiredText(value, name, max);
  for (const [pattern, kind] of REFERENCES) {
    const match = text.match(pattern);
    if (match)
      throw new HarnessError(
        `${name} contains ${kind} ("${match[0].trim()}"). The owner reads this without context: write it as you would for an outside client, saying what the thing is instead of its ID, ticket code, PR number, hash or file path.`,
      );
  }
  return text;
}
function optionalPlain(value: unknown, name: string, max: number): string {
  return value === undefined || value === null || value === ""
    ? ""
    : plainText(value, name, max);
}
export interface GoalInput {
  title: string;
  summary: string;
  why: string;
  status: GoalStatus;
  now: string;
  etaAt: number | null;
  startsWhen: string;
  steps: GoalStep[];
  targets: GoalTarget[];
  targetNote: string;
}
export interface GoalChange {
  goal: GoalInput;
  /** What changed, one sentence for the goal's history. */
  change: string;
  decisions: { text: string; by: string }[];
}
function parseSteps(value: unknown): GoalStep[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 30)
    throw new HarnessError("Give at most 30 steps.");
  return value.map((item, index) => {
    const row = (item ?? {}) as Record<string, unknown>;
    const status = row.status as StepStatus;
    if (!STEP_STATUSES.includes(status))
      throw new HarnessError(
        `Step ${index + 1} needs a status: ${STEP_STATUSES.join(", ")}.`,
      );
    const label = plainText(row.label, `Step ${index + 1}`, 200);
    const answer = optionalPlain(row.answer, `Answer to "${label}"`, 200);
    if (status === "done" && !answer)
      throw new HarnessError(
        `"${label}" is done: give its answer, what came out of it, in one short sentence.`,
      );
    const detail = optionalPlain(row.detail, `Detail of "${label}"`, 600);
    return {
      label,
      status,
      ...(answer ? { answer } : {}),
      ...(detail ? { detail } : {}),
    };
  });
}
function parseTargets(value: unknown): GoalTarget[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8)
    throw new HarnessError("Give at most 8 targets.");
  return value.map((item, index) => {
    const row = (item ?? {}) as Record<string, unknown>;
    const label = plainText(row.label, `Target ${index + 1}`, 80);
    const number = (field: unknown, what: string) => {
      if (
        typeof field !== "number" ||
        !Number.isFinite(field) ||
        field < 0 ||
        field > 1_000_000
      )
        throw new HarnessError(`"${label}" needs ${what} as a number.`);
      return field;
    };
    const target = number(row.target, "a target");
    if (target === 0)
      throw new HarnessError(`"${label}" needs a target above zero.`);
    const note = optionalPlain(row.note, `Note on "${label}"`, 200);
    return {
      label,
      current: number(row.current, "a current count"),
      target,
      ...(note ? { note } : {}),
    };
  });
}
function parseEta(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(time))
    throw new HarnessError(
      "eta must be an ISO time such as 2026-11-07T20:00:00Z.",
    );
  return time;
}
/**
 * Arguments of goal_set, in snake_case. Fields left out keep their value on
 * an existing goal; a new goal needs a title, summary, why and progress.
 */
export function parseGoalChange(
  args: Record<string, unknown>,
  existing?: GoalInput,
): GoalChange {
  const has = (key: string) => args[key] !== undefined;
  const status = has("status")
    ? (args.status as GoalStatus)
    : (existing?.status ?? "active");
  if (!GOAL_STATUSES.includes(status))
    throw new HarnessError(`status is one of ${GOAL_STATUSES.join(", ")}.`);
  const goal: GoalInput = {
    title: has("title")
      ? plainText(args.title, "Title", 40)
      : (existing?.title ?? plainText(args.title, "Title", 40)),
    summary: has("summary")
      ? plainText(args.summary, "Summary", 200)
      : (existing?.summary ?? plainText(args.summary, "Summary", 200)),
    why: has("why")
      ? plainText(args.why, "Why", 1500)
      : (existing?.why ?? plainText(args.why, "Why", 1500)),
    status,
    now: has("now")
      ? optionalPlain(args.now, "Now", 300)
      : (existing?.now ?? ""),
    etaAt: has("eta") ? parseEta(args.eta) : (existing?.etaAt ?? null),
    startsWhen: has("starts_when")
      ? optionalPlain(args.starts_when, "Starts when", 120)
      : (existing?.startsWhen ?? ""),
    steps: has("steps") ? parseSteps(args.steps) : (existing?.steps ?? []),
    targets: has("targets")
      ? parseTargets(args.targets)
      : (existing?.targets ?? []),
    targetNote: has("target_note")
      ? optionalPlain(args.target_note, "Target note", 400)
      : (existing?.targetNote ?? ""),
  };
  if (goal.steps.length && goal.targets.length)
    throw new HarnessError(
      "Track a goal with steps or with targets, not both.",
    );
  if (!goal.steps.length && !goal.targets.length)
    throw new HarnessError(
      "Give the goal steps (questions or milestones) or targets (counts toward a number).",
    );
  // A finished goal shows no current activity or estimate.
  if (status === "done" || status === "dropped") {
    goal.now = "";
    goal.etaAt = null;
  }
  const decisions = args.decisions === undefined ? [] : args.decisions;
  if (!Array.isArray(decisions) || decisions.length > 10)
    throw new HarnessError("Give at most 10 decisions.");
  return {
    goal,
    change: plainText(args.change, "Change", 300),
    decisions: decisions.map((item, index) => {
      const row = (item ?? {}) as Record<string, unknown>;
      return {
        text: plainText(row.text, `Decision ${index + 1}`, 500),
        by: plainText(row.by, `Who made decision ${index + 1}`, 60),
      };
    }),
  };
}
