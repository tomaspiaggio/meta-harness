"use client";
import {
  type AgentDefaults,
  type AgentProvider,
  defaultAgentDefaults,
} from "@harness/core/models";
import type { ResourcePolicy } from "@harness/core/resources";
import type { WorkerRecord } from "@harness/core/scheduling";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ModelPicker } from "../model-picker";
import { ErrorNote, PageHeading, Shell, useTree } from "../shell";
import { WorkerSetup } from "../worker-setup";
import { Integrations } from "./integrations";
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
  const [name, setName] = useState("Raspberry Pi");
  const [workerUrl, setWorkerUrl] = useState("");
  useEffect(() => setWorkerUrl(window.location.origin), []);
  const [workers, setWorkers] = useState<WorkerRecord[]>([]);
  const [workerHandoff, setWorkerHandoff] = useState<{
    markdown: string;
    filename: string;
    copied: boolean;
  } | null>(null);
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
  useEffect(() => {
    void api("workers")
      .then(setWorkers)
      .catch((error) => setError(error.message));
  }, []);
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
  async function copyWorkerHandoff(markdown: string, filename: string) {
    let copied = false;
    try {
      await navigator.clipboard.writeText(markdown);
      copied = true;
    } catch {
      // The enrollment already succeeded. Keep the same handoff for manual copy
      // or download when clipboard access requires another click or HTTPS.
    }
    setWorkerHandoff({ markdown, filename, copied });
    setNotice(
      copied
        ? "Copied. Paste to agent on your new device."
        : "Device enrolled. Copy the setup below and paste to agent on your new device.",
    );
  }
  return (
    <section className="mx-auto grid max-w-3xl gap-5 p-6">
      <PageHeading eyebrow="Control" title="Settings">
        Connect machines and choose the resources each workspace may use.
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
              className="rounded border bg-background p-2"
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
      <Card>
        <CardHeader>
          <CardTitle>Workspace resources</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <label className="grid gap-1 text-sm">
            Workspace
            <select
              value={workspace}
              onChange={(event) => setWorkspace(event.target.value)}
              className="rounded border bg-background p-2"
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
              className="rounded border bg-background p-2"
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
          <div className="grid gap-2 rounded border p-3 text-sm">
            <strong>Managed browser on each worker</strong>
            <p>
              Patchright runs a dedicated persistent browser profile. It does
              not use your everyday Chrome, an extension, or another machine's
              logins.
            </p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                On the browser host run <code>pnpm browser:install</code>. On a
                Pi with compatible system Chromium, set{" "}
                <code>HARNESS_BROWSER_EXECUTABLE=/usr/bin/chromium</code>.
              </li>
              <li>
                Use <code>HARNESS_BROWSER_BACKEND=managed</code> and restart
                that worker. No extension pairing or remote-debugging approval
                is needed.
              </li>
              <li>
                Open the browser from a conversation to watch live. Click Take
                control or Sign in, then click and type directly in the browser
                view.
              </li>
              <li>
                Press Esc to release control without sending a message. Continue
                task explicitly resumes an agent waiting for login.
              </li>
            </ol>
            <p>
              Each host retains its own sessions. If a new host needs
              authentication, sign in there through the encrypted view. Never
              paste passwords into chat.
            </p>
          </div>
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
            Only references belong here. Secret values stay in your configured
            secrets backend. Sandbox use also requires deployment configuration
            and compatible credentials.
          </p>
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
      <Integrations />
      <Card>
        <CardHeader>
          <CardTitle>Workers</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <WorkerSetup />
          <label htmlFor="worker-control-url" className="grid gap-1 text-sm">
            Control URL reachable from the worker
            <Input
              id="worker-control-url"
              aria-label="Worker control URL"
              value={workerUrl}
              onChange={(event) => setWorkerUrl(event.target.value)}
              placeholder="https://harness.your-tailnet.ts.net"
            />
          </label>
          <p className="text-xs text-muted-foreground">
            For another machine, use the control plane’s HTTPS address on your
            private network. localhost and 127.0.0.1 refer to the worker itself.
            This address is included in the copied setup; it does not expose or
            reconfigure the server.
          </p>
          <div className="flex gap-2">
            <Input
              aria-label="New worker name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
            />
            <Button
              disabled={busy || !name.trim() || !workerUrl.trim()}
              onClick={() =>
                void perform(async () => {
                  const response = await fetch("/api/workers", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      name,
                      serverUrl: workerUrl.trim(),
                      format: "markdown",
                    }),
                  });
                  if (!response.ok) {
                    const result = await response.json();
                    throw new Error(result.error ?? "Enrollment failed.");
                  }
                  const markdown = await response.text();
                  const filename =
                    response.headers
                      .get("content-disposition")
                      ?.match(/filename="([^"]+)"/)?.[1] ?? "worker-setup.md";
                  await copyWorkerHandoff(markdown, filename);
                  setWorkers(await api("workers"));
                })
              }
            >
              Enroll worker
            </Button>
          </div>
          {workerHandoff && (
            <div className="grid gap-3 rounded border p-3 text-sm">
              <h3 className="font-medium">Paste to agent</h3>
              <p className="text-muted-foreground">
                {workerHandoff.copied
                  ? "Setup instructions copied. Paste them into the coding agent on your new device; it will guide you through installation and login."
                  : "Automatic copy was blocked. Use Copy setup, or select and copy the instructions below. Your device is already enrolled."}
              </p>
              <div className="flex gap-2">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void copyWorkerHandoff(
                      workerHandoff.markdown,
                      workerHandoff.filename,
                    )
                  }
                >
                  {workerHandoff.copied ? "Copy again" : "Copy setup"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    const url = URL.createObjectURL(
                      new Blob([workerHandoff.markdown], {
                        type: "text/markdown; charset=utf-8",
                      }),
                    );
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = workerHandoff.filename;
                    document.body.append(link);
                    link.click();
                    link.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }}
                >
                  Download Markdown
                </Button>
              </div>
              {!workerHandoff.copied && (
                <textarea
                  aria-label="Agent setup instructions"
                  readOnly
                  rows={6}
                  value={workerHandoff.markdown}
                  onFocus={(event) => event.currentTarget.select()}
                  className="rounded border bg-background p-2 font-mono text-xs"
                />
              )}
            </div>
          )}
          {workers.map((worker) => (
            <div
              key={worker.id}
              className="flex items-center justify-between gap-3 border-t pt-3 text-sm"
            >
              <div>
                {worker.name}
                <span className="ml-2 text-muted-foreground">
                  {worker.draining
                    ? "Draining / revoked"
                    : worker.seenAt && worker.seenAt > Date.now() - 30000
                      ? "Online"
                      : "Offline"}
                </span>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !!worker.draining}
                onClick={() =>
                  void perform(async () => {
                    await api("workers", "DELETE", { id: worker.id });
                    setWorkers(await api("workers"));
                  })
                }
              >
                Revoke
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
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
            className="rounded border bg-background p-2"
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
