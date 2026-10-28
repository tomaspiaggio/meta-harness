"use client";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { MarkdownMessage } from "./markdown";
import { conversationHref, ErrorNote, timeAgo } from "./shell";

type SessionRef = { id: string; title: string; workspaceId: string };
export type DelegationView = {
  id: string;
  title: string;
  state: string;
  rounds: number;
  progress: string | null;
  progressAt: number | null;
  report: string | null;
  reportAt: number | null;
  updatedAt: number;
  from: SessionRef;
  to: SessionRef;
};
/** Who a task, feedback or report message in this conversation came from. */
export type DelegationTag = {
  role: "task" | "reply" | "report";
  taskId: string;
  title: string;
  round: number;
  status: string | null;
  peer: SessionRef | null;
};

/** Where a task stands, in the four phases the owner cares about. */
const phases = {
  needs: {
    label: "needs answer",
    tone: "bg-danger-soft text-danger",
    help: "The worker asked a question, is blocked, or its turn failed. The planner answers if it can; if not, it asks you.",
  },
  review: {
    label: "to review",
    tone: "bg-warning-soft text-warning",
    help: "The worker finished and reported back. The planner checks the result, then closes the task or sends it back.",
  },
  working: {
    label: "working",
    tone: "bg-secondary text-foreground",
    help: "The worker has it: waiting for a free machine or working on it now.",
  },
  closed: {
    label: "closed",
    tone: "text-muted-foreground",
    help: "Finished: the planner accepted the result, or the task was cancelled.",
  },
} as const;
type Phase = keyof typeof phases;
const order: Phase[] = ["needs", "review", "working", "closed"];
export function taskPhase(state: string): Phase {
  if (state === "accepted" || state === "cancelled") return "closed";
  if (state === "queued" || state === "working") return "working";
  if (state === "done" || state === "finished" || state === "progress")
    return "review";
  // waiting-on-owner, question, blocked, failed, interrupted.
  return "needs";
}
function PhaseBadge({ state }: { state: string }) {
  const phase = phases[taskPhase(state)];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="secondary"
          tabIndex={0}
          className={cn(
            "gap-1.5 rounded-full border-transparent font-mono text-[11px] font-normal normal-case tracking-normal",
            phase.tone,
          )}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full bg-current",
              taskPhase(state) === "working" && "animate-pulse text-live",
            )}
          />
          {phase.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{phase.help}</TooltipContent>
    </Tooltip>
  );
}

export function SessionLink({ session }: { session: SessionRef | null }) {
  if (!session?.workspaceId)
    return <span>{session?.title ?? "a deleted session"}</span>;
  return (
    <Link
      href={conversationHref(session.workspaceId, session.id)}
      className="underline underline-offset-2"
    >
      {session.title}
    </Link>
  );
}

/**
 * Tasks this session handed to other sessions, or received from one. Workers
 * report back on their own; the owner can look in or cancel a task here.
 */
