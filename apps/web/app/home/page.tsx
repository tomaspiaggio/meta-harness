"use client";
import type { Brief, BriefSummary } from "@harness/core/briefs";
import { ArrowLeft, ArrowRight, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  conversationHref,
  ErrorNote,
  Meta,
  PageHeading,
  Shell,
} from "../shell";
import { BriefView } from "./brief-view";

interface Overview {
  days: { day: string; count: number }[];
  briefs: BriefSummary[];
  workspaces: { id: string; name: string }[];
  yesterday: string;
  nextRunHour: number;
  run: {
    day: string;
    status: string;
    turnId: string | null;
    turnStatus: string | null;
  } | null;
}
export default function Page() {
  return (
    <Shell>
      <Suspense fallback={null}>
        <Home />
      </Suspense>
    </Shell>
  );
}
/** "Mon, Oct 26" for a YYYY-MM-DD day, without shifting it across zones. */
function dayLabel(day: string, style: "long" | "short" = "long") {
  const date = new Date(`${day}T12:00:00Z`);
  return date.toLocaleDateString(undefined, {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(style === "long" ? {} : { weekday: undefined }),
  });
}
function Home() {
  const params = useSearchParams();
  const router = useRouter();
  const day = params.get("day");
  const briefId = params.get("brief");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch(`/api/briefs${day ? `?day=${day}` : ""}`);
    if (response.status === 401) return location.assign("/login");
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Briefs are unavailable.");
    setOverview(body);
  }, [day]);
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
  const go = (query: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(query))
      if (value) next.set(key, value);
      else next.delete(key);
    router.push(`/home${next.size ? `?${next}` : ""}`);
  };
  // Asking by hand always writes, even over a day already briefed or skipped.
  const write = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/briefs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          day: day ?? overview?.yesterday,
          rewrite: true,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not start it.");
      if (body.status === "no-activity")
        setError(
          "Nothing was completed that day, so there is nothing to brief.",
        );
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (briefId)
    return (
      <Reader
        id={briefId}
        overview={overview}
        back={() => go({ brief: null })}
      />
    );
  const names = new Map(
    overview?.workspaces.map((item) => [item.id, item.name]),
  );
  const writing =
    overview?.run?.turnStatus &&
    ["pending", "queued", "running"].includes(overview.run.turnStatus);
  const shownDay = day ?? overview?.yesterday;
  return (
    <section className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <PageHeading
        eyebrow={day ? "Daily brief" : "Latest from each workspace"}
        title={day ? dayLabel(day) : "Home"}
      >
        {overview && shownDay && (
          <Button
            variant="outline"
            disabled={busy || !!writing}
            onClick={() => void write()}
          >
            <Sparkles />
            {writing
              ? "Writing…"
              : overview.briefs.some((brief) => brief.day === shownDay)
                ? `Rewrite ${dayLabel(shownDay, "short")}`
                : `Write ${dayLabel(shownDay, "short")} now`}
          </Button>
        )}
      </PageHeading>
      {overview && (
        <nav
          aria-label="Days"
          className="-mx-4 mb-6 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0"
        >
          <DayChip active={!day} onClick={() => go({ day: null })}>
            Latest
          </DayChip>
          {overview.days.map((item) => (
            <DayChip
              key={item.day}
              active={day === item.day}
              onClick={() => go({ day: item.day })}
            >
              {dayLabel(item.day)}
            </DayChip>
          ))}
        </nav>
      )}
      {writing && overview?.run && (
        <p className="mb-5 flex items-center gap-2 rounded-lg bg-live-soft px-3.5 py-2.5 text-sm">
          <span className="size-2 animate-pulse rounded-full bg-primary" />
          Writing the brief for {dayLabel(overview.run.day)}.
          <Link className="ml-auto underline" href={conversationHref("briefs")}>
            Watch it
          </Link>
        </p>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      {overview && !overview.briefs.length && (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <p className="font-serif text-2xl">
            No briefs {day ? "for this day" : "yet"}
          </p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Every morning after {overview.nextRunHour}:00 an agent writes a
            short, visual brief of the previous day for each workspace that had
            work. Days without work are skipped.
          </p>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {overview?.briefs.map((brief) => (
          <Card
            key={brief.id}
            className="group cursor-pointer gap-4 py-5 transition-shadow hover:shadow-md"
            onClick={() => go({ brief: brief.id })}
          >
            <CardHeader className="gap-1.5 px-6">
              <Meta
                items={[
                  names.get(brief.workspaceId) ?? "Removed workspace",
                  !day && dayLabel(brief.day),
                ].filter(Boolean)}
              />
              <h2 className="font-serif text-2xl leading-tight tracking-tight">
                {brief.title}
              </h2>
            </CardHeader>
            <CardContent className="px-6">
              <ul className="grid gap-2">
                {brief.highlights.map((highlight) => (
                  <li
                    key={highlight}
                    className="flex gap-2.5 text-sm leading-snug"
                  >
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                    {highlight}
                  </li>
                ))}
              </ul>
            </CardContent>
            <CardFooter className="mt-auto px-6">
              <span className="flex items-center gap-1.5 text-sm font-medium text-primary">
                Read the brief
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </CardFooter>
          </Card>
        ))}
      </div>
    </section>
  );
}
function DayChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "shrink-0 rounded-full border px-3.5 py-1.5 text-sm whitespace-nowrap transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
function Reader({
  id,
  overview,
  back,
}: {
  id: string;
  overview: Overview | null;
  back: () => void;
}) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setBrief(null);
    void fetch(`/api/briefs?id=${encodeURIComponent(id)}`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Brief unavailable.");
        setBrief(body);
      })
      .catch((reason: Error) => setError(reason.message));
  }, [id]);
  const name = overview?.workspaces.find(
    (item) => item.id === brief?.workspaceId,
  )?.name;
  return (
    <section className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <Button variant="ghost" size="sm" className="-ml-2 mb-4" onClick={back}>
        <ArrowLeft />
        All briefs
      </Button>
      {error && <ErrorNote>{error}</ErrorNote>}
      {brief && (
        <>
          <Meta
            className="mb-6"
            items={[
              name ?? "Removed workspace",
              dayLabel(brief.day),
              name && (
                <Link
                  key="open"
                  className="underline"
                  href={conversationHref(brief.workspaceId)}
                >
                  Open workspace
                </Link>
              ),
            ].filter(Boolean)}
          />
          <Card className="px-5 py-8 sm:px-10">
            <BriefView html={brief.html} />
          </Card>
        </>
      )}
    </section>
  );
}
