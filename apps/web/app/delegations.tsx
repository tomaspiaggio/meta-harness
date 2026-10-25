"use client";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MarkdownMessage } from "./markdown";
import { conversationHref, ErrorNote, StatusBadge, timeAgo } from "./shell";

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
  return (
    <section className="my-6 rounded-lg border">
      <h2 className="border-b px-4 py-2.5 text-sm font-medium">Tasks</h2>
      <ul className="divide-y">
        {delegations.map((item) => {
          const given = item.from.id === sessionId;
          const expanded = open === item.id;
          const live = !["accepted", "cancelled"].includes(item.state);
          return (
            <li key={item.id} className="px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <StatusBadge status={item.state} />
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
                {item.rounds > 1 ? ` · round ${item.rounds}` : ""} · updated{" "}
                {timeAgo(item.updatedAt)}
              </p>
              {expanded && (
                <div className="mt-3 grid gap-3">
                  {item.progress && (
                    <div>
                      <p className="mb-1 text-xs font-medium text-muted-foreground">
                        Latest progress
                        {item.progressAt
                          ? ` · ${timeAgo(item.progressAt)}`
                          : ""}
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
                      No progress reported yet. Open{" "}
                      <SessionLink session={item.to} /> to watch it work.
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
        })}
      </ul>
      {error && (
        <div className="px-4 pb-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </section>
  );
}
