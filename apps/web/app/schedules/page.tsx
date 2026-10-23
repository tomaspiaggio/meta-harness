"use client";
import type { Session } from "@harness/core";
import type { Schedule } from "@harness/core/automations";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScheduleCard } from "../schedule-card";
import { ErrorNote, PageHeading, Shell, useTree } from "../shell";

export default function Page() {
  return (
    <Shell>
      <Schedules />
    </Shell>
  );
}
function Schedules() {
  const { tree, refresh } = useTree();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [sessionId, setSessionId] = useState("new");
  const [workspaceChoice, setWorkspaceId] = useState("business");
  const workspaceId =
    tree.loaded && !tree.workspaces.some((item) => item.id === workspaceChoice)
      ? (tree.workspaces[0]?.id ?? "")
      : workspaceChoice;
  const [kind, setKind] = useState("agent");
  const [type, setType] = useState("cron");
  const [expression, setExpression] = useState("0 8 * * 1-5");
  const [date, setDate] = useState("");
  const [timezone, setTimezone] = useState("America/Los_Angeles");
  const load = async () => {
    const response = await fetch("/api/schedules");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    setSchedules(result.schedules);
  };
  useEffect(() => {
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    let cancelled = false;
    const update = async () => {
      if (document.hidden || cancelled) return;
      try {
        const response = await fetch("/api/schedules");
        const result = await response.json();
        if (!cancelled) {
          if (!response.ok) throw new Error(result.error);
          setSchedules(result.schedules);
        }
      } catch (error) {
        if (!cancelled)
          setError(
            error instanceof Error ? error.message : "Cannot load schedules.",
          );
      }
    };
    void update();
    const timer = setInterval(() => void update(), 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  const changed = () => {
    void load().catch((error) => setError(error.message));
    refresh();
  };
  const select = "h-9 rounded-md border bg-background px-2 text-sm";
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-8">
      <PageHeading eyebrow="Automation" title="Schedules">
        <Button onClick={() => setCreating(!creating)}>
          {creating ? "Close" : "New schedule"}
        </Button>
      </PageHeading>
      {error && <ErrorNote>{error}</ErrorNote>}
      <p className="mb-6 text-sm text-muted-foreground">
        Each run posts to the same persistent conversation. You can also
        describe a schedule to your agent; it will propose a draft here for
        review.
      </p>
      {creating && (
        <form
          className="mb-8 grid gap-3 rounded-xl border bg-card p-5"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            try {
              let destination = sessionId;
              if (destination === "new") {
                const response = await fetch("/api/sessions", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    workspaceId,
                    title: name,
                    provider: tree.defaults?.provider ?? "claude",
                  }),
                });
                const result: Session & { error?: string } =
                  await response.json();
                if (!response.ok) throw new Error(result.error);
                destination = result.id;
                setSessionId(destination);
                refresh();
              }
              const response = await fetch("/api/schedules", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  id: crypto.randomUUID(),
                  draft: {
                    name,
                    prompt,
                    sessionId: destination,
                    kind,
                    trigger:
                      type === "cron"
                        ? { type, expression, timezone }
                        : {
                            type: "once",
                            at: new Date(date).getTime(),
                            timezone:
                              Intl.DateTimeFormat().resolvedOptions().timeZone,
                          },
                    maxLatenessMs: 86400000,
                  },
                }),
              });
              const result = await response.json();
              if (!response.ok) throw new Error(result.error);
              setCreating(false);
              setName("");
              setPrompt("");
              changed();
            } catch (error) {
              setError(
                error instanceof Error
                  ? error.message
                  : "Cannot save schedule.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <Input
            aria-label="Schedule name"
            placeholder="CRM morning review"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
            required
          />
          <Textarea
            aria-label="Schedule prompt"
            placeholder="The exact message to send each time…"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={4}
            maxLength={20000}
            required
          />
          <label className="grid gap-1 text-xs">
            Destination
            <select
              className={select}
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
            >
              <option value="new">
                Create one dedicated persistent session
              </option>
              {tree.sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {
                    tree.workspaces.find(
                      (workspace) => workspace.id === session.workspaceId,
                    )?.name
                  }{" "}
                  / {session.title}
                </option>
              ))}
            </select>
          </label>
          {sessionId === "new" && (
            <label className="grid gap-1 text-xs">
              Workspace
              <select
                className={select}
                value={workspaceId}
                onChange={(event) => setWorkspaceId(event.target.value)}
              >
                {tree.workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-xs">
              Work
              <select
                className={select}
                value={kind}
                onChange={(event) => setKind(event.target.value)}
              >
                <option value="agent">Run the agent</option>
                <option value="reminder">
                  Post a reminder, without an agent
                </option>
              </select>
            </label>
            <label className="grid gap-1 text-xs">
              When
              <select
                className={select}
                value={type}
                onChange={(event) => setType(event.target.value)}
              >
                <option value="cron">Recurring</option>
                <option value="once">One time</option>
              </select>
            </label>
          </div>
          {type === "cron" ? (
            <>
              <Input
                aria-label="Five-field cron"
                value={expression}
                onChange={(event) => setExpression(event.target.value)}
                required
              />
              <Input
                aria-label="IANA timezone"
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                required
              />
            </>
          ) : (
            <Input
              type="datetime-local"
              aria-label="One-time date in your current timezone"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              required
            />
          )}
          <Button className="justify-self-end" disabled={busy}>
            {busy ? "Saving…" : "Create review draft"}
          </Button>
        </form>
      )}
      {schedules.length ? (
        schedules.map((schedule) => (
          <ScheduleCard
            key={`${schedule.id}:${schedule.revision}`}
            schedule={schedule}
            destination={
              tree.sessions.find((session) => session.id === schedule.sessionId)
                ?.title
            }
            onChange={changed}
          />
        ))
      ) : (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No schedules yet.
        </p>
      )}
    </div>
  );
}
