"use client";
import {
  type AgentDefaults,
  type AgentProvider,
  defaultAgentDefaults,
} from "@harness/core/models";
import type { ResourcePolicy } from "@harness/core/resources";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ModelPicker } from "../model-picker";
import { ErrorNote, PageHeading, Shell, useTree } from "../shell";
import { BackupsCard } from "./backups";
import { GoogleIntegrationSetup } from "./GoogleIntegrationSetup";
import { GoogleWorkspaceLimits } from "./GoogleWorkspaceLimits";
import { Integrations } from "./integrations";
import {
  McpConnectionSettings,
  McpIntegrationSetup,
} from "./McpIntegrationSetup";
import { NotificationsCard } from "./notifications";
import { WorkersCard } from "./workers";
export default function Page() {
  return (
    <Shell>
      <Settings />
    </Shell>
  );
}
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 401) {
    // Match the shell and conversation views: an expired session goes to login
    // instead of rendering every panel with its own sign-in error.
    location.assign("/login");
    throw new Error("Sign in to continue.");
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Request failed.");
  return result;
}
function Settings() {
  const { tree, refresh } = useTree();
  const [defaults, setDefaults] = useState<AgentDefaults>(defaultAgentDefaults);
  const [defaultsLoaded, setDefaultsLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void api("preferences")
      .then((value) => {
        if (!cancelled) {
          setDefaults(value);
          setDefaultsLoaded(true);
        }
      })
      .catch((error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [workspaceChoice, setWorkspace] = useState("business");
  const workspace =
    tree.loaded && !tree.workspaces.some((item) => item.id === workspaceChoice)
      ? (tree.workspaces[0]?.id ?? "")
      : workspaceChoice;
  const [policy, setPolicy] = useState<ResourcePolicy>({
    capacity: "personal",
    browser: true,
    secrets: [],
  });
  const [bindings, setBindings] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState("");
  const [topic, setTopic] = useState("");
  const [delivery, setDelivery] = useState<{
    configured: boolean;
    binding: { topicId: string | null } | null;
    deliveries: {
      id: string;
      kind: string;
      status: string;
      attempts: number;
      error?: string | null;
    }[];
  } | null>(null);
  useEffect(() => {
    if (
      tree.loaded &&
      session &&
      !tree.sessions.some((item) => item.id === session)
    ) {
      setSession("");
      setError("");
    }
  }, [tree, session]);
  useEffect(() => {
    if (!session) {
      setDelivery(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      if (!document.hidden)
        void api(`notifications?session=${encodeURIComponent(session)}`)
          .then((result) => {
            if (!cancelled) setDelivery(result);
          })
          .catch((error) => {
            if (!cancelled) setError(error.message);
          });
    };
    load();
    const timer = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [session]);
  useEffect(() => {
    if (!tree.loaded || !workspace) return;
    let cancelled = false;
    void api(`resources?workspace=${encodeURIComponent(workspace)}`)
      .then((value) => {
        if (!cancelled) {
          setPolicy(value);
          setBindings(
            value.secrets
              .map(
                (item: { ref: string; env: string }) =>
                  `${item.ref}=${item.env}`,
              )
              .join("\n"),
          );
        }
      })
      .catch((error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace, tree.loaded]);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mx-auto grid max-w-3xl gap-5 p-6">
      <PageHeading eyebrow="Control" title="Settings">
        Choose your default agent, add machines that run agents, and connect
        services like Google.
      </PageHeading>
      {error && <ErrorNote>{error}</ErrorNote>}
      {notice && (
        <p role="status" className="text-sm text-primary">
          {notice}
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Default agent and model</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <label className="grid gap-1 text-sm">
            Default agent
            <select
              aria-label="Default agent"
              className="w-full min-w-0 rounded border bg-background p-2"
              disabled={!defaultsLoaded || busy}
              value={defaults.provider}
              onChange={(event) =>
                setDefaults({
                  ...defaults,
                  provider: event.target.value as AgentProvider,
                })
              }
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <div className="grid gap-1 text-sm">
            <span>Default model</span>
            <ModelPicker
              key={defaults.provider}
              provider={defaults.provider}
              value={defaults.models[defaults.provider]}
              disabled={!defaultsLoaded || busy}
              label="Default model"
              onChange={(model) =>
                setDefaults({
                  ...defaults,
                  models: { ...defaults.models, [defaults.provider]: model },
                })
              }
            />
          </div>
          <p className="text-sm text-muted-foreground">
            New sessions inherit these choices. Existing sessions keep their
            agent and model. Model access depends on your provider account.
          </p>
          <Button
            disabled={!defaultsLoaded || busy}
            onClick={() =>
              void perform(async () => {
                setDefaults(await api("preferences", "PATCH", defaults));
                refresh();
                setNotice("Agent defaults saved.");
              })
            }
          >
            Save defaults
          </Button>
        </CardContent>
      </Card>
      <NotificationsCard onError={setError} />
      <WorkersCard api={api} onError={setError} />
      <BackupsCard api={api} onError={setError} />
      <Card>
        <CardHeader>
          <CardTitle>Workspace access</CardTitle>
          <p className="text-sm text-muted-foreground">
            Where agents in each workspace run and which timezone schedules use.
          </p>
        </CardHeader>
        <CardContent className="grid gap-4">
          <label className="grid gap-1 text-sm">
            Workspace
            <select
              value={workspace}
              onChange={(event) => setWorkspace(event.target.value)}
              className="w-full min-w-0 rounded border bg-background p-2"
            >
              {tree.workspaces.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Execution capacity
            <select
              value={policy.capacity}
              onChange={(event) =>
                setPolicy({
                  ...policy,
                  capacity: event.target.value as ResourcePolicy["capacity"],
                })
              }
              className="w-full min-w-0 rounded border bg-background p-2"
            >
              <option value="personal">Wait for my machines</option>
              <option value="fallback">
                Allow Sandbox when my machines cannot run the work
              </option>
              <option value="sandbox">Prefer Sandbox</option>
            </select>
          </label>
          <label htmlFor="schedule-timezone" className="grid gap-1 text-sm">
            Scheduling timezone
            <Input
              id="schedule-timezone"
              value={policy.timezone ?? "UTC"}
              onChange={(event) =>
                setPolicy({ ...policy, timezone: event.target.value })
              }
              placeholder="America/Los_Angeles"
            />
          </label>
          <p className="text-sm text-muted-foreground">
            Each machine keeps its own browser and its own website logins. When
            an agent needs you to sign in, the conversation shows a Sign in
            button; you log in once per machine.
          </p>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              Advanced: secret references for agents
            </summary>
            <div className="mt-3 grid gap-2">
              <label className="grid gap-1 text-sm">
                Named secret bindings (reference=ENV_VARIABLE, one per line)
                <textarea
                  className="rounded border bg-background p-2 font-mono"
                  rows={3}
                  value={bindings}
                  onChange={(event) => setBindings(event.target.value)}
                  placeholder="crm-token=CRM_API_TOKEN"
                />
              </label>
              <p className="text-xs text-muted-foreground">
                Only references belong here. Secret values stay in your
                configured secrets backend. Sandbox use also requires deployment
                configuration and compatible credentials.
              </p>
            </div>
          </details>
          <Button
            className="justify-self-start"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const secrets = bindings
                  .split(/\r?\n/)
                  .filter((line) => line.trim())
                  .map((line) => {
                    const [ref, env, ...extra] = line.trim().split("=");
                    if (!ref || !env || extra.length)
                      throw new Error(
                        "Use reference=ENV_VARIABLE for each binding.",
                      );
                    return { ref, env };
                  });
                await api("resources", "POST", {
                  workspaceId: workspace,
                  policy: { ...policy, secrets },
                });
                setNotice("Workspace resource policy saved.");
              })
            }
          >
            Save policy
          </Button>
        </CardContent>
      </Card>
      <Integrations
        setup={
          <>
            <GoogleIntegrationSetup />
            <McpIntegrationSetup />
          </>
        }
        connectionSetup={(connection) =>
          connection.adapter === "mcp" ? (
            <McpConnectionSettings connection={connection} />
          ) : connection.adapter === "native" &&
            connection.config.adapterId === "google" ? (
            <GoogleWorkspaceLimits connectionId={connection.id} />
          ) : null
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>Telegram topics</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            Each connected session keeps one topic for replies, schedules and
            notifications. Configure the bot, owner IDs, webhook secret and
            destination chat first. Notifications link to the UI and omit result
            contents.
          </p>
          <select
            aria-label="Session to connect"
            value={session}
            onChange={(event) => setSession(event.target.value)}
            className="w-full min-w-0 rounded border bg-background p-2"
          >
            <option value="">Choose a session</option>
            {tree.sessions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
          <Input
            aria-label="Existing topic ID"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="Existing topic ID (optional)"
          />
          <Button
            className="justify-self-start"
            disabled={busy || !session}
            onClick={() =>
              void perform(async () => {
                await api("notifications", "POST", {
                  sessionId: session,
                  ...(topic ? { topicId: topic } : {}),
                });
                setNotice("Session connected to its Telegram topic.");
              })
            }
          >
            Connect topic
          </Button>
          <Button
            variant="outline"
            className="justify-self-start"
            disabled={busy || !session}
            onClick={() =>
              void perform(async () => {
                await api("notifications", "DELETE", { sessionId: session });
                setNotice(
                  "Session disconnected from Telegram. Its conversation and topic remain available.",
                );
              })
            }
          >
            Disconnect topic
          </Button>
          {delivery && (
            <div className="grid gap-2 text-xs text-muted-foreground">
              <p>
                {!delivery.configured
                  ? "Telegram is not configured."
                  : delivery.binding?.topicId
                    ? `Connected to topic ${delivery.binding.topicId}.`
                    : "This session uses in-app attention only."}
              </p>
              {delivery.deliveries.slice(0, 5).map((item) => (
                <p key={item.id}>
                  {item.kind} · {item.status}
                  {item.attempts ? ` · ${item.attempts} attempt(s)` : ""}
                  {item.error ? ` · ${item.error}` : ""}
                </p>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <Button
        variant="ghost"
        className="justify-self-start"
        onClick={() =>
          void perform(async () => {
            await api("auth/logout", "POST");
            location.assign("/login");
          })
        }
      >
        Sign out
      </Button>
    </section>
  );
}
