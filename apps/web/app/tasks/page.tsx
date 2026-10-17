"use client";

import type { Provider, Workspace } from "@harness/core";
import type {
  ResourceProfile,
  Task,
  WorkerRecord,
} from "@harness/core/scheduling";
import { useEffect, useRef, useState } from "react";

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

export default function Tasks() {
  const [board, setBoard] = useState<Board>({
    tasks: [],
    workers: [],
    workspaces: [],
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("tech");
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [provider, setProvider] = useState<Provider>("demo");
  const [profile, setProfile] = useState<ResourceProfile>("standard");
  const [priority, setPriority] = useState(0);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const pending = useRef<{ id: string; fingerprint: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let loading = false;
    const load = async () => {
      if (loading || controller.signal.aborted) return;
      clearTimeout(timer);
      if (document.hidden) {
        timer = setTimeout(load, 10_000);
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

  return (
    <div className="task-app">
      <header>
        <a className="task-brand" href="/">
          m / meta harness
        </a>
        <span className="slash">/</span>
        <span>Tasks</span>
        <a className="back-link" href="/">
          Conversations ↗
        </a>
      </header>
      <div className="task-layout">
        <section className="task-backlog">
          <div className="eyebrow">KEEP WORK MOVING</div>
          <h1>Your work, in motion.</h1>
          <p className="muted">
            Tasks wait for the right capacity. Conversations and findings stay
            attached.
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <form
            className="task-create"
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
            <input
              aria-label="Task title"
              placeholder="What needs investigating?"
              required
              maxLength={100}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <textarea
              aria-label="Task objective"
              placeholder="Describe the outcome and what would count as done…"
              required
              maxLength={20000}
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
            />
            <div className="task-options">
              <label>
                Workspace
                <select
                  value={workspaceId}
                  onChange={(event) => setWorkspaceId(event.target.value)}
                >
                  {board.workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Agent
                <select
                  value={provider}
                  onChange={(event) =>
                    setProvider(event.target.value as Provider)
                  }
                >
                  <option value="demo">Demo</option>
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </select>
              </label>
              <label>
                Resource estimate
                <select
                  value={profile}
                  onChange={(event) =>
                    setProfile(event.target.value as ResourceProfile)
                  }
                >
                  <option value="standard">Standard · 512 MiB</option>
                  <option value="build">Build · 2 GiB</option>
                  <option value="browser">Browser · 1 GiB</option>
                </select>
              </label>
              <label>
                Priority
                <select
                  value={priority}
                  onChange={(event) => setPriority(Number(event.target.value))}
                >
                  <option value={-10}>Low</option>
                  <option value={0}>Normal</option>
                  <option value={10}>High</option>
                </select>
              </label>
              <button className="send" type="submit" disabled={busy}>
                {busy ? "Adding…" : "Add task ↗"}
              </button>
            </div>
          </form>
          <p className="task-footnote">
            Resource profiles reserve scheduling capacity. A browser profile
            does not yet provision a browser.
          </p>
          <div className="task-list">
            {board.tasks.length === 0 && (
              <p className="muted">Your first task starts here.</p>
            )}
            {board.tasks.map((task) => (
              <article className="task-card" key={task.id}>
                <div className="task-card-heading">
                  <a
                    href={`/?workspace=${encodeURIComponent(task.workspaceId)}&session=${encodeURIComponent(task.sessionId)}`}
                  >
                    {task.title}
                  </a>
                  <span className={`status ${task.status}`}>{task.status}</span>
                </div>
                <p>{task.objective}</p>
                <div className="task-meta">
                  {
                    board.workspaces.find(
                      (workspace) => workspace.id === task.workspaceId,
                    )?.name
                  }{" "}
                  · {task.provider} · {task.profile} · priority {task.priority}
                </div>
                {task.waitingReason && (
                  <div className="waiting-reason">{task.waitingReason}</div>
                )}
                <div className="task-controls">
                  <button
                    type="button"
                    onClick={() =>
                      update({ id: task.id, paused: !task.paused })
                    }
                  >
                    {task.paused ? "Resume queueing" : "Pause queueing"}
                  </button>
                  <label className="target-label">
                    Next eligible worker
                    <select
                      aria-label={`Worker for ${task.title}`}
                      value={task.targetWorkerId ?? ""}
                      onChange={(event) =>
                        update({
                          id: task.id,
                          targetWorkerId: event.target.value || null,
                        })
                      }
                    >
                      <option value="">Automatic</option>
                      {board.workers.map((worker) => (
                        <option key={worker.id} value={worker.id}>
                          {worker.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </article>
            ))}
          </div>
        </section>
        <section className="capacity">
          <div className="eyebrow">EXECUTION CAPACITY</div>
          <h2>Your workers</h2>
          <p className="muted">
            Draining lets active work finish and directs new work elsewhere.
          </p>
          {!board.workers.length && (
            <p className="muted">Start a worker to pick up queued tasks.</p>
          )}
          {board.workers.map((worker) => {
            const online =
              worker.seenAt !== null && Date.now() - worker.seenAt < 30_000;
            return (
              <article className="worker-card" key={worker.id}>
                <div className="task-card-heading">
                  <strong>{worker.name}</strong>
                  <span className="status">
                    {!online
                      ? "offline"
                      : worker.draining || worker.report?.draining
                        ? "draining"
                        : "online"}
                  </span>
                </div>
                {worker.report && (
                  <>
                    <p className="task-meta">
                      {worker.report.hostname} ·{" "}
                      {worker.report.labels.join(", ")}
                    </p>
                    <dl>
                      <dt>Agent slots</dt>
                      <dd>{worker.report.maxAgents}</dd>
                      <dt>Harness memory budget</dt>
                      <dd>{worker.report.memoryBudgetMiB} MiB</dd>
                      <dt>Host free / reserve</dt>
                      <dd>
                        {worker.report.availableMemoryMiB} /{" "}
                        {worker.report.reserveMemoryMiB} MiB
                      </dd>
                      <dt>CPU slots</dt>
                      <dd>{worker.report.cpuSlots}</dd>
                      <dt>Available agents</dt>
                      <dd>{worker.report.providers.join(", ")}</dd>
                    </dl>
                  </>
                )}
                <button
                  type="button"
                  onClick={() =>
                    update({
                      kind: "worker",
                      id: worker.id,
                      draining: !worker.draining,
                    })
                  }
                >
                  {worker.draining ? "Accept new work" : "Drain worker"}
                </button>
              </article>
            );
          })}
        </section>
      </div>
    </div>
  );
}
