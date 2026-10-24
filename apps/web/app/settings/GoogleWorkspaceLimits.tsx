"use client";
import type { WorkspaceIntegrationBinding } from "@harness/core/integrations";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
export function GoogleWorkspaceLimits({
  connectionId,
}: {
  connectionId: string;
}) {
  const [bindings, setBindings] = useState<WorkspaceIntegrationBinding[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch("/api/integrations");
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    setBindings(
      value.bindings.filter(
        (binding: WorkspaceIntegrationBinding) =>
          binding.connectionId === connectionId,
      ),
    );
    setNames(
      Object.fromEntries(
        value.workspaces.map((workspace: { id: string; name: string }) => [
          workspace.id,
          workspace.name,
        ]),
      ),
    );
  }, [connectionId]);
  useEffect(() => {
    const refresh = () => {
      void load().catch((e) => setError(e.message));
    };
    refresh();
    window.addEventListener("integrations-changed", refresh);
    return () => window.removeEventListener("integrations-changed", refresh);
  }, [load]);
  const values = (input: unknown) =>
    Array.isArray(input) ? input.join(", ") : "";
  return (
    <details>
      <summary>Workspace file, label, calendar and range limits</summary>
      <p>
        Save workspace tools below first. Empty limit fields allow all resources
        in that read group within Google consent. Explicit file IDs apply to
        Drive, Docs and Sheets. Folder grants are unavailable.
      </p>
      {bindings.map((binding) => (
        <form
          key={binding.revision}
          className="space-y-2 border p-2"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const constraints: Record<string, unknown> = {};
            for (const key of ["fileIds", "gmailLabelIds", "calendarIds"]) {
              const items = String(data.get(key) ?? "")
                .split(/[\n,]/)
                .map((value) => value.trim())
                .filter(Boolean);
              if (items.length) constraints[key] = items;
            }
            const ranges: Record<string, string[]> = {};
            try {
              for (const line of String(data.get("sheetRanges") ?? "")
                .split("\n")
                .filter((value) => value.trim())) {
                const separator = line.indexOf("|");
                if (separator < 1)
                  throw new Error(
                    "Enter each Sheets grant as spreadsheet ID | 'Tab'!A1:D20.",
                  );
                const id = line.slice(0, separator).trim();
                const range = line.slice(separator + 1).trim();
                ranges[id] ??= [];
                ranges[id].push(range);
              }
              if (Object.keys(ranges).length) constraints.sheetRanges = ranges;
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              return;
            }
            setBusy(true);
            setError("");
            void fetch("/api/integrations/google/binding", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                connectionId,
                workspaceId: binding.workspaceId,
                expectedRevision: binding.revision,
                constraints,
              }),
            })
              .then(async (response) => {
                const value = await response.json();
                if (!response.ok) throw new Error(value.error);
                window.dispatchEvent(new Event("integrations-changed"));
              })
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          <strong>{names[binding.workspaceId] ?? binding.workspaceId}</strong>
          <label className="block">
            Allowed file IDs{" "}
            <textarea
              className="block w-full rounded border p-1"
              name="fileIds"
              defaultValue={values(binding.constraints.fileIds)}
              placeholder="Comma-separated Drive / Docs / Sheets IDs"
            />
          </label>
          <label className="block">
            Allowed Gmail label IDs{" "}
            <input
              className="block w-full rounded border p-1"
              name="gmailLabelIds"
              defaultValue={values(binding.constraints.gmailLabelIds)}
              placeholder="INBOX, Label_123"
            />
          </label>
          <label className="block">
            Allowed calendar IDs{" "}
            <input
              className="block w-full rounded border p-1"
              name="calendarIds"
              defaultValue={values(binding.constraints.calendarIds)}
              placeholder="primary, calendar@example.com"
            />
          </label>
          <label className="block">
            Allowed Sheets ranges, one per line{" "}
            <textarea
              className="block w-full rounded border p-1"
              name="sheetRanges"
              defaultValue={Object.entries(
                binding.constraints.sheetRanges ?? {},
              )
                .flatMap(([id, ranges]) =>
                  Array.isArray(ranges)
                    ? ranges.map((range) => `${id} | ${range}`)
                    : [],
                )
                .join("\n")}
              placeholder="spreadsheet-id | 'Revenue'!A1:D20"
            />
          </label>
          <Button variant="outline" disabled={busy} type="submit">
            Save workspace read limits
          </Button>
        </form>
      ))}
      {!bindings.length && <p>No workspace grants yet.</p>}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
