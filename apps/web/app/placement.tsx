import { X } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";

export type Placement = {
  labels: string[];
  available: string[];
  machines: { name: string; online: boolean; labels: string[] }[];
};

/** Labels typed or picked by the owner, with removable chips. */
export function LabelEditor({
  labels,
  suggestions,
  disabled,
  label,
  onChange,
}: {
  labels: string[];
  suggestions: string[];
  disabled?: boolean;
  label: string;
  onChange: (labels: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const listId = `labels-${label.replace(/\W+/g, "-").toLowerCase()}`;
  const add = () => {
    const words = draft
      .toLowerCase()
      .split(/[\s,]+/)
      .filter((word) => word && !labels.includes(word));
    setDraft("");
    if (words.length) onChange([...labels, ...words]);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {labels.map((item) => (
        <span
          key={item}
          className="inline-flex items-center gap-1 rounded-md border bg-muted px-2 py-0.5 font-mono text-xs"
        >
          {item}
          <button
            type="button"
            disabled={disabled}
            aria-label={`Remove ${item}`}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onChange(labels.filter((value) => value !== item))}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <Input
        aria-label={label}
        list={listId}
        placeholder={labels.length ? "Add another" : "Add a label"}
        value={draft}
        disabled={disabled}
        maxLength={80}
        className="h-7 w-36 text-xs"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={add}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            add();
          }
        }}
      />
      <datalist id={listId}>
        {suggestions
          .filter((item) => !labels.includes(item))
          .map((item) => (
            <option key={item} value={item} />
          ))}
      </datalist>
    </div>
  );
}

/**
 * Advanced: which machines may run this conversation. Without labels any
 * machine that has the agent picks it up, preferring the one that ran it last.
 */
export function PlacementPanel({
  placement,
  labels,
  provider,
  disabled,
  onChange,
  workspace,
  onFolder,
  sandboxed,
  onSandboxed,
}: {
  placement: Placement | null | undefined;
  labels: string[];
  provider: string;
  disabled?: boolean;
  onChange: (labels: string[]) => void;
  workspace?: { name: string; folder?: string | null };
  onFolder: (folder: string) => void;
  sandboxed: boolean;
  onSandboxed: (sandboxed: boolean) => void;
}) {
  const agent = provider === "codex" ? "Codex" : "Claude";
  const fits = (placement?.machines ?? []).filter((machine) =>
    [provider, ...labels].every((item) => machine.labels.includes(item)),
  );
  const names = fits
    .map((machine) => `${machine.name}${machine.online ? "" : " (offline)"}`)
    .join(", ");
  return (
    <div className="mt-3 grid gap-2 rounded-lg border bg-background/40 p-3 text-xs">
      <p className="font-medium text-foreground">Where it runs</p>
      <LabelEditor
        label="Required machine labels"
        labels={labels}
        suggestions={placement?.available ?? []}
        disabled={disabled}
        onChange={onChange}
      />
      <p className="text-muted-foreground">
        {labels.length
          ? fits.length
            ? `Only machines with ${labels.join(" and ")} that run ${agent} take it: ${names}. Messages wait while none of them is online.`
            : `No machine that runs ${agent} has ${labels.join(" and ")} yet, so messages wait. Add the label to a machine in Settings → Machines.`
          : `No labels: any online machine that runs ${agent} picks it up${fits.length ? ` (${names})` : ""}. It prefers the machine that ran it last and moves on when that one is off or busy.`}
      </p>
      <div className="mt-1 grid gap-1">
        <label
          htmlFor="workspace-folder"
          className="font-medium text-foreground"
        >
          Working folder for every session in{" "}
          {workspace?.name ?? "this workspace"}
        </label>
        <Input
          id="workspace-folder"
          key={workspace?.folder ?? ""}
          defaultValue={workspace?.folder ?? ""}
          placeholder="e.g. ~/Documents/Projects/litho"
          disabled={disabled}
          maxLength={500}
          className="h-7 text-xs"
          onBlur={(event) => {
            const value = event.currentTarget.value.trim();
            if (value !== (workspace?.folder ?? "")) onFolder(value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <span className="text-muted-foreground">
          Agents work there on machines that have it and follow its
          CLAUDE.md/AGENTS.md. Require a label so the session only runs where
          the folder exists. Empty: each session gets a private folder.
        </span>
      </div>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={sandboxed}
          disabled={disabled}
          onChange={(event) => onSandboxed(event.target.checked)}
        />
        <span>
          <span className="font-medium text-foreground">Sandboxed</span>
          <span className="text-muted-foreground">
            {" "}
            — restrict this session's agent to its private folder. Off (the
            default): full permissions, like running Claude Code with
            --dangerously-skip-permissions.
          </span>
        </span>
      </label>
    </div>
  );
}
