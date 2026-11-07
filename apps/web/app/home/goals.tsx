"use client";
import {
  type Goal,
  type GoalEvent,
  type GoalStep,
  goalProgress,
  type StepStatus,
} from "@harness/core/goals";
import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { conversationHref, ErrorNote } from "../shell";

interface Need {
  id: string;
  kind: string;
  message: string;
  sessionId: string;
  sessionTitle: string;
  workspaceId: string;
  goalId: string | null;
  createdAt: number;
}
interface HistoryEvent extends GoalEvent {
  goalTitle: string;
  workspaceId: string;
}
interface Overview {
  goals: Goal[];
  needs: Need[];
  history: HistoryEvent[];
  workspaces: { id: string; name: string }[];
  timeZone: string;
}
interface Detail {
  goal: Goal;
  events: GoalEvent[];
  people: {
    sessionId: string;
    title: string;
    planner: boolean;
    working: boolean;
  }[];
  needs: Need[];
  workspaces: { id: string; name: string }[];
  timeZone: string;
}

const STATUS: Record<StepStatus, { label: string; className: string }> = {
  done: { label: "Done", className: "bg-success-soft text-success" },
  review: { label: "In review", className: "bg-warning-soft text-warning" },
  working: { label: "Working", className: "bg-live-soft text-primary" },
  waiting: { label: "Waiting", className: "bg-muted text-muted-foreground" },
  todo: { label: "Not started", className: "bg-muted text-muted-foreground" },
  postponed: {
    label: "Postponed",
    className: "bg-muted text-muted-foreground",
  },
};

