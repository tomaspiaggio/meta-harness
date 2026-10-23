"use client";
import type { Provider, Session, Turn, Workspace } from "@harness/core";
import { isTerminal } from "@harness/core";
import type { Attachment } from "@harness/core/attachments";
import type { Schedule } from "@harness/core/automations";
import type { Decision } from "@harness/core/knowledge";
import { type AgentProvider, defaultAgentDefaults } from "@harness/core/models";
import { ArrowUp, Globe2, Square } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
  acceptFiles,
  FilePicker,
  PendingAttachments,
  type PendingFile,
  uploadAttachment,
} from "./attachment-input";
import { BrowserPanel } from "./browser-panel";
import { MarkdownMessage } from "./markdown";
import { ModelPicker } from "./model-picker";
import { ScheduleCard } from "./schedule-card";
import {
  conversationHref,
  ErrorNote,
  Shell,
  StatusBadge,
  useTree,
} from "./shell";

type State = {
  loadedSessionId?: string;
  workspaces: Workspace[];
  sessions: Session[];
  schedules?: Schedule[];
  inputRequests?: {
    id: string;
    sessionId: string;
    kind: string;
    message: string;
  }[];
  turns: (Turn & {
    waitingReason?: string | null;
    publications?: Decision[];
    attachments?: Attachment[];
  })[];
};
const initial: State = { workspaces: [], sessions: [], turns: [] };
const providers: {
  id: Provider;
  label: string;
  note: string;
}[] = [
  { id: "claude", label: "Claude", note: "Claude Code CLI" },
  { id: "codex", label: "Codex", note: "Codex CLI" },
];
async function post<T>(
  path: string,
  body: unknown,
  method = "POST",
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Request failed.");
  return result;
}
export default function Page() {
  return (
    <Shell>
      <Suspense fallback={null}>
        <Conversation />
      </Suspense>
    </Shell>
  );
}
function Conversation() {
  const router = useRouter();
  const params = useSearchParams();
  const { tree, refresh: refreshTree } = useTree();
  // The URL is the source of truth for location, so refresh and back work.
  const requestedWorkspace = params.get("workspace");
  const workspaceId =
    requestedWorkspace ??
    (tree.loaded ? (tree.workspaces[0]?.id ?? "") : "business");
  useEffect(() => {
    if (
      tree.loaded &&
      workspaceId &&
      !tree.workspaces.some((workspace) => workspace.id === workspaceId)
    )
      router.replace(
        tree.workspaces[0] ? conversationHref(tree.workspaces[0].id) : "/",
      );
  }, [tree, workspaceId, router]);
  const sessionId = params.get("session");
  const [state, setState] = useState<State>(initial);
  const [provider, setProvider] = useState<Provider>("claude");
  const [models, setModels] = useState(defaultAgentDefaults.models);
  const choicesEdited = useRef(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const draftSession = useRef<{ location: string; id: string } | null>(null);
  const routeKey = `${workspaceId}:${sessionId ?? ""}`;
  const currentLocation = useRef(routeKey);
  currentLocation.current = routeKey;
  const [atBottom, setAtBottom] = useState(true);
  const acknowledged = useRef("");
  const submission = useRef<{
    id: string;
    sessionId: string;
    prompt: string;
    interruptsTurnId?: string;
    attachmentIds?: string[];
  } | null>(null);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  // Filter by ID so a previous location's data never flashes in the new one.
  const turns = state.turns.filter((t) => t.sessionId === sessionId);
  const workspace = state.workspaces.find((w) => w.id === workspaceId);
  const selected = state.sessions.find((s) => s.id === sessionId);
  const active = turns.some((turn) => !isTerminal(turn.status));
  const activeTurn =
    turns.find((turn) => turn.status === "running") ??
    turns.find((turn) => !isTerminal(turn.status));
  const latest = turns.at(-1);
  const statusTurn = activeTurn ?? latest;
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear unsent files only when navigating to a different conversation
  useEffect(() => {
    draftSession.current = null;
    choicesEdited.current = false;
    setFiles([]);
    setPrompt("");
    setBrowserOpen(false);
  }, [routeKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: initialize defaults after the composer location resets
  useEffect(() => {
    if (!sessionId && !choicesEdited.current && tree.defaults) {
      setProvider(tree.defaults.provider);
      setModels(tree.defaults.models);
    }
  }, [sessionId, tree.defaults, routeKey]);
  const addFiles = (incoming: FileList | File[]) => {
    // FileList is live, and picker reset/drop event cleanup can empty it before
    // React evaluates a deferred state updater. Snapshot inside the input event.
    const snapshot = Array.from(incoming);
    if (!busy)
      setFiles((previous) => acceptFiles(previous, snapshot, setError));
  };
  useEffect(() => {
    const markRead = () => {
      const sequence = selected?.attentionSequence ?? 0;
      const key = `${sessionId}:${sequence}`;
      if (
        document.hidden ||
        !atBottom ||
        !sessionId ||
        state.loadedSessionId !== sessionId ||
        !sequence ||
        acknowledged.current === key
      )
        return;
      acknowledged.current = key;
      void post<Session>(
        "sessions",
        { id: sessionId, action: "read", throughSequence: sequence },
        "PATCH",
      )
        .then(() => refreshTree())
        .catch(() => {
          if (acknowledged.current === key) acknowledged.current = "";
        });
    };
    markRead();
    document.addEventListener("visibilitychange", markRead);
    return () => document.removeEventListener("visibilitychange", markRead);
  }, [selected, sessionId, state.loadedSessionId, atBottom, refreshTree]);
  // Single in-flight request, no polling in hidden tabs, faster refresh during work.
  useEffect(() => {
    if (!workspaceId) {
      setState(initial);
      setError("");
      return;
    }
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
      let nextDelay = 10000;
      try {
        const query = new URLSearchParams({ workspace: workspaceId });
        if (sessionId) query.set("session", sessionId);
        const response = await fetch(`/api/state?${query}`, {
          signal: controller.signal,
        });
        if (response.status === 401) {
          location.assign("/login");
          return;
        }
        const next: State & {
          error?: string;
        } = await response.json();
        if (!response.ok)
          throw new Error(next.error ?? "Cannot load workspace.");
        if (controller.signal.aborted) return;
        setState({ ...next, loadedSessionId: sessionId ?? undefined });
        setError("");
        if (next.turns.some((turn) => !isTerminal(turn.status)))
          nextDelay = 1000;
      } catch (error) {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : "Connection lost.");
      } finally {
        loading = false;
        if (!controller.signal.aborted) timer = setTimeout(load, nextDelay);
      }
    };
    refresh.current = load;
    pinned.current = true;
    setAtBottom(true);
    void load();
    document.addEventListener("visibilitychange", load);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [workspaceId, sessionId]);
  // Follow streaming output unless the reader has scrolled up.
  const outputLength = turns.reduce(
    (length, turn) => length + turn.output.length,
    0,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when content grows
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [turns.length, outputLength, latest?.status]);
  // Grow the composer with its content, up to its max height.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure on every edit
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [prompt]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus on navigation
  useEffect(() => {
    input.current?.focus();
  }, [sessionId, workspaceId]);
  const perform = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }, []);
  const canSend =
    !!workspaceId &&
    !busy &&
    !modelBusy &&
    (!!prompt.trim() || files.length > 0);
  const stopTurn = (id: string) =>
    void perform(async () => {
      await post<Turn>("turns", { id }, "PATCH");
      await refresh.current();
      refreshTree();
    });
  const send = (interrupt = false) => {
    if (!canSend) return;
    void perform(async () => {
      let id = sessionId;
      if (!id && draftSession.current?.location === routeKey) {
        id = draftSession.current.id;
        // An upload failure can leave an empty session. Keep its native agent,
        // but apply any model choice made before retrying the upload.
        await post<Session>(
          "sessions",
          {
            id,
            action: "model",
            model: provider === "demo" ? null : models[provider],
          },
          "PATCH",
        );
      }
      if (!id) {
        const session = await post<Session>("sessions", {
          workspaceId,
          title: (prompt.trim() || files[0]?.file.name || "Attachments").slice(
            0,
            60,
          ),
          provider,
          model: provider === "demo" ? null : models[provider],
        });
        id = session.id;
        draftSession.current = { location: routeKey, id };
        setState((s) => ({ ...s, sessions: [session, ...s.sessions] }));
        refreshTree();
      }
      const attachmentIds: string[] = [];
      for (const pending of files) {
        const uploaded = await uploadAttachment(id, pending, (percentage) =>
          setFiles((previous) =>
            previous.map((file) =>
              file.id === pending.id ? { ...file, progress: percentage } : file,
            ),
          ),
        );
        attachmentIds.push(uploaded.id);
        setFiles((previous) =>
          previous.map((file) =>
            file.id === pending.id ? { ...file, uploaded } : file,
          ),
        );
      }
      const message = prompt.trim() || "Please review the attached files.";
      if (
        !submission.current ||
        submission.current.sessionId !== id ||
        submission.current.prompt !== message ||
        JSON.stringify(submission.current.attachmentIds) !==
          JSON.stringify(attachmentIds) ||
        submission.current.interruptsTurnId !==
          (interrupt ? activeTurn?.id : undefined)
      ) {
        submission.current = {
          id: crypto.randomUUID(),
          sessionId: id,
          prompt: message,
          attachmentIds,
          ...(interrupt && activeTurn
            ? { interruptsTurnId: activeTurn.id }
            : {}),
        };
      }
      const turn = await post<Turn>("turns", submission.current);
      setState((s) => ({
        ...s,
        turns: [...s.turns.filter((t) => t.id !== turn.id), turn],
      }));
      submission.current = null;
      if (currentLocation.current !== routeKey) return;
      setPrompt("");
      setFiles([]);
      draftSession.current = null;
      pinned.current = true;
      if (id !== sessionId) router.push(conversationHref(workspaceId, id));
      // Give state a chance to commit, then pick up streaming output.
      else setTimeout(() => void refresh.current(), 100);
    });
  };
  return (
    <section
      aria-label="Conversation and attachments"
      className="flex min-h-0 flex-1 flex-col"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        addFiles(event.dataTransfer.files);
      }}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-6 text-sm">
        <nav
          aria-label="Location"
          className="flex min-w-0 flex-1 items-center gap-2"
        >
          <Link
            href={conversationHref(workspaceId)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            {workspace?.name ?? "Workspace"}
          </Link>
          <span aria-hidden className="text-muted-foreground/50">
            /
          </span>
          <span className="truncate font-medium">
            {selected?.title ?? (sessionId ? "…" : "New session")}
          </span>
        </nav>
        {selected && (
          <Badge variant="outline" className="font-mono font-normal">
            {selected.provider}
          </Badge>
        )}
        {statusTurn && (
          <StatusBadge
            status={
              statusTurn.status === "running" && statusTurn.stopRequestedAt
                ? "stopping"
                : statusTurn.status
            }
          />
        )}
      </div>

      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            80;
          setAtBottom(pinned.current);
        }}
      >
        <div className="mx-auto max-w-3xl px-6 py-8">
          {!sessionId && (
            <div className="animate-in fade-in slide-in-from-bottom-2 pt-[12vh] duration-500">
              <div className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                {workspace?.name ?? "Workspace"} · new session
              </div>
              <h1 className="mt-3 mb-4 font-serif text-5xl font-normal tracking-tight">
                What should we <em className="text-primary">work on</em>?
              </h1>
              {workspace?.instructions && (
                <p className="mb-4 whitespace-pre-wrap border-l-2 border-primary pl-4 font-serif text-lg italic text-foreground/75">
                  {workspace.instructions}
                </p>
              )}
              <p className="text-muted-foreground">
                {workspaceId
                  ? "Each session is its own conversation inside this workspace. Pick an agent, then send the first instruction."
                  : "Create a workspace using the + button in the sidebar to get started."}
              </p>
            </div>
          )}
          {sessionId && selected && !turns.length && (
            <div className="pt-[12vh]">
              <h1 className="font-serif text-5xl font-normal tracking-tight">
                Ready when <em className="text-primary">you are</em>.
              </h1>
              <p className="mt-3 text-muted-foreground">
                Send the first instruction below.
              </p>
            </div>
          )}
          {turns.map((turn) => (
            <article
              key={turn.id}
              className="animate-in fade-in border-b py-7 first:pt-0 last:border-0"
            >
              <div className="rounded-lg bg-muted px-4 py-3">
                <Role>You</Role>
                <div className="whitespace-pre-wrap break-words">
                  {turn.prompt}
                </div>
                {!!turn.attachments?.length && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {turn.attachments.map((file) => (
                      <a
                        key={file.id}
                        href={`/api/attachments?id=${encodeURIComponent(file.id)}`}
                        className="rounded border bg-background px-3 py-1 text-xs underline"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {file.name}
                      </a>
                    ))}
                  </div>
                )}
              </div>
              <div className="px-0.5 pt-5">
                <Role className="text-primary">
                  {selected?.provider ?? "agent"}
                  <StatusBadge
                    status={
                      turn.status === "running" && turn.stopRequestedAt
                        ? "stopping"
                        : turn.status
                    }
                  />
                  {!isTerminal(turn.status) && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy || !!turn.stopRequestedAt}
                      onClick={() => stopTurn(turn.id)}
                      className="h-6 px-2 text-xs normal-case tracking-normal"
                    >
                      <Square className="size-3" />{" "}
                      {turn.stopRequestedAt ? "Stopping…" : "Stop"}
                    </Button>
                  )}
                </Role>
                {turn.output && (
                  <MarkdownMessage>{turn.output}</MarkdownMessage>
                )}
                {!turn.output && !isTerminal(turn.status) && (
                  <p className="flex items-center gap-3 text-muted-foreground">
                    <span
                      aria-hidden
                      className="h-0.5 w-7 animate-pulse rounded bg-primary"
                    />
                    {turn.stopRequestedAt
                      ? "Stopping the worker; preserving partial output…"
                      : turn.status === "running"
                        ? "Working…"
                        : (turn.waitingReason ??
                          "Waiting for an eligible worker…")}
                  </p>
                )}
                {turn.model && (
                  <p className="mb-2 text-xs text-muted-foreground">
                    {turn.model}
                  </p>
                )}
                {turn.error && <ErrorNote>{turn.error}</ErrorNote>}
                {!!turn.publications?.length && (
                  <div className="mt-4 flex flex-wrap items-center gap-1.5 text-xs text-success">
                    Published to shared decisions
                    {turn.publications.map((decision) => (
                      <Badge
                        key={`${decision.key}-${decision.revision}`}
                        variant="outline"
                        asChild
                        className="font-mono font-normal"
                      >
                        <Link href="/knowledge">
                          {decision.key} · r{decision.revision}
                        </Link>
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </article>
          ))}
          {sessionId && (
            <BrowserPanel
              key={`${workspaceId}:${sessionId}`}
              workspaceId={workspaceId}
              sessionId={sessionId}
              open={browserOpen}
              onOpenChange={setBrowserOpen}
              needsLogin={state.inputRequests?.some(
                (request) =>
                  request.sessionId === sessionId &&
                  request.kind === "browser-login",
              )}
              onResume={() => {
                void refresh.current();
                refreshTree();
              }}
            />
          )}
          {state.schedules
            ?.filter(
              (schedule) =>
                schedule.sessionId === sessionId && schedule.status === "draft",
            )
            .map((schedule) => (
              <ScheduleCard
                key={`${schedule.id}:${schedule.revision}`}
                schedule={schedule}
                onChange={() => {
                  void refresh.current();
                  refreshTree();
                }}
              />
            ))}
          {state.inputRequests
            ?.filter(
              (request) =>
                request.sessionId === sessionId &&
                request.kind !== "browser-login",
            )
            .map((request) => (
              <div
                key={request.id}
                className="my-4 rounded-lg border border-warning p-4"
              >
                <p className="mb-3 text-sm text-warning">
                  Needs your input: {request.message}
                </p>
                {request.kind !== "browser-login" && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const response = String(
                        new FormData(event.currentTarget).get("response") ?? "",
                      );
                      void perform(async () => {
                        await post("inputs", { id: request.id, response });
                        await refresh.current();
                        refreshTree();
                      });
                    }}
                  >
                    <input
                      name="response"
                      aria-label="Answer the agent"
                      required
                      className="mb-2 w-full rounded border bg-background p-2 text-sm"
                    />
                    <Button size="sm" disabled={busy}>
                      Send answer
                    </Button>
                  </form>
                )}
              </div>
            ))}
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl px-6 pt-2 pb-5">
        {error && <ErrorNote>{error}</ErrorNote>}
        {dragging && (
          <p className="mb-2 rounded-lg border border-dashed border-primary p-3 text-center text-sm text-primary">
            Drop images or files to attach them.
          </p>
        )}
        {active && (
          <p className="mb-2 text-xs text-muted-foreground">
            Send next queues your message. Interrupt and send stops the current
            turn before continuing.
          </p>
        )}
        <form
          className="rounded-xl border bg-card p-3 pl-4 shadow-lg transition-shadow focus-within:border-foreground/30 focus-within:shadow-xl"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <PendingAttachments
            files={files}
            disabled={busy}
            remove={(id) =>
              setFiles((previous) => previous.filter((file) => file.id !== id))
            }
          />
          <textarea
            ref={input}
            aria-label="Your instruction"
            placeholder={
              sessionId
                ? "Reply to this session…"
                : `Start a session in ${workspace?.name ?? "this workspace"}…`
            }
            maxLength={20000}
            value={prompt}
            disabled={busy}
            onPaste={(event) => {
              if (event.clipboardData.files.length) {
                event.preventDefault();
                addFiles(event.clipboardData.files);
              }
            }}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                send();
              }
            }}
            rows={1}
            className="block max-h-64 min-h-6 w-full resize-none bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
          />
          {sessionId && selected?.provider !== "demo" && (
            <p className="mt-2 text-xs text-muted-foreground">
              Model changes apply to new messages; queued and running messages
              keep their model.
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <FilePicker files={files} disabled={busy} onFiles={addFiles} />
            {sessionId && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Open browser"
                title="Open browser"
                onClick={() => setBrowserOpen(true)}
              >
                <Globe2 />
              </Button>
            )}
            {!sessionId ? (
              <ToggleGroup
                type="single"
                disabled={busy || !!draftSession.current}
                variant="outline"
                size="sm"
                value={provider}
                onValueChange={(value) => {
                  if (value) {
                    choicesEdited.current = true;
                    setProvider(value as Provider);
                  }
                }}
                aria-label="Agent"
              >
                {providers.map((option) => (
                  <ToggleGroupItem
                    key={option.id}
                    value={option.id}
                    title={option.note}
                    className="px-3 text-xs data-[state=on]:bg-foreground data-[state=on]:text-background"
                  >
                    {option.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            ) : (
              <span className="font-mono text-[11px] text-muted-foreground">
                {active ? "Messages run in order" : selected?.provider}
              </span>
            )}
            {(!sessionId || selected) &&
              (selected?.provider ?? provider) !== "demo" && (
                <ModelPicker
                  key={sessionId ?? provider}
                  provider={(selected?.provider ?? provider) as AgentProvider}
                  value={
                    sessionId
                      ? (selected?.model ?? null)
                      : models[provider as AgentProvider]
                  }
                  disabled={busy || modelBusy}
                  label={sessionId ? "Session model" : "Model"}
                  onChange={(model) => {
                    if (!sessionId) {
                      choicesEdited.current = true;
                      setModels({ ...models, [provider]: model });
                      return;
                    }
                    setModelBusy(true);
                    setError("");
                    void post<Session>(
                      "sessions",
                      { id: sessionId, action: "model", model },
                      "PATCH",
                    )
                      .then((session) => {
                        setState((previous) => ({
                          ...previous,
                          sessions: previous.sessions.map((item) =>
                            item.id === session.id ? session : item,
                          ),
                        }));
                        refreshTree();
                      })
                      .catch((reason) => setError(reason.message))
                      .finally(() => setModelBusy(false));
                  }}
                />
              )}
            <span
              aria-hidden
              className="ml-auto hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex"
            >
              <Kbd>↵</Kbd> send <Kbd className="ml-2">⇧ ↵</Kbd> new line
            </span>
            {activeTurn && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canSend || !!activeTurn.stopRequestedAt}
                onClick={() => send(true)}
                className="ml-auto text-xs"
              >
                Interrupt and send
              </Button>
            )}
            <Button
              type="submit"
              size="icon-sm"
              disabled={!canSend}
              aria-label={busy ? "Sending" : active ? "Send next" : "Send"}
              className="ml-auto rounded-lg sm:ml-0"
            >
              <ArrowUp />
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}
function Role({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-2 flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}