export function DelegationsCard({
  sessionId,
  delegations,
  onChange,
}: {
  sessionId: string;
  delegations: DelegationView[];
  onChange: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!delegations.length) return null;
  async function cancel(id: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/delegations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "cancel" }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Cannot cancel.");
      onChange();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  const sorted = [...delegations].sort(
    (a, b) =>
      order.indexOf(taskPhase(a.state)) - order.indexOf(taskPhase(b.state)) ||
      b.updatedAt - a.updatedAt,
  );
  const active = sorted.filter((item) => taskPhase(item.state) !== "closed");
  const closed = sorted.filter((item) => taskPhase(item.state) === "closed");
  const row = (item: DelegationView) => {
    const given = item.from.id === sessionId;
    const expanded = open === item.id;
    const live = taskPhase(item.state) !== "closed";
    return (
      <li key={item.id} className="px-4 py-3 text-sm">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <PhaseBadge state={item.state} />
          <button
            type="button"
            className="min-w-0 flex-1 text-left font-medium"
            onClick={() => setOpen(expanded ? null : item.id)}
          >
            {item.title}
          </button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {given ? "Given to " : "From "}
          <SessionLink session={given ? item.to : item.from} />
          {item.rounds > 1 && (
            <span title="How many times the planner has sent this task back with feedback or a next step.">
              {` · round ${item.rounds}`}
            </span>
          )}{" "}
          · updated {timeAgo(item.updatedAt)}
        </p>
        {expanded && (
          <div className="mt-3 grid gap-3">
            <p className="text-xs text-muted-foreground">
              {phases[taskPhase(item.state)].help}
            </p>
            {item.progress && (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  Latest progress
                  {item.progressAt ? ` · ${timeAgo(item.progressAt)}` : ""}
                </p>
                <MarkdownMessage>{item.progress}</MarkdownMessage>
              </div>
            )}
            {item.report && (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  Latest report
                  {item.reportAt ? ` · ${timeAgo(item.reportAt)}` : ""}
                </p>
                <MarkdownMessage>{item.report}</MarkdownMessage>
              </div>
            )}
            {!item.progress && !item.report && (
              <p className="text-muted-foreground">
                No progress reported yet. Open <SessionLink session={item.to} />{" "}
                to watch it work.
              </p>
            )}
            {given && live && (
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void cancel(item.id)}
                >
                  Cancel task
                </Button>
              </div>
            )}
          </div>
        )}
      </li>
    );
  };
  return (
    <section className="my-6 rounded-lg border">
      <h2 className="border-b px-4 py-2.5 text-sm font-medium">
        Tasks
        {active.length > 0 && (
          <span className="ml-2 font-normal text-muted-foreground">
            {active.length} active
          </span>
        )}
      </h2>
      {active.length > 0 ? (
        <ul className="divide-y">{active.map(row)}</ul>
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No active tasks.
        </p>
      )}
      {closed.length > 0 && (
        <details className="group border-t">
          <summary className="cursor-pointer list-none px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground">
            <span className="inline-block transition-transform group-open:rotate-90">
              ▸
            </span>{" "}
            {closed.length} closed
          </summary>
          <ul className="divide-y border-t">{closed.map(row)}</ul>
        </details>
      )}
      {error && (
        <div className="px-4 pb-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </section>
  );
}
export function phaseLabel(phase: Phase) {
  return phases[phase].label;
}
/**
 * A planner's workers: each session it handed work to, whether it is working
 * now, and every task on the board below.
 */
export function WorkersBoard({
  sessionId,
  delegations,
  sessions,
  onChange,
}: {
  sessionId: string;
  delegations: DelegationView[];
  sessions: { id: string; busy?: boolean }[];
  onChange: () => void;
}) {
  const workers = new Map<
    string,
    { session: SessionRef; active: number; updatedAt: number }
  >();
  for (const item of delegations) {
    const entry = workers.get(item.to.id) ?? {
      session: item.to,
      active: 0,
      updatedAt: 0,
    };
    if (taskPhase(item.state) !== "closed") entry.active++;
    entry.updatedAt = Math.max(entry.updatedAt, item.updatedAt);
    workers.set(item.to.id, entry);
  }
  const busy = new Set(
    sessions.filter((session) => session.busy).map((session) => session.id),
  );
  const list = [...workers.values()].sort(
    (a, b) =>
      Number(busy.has(b.session.id)) - Number(busy.has(a.session.id)) ||
      b.active - a.active ||
      b.updatedAt - a.updatedAt,
  );
  return (
    <div>
      <h2 className="mb-3 font-serif text-3xl tracking-tight">Workers</h2>
      {list.length ? (
        <ul className="mb-2 grid gap-2 sm:grid-cols-2">
          {list.map(({ session, active, updatedAt }) => (
            <li
              key={session.id}
              className="flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 text-sm"
            >
              <span
                aria-hidden
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  busy.has(session.id)
                    ? "animate-pulse bg-live"
                    : "bg-muted-foreground/30",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  <SessionLink session={session} />
                </span>
                <span className="text-xs text-muted-foreground">
                  {busy.has(session.id) ? "working now" : "idle"}
                  {active ? ` · ${active} open` : ""} · {timeAgo(updatedAt)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No workers yet. Ask the planner for work and it launches workers as
          needed.
        </p>
      )}
      <DelegationsCard
        sessionId={sessionId}
        delegations={delegations}
        onChange={onChange}
      />
    </div>
  );
}
