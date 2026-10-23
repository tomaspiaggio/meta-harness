"use client";
import { AlertDialog } from "radix-ui";
import { useState } from "react";
import { Button } from "@/components/ui/button";
export interface DeleteTarget {
  kind: "workspace" | "session";
  id: string;
  name: string;
  sessions?: number;
}
export function DeleteDialog({
  target,
  close,
  deleted,
}: {
  target: DeleteTarget | null;
  close: () => void;
  deleted: (target: DeleteTarget) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <AlertDialog.Root
      open={!!target}
      onOpenChange={(open) => {
        if (!open && !busy) {
          setError("");
          close();
        }
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 grid w-[calc(100%_-_2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border bg-background p-6 shadow-lg">
          <AlertDialog.Title className="text-lg font-semibold">
            Delete {target?.kind} “{target?.name}”?
          </AlertDialog.Title>
          <AlertDialog.Description className="text-sm text-muted-foreground">
            {target?.kind === "workspace"
              ? "This permanently deletes this workspace and all its sessions, including conversations, tasks, schedules, attachments and its managed browser identity."
              : "This permanently deletes this session, including its conversation, tasks, schedules and attachments."}{" "}
            Active work loses access and is stopped when its worker checks in.
            Already submitted external actions cannot be undone. Published
            shared decisions remain in Decisions. This cannot be undone.
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
              disabled={busy || !target}
              onClick={async () => {
                if (!target || busy) return;
                setBusy(true);
                setError("");
                try {
                  const response = await fetch(
                    `/api/${target.kind === "workspace" ? "workspaces" : "sessions"}`,
                    {
                      method: "DELETE",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ id: target.id, confirm: true }),
                    },
                  );
                  const result = await response.json();
                  if (!response.ok)
                    throw new Error(result.error ?? "Deletion failed.");
                  deleted(target);
                  close();
                } catch (reason) {
                  setError(
                    reason instanceof Error
                      ? reason.message
                      : "Deletion failed.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Deleting…" : `Delete ${target?.kind ?? "session"}`}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
