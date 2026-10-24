import { ChevronLeft, ChevronRight, Eye, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { BrowserStep } from "./browser-panel";

const statusLabel: Record<string, string> = {
  pending: "Waiting",
  running: "Running",
  completed: "Done",
  failed: "Failed",
  unknown_outcome: "Outcome unconfirmed",
};
const time = (value: number) =>
  new Date(value).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/**
 * The agent's browser actions for one turn: a scrollable strip of after-action
 * screenshots (the orange ring marks where it clicked) with a full-size viewer.
 */
export function BrowserSteps({
  steps,
  onWatch,
}: {
  steps: BrowserStep[];
  onWatch?: () => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const viewed = open === null ? null : steps[open];
  useEffect(() => {
    if (open === null) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
      if (event.key === "ArrowLeft")
        setOpen((value) => Math.max(0, (value ?? 0) - 1));
      if (event.key === "ArrowRight")
        setOpen((value) => Math.min(steps.length - 1, (value ?? 0) + 1));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, steps.length]);
  if (!steps.length) return null;
  const last = steps[steps.length - 1];
  return (
    <section
      aria-label="Browser activity"
      className="my-4 rounded-xl border bg-card"
    >
      <header className="flex items-center gap-2 border-b px-3 py-2 text-xs">
        <span className="font-medium">Browser activity</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {steps.length} step{steps.length === 1 ? "" : "s"} · last:{" "}
          {last.label}
        </span>
        {onWatch && (
          <Button size="sm" variant="outline" className="h-7" onClick={onWatch}>
            <Eye /> Watch live
          </Button>
        )}
      </header>
      <ol
        className="flex snap-x gap-3 overflow-x-auto p-3"
        aria-label="Browser steps, oldest first"
      >
        {steps.map((step, index) => (
          <li key={step.id} className="w-44 shrink-0 snap-start text-xs">
            <button
              type="button"
              className="block w-full overflow-hidden rounded-lg border bg-muted text-left"
              aria-label={`View step ${index + 1}: ${step.label}`}
              onClick={() => setOpen(index)}
            >
              {step.image ? (
                // biome-ignore lint/performance/noImgElement: inline data URL
                <img
                  src={`data:image/jpeg;base64,${step.image}`}
                  alt=""
                  className="aspect-[16/10] w-full object-cover"
                />
              ) : (
                <span className="flex aspect-[16/10] items-center justify-center p-2 text-center text-[11px] text-muted-foreground">
                  {step.login
                    ? "Sign-in page (private)"
                    : step.status === "pending" || step.status === "running"
                      ? "In progress…"
                      : "No preview"}
                </span>
              )}
            </button>
            <p className="mt-1.5 line-clamp-2 font-medium">
              {index + 1}. {step.label}
            </p>
            <p
              className={
                step.error || step.status === "failed"
                  ? "text-destructive"
                  : "text-muted-foreground"
              }
            >
              {step.login
                ? "Sign-in needed"
                : (statusLabel[step.status] ?? step.status)}{" "}
              · {time(step.createdAt)}
            </p>
          </li>
        ))}
      </ol>
      {viewed && open !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Step ${open + 1}: ${viewed.label}`}
          className="fixed inset-0 z-[60] flex flex-col bg-black/90 p-3 text-white sm:p-6"
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(null);
          }}
          onKeyDown={() => {}}
        >
          <div className="flex items-center gap-2 pb-3 text-sm">
            <span className="min-w-0 flex-1 truncate">
              {open + 1}/{steps.length} · {viewed.label}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Close"
              onClick={() => setOpen(null)}
            >
              <X />
            </Button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center">
            {viewed.image ? (
              // biome-ignore lint/performance/noImgElement: inline data URL
              <img
                src={`data:image/jpeg;base64,${viewed.image}`}
                alt={`After: ${viewed.label}`}
                className="max-h-full max-w-full rounded object-contain"
              />
            ) : (
              <p className="text-sm text-white/70">
                {viewed.login
                  ? "Sign-in pages are never captured. Open the live browser to sign in."
                  : "No screenshot for this step."}
              </p>
            )}
          </div>
          <div className="grid gap-1 pt-3 text-xs text-white/80">
            {viewed.target && <p className="break-all">{viewed.target}</p>}
            {viewed.error && <p className="text-red-300">{viewed.error}</p>}
          </div>
          <div className="flex justify-between pt-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={open === 0}
              onClick={() => setOpen(open - 1)}
            >
              <ChevronLeft /> Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={open === steps.length - 1}
              onClick={() => setOpen(open + 1)}
            >
              Next <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