/** Loads a goals endpoint and refreshes it while the page is visible. */
function useGoals<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const response = await fetch(url);
    if (response.status === 401) return location.assign("/login");
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Goals are unavailable.");
    setData(body);
  }, [url]);
  useEffect(() => {
    let stopped = false;
    const tick = () =>
      void load()
        .then(() => setError(""))
        .catch((reason: Error) => !stopped && setError(reason.message));
    tick();
    const timer = setInterval(() => !document.hidden && tick(), 15000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [load]);
  return { data, error };
}

function dayKey(at: number, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}
function dayName(at: number, timeZone: string) {
  if (dayKey(at, timeZone) === dayKey(Date.now(), timeZone)) return "Today";
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(at);
}
function timeOfDay(at: number, timeZone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}
function clock(at: number, timeZone: string) {
  const time = timeOfDay(at, timeZone);
  return dayKey(at, timeZone) === dayKey(Date.now(), timeZone)
    ? time
    : `${new Intl.DateTimeFormat(undefined, { timeZone, weekday: "short" }).format(at)} ${time}`;
}
function hours(ms: number) {
  const minutes = Math.round(ms / 60000);
  return minutes < 90
    ? `${minutes} min`
    : `${Math.round((minutes / 60) * 10) / 10} h`;
}
/** "done ≈ 8:10 PM", or how late a run is past its estimate. */
function eta(goal: Goal, timeZone: string) {
  if (!goal.etaAt) return null;
  const late = Date.now() - goal.etaAt;
  return late > 0
    ? `${hours(late)} over its estimate`
    : `done ≈ ${clock(goal.etaAt, timeZone)}`;
}

function ProgressBar({ goal }: { goal: Goal }) {
  const progress = goalProgress(goal);
  const share = (count: number) =>
    `${progress.total ? (count / progress.total) * 100 : 0}%`;
  return (
    <div
      className="flex h-2 overflow-hidden rounded-full bg-muted"
      role="img"
      aria-label={`${progress.done} of ${progress.total} done`}
    >
      {goal.targets.length ? (
        <span
          className="bg-success"
          style={{ width: `${progress.fraction * 100}%` }}
        />
      ) : (
        <>
          <span
            className="bg-success"
            style={{ width: share(progress.done) }}
          />
          <span
            className="bg-warning/70"
            style={{
              width: share(progress.review),
              backgroundImage:
                "repeating-linear-gradient(135deg, transparent 0 5px, var(--card) 5px 7px)",
            }}
          />
          <span
            className="bg-primary"
            style={{ width: share(progress.working) }}
          />
        </>
      )}
    </div>
  );
}
function Counts({ goal }: { goal: Goal }) {
  if (goal.targets.length)
    return (
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {goal.targets.map((target) => (
          <span key={target.label}>
            <b className="font-semibold tabular-nums">
              {target.current} of {target.target}
            </b>{" "}
            <span className="text-muted-foreground">{target.label}</span>
          </span>
        ))}
      </p>
    );
  const progress = goalProgress(goal);
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      <span>
        <b className="font-semibold tabular-nums">
          {progress.done} of {progress.total}
        </b>{" "}
        done
      </span>
      {progress.review > 0 && (
        <span className="text-muted-foreground">
          {progress.review} in review
        </span>
      )}
      {progress.working > 0 && (
        <span className="text-muted-foreground">
          {progress.working} in progress
        </span>
      )}
    </p>
  );
}
function StatusChip({ status }: { status: StepStatus }) {
  return (
    <span
      className={cn(
        "inline-block rounded-full px-2 py-px text-xs font-medium whitespace-nowrap",
        STATUS[status].className,
      )}
    >
      {STATUS[status].label}
    </span>
  );
}
/** What a hover shows: every step by status, with the answers to done ones. */
function StepSummary({ steps }: { steps: GoalStep[] }) {
  const order: StepStatus[] = ["done", "review", "working", "waiting", "todo"];
  return (
    <div className="grid gap-3">
      {order.map((status) => {
        const list = steps.filter((step) => step.status === status);
        if (!list.length) return null;
        return (
          <div
            key={status}
            className="grid grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-3"
          >
            <span>
              <StatusChip status={status} />
            </span>
            <ul className="grid gap-1.5">
              {list.map((step) => (
                <li key={step.label}>
                  {step.label}
                  {step.answer && (
                    <span className="block font-semibold text-success">
                      → {step.answer}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
function GoalCard({
  goal,
  needs,
  workspace,
  timeZone,
}: {
  goal: Goal;
  needs: number;
  workspace: string;
  timeZone: string;
}) {
  const finish = eta(goal, timeZone);
  return (
    <Link
      prefetch={false}
      href={`/home?goal=${encodeURIComponent(goal.id)}`}
      className="group relative block rounded-xl border bg-card px-5 py-4 shadow-xs transition-colors hover:border-primary focus-visible:border-primary focus-visible:outline-none"
    >
      <div className="flex flex-col justify-between gap-x-3 gap-y-0.5 sm:flex-row sm:items-baseline">
        <h3 className="font-serif text-xl leading-snug tracking-tight text-balance">
          {goal.title}
        </h3>
        <span className="text-sm whitespace-nowrap text-muted-foreground">
          {workspace}
        </span>
      </div>
      <p className="mt-0.5 text-sm text-muted-foreground">{goal.summary}</p>
      <div className="mt-3 mb-2">
        <ProgressBar goal={goal} />
      </div>
      <Counts goal={goal} />
      {goal.now && (
        <p className="mt-2 text-sm">
          {goal.now}
          {finish && (
            <span className="ml-1.5 rounded bg-live-soft px-1.5 py-px font-mono text-xs whitespace-nowrap text-primary">
              {finish}
            </span>
          )}
        </p>
      )}
      {needs > 0 && (
        <p className="mt-2.5 text-sm font-medium text-primary">
          Needs you: {needs === 1 ? "one question" : `${needs} questions`}
        </p>
      )}
      {goal.steps.length > 0 && (
        <div
          aria-hidden
          className="pointer-events-none invisible absolute inset-x-4 top-[calc(100%-0.5rem)] z-20 hidden rounded-lg border bg-popover px-4 py-3.5 text-sm text-popover-foreground opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100 md:block"
        >
          <StepSummary steps={goal.steps} />
          <p className="mt-3 text-xs text-muted-foreground">
            Open for the reasons, decisions and day-by-day history.
          </p>
        </div>
      )}
    </Link>
  );
}
function NeedCard({
  need,
  workspace,
  goal,
}: {
  need: Need;
  workspace: string;
  goal?: Goal;
}) {
  return (
    <div className="flex gap-3.5 overflow-hidden rounded-xl border bg-card py-3.5 pr-4 shadow-xs">
      <span className="w-1 shrink-0 rounded-r bg-primary" />
      <div className="min-w-0">
        <p className="text-sm text-muted-foreground">
          {need.sessionTitle} · {workspace}
          {goal && (
            <>
              {" · "}
              <Link
                prefetch={false}
                className="underline-offset-2 hover:underline"
                href={`/home?goal=${encodeURIComponent(goal.id)}`}
              >
                {goal.title}
              </Link>
            </>
          )}
        </p>
        <p className="mt-1 mb-2 whitespace-pre-wrap break-words">
          {need.message}
        </p>
        <Link
          prefetch={false}
          className="text-sm font-medium text-primary hover:underline"
          href={conversationHref(need.workspaceId, need.sessionId)}
        >
          {need.kind === "browser-login"
            ? "Sign in in the shared browser"
            : `Answer in ${need.sessionTitle}`}{" "}
          →
        </Link>
      </div>
    </div>
  );
}
function SectionTitle({
  children,
  count,
}: {
  children: React.ReactNode;
  count?: number;
}) {
  return (
    <h2 className="mb-3 flex items-baseline gap-2 text-xs font-semibold tracking-widest text-muted-foreground uppercase">
      {children}
      {count !== undefined && (
        <span className="font-mono tracking-normal">{count}</span>
      )}
    </h2>
  );
}

/** One line per goal that moved on a day: how far, and what happened. */
function dayRows(events: HistoryEvent[]) {
  const byGoal = new Map<string, HistoryEvent[]>();
  for (const event of events)
    byGoal.set(event.goalId, [...(byGoal.get(event.goalId) ?? []), event]);
  return [...byGoal.values()].map((list) => {
    const first = list[0];
    const last = list[list.length - 1];
    const moves = list.filter((event) => event.kind !== "decision");
    const finished = list.some((event) => event.kind === "finished");
    const started = list.some((event) => event.kind === "started");
    const delta = finished
      ? "finished"
      : started
        ? `started → ${last.done} of ${last.total}`
        : first.done !== last.done || first.total !== last.total
          ? `${first.done} → ${last.done} of ${last.total}`
          : "";
    return {
      goalId: last.goalId,
      title: last.goalTitle,
      delta,
      notes: moves.slice(-2).map((event) => event.text),
      decisions: list
        .filter((event) => event.kind === "decision")
        .map((event) => event.text),
    };
  });
}

export function GoalsOverview() {
  const { data, error } = useGoals<Overview>("/api/goals");
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return null;
  const names = new Map(data.workspaces.map((item) => [item.id, item.name]));
  const goals = new Map(data.goals.map((goal) => [goal.id, goal]));
  const active = data.goals.filter((goal) => goal.status === "active");
  const next = data.goals.filter((goal) => goal.status === "next");
  const days = new Map<string, HistoryEvent[]>();
  for (const event of [...data.history].reverse()) {
    const key = dayKey(event.at, data.timeZone);
    days.set(key, [...(days.get(key) ?? []), event]);
  }
  return (
    <div className="mb-12 grid gap-9">
      {data.needs.length > 0 && (
        <section>
          <SectionTitle count={data.needs.length}>Needs you</SectionTitle>
          <div className="grid gap-2.5">
            {data.needs.map((need) => (
              <NeedCard
                key={need.id}
                need={need}
                workspace={names.get(need.workspaceId) ?? ""}
                goal={need.goalId ? goals.get(need.goalId) : undefined}
              />
            ))}
          </div>
        </section>
      )}
      <section>
        <SectionTitle count={active.length}>Now</SectionTitle>
        {active.length ? (
          <div className="grid gap-2.5">
            {active.map((goal) => (
              <GoalCard
                key={goal.id}
                goal={goal}
                needs={
                  data.needs.filter((need) => need.goalId === goal.id).length
                }
                workspace={names.get(goal.workspaceId) ?? ""}
                timeZone={data.timeZone}
              />
            ))}
          </div>
        ) : (
          <p className="rounded-xl border border-dashed px-5 py-6 text-sm text-muted-foreground">
            No goals yet. When you ask a planner for something that takes
            several steps, it shows up here with its progress.
          </p>
        )}
      </section>
      {next.length > 0 && (
        <section>
          <SectionTitle>Next</SectionTitle>
          <div className="divide-y">
            {next.map((goal) => (
              <Link
                prefetch={false}
                key={goal.id}
                href={`/home?goal=${encodeURIComponent(goal.id)}`}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 py-3 first:pt-0 hover:text-primary"
              >
                <b className="font-semibold">{goal.title}</b>
                <span className="text-right text-sm text-muted-foreground">
                  {goal.startsWhen}
                </span>
                <span className="col-span-2 text-sm text-muted-foreground">
                  {goal.summary}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
      {days.size > 0 && (
        <section>
          <SectionTitle>Past week</SectionTitle>
          {[...days.entries()].map(([key, events]) => (
            <div
              key={key}
              className="grid gap-1.5 border-t py-3.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-4"
            >
              <span className="pt-0.5 font-mono text-sm text-muted-foreground">
                {dayName(events[0].at, data.timeZone)}
              </span>
              <ul className="grid gap-2.5">
                {dayRows([...events].reverse()).map((row) => (
                  <li key={row.goalId}>
                    <Link
                      prefetch={false}
                      className="font-semibold hover:underline"
                      href={`/home?goal=${encodeURIComponent(row.goalId)}`}
                    >
                      {row.title}
                    </Link>
                    {row.delta && (
                      <span className="ml-2 font-mono text-xs whitespace-nowrap text-muted-foreground">
                        {row.delta}
                      </span>
                    )}
                    {[
                      ...row.notes,
                      ...row.decisions.map((d) => `Decided: ${d}`),
                    ]
                      .slice(0, 3)
                      .map((note) => (
                        <p key={note} className="text-sm text-muted-foreground">
                          {note}
                        </p>
                      ))}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

export function GoalPage({ id }: { id: string }) {
  const { data, error } = useGoals<Detail>(
    `/api/goals?id=${encodeURIComponent(id)}`,
  );
  const back = (
    <Link
      prefetch={false}
      href="/home"
      className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
      Home
    </Link>
  );
  if (error)
    return (
      <section className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
        {back}
        <ErrorNote>{error}</ErrorNote>
      </section>
    );
  if (!data) return null;
  const { goal, timeZone } = data;
  const workspace =
    data.workspaces.find((item) => item.id === goal.workspaceId)?.name ?? "";
  const progress = goalProgress(goal);
  const finish = eta(goal, timeZone);
  const decisions = data.events.filter((event) => event.kind === "decision");
  const history = data.events.filter((event) => event.kind !== "decision");
  const postponed = goal.steps.some((step) => step.status === "postponed");
  return (
    <section className="mx-auto grid w-full max-w-3xl gap-8 px-4 py-6 sm:px-6">
      <div>
        {back}
        <h1 className="font-serif text-3xl leading-tight tracking-tight text-balance">
          {goal.title}
        </h1>
        <p className="mt-1.5 text-lg">{goal.summary}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {[
            workspace,
            `started ${dayName(goal.createdAt, timeZone).replace("Today", "today")}`,
            goal.finishedAt &&
              `${goal.status === "dropped" ? "dropped" : "finished"} ${dayName(goal.finishedAt, timeZone).replace("Today", "today")}`,
            goal.status === "next" && goal.startsWhen,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      {data.needs.length > 0 && (
        <section>
          <SectionTitle>Needs you</SectionTitle>
          <div className="grid gap-2.5">
            {data.needs.map((need) => (
              <NeedCard key={need.id} need={need} workspace={workspace} />
            ))}
          </div>
        </section>
      )}
      <section>
        <SectionTitle>Why we're doing this</SectionTitle>
        <div className="rounded-xl border bg-card px-5 py-4 whitespace-pre-wrap shadow-xs">
          {goal.why}
        </div>
      </section>
      <section>
        <SectionTitle>Where it stands</SectionTitle>
        <div className="rounded-xl border bg-card px-5 py-4 shadow-xs">
          {goal.now && (
            <p className="mb-3">
              <b className="font-semibold">Right now:</b> {goal.now}
              {finish && (
                <span className="ml-1.5 rounded bg-live-soft px-1.5 py-px font-mono text-xs whitespace-nowrap text-primary">
                  {finish}
                </span>
              )}
            </p>
          )}
          <ProgressBar goal={goal} />
          {goal.targets.length ? (
            <>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {goal.targets.map((target) => (
                  <div key={target.label}>
                    <p className="font-mono text-2xl tabular-nums">
                      {target.current}
                      <span className="text-sm text-muted-foreground">
                        {" "}
                        of {target.target}
                      </span>
                    </p>
                    <p>{target.label}</p>
                    {target.note && (
                      <p className="text-sm text-muted-foreground">
                        {target.note}
                      </p>
                    )}
                  </div>
                ))}
              </div>
              {goal.targetNote && (
                <p className="mt-4 text-sm text-muted-foreground">
                  {goal.targetNote}
                </p>
              )}
            </>
          ) : (
            <>
              <p className="mt-2 mb-4 text-sm text-muted-foreground">
                {progress.done} of {progress.total} done
                {progress.review > 0 && `, ${progress.review} in review`}. A
                step counts as done only once its result is accepted.
                {postponed && " Postponed steps don't count."}
              </p>
              <ol className="divide-y">
                {goal.steps.map((step) => (
                  <li
                    key={step.label}
                    className="grid gap-1 py-3 first:pt-0 sm:grid-cols-[6.5rem_minmax(0,1fr)] sm:gap-3"
                  >
                    <span>
                      <StatusChip status={step.status} />
                    </span>
                    <div>
                      <p className="font-medium">{step.label}</p>
                      {step.answer && (
                        <p className="mt-0.5 font-semibold text-success">
                          → {step.answer}
                        </p>
                      )}
                      {step.detail && (
                        <p className="mt-0.5 text-sm text-muted-foreground">
                          {step.detail}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </section>
      {decisions.length > 0 && (
        <section>
          <SectionTitle>Decisions along the way</SectionTitle>
          <ul className="grid gap-3 rounded-xl border bg-card px-5 py-4 shadow-xs">
            {decisions.map((event) => (
              <li key={event.id}>
                {event.text}
                <p className="text-sm text-muted-foreground">
                  {event.by} · {dayName(event.at, timeZone)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <SectionTitle>History</SectionTitle>
        <ol className="grid gap-4 border-l-2 pl-5">
          {history.map((event) => (
            <li key={event.id} className="relative">
              <span
                className={cn(
                  "absolute top-1.5 -left-[1.6rem] size-3 rounded-full border-2 border-muted-foreground bg-card",
                  event.kind === "finished" && "border-success bg-success",
                )}
              />
              <p className="font-mono text-sm text-muted-foreground">
                {dayName(event.at, timeZone)}, {timeOfDay(event.at, timeZone)}
                <span className="ml-2 text-foreground">
                  {event.done} of {event.total}
                </span>
              </p>
              <p className="mt-0.5 text-sm">{event.text}</p>
            </li>
          ))}
        </ol>
      </section>
      {data.people.length > 0 && (
        <section>
          <SectionTitle>Who's working on it</SectionTitle>
          <div className="flex flex-wrap gap-2">
            {data.people.map((person) => (
              <Link
                prefetch={false}
                key={person.sessionId}
                href={conversationHref(goal.workspaceId, person.sessionId)}
                className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-sm hover:border-primary"
              >
                {person.title}
                <span className="text-muted-foreground">
                  {person.planner
                    ? "· plans it"
                    : person.working
                      ? "· working now"
                      : ""}
                </span>
                <ArrowRight className="size-3.5 text-muted-foreground" />
              </Link>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
