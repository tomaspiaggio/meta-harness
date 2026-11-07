import { type RefObject, useEffect, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type IndexEntry = {
  id: string;
  /** Written by the owner, rather than sent by an agent or another session. */
  mine: boolean;
  label: string;
  text: string;
};

/**
 * One mark per message along the conversation's left edge. The owner's
 * messages are orange and those sent by agents grey, the one being read is
 * longest, hovering previews a message and clicking scrolls to it.
 */
export function MessageIndex({
  entries,
  scroller,
}: {
  entries: IndexEntry[];
  scroller: RefObject<HTMLDivElement | null>;
}) {
  const [current, setCurrent] = useState<string | null>(null);
  // Streaming output re-renders often; measure again only when messages change.
  const ids = entries.map((entry) => entry.id).join(" ");
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let frame = 0;
    // The message being read is the last one starting above a third of the view.
    const measure = () => {
      frame = 0;
      const line =
        element.getBoundingClientRect().top + element.clientHeight / 3;
      let found: string | null = null;
      for (const article of element.querySelectorAll<HTMLElement>(
        "[data-turn]",
      )) {
        if (article.getBoundingClientRect().top > line) break;
        found = article.dataset.turn ?? null;
      }
      setCurrent(found ?? ids.split(" ")[0] ?? null);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    element.addEventListener("scroll", schedule, { passive: true });
    return () => {
      element.removeEventListener("scroll", schedule);
      cancelAnimationFrame(frame);
    };
  }, [scroller, ids]);
  // Keep the current mark visible when the index itself has to scroll.
  useEffect(() => {
    if (current)
      document
        .querySelector(`[data-index-mark="${CSS.escape(current)}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [current]);
  if (entries.length < 2) return null;
  const jump = (id: string) => {
    const element = scroller.current;
    const article = element?.querySelector(`[data-turn="${CSS.escape(id)}"]`);
    if (!element || !article) return;
    element.scrollTo({
      top:
        element.scrollTop +
        article.getBoundingClientRect().top -
        element.getBoundingClientRect().top -
        16,
      behavior: "smooth",
    });
  };
  return (
    <nav
      aria-label="Messages"
      // Phones get a narrower strip inside the page margin; tapping jumps.
      className="absolute top-1/2 left-0 z-10 flex max-h-[80%] -translate-y-1/2 flex-col overflow-y-auto py-1 [scrollbar-width:none] lg:left-1"
    >
      {entries.map((entry) => {
        const active = entry.id === current;
        return (
          <Tooltip key={entry.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-index-mark={entry.id}
                aria-label={entry.label}
                aria-current={active ? "location" : undefined}
                onClick={() => jump(entry.id)}
                className="group flex h-3 w-5 shrink-0 items-center px-1 lg:w-10 lg:px-2"
              >
                <span
                  className={cn(
                    "h-1 rounded-full transition-all group-hover:w-6",
                    entry.mine ? "bg-primary" : "bg-muted-foreground/45",
                    active ? "w-3.5 lg:w-6" : "w-2 lg:w-3",
                  )}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-80 text-left">
              <div
                className={cn(
                  "mb-1 font-mono text-[10px] uppercase tracking-wider",
                  entry.mine ? "text-primary" : "opacity-70",
                )}
              >
                {entry.label}
              </div>
              <p className="line-clamp-4 whitespace-pre-wrap break-words">
                {entry.text}
              </p>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}
