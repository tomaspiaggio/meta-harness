"use client";
import type { Schedule, ScheduleDraft } from "@harness/core/automations";
import { upcomingOccurrences } from "@harness/core/automations";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ErrorNote, StatusBadge } from "./shell";

export function ScheduleCard({
  schedule,
  destination,
  onChange,
}: {
  schedule: Schedule;
  destination?: string;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(schedule.name);
  const [prompt, setPrompt] = useState(schedule.prompt);
  const [expression, setExpression] = useState(
    schedule.trigger.type === "cron" ? schedule.trigger.expression : "",
  );
  const [at, setAt] = useState(
    schedule.trigger.type === "once"
      ? new Date(schedule.trigger.at).toISOString().slice(0, 16)
      : "",
  );
  const [zone, setZone] = useState(schedule.trigger.timezone ?? "UTC");
  const [history, setHistory] = useState<
    { id: string; outcome: string; firedAt: number }[] | null
  >(null);
  const timezone = schedule.trigger.timezone ?? "UTC";
  const format = (date: number) =>
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(date);
  async function request(method: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/schedules", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error ?? "Schedule request failed.");
      setEditing(false);
      onChange();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Schedule request failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  const times = upcomingOccurrences(schedule.trigger, Date.now());
  return (
    <Card className="mb-4 gap-3 py-4">
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle className="text-base">{schedule.name}</CardTitle>
        <StatusBadge status={schedule.status} />
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {error && <ErrorNote>{error}</ErrorNote>}
        {editing ? (
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const draft: ScheduleDraft = {
                name,
                prompt,
                sessionId: schedule.sessionId,
                kind: schedule.kind,
                trigger:
                  schedule.trigger.type === "cron"
                    ? { ...schedule.trigger, expression, timezone: zone }
                    : { ...schedule.trigger, at: new Date(`${at}Z`).getTime() },
                maxLatenessMs: schedule.maxLatenessMs,
              };
              void request("POST", {
                id: schedule.id,
                revision: schedule.revision,
                draft,
              });
            }}
          >
            <Input
              aria-label="Schedule name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
            />
            <Textarea
              aria-label="Exact scheduled prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={4}
              maxLength={20000}
            />
            {schedule.trigger.type === "cron" && (
              <Input
                aria-label="Cron expression"
                value={expression}
                onChange={(event) => setExpression(event.target.value)}
              />
            )}
            {schedule.trigger.type === "once" ? (
              <label
                htmlFor={`schedule-time-${schedule.id}`}
                className="grid gap-1"
              >
                One-time date (UTC)
                <Input
                  id={`schedule-time-${schedule.id}`}
                  type="datetime-local"
                  required
                  value={at}
                  onChange={(event) => setAt(event.target.value)}
                />
              </label>
            ) : (
              <Input
                aria-label="IANA timezone"
                required
                value={zone}
                onChange={(event) => setZone(event.target.value)}
              />
            )}
            <div className="flex gap-2">
              <Button size="sm" disabled={busy}>
                Save review draft
              </Button>
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            <p className="whitespace-pre-wrap rounded-md bg-muted p-3">
              {schedule.prompt}
            </p>
            <p className="text-muted-foreground">
              {schedule.kind === "reminder"
                ? "Reminder · no agent needed"
                : "Agent task"}{" "}
              · {destination ?? "This conversation"}
            </p>
            <p className="font-mono text-xs">
              {schedule.trigger.type === "cron"
                ? `${schedule.trigger.expression} · ${timezone}`
                : `Once · ${format(schedule.trigger.at)} · ${timezone}`}
            </p>
            {schedule.lastRun && (
              <p className="text-xs text-muted-foreground">
                Last run · {format(schedule.lastRun.at)} ·{" "}
                {schedule.lastRun.outcome}
              </p>
            )}
            {schedule.status === "draft" && (
              <p className="text-warning">
                Review the exact prompt and times before activating. Changes
                remain inactive until approved.
              </p>
            )}
            {times.length > 0 && (
              <div className="text-xs text-muted-foreground">
                Upcoming: {times.map(format).join(" · ")}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {(schedule.status === "draft" ||
                schedule.status === "paused") && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void request("PATCH", {
                      id: schedule.id,
                      revision: schedule.revision,
                      action: "activate",
                    })
                  }
                >
                  {schedule.status === "draft"
                    ? "Approve and activate"
                    : "Resume"}
                </Button>
              )}
              {schedule.status === "active" && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void request("PATCH", {
                        id: schedule.id,
                        revision: schedule.revision,
                        action: "pause",
                      })
                    }
                  >
                    Pause
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void request("PATCH", {
                        id: schedule.id,
                        revision: schedule.revision,
                        action: "run",
                        occurrenceId: crypto.randomUUID(),
                      })
                    }
                  >
                    Run now
                  </Button>
                </>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setName(schedule.name);
                  setPrompt(schedule.prompt);
                  setEditing(true);
                }}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void request("PATCH", {
                    id: schedule.id,
                    revision: schedule.revision,
                    action: "delete",
                  })
                }
              >
                Delete
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void fetch(
                    `/api/schedules?id=${encodeURIComponent(schedule.id)}`,
                  )
                    .then(async (response) => {
                      const result = await response.json();
                      if (!response.ok) throw new Error(result.error);
                      setHistory(result.history);
                    })
                    .catch((error) => setError(error.message));
                }}
              >
                History
              </Button>
            </div>
          </>
        )}
        {history && (
          <ul className="grid gap-1 text-xs text-muted-foreground">
            {history.length ? (
              history.map((run) => (
                <li key={run.id}>
                  {format(run.firedAt)} · {run.outcome}
                </li>
              ))
            ) : (
              <li>No runs yet.</li>
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
