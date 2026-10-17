"use client";

import type { Provider, Session, Turn, Workspace } from "@harness/core";
import { isTerminal } from "@harness/core";
import { useCallback, useEffect, useRef, useState } from "react";

type State = { workspaces: Workspace[]; sessions: Session[]; turns: Turn[] };
const initial: State = { workspaces: [], sessions: [], turns: [] };

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Request failed.");
  return result;
}

export default function Home() {
  const [state, setState] = useState<State>(initial);
  const [workspaceId, setWorkspaceId] = useState("business");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [provider, setProvider] = useState<Provider>("demo");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [workspaceForm, setWorkspaceForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [instructions, setInstructions] = useState("");
  const submission = useRef<{
    id: string;
    sessionId: string;
    prompt: string;
  } | null>(null);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const selected = state.sessions.find((s) => s.id === sessionId);
  const active = state.turns.some((turn) => !isTerminal(turn.status));

  // Single in-flight request, no polling in hidden tabs, faster refresh during work.
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
      let nextDelay = 10_000;
      try {
        const query = new URLSearchParams({ workspace: workspaceId });
        if (sessionId) query.set("session", sessionId);
        const response = await fetch(`/api/state?${query}`, {
          signal: controller.signal,
        });
        const next: State & { error?: string } = await response.json();
        if (!response.ok)
          throw new Error(next.error ?? "Cannot load workspace.");
        setState(next);
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
    void load();
    document.addEventListener("visibilitychange", load);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [workspaceId, sessionId]);

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

  return (
    <main>
      <aside>
        <a className="brand" href="/">
          m<span> / </span>meta harness
        </a>
        <div className="sidebar-label">YOUR WORKSPACES</div>
        <nav aria-label="Workspaces">
          {state.workspaces.map((workspace) => (
            <button
              type="button"
              key={workspace.id}
              className={
                workspace.id === workspaceId
                  ? "workspace selected"
                  : "workspace"
              }
              onClick={() => {
                setWorkspaceId(workspace.id);
                setSessionId(null);
                setState(initial);
                setError("");
              }}
            >
              <span className="dot" />
              {workspace.name}
            </button>
          ))}
          <button
            type="button"
            className="quiet"
            onClick={() => setWorkspaceForm(!workspaceForm)}
          >
            + Add workspace
          </button>
        </nav>
        {workspaceForm && (
          <form
            className="workspace-form"
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                const workspace = await post<Workspace>("workspaces", {
                  name: newName,
                  instructions,
                });
                setWorkspaceId(workspace.id);
                setSessionId(null);
                setState(initial);
                setWorkspaceForm(false);
                setNewName("");
                setInstructions("");
              });
            }}
          >
            <input
              aria-label="Workspace name"
              placeholder="Name"
              required
              maxLength={100}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            <textarea
              aria-label="Workspace purpose"
              placeholder="What is this workspace for?"
              required
              maxLength={10000}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
            <button type="submit" disabled={busy}>
              Create
            </button>
          </form>
        )}
        <div className="sidebar-label sessions-label">
          SESSIONS{" "}
          <button
            type="button"
            className="quiet"
            onClick={() => {
              setSessionId(null);
              setState((s) => ({ ...s, turns: [] }));
              setError("");
            }}
          >
            +
          </button>
        </div>
        <nav aria-label="Sessions">
          {state.sessions.map((session) => (
            <button
              type="button"
              className={
                session.id === sessionId ? "session selected" : "session"
              }
              key={session.id}
              onClick={() => {
                setSessionId(session.id);
                setState((s) => ({ ...s, turns: [] }));
                setError("");
              }}
            >
              <span>{session.title}</span>
              <small>{session.provider}</small>
            </button>
          ))}
        </nav>
        <div className="local-status">
          <span className="dot" /> Local development
        </div>
      </aside>
      <section className="content">
        <header>
          <span>
            {state.workspaces.find((w) => w.id === workspaceId)?.name ??
              "Workspace"}
          </span>
          <span className="slash">/</span>
          <span>{selected?.title ?? "New session"}</span>
          {selected && <span className="badge">{selected.provider}</span>}
        </header>
        <div className="conversation">
          {!sessionId && (
            <div className="welcome">
              <div className="eyebrow">A PLACE FOR YOUR WORK</div>
              <h1>Where shall we start?</h1>
              <p>Start a conversation. Come back to it when you’re ready.</p>
            </div>
          )}
          {sessionId && !state.turns.length && (
            <div className="welcome">
              <h1>Ready when you are.</h1>
              <p>Send the first instruction to this session.</p>
            </div>
          )}
          {state.turns.map((turn) => (
            <article className="turn" key={turn.id}>
              <div className="message-label">YOU</div>
              <div className="prompt">{turn.prompt}</div>
              <div className="message-label agent-label">
                {selected?.provider.toUpperCase() ?? "AGENT"}
                <span className={`status ${turn.status}`}>{turn.status}</span>
              </div>
              {turn.output && <div className="output">{turn.output}</div>}
              {!turn.output && !isTerminal(turn.status) && (
                <p className="muted">
                  {turn.status === "running"
                    ? "Working…"
                    : "Waiting for the local worker…"}
                </p>
              )}
              {turn.error && <p className="error">{turn.error}</p>}
            </article>
          ))}
        </div>
        <div className="composer-area">
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              if (!prompt.trim() || busy || active) return;
              void perform(async () => {
                let id = sessionId;
                if (!id) {
                  const session = await post<Session>("sessions", {
                    workspaceId,
                    title: prompt.trim().slice(0, 60),
                    provider,
                  });
                  id = session.id;
                  setSessionId(id);
                  setState((s) => ({
                    ...s,
                    sessions: [session, ...s.sessions],
                    turns: [],
                  }));
                }
                if (
                  !submission.current ||
                  submission.current.sessionId !== id ||
                  submission.current.prompt !== prompt.trim()
                ) {
                  submission.current = {
                    id: crypto.randomUUID(),
                    sessionId: id,
                    prompt: prompt.trim(),
                  };
                }
                const turn = await post<Turn>("turns", submission.current);
                setState((s) => ({
                  ...s,
                  turns: [...s.turns.filter((t) => t.id !== turn.id), turn],
                }));
                submission.current = null;
                setPrompt("");
                // Give state a chance to commit, then pick up streaming output.
                setTimeout(() => void refresh.current(), 100);
              });
            }}
          >
            <textarea
              aria-label="Your instruction"
              placeholder="Give this workspace something to work on…"
              maxLength={20000}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
            />
            <div className="composer-actions">
              {!sessionId ? (
                <select
                  aria-label="Agent runtime"
                  value={provider}
                  onChange={(event) =>
                    setProvider(event.target.value as Provider)
                  }
                >
                  <option value="demo">Demo · no account needed</option>
                  <option value="codex">Codex</option>
                  <option value="claude">Claude</option>
                </select>
              ) : (
                <span className="muted">
                  {active ? "Turn in progress" : "Continue this conversation"}
                </span>
              )}
              <button
                className="send"
                type="submit"
                disabled={busy || active || !prompt.trim()}
              >
                {busy ? "Sending…" : "Send ↗"}
              </button>
            </div>
          </form>
          <p className="composer-note">
            {provider === "demo" && !sessionId
              ? "Try the full local flow without calling a model."
              : "Your work and conversation stay on this machine."}
          </p>
        </div>
      </section>
    </main>
  );
}
