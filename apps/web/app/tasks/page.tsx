"use client";
import type { Provider, Workspace } from "@harness/core";
import type {
  ResourceProfile,
  Task,
  WorkerRecord,
} from "@harness/core/scheduling";
import { Pause, Play, Plus, Square, X } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  conversationHref,
  ErrorNote,
  Meta,
  PageHeading,
  Shell,
  StatusBadge,
  timeAgo,
  useTree,
} from "../shell";

type TaskView = Task & {
  status: string;
  provider: Provider;
  turnId: string;
  workerId: string | null;
  waitingReason: string | null;
};
type Board = {
  tasks: TaskView[];
  workers: WorkerRecord[];
  workspaces: Workspace[];
};
const filters = {
  all: { label: "All", statuses: null },
  active: {
    label: "Active",
    statuses: ["pending", "queued", "running", "paused", "stopping"],
  },
  done: { label: "Finished", statuses: ["completed", "failed", "interrupted"] },
} satisfies Record<
  string,
  {
    label: string;
    statuses: string[] | null;
  }
>;
type Filter = keyof typeof filters;
const matches = (filter: Filter, status: string) =>
  filters[filter].statuses?.includes(status) ?? true;
const priorityLabel: Record<number, string> = { [-10]: "Low", 10: "High" };
const AUTOMATIC = "automatic";
export default function Page() {
  return (
    <Shell>
      <Suspense fallback={null}>
        <Tasks />
      </Suspense>
    </Shell>
  );
}
function Tasks() {
  const { tree } = useTree();
  const params = useSearchParams();
  const requested = params.get("filter");
  const filter: Filter =
    requested && requested in filters ? (requested as Filter) : "all";
  const [board, setBoard] = useState<Board>({
    tasks: [],
    workers: [],
    workspaces: [],
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("tech");
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [provider, setProvider] = useState<Provider>("claude");
  useEffect(() => {
    if (!composing && tree.defaults) setProvider(tree.defaults.provider);
  }, [tree.defaults, composing]);
  const [profile, setProfile] = useState<ResourceProfile>("standard");
  const [priority, setPriority] = useState(0);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const pending = useRef<{
    id: string;
    fingerprint: string;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let loading = false;
    const load = async () => {
      if (loading || controller.signal.aborted) return;
      clearTimeout(timer);
      if (document.hidden) {
        timer = setTimeout(load, 10000);
        return;
      }
      loading = true;
      try {
        const response = await fetch("/api/tasks", {
          signal: controller.signal,
        });
        if (response.status === 401) {
          location.assign("/login");
          return;
        }
        if (!response.ok) throw new Error("Cannot load the task board.");
        setBoard(await response.json());
      } catch (error) {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : "Connection lost.");
      } finally {
        loading = false;
        if (!controller.signal.aborted) timer = setTimeout(load, 2000);
      }
    };
    refresh.current = load;
    void load();
    document.addEventListener("visibilitychange", load);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);
  async function mutate(method: string, body: unknown) {
    setError("");
    const response = await fetch("/api/tasks", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status === 401) {
      location.assign("/login");
      throw new Error("Sign in to continue.");
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Request failed.");
    await refresh.current();
  }
  const update = (body: unknown) =>
    void mutate("PATCH", body).catch((error) => setError(error.message));
  const workspaceName = (id: string) =>
    board.workspaces.find((workspace) => workspace.id === id)?.name ?? id;
  const visible = board.tasks.filter((task) => matches(filter, task.status));
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-10 px-6 py-8 lg:grid-cols-[minmax(0,1fr)_300px]">
      <section className="min-w-0">
        <PageHeading eyebrow="Backlog" title="Tasks">
          <Button
            variant={composing ? "outline" : "default"}
            aria-expanded={composing}
            onClick={() => setComposing(!composing)}
          >
            {composing ? <X /> : <Plus />}
            {composing ? "Close" : "New task"}
          </Button>
        </PageHeading>
        {error && <ErrorNote>{error}</ErrorNote>}
        {composing && (
          <Card className="animate-in fade-in slide-in-from-top-1 mb-6 gap-4 py-5">
            <form
              className="contents"
              onSubmit={async (event) => {
                event.preventDefault();
                setBusy(true);
                const body = {
                  workspaceId,
                  title,
                  objective,
                  provider,
                  profile,
                  priority,
                };
                const fingerprint = JSON.stringify(body);
                if (pending.current?.fingerprint !== fingerprint)
                  pending.current = { id: crypto.randomUUID(), fingerprint };
                try {
                  await mutate("POST", { ...body, id: pending.current.id });
                  setTitle("");
                  setObjective("");
                  setComposing(false);
                  pending.current = null;
                } catch (error) {
                  setError(
                    error instanceof Error
                      ? error.message
                      : "Cannot create task.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              <CardContent className="grid gap-3">
                <Input
                  aria-label="Task title"
                  placeholder="What needs doing?"
                  required
                  maxLength={100}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  className="h-auto border-0 px-0 text-lg font-medium shadow-none focus-visible:ring-0"
                />
                <Textarea
                  aria-label="Task objective"
                  placeholder="Describe the outcome and what would count as done…"
                  required
                  maxLength={20000}
                  rows={4}
                  value={objective}
                  onChange={(event) => setObjective(event.target.value)}
                />
              </CardContent>
              <CardFooter className="flex-wrap items-end gap-3 border-t pt-4">
                <Field label="Workspace">
                  <Select value={workspaceId} onValueChange={setWorkspaceId}>
                    <SelectTrigger size="sm" className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {board.workspaces.map((workspace) => (
                        <SelectItem key={workspace.id} value={workspace.id}>
                          {workspace.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Agent">
                  <Select
                    value={provider}
                    onValueChange={(value) => setProvider(value as Provider)}
                  >
                    <SelectTrigger size="sm" className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="claude">Claude</SelectItem>
                      <SelectItem value="codex">Codex</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Resources">
                  <Select
                    value={profile}
                    onValueChange={(value) =>
                      setProfile(value as ResourceProfile)
                    }
                  >
                    <SelectTrigger size="sm" className="w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="standard">
                        Standard · 512 MiB
                      </SelectItem>
                      <SelectItem value="build">Build · 2 GiB</SelectItem>
                      <SelectItem value="browser">Browser · 1 GiB</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Priority">
                  <Select
                    value={String(priority)}
                    onValueChange={(value) => setPriority(Number(value))}
                  >
                    <SelectTrigger size="sm" className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="-10">Low</SelectItem>
                      <SelectItem value="0">Normal</SelectItem>
                      <SelectItem value="10">High</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Button type="submit" className="ml-auto" disabled={busy}>
                  {busy ? "Adding…" : "Add task"}
                </Button>
                <p className="w-full text-xs text-muted-foreground">
                  Resource profiles reserve scheduling capacity. A browser
                  profile does not yet provision a browser.
                </p>
              </CardFooter>
            </form>
          </Card>
        )}

        <Tabs value={filter}>
          <TabsList variant="line" className="w-full justify-start border-b">
            {(Object.keys(filters) as Filter[]).map((key) => (
              <TabsTrigger key={key} value={key} asChild className="flex-none">
                <Link
                  href={key === "all" ? "/tasks" : `/tasks?filter=${key}`}
                  replace
                >
                  {filters[key].label}
                  <Badge
                    variant="secondary"
                    className="h-5 min-w-5 rounded-full px-1.5 font-mono text-[11px] font-normal"
                  >
                    {
                      board.tasks.filter((task) => matches(key, task.status))
                        .length
                    }
                  </Badge>
                </Link>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="mt-2 flex flex-col">
          {visible.length === 0 && (
            <p className="mt-4 rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
              {board.tasks.length
                ? "Nothing here."
                : "No tasks yet. Conversations appear here after their first instruction."}
            </p>
          )}
          {visible.map((task) => (
            <article
              key={task.id}
              className="group flex flex-col gap-3 border-b py-4 sm:flex-row sm:items-start sm:gap-6"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3">
                  <Link
                    href={conversationHref(task.workspaceId, task.sessionId)}
                    className="truncate font-semibold hover:text-primary"
                  >
                    {task.title}
                  </Link>
                  <StatusBadge status={task.status} />
                </div>
                <p className="mt-1 mb-2 line-clamp-2 text-sm whitespace-pre-wrap break-words text-muted-foreground">
                  {task.objective}
                </p>
                <Meta
                  items={[
                    workspaceName(task.workspaceId),
                    task.provider,
                    task.profile,
                    priorityLabel[task.priority] && (
                      <span className={task.priority > 0 ? "text-primary" : ""}>
                        {priorityLabel[task.priority]} priority
                      </span>
                    ),
                    <span
                      key="created"
                      title={new Date(task.createdAt).toLocaleString()}
                    >
                      {timeAgo(task.createdAt)}
                    </span>,
                  ]}
                />
                {task.waitingReason && (
                  <div className="mt-2.5 rounded-md bg-warning-soft px-2.5 py-1.5 text-xs text-warning">
                    {task.waitingReason}
                  </div>
                )}
              </div>
              {!matches("done", task.status) && (
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={task.status === "stopping"}
                    onClick={() => {
                      void (async () => {
                        const response = await fetch("/api/turns", {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ id: task.turnId }),
                        });
                        const result = await response.json();
                        if (!response.ok)
                          throw new Error(
                            result.error ?? "Could not stop task.",
                          );
                        await refresh.current();
                      })().catch((error) => setError(error.message));
                    }}
                  >
                    <Square />
                    {task.status === "stopping" ? "Stopping…" : "Stop turn"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      update({ id: task.id, paused: !task.paused })
                    }
                  >
                    {task.paused ? <Play /> : <Pause />}
                    {task.paused ? "Resume" : "Pause"}
                  </Button>
                  <Select
                    value={task.targetWorkerId ?? AUTOMATIC}
                    onValueChange={(value) =>
                      update({
                        id: task.id,
                        targetWorkerId: value === AUTOMATIC ? null : value,
                      })
                    }
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-36"
                      aria-label={`Worker for ${task.title}`}
                      title="Next eligible worker"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={AUTOMATIC}>Any worker</SelectItem>
                      {board.workers.map((worker) => (
                        <SelectItem key={worker.id} value={worker.id}>
                          {worker.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>

      <aside className="lg:sticky lg:top-8 lg:self-start">
        <div className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          Capacity
        </div>
        <h2 className="mt-1 font-serif text-2xl">Workers</h2>
        <p className="mt-1 mb-4 text-sm text-muted-foreground">
          Draining lets active work finish and sends new work elsewhere.
        </p>
        {!board.workers.length && (
          <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
            Start a worker to pick up queued tasks.
          </p>
        )}
        <div className="grid gap-3">
          {board.workers.map((worker) => {
            const online =
              worker.seenAt !== null && Date.now() - worker.seenAt < 30000;
            const status = !online
              ? "offline"
              : worker.draining || worker.report?.draining
                ? "draining"
                : "online";
            return (
              <Card key={worker.id} className="gap-3 py-4">
                <CardHeader className="flex items-center justify-between px-4">
                  <CardTitle className="text-sm">{worker.name}</CardTitle>
                  <StatusBadge status={status} />
                </CardHeader>
                {worker.report && (
                  <CardContent className="px-4">
                    <Meta
                      items={[worker.report.hostname, ...worker.report.labels]}
                    />
                    <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 border-t pt-3 text-xs">
                      <Stat
                        label="Agent slots"
                        value={worker.report.maxAgents}
                      />
                      <Stat
                        label="Memory budget"
                        value={`${worker.report.memoryBudgetMiB} MiB`}
                      />
                      <Stat
                        label="Host free / reserve"
                        value={`${worker.report.availableMemoryMiB} / ${worker.report.reserveMemoryMiB} MiB`}
                      />
                      <Stat label="CPU slots" value={worker.report.cpuSlots} />
                      <Stat
                        label="Agents"
                        value={worker.report.providers.join(", ")}
                      />
                    </dl>
                  </CardContent>
                )}
                <CardFooter className="px-4">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      update({
                        kind: "worker",
                        id: worker.id,
                        draining: !worker.draining,
                      })
                    }
                  >
                    {worker.draining ? "Accept new work" : "Drain worker"}
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <span className="font-mono text-[10.5px] font-normal uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}
function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-mono">{value}</dd>
    </>
  );
}
