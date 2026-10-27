import { HarnessError, requiredText } from "./index";

/** The workspace that holds the session writing the daily briefs. */
export const BRIEFS_WORKSPACE = "briefs";
/** Local hour after which yesterday's brief is written. */
export const BRIEF_HOUR = 5;
export const MAX_BRIEF_HTML = 200_000;

export interface BriefSource {
  sessionId?: string;
  decisionKey?: string;
}
export interface BriefSummary {
  id: string;
  day: string;
  workspaceId: string;
  title: string;
  highlights: string[];
  createdAt: number;
  updatedAt: number;
}
export interface Brief extends BriefSummary {
  html: string;
  sources: BriefSource[];
  turnId: string | null;
}
export interface BriefInput {
  day: string;
  workspaceId: string;
  title: string;
  highlights: string[];
  html: string;
  sources: BriefSource[];
}

function parts(epochMs: number, timeZone: string) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(epochMs)
      .map((part) => [part.type, part.value]),
  );
  return {
    day: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    // Wall-clock time in that zone, read as if it were UTC.
    wall: Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
    ),
  };
}
/** The calendar day (YYYY-MM-DD) and hour of an instant in a time zone. */
export function localTime(epochMs: number, timeZone: string) {
  const { day, hour } = parts(epochMs, timeZone);
  return { day, hour };
}
export function parseDay(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  )
    throw new HarnessError("Use a day like 2026-10-26.");
  return value;
}
/** The day before `day`, as YYYY-MM-DD. */
export function previousDay(day: string): string {
  return new Date(Date.parse(`${parseDay(day)}T12:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
}
/** Start (inclusive) and end (exclusive) of a local day, in epoch ms. */
export function dayBounds(
  day: string,
  timeZone: string,
): { start: number; end: number } {
  const midnight = (value: string) => {
    const guess = Date.parse(`${value}T00:00:00Z`);
    // Correct twice so a daylight-saving change on that day lands exactly.
    let start = guess - (parts(guess, timeZone).wall - guess);
    start -= parts(start, timeZone).wall - guess;
    return start;
  };
  const next = new Date(Date.parse(`${parseDay(day)}T12:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  return { start: midnight(day), end: midnight(next) };
}
export function parseBrief(value: Record<string, unknown>): BriefInput {
  const highlights = value.highlights;
  if (
    !Array.isArray(highlights) ||
    highlights.length < 1 ||
    highlights.length > 6
  )
    throw new HarnessError("Give 1–6 highlights.");
  const sources = Array.isArray(value.sources) ? value.sources : [];
  if (sources.length > 50) throw new HarnessError("List at most 50 sources.");
  return {
    day: parseDay(value.day),
    workspaceId: requiredText(value.workspace_id, "Workspace ID", 100),
    title: requiredText(value.title, "Title", 120),
    highlights: highlights.map((item) =>
      requiredText(item, "Each highlight", 240),
    ),
    html: requiredText(value.html, "HTML", MAX_BRIEF_HTML),
    sources: sources.map((item) => {
      const row = (item ?? {}) as Record<string, unknown>;
      return {
        ...(typeof row.session_id === "string"
          ? { sessionId: row.session_id.slice(0, 100) }
          : {}),
        ...(typeof row.decision_key === "string"
          ? { decisionKey: row.decision_key.slice(0, 100) }
          : {}),
      };
    }),
  };
}
