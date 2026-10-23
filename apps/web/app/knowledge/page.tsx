"use client";
import type { Decision, DecisionSnapshot } from "@harness/core/knowledge";
import Link from "next/link";
import { AlertDialog } from "radix-ui";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { MarkdownMessage } from "../markdown";
import {
  conversationHref,
  ErrorNote,
  Meta,
  PageHeading,
  Shell,
  timeAgo,
  useTree,
} from "../shell";
export default function Page() {
  return (
    <Shell>
      <Knowledge />
    </Shell>
  );
}
function Knowledge() {
  const { tree } = useTree();
  const [snapshot, setSnapshot] = useState<DecisionSnapshot>({
    revision: 0,
    decisions: [],
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [withdrawn, setWithdrawn] = useState(false);
  const [editing, setEditing] = useState<{
    decision: Decision;
    content: string;
  } | null>(null);
  const [deleting, setDeleting] = useState<Decision | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let loading = false;
    const load = async () => {
      if (loading || controller.signal.aborted) return;
      clearTimeout(timer);
      loading = true;
      try {
        if (document.hidden) return;
        const response = await fetch("/api/decisions", {
          signal: controller.signal,
        });
        if (response.status === 401) {
          location.assign("/login");
          return;
        }
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error ?? "Cannot load shared decisions.");
        setSnapshot((previous) =>
          data.revision >= previous.revision ? data : previous,
        );
      } catch (reason) {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error ? reason.message : "Connection lost.",
          );
      } finally {
        loading = false;
        if (!controller.signal.aborted) timer = setTimeout(load, 5000);
      }
    };
    void load();
    document.addEventListener("visibilitychange", load);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);
  async function save(decision: Decision, content: string | null) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/decisions", {
        method: content === null ? "DELETE" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: decision.key,
          expectedRevision: decision.revision,
          content,
          ...(content === null ? { confirm: true } : {}),
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error ?? "Decision update failed.");
      setSnapshot(result);
      setEditing(null);
      setDeleting(null);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Decision update failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  const visible = snapshot.decisions.filter(
    (decision) => withdrawn || decision.content !== null,
  );
  const workspaceName = (id: string) =>
    tree.workspaces.find((item) => item.id === id)?.name ?? id;
  return (
    <section className="mx-auto w-full max-w-3xl px-6 py-8">
      <PageHeading eyebrow="Shared across every workspace" title="Decisions">
        <Badge variant="outline" className="font-mono font-normal">
          snapshot r{snapshot.revision}
        </Badge>
      </PageHeading>
      <p className="-mt-3 mb-4 text-muted-foreground">
        These records are supplied automatically to every workspace before each
        turn. Edits create new revisions. Deleting withdraws a decision and
        preserves its history.
      </p>
      <label className="mb-5 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={withdrawn}
          onChange={(event) => setWithdrawn(event.target.checked)}
        />
        Show withdrawn decisions
      </label>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!visible.length && (
        <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
          No shared decisions published yet.
        </p>
      )}
      <div className="grid gap-3">
        {visible.map((decision) => (
          <Card key={decision.key} className="gap-3 py-4">
            <CardHeader className="flex flex-wrap items-center justify-between gap-3 px-5">
              <code className="break-all font-mono text-sm font-medium">
                {decision.key}
              </code>
              <div className="flex items-center gap-2">
                <Badge variant="outline">r{decision.revision}</Badge>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  aria-label={`Edit ${decision.key}`}
                  onClick={() => {
                    setEditing({ decision, content: decision.content ?? "" });
                    setError("");
                  }}
                >
                  {decision.content === null ? "Restore" : "Edit"}
                </Button>
                {decision.content !== null && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    aria-label={`Delete ${decision.key}`}
                    onClick={() => {
                      setDeleting(decision);
                      setError("");
                    }}
                  >
                    Delete
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="px-5">
              {editing?.decision.key === decision.key ? (
                <div className="grid gap-3">
                  <label className="grid gap-2 text-sm">
                    Decision content
                    <textarea
                      aria-label="Decision content"
                      className="min-h-36 w-full rounded border bg-background p-3"
                      maxLength={4000}
                      value={editing.content}
                      onChange={(event) =>
                        setEditing({ ...editing, content: event.target.value })
                      }
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Editing revision {editing.decision.revision}. If another
                    session changes it, saving will require reviewing the latest
                    revision.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      disabled={busy || !editing.content.trim()}
                      onClick={() =>
                        void save(editing.decision, editing.content.trim())
                      }
                    >
                      Save decision
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <MarkdownMessage>
                  {decision.content ?? "This decision has been withdrawn."}
                </MarkdownMessage>
              )}
            </CardContent>
            <CardFooter className="border-t px-5 pt-3">
              <Meta
                items={[
                  workspaceName(decision.workspaceId),
                  <span
                    key="updated"
                    title={new Date(decision.updatedAt).toLocaleString()}
                  >
                    {timeAgo(decision.updatedAt)}
                  </span>,
                  decision.sessionId && (
                    <Link
                      key="source"
                      href={conversationHref(
                        decision.workspaceId,
                        decision.sessionId,
                      )}
                      className="text-foreground/70 hover:text-primary"
                    >
                      Source conversation →
                    </Link>
                  ),
                ]}
              />
            </CardFooter>
          </Card>
        ))}
      </div>
      <AlertDialog.Root
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 grid w-[calc(100%_-_2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border bg-background p-6 shadow-lg">
            <AlertDialog.Title className="text-lg font-semibold">
              Delete decision “{deleting?.key}”?
            </AlertDialog.Title>
            <AlertDialog.Description className="text-sm text-muted-foreground">
              This withdraws it from active shared knowledge. Earlier revisions
              remain stored, and you can restore it using Show withdrawn
              decisions.
            </AlertDialog.Description>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button variant="outline" disabled={busy}>
                  Cancel
                </Button>
              </AlertDialog.Cancel>
              <Button
                variant="destructive"
                disabled={busy || !deleting}
                onClick={() => {
                  if (deleting) void save(deleting, null);
                }}
              >
                Delete decision
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );
}
