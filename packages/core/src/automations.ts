import { CronExpressionParser } from "cron-parser";
import { HarnessError, requiredText } from "./index";

export type ScheduleTrigger =
  | { type: "once"; at: number; timezone?: string }
  | { type: "cron"; expression: string; timezone: string };
export interface ScheduleDraft {
  name: string;
  prompt: string;
  sessionId: string;
  kind: "agent" | "reminder";
  trigger: ScheduleTrigger;
  maxLatenessMs: number;
}
export interface Schedule extends ScheduleDraft {
  id: string;
  revision: number;
  status: "draft" | "active" | "paused" | "completed" | "deleted";
  nextAt: number | null;
  lastRun?: { at: number; outcome: string };
  createdAt: number;
  updatedAt: number;
}
export function nextOccurrence(
  trigger: ScheduleTrigger,
  after: number,
): number | null {
  if (trigger.type === "once") return trigger.at > after ? trigger.at : null;
  try {
    return CronExpressionParser.parse(trigger.expression, {
      currentDate: new Date(after),
      tz: trigger.timezone,
    })
      .next()
      .getTime();
  } catch {
    throw new HarnessError(
      "Invalid cron expression, timezone, or next occurrence.",
    );
  }
}
export function parseScheduleDraft(
  value: unknown,
  now = Date.now(),
): ScheduleDraft {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HarnessError("Expected a schedule draft.");
  const input = value as Record<string, unknown>;
  const raw = input.trigger as Record<string, unknown> | undefined;
  let trigger: ScheduleTrigger;
  if (
    raw?.type === "once" &&
    typeof raw.at === "number" &&
    Number.isSafeInteger(raw.at) &&
    raw.at > now
  )
    trigger = {
      type: "once",
      at: raw.at,
      timezone: typeof raw.timezone === "string" ? raw.timezone : "UTC",
    };
  else if (raw?.type === "cron") {
    const expression = requiredText(raw.expression, "Cron", 100);
    if (expression.split(/\s+/).length !== 5)
      throw new HarnessError(
        "Use a five-field cron expression (minute hour day month weekday).",
      );
    const timezone = requiredText(raw.timezone, "Timezone", 100);
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone }).format(now);
    } catch {
      throw new HarnessError("Use a valid IANA timezone.");
    }
    trigger = { type: "cron", expression, timezone };
  } else
    throw new HarnessError(
      "Choose a future one-time date or a cron schedule with a timezone.",
    );
  try {
    new Intl.DateTimeFormat("en", {
      timeZone: trigger.timezone ?? "UTC",
    }).format(now);
  } catch {
    throw new HarnessError("Use a valid IANA timezone.");
  }
  if (input.kind !== "agent" && input.kind !== "reminder")
    throw new HarnessError("Choose agent work or a simple reminder.");
  const maxLatenessMs = input.maxLatenessMs ?? 86400000;
  if (
    typeof maxLatenessMs !== "number" ||
    !Number.isSafeInteger(maxLatenessMs) ||
    maxLatenessMs < 0 ||
    maxLatenessMs > 7 * 86400000
  )
    throw new HarnessError(
      "Maximum lateness must be between zero and seven days.",
    );
  const draft: ScheduleDraft = {
    name: requiredText(input.name, "Schedule name", 100),
    prompt: requiredText(input.prompt, "Schedule prompt"),
    sessionId: requiredText(input.sessionId, "Session ID", 100),
    kind: input.kind,
    trigger,
    maxLatenessMs,
  };
  nextOccurrence(trigger, now);
  return draft;
}
export function upcomingOccurrences(
  trigger: ScheduleTrigger,
  after: number,
  count = 3,
): number[] {
  const result: number[] = [];
  for (let i = 0; i < Math.min(count, 10); i++) {
    const next = nextOccurrence(trigger, after);
    if (next === null) break;
    result.push(next);
    after = next;
  }
  return result;
}

export interface ScheduleOccurrence {
  id: string;
  scheduleId: string;
  revision: number;
  plannedAt: number;
  firedAt: number;
  turnId: string | null;
  outcome: "queued" | "reminded" | "skipped";
}
