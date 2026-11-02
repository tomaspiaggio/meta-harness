"use client";
import type { ExtensionManifest } from "@harness/core/extensions";
import type {
  Extension,
  ExtensionEventRecord,
  ExtensionRevision,
  ExtensionRun,
  ExtensionSubscription,
} from "@harness/storage/extensions";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ErrorNote, PageHeading, Shell, timeAgo, useTree } from "../shell";

export default function Page() {
  return (
    <Shell>
      <Extensions />
    </Shell>
  );
}
type Detail = {
  extension: Extension;
  revisions: ExtensionRevision[];
  runs: ExtensionRun[];
  events: ExtensionEventRecord[];
  state: string[];
  subscriptions: (ExtensionSubscription & {
    session: { id: string; title: string; workspaceId: string } | null;
  })[];
};
async function call<T = unknown>(
  url: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Request failed.");
  return result;
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

function Extensions() {
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setExtensions(await call<Extension[]>("/api/extensions"));
      setLoaded(true);
    } catch (error) {
      setError(message(error));
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => !document.hidden && void load(), 15000);
    return () => clearInterval(timer);
  }, [load]);
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-8">
      <PageHeading eyebrow="Automation" title="Extensions">
        <Button onClick={() => setAdding(!adding)}>
          {adding ? "Close" : "Add extension"}
        </Button>
      </PageHeading>
      {error && <ErrorNote>{error}</ErrorNote>}
      <p className="mb-6 text-sm text-muted-foreground">
        Small scripts that watch something outside, like an inbox or a webhook,
        without an agent. When one finds something new it sends it as a message
        to the conversations subscribed to it. Each runs in a sandbox on a
        worker with Deno and can only reach the hosts it lists. Agents can
        propose extensions too; nothing runs until you approve it here.
      </p>
      {adding && (
        <AddExtension
          done={(id) => {
            setAdding(false);
            setOpen(id);
            void load();
          }}
        />
      )}
      {loaded && !extensions.length && !adding && (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No extensions yet.
        </p>
      )}
      <div className="grid gap-3">
        {extensions.map((extension) => (
          <ExtensionCard
            key={extension.id}
            extension={extension}
            open={open === extension.id}
            toggle={() => setOpen(open === extension.id ? null : extension.id)}
            changed={load}
          />
        ))}
      </div>
    </div>
  );
}

function AddExtension({ done }: { done: (id: string) => void }) {
  const [url, setUrl] = useState("");
  const [manifest, setManifest] = useState("");
  const [code, setCode] = useState("");
  const [pasting, setPasting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="mb-8 grid gap-3 rounded-xl border bg-card p-5"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
          let parsed: unknown;
          if (pasting)
            try {
              parsed = JSON.parse(manifest);
            } catch {
              throw new Error("The manifest is not valid JSON.");
            }
          const revision = await call<ExtensionRevision>(
            "/api/extensions",
            "POST",
            pasting
              ? { action: "propose", manifest: parsed, code }
              : { action: "install-url", url },
          );
          done(revision.extensionId);
        } catch (error) {
          setError(message(error));
        } finally {
          setBusy(false);
        }
      }}
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      {pasting ? (
        <>
          <Textarea
            aria-label="manifest.json"
            placeholder='{"id": "my-extension", "name": …}'
            className="font-mono text-xs"
            rows={8}
            value={manifest}
            onChange={(event) => setManifest(event.target.value)}
            required
          />
          <Textarea
            aria-label="main.ts"
            placeholder="export default async function run(ctx) { … }"
            className="font-mono text-xs"
            rows={10}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
        </>
      ) : (
        <Input
          aria-label="Manifest URL"
          placeholder="https://raw.githubusercontent.com/…/manifest.json"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          required
        />
      )}
      <div className="flex items-center justify-between gap-3">
        <Button
          type="button"
          variant="link"
          className="px-0"
          onClick={() => setPasting(!pasting)}
        >
          {pasting ? "Install from a URL instead" : "Paste the files instead"}
        </Button>
        <Button disabled={busy}>
          {busy ? "Reading…" : "Review before installing"}
        </Button>
      </div>
    </form>
  );
}

function status(extension: Extension) {
  if (!extension.activeRevision) return "Waiting for review";
  if (!extension.enabled) return "Off";
  if (extension.missing.length) return "Needs settings";
  return "On";
}
function ExtensionCard({
  extension,
  open,
  toggle,
  changed,
}: {
  extension: Extension;
  open: boolean;
  toggle: () => void;
  changed: () => Promise<void>;
}) {
  const manifest = extension.manifest ?? extension.proposal?.manifest;
  const state = status(extension);
  return (
    <div className="rounded-xl border bg-card">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 p-4 text-left"
        onClick={toggle}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">
              {manifest?.name ?? extension.id}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {extension.id}
              {manifest ? ` · v${manifest.version}` : ""}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {manifest?.description}
          </p>
          {extension.lastRun && (
            <p className="mt-1 text-xs text-muted-foreground">
              Last run {timeAgo(extension.lastRun.createdAt)}:{" "}
              {extension.lastRun.status}
              {extension.lastRun.status === "completed"
                ? `, ${extension.lastRun.events} new`
                : ""}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {extension.proposal && extension.activeRevision !== null && (
            <Badge variant="secondary">Update to review</Badge>
          )}
          <Badge variant={state === "On" ? "default" : "outline"}>
            {state}
          </Badge>
        </div>
      </button>
      {open && <ExtensionDetail id={extension.id} changed={changed} />}
    </div>
  );
}

function ExtensionDetail({
  id,
  changed,
}: {
  id: string;
  changed: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setDetail(await call<Detail>(`/api/extensions/${id}`));
    } catch (error) {
      setError(message(error));
    }
  }, [id]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => !document.hidden && void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  const act = async (action: () => Promise<unknown>) => {
    setError("");
    try {
      await action();
      await Promise.all([load(), changed()]);
    } catch (error) {
      setError(message(error));
    }
  };
  if (!detail)
    return (
      <div className="border-t p-4 text-sm text-muted-foreground">
        {error || "Loading…"}
      </div>
    );
  const { extension } = detail;
  return (
    <div className="grid gap-6 border-t p-4">
      {error && <ErrorNote>{error}</ErrorNote>}
      {extension.proposal && (
        <Review
          id={id}
          proposal={extension.proposal}
          current={extension.manifest}
          act={act}
        />
      )}
      {extension.manifest && (
        <>
          <Settings extension={extension} act={act} />
          <Triggers extension={extension} act={act} />
          <Subscriptions id={id} detail={detail} act={act} />
          <Runs runs={detail.runs} />
          <Events events={detail.events} />
        </>
      )}
      <Revisions id={id} detail={detail} act={act} />
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="text-danger"
          onClick={() => {
            if (
              confirm(
                `Delete ${extension.manifest?.name ?? id}, its history and saved state?`,
              )
            )
              void act(async () => {
                if (extension.enabled)
                  await call(`/api/extensions/${id}`, "PATCH", {
                    enabled: false,
                  });
                await call(`/api/extensions/${id}`, "DELETE");
              });
          }}
        >
          Delete extension
        </Button>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-2">
      <h3 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}
function Permissions({ manifest }: { manifest: ExtensionManifest }) {
  return (
    <ul className="grid gap-1 text-sm">
      <li>
        {manifest.permissions.net.length
          ? `Reaches ${manifest.permissions.net.join(", ")}`
          : "No network access"}
        ; no files, no environment, no other programs.
      </li>
      <li>
        Runs{" "}
        {manifest.triggers
          .map((trigger) =>
            trigger.type === "cron"
              ? `on "${trigger.cron}" (${trigger.timezone})`
              : "when its webhook is called",
          )
          .join(" and ")}
        , for at most {manifest.timeoutSeconds}s each time.
      </li>
      {Object.keys(manifest.config.properties).length > 0 && (
        <li>
          Settings:{" "}
          {Object.entries(manifest.config.properties)
            .map(
              ([name, field]) =>
                `${field.title || name}${field.secret ? " (secret)" : ""}`,
            )
            .join(", ")}
        </li>
      )}
    </ul>
  );
}
function Review({
  id,
  proposal,
  current,
  act,
}: {
  id: string;
  proposal: ExtensionRevision;
  current: ExtensionManifest | null;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const { tree } = useTree();
  const [code, setCode] = useState<string | null>(null);
  const proposer = proposal.proposedBy.startsWith("session:")
    ? (tree.sessions.find(
        (session) => `session:${session.id}` === proposal.proposedBy,
      )?.title ?? "an agent")
    : proposal.proposedBy === "owner"
      ? "you"
      : proposal.proposedBy;
  useEffect(() => {
    void call<{ code: string }>(
      `/api/extensions/${id}?revision=${proposal.revision}`,
    ).then((result) => setCode(result.code));
  }, [id, proposal.revision]);
  const widened =
    current &&
    proposal.manifest.permissions.net.filter(
      (host) => !current.permissions.net.includes(host),
    );
  return (
    <div className="grid gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="text-sm font-medium">
        {current ? "Update" : "New extension"} waiting for your review (revision{" "}
        {proposal.revision}, v{proposal.manifest.version})
      </div>
      <p className="text-xs text-muted-foreground">
        Proposed by {proposer} {timeAgo(proposal.createdAt)}
        {proposal.note ? `: ${proposal.note}` : ""}
      </p>
      <Permissions manifest={proposal.manifest} />
      {widened && widened.length > 0 && (
        <p className="text-sm font-medium text-danger">
          New network access: {widened.join(", ")}
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-sm">
          Read the script ({code ? `${code.split("\n").length} lines` : "…"})
        </summary>
        <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
          {code}
        </pre>
      </details>
      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          onClick={() =>
            void act(() =>
              call(`/api/extensions/${id}`, "POST", {
                action: "reject",
                revision: proposal.revision,
              }),
            )
          }
        >
          Reject
        </Button>
        <Button
          onClick={() =>
            void act(() =>
              call(`/api/extensions/${id}`, "POST", {
                action: "approve",
                revision: proposal.revision,
              }),
            )
          }
        >
          {current ? "Approve update" : "Approve"}
        </Button>
      </div>
    </div>
  );
}
function Settings({
  extension,
  act,
}: {
  extension: Extension;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const manifest = extension.manifest as ExtensionManifest;
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      Object.entries(manifest.config.properties).map(([name, field]) => [
        name,
        field.type === "boolean"
          ? Boolean(extension.config[name] ?? field.default ?? false)
          : field.secret
            ? ""
            : String(extension.config[name] ?? ""),
      ]),
    ),
  );
  const [labels, setLabels] = useState(extension.requiredLabels.join(", "));
  const fields = Object.entries(manifest.config.properties);
  return (
    <Section title="Settings">
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const config: Record<string, unknown> = {};
          for (const [name, field] of fields) {
            const value = values[name];
            if (field.type === "boolean") config[name] = value;
            else if (field.secret) {
              if (value) config[name] = value;
            } else if (value === "") config[name] = null;
            else
              config[name] =
                field.type === "string" ? value : Number(value as string);
          }
          void act(async () => {
            await call(`/api/extensions/${extension.id}`, "PATCH", {
              config,
              requiredLabels: labels,
            });
            setValues((old) =>
              Object.fromEntries(
                Object.entries(old).map(([name, value]) => [
                  name,
                  manifest.config.properties[name]?.secret ? "" : value,
                ]),
              ),
            );
          });
        }}
      >
        {fields.map(([name, field]) => (
          <label
            key={name}
            htmlFor={`setting-${extension.id}-${name}`}
            className="grid gap-1 text-xs"
          >
            <span>
              {field.title || name}
              {manifest.config.required.includes(name) ? " *" : ""}
              {extension.missing.includes(name) && (
                <span className="text-danger"> — needed</span>
              )}
            </span>
            {field.type === "boolean" ? (
              <input
                id={`setting-${extension.id}-${name}`}
                type="checkbox"
                className="size-4"
                checked={values[name] as boolean}
                onChange={(event) =>
                  setValues({ ...values, [name]: event.target.checked })
                }
              />
            ) : field.enum ? (
              <select
                id={`setting-${extension.id}-${name}`}
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={values[name] as string}
                onChange={(event) =>
                  setValues({ ...values, [name]: event.target.value })
                }
              >
                <option value="">—</option>
                {field.enum.map((choice) => (
                  <option key={String(choice)} value={String(choice)}>
                    {String(choice)}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id={`setting-${extension.id}-${name}`}
                type={
                  field.secret
                    ? "password"
                    : field.type === "string"
                      ? "text"
                      : "number"
                }
                autoComplete="off"
                placeholder={
                  field.secret && extension.secretNames.includes(name)
                    ? "Saved — type to replace"
                    : field.default !== undefined
                      ? `Default: ${field.default}`
                      : ""
                }
                value={values[name] as string}
                onChange={(event) =>
                  setValues({ ...values, [name]: event.target.value })
                }
              />
            )}
            {field.description && (
              <span className="text-muted-foreground">{field.description}</span>
            )}
          </label>
        ))}
        <label
          htmlFor={`labels-${extension.id}`}
          className="grid gap-1 text-xs"
        >
          Run only on machines labelled
          <Input
            id={`labels-${extension.id}`}
            placeholder="Any machine with Deno"
            value={labels}
            onChange={(event) => setLabels(event.target.value)}
          />
        </label>
        <div className="flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={extension.enabled}
              onChange={(event) =>
                void act(() =>
                  call(`/api/extensions/${extension.id}`, "PATCH", {
                    enabled: event.target.checked,
                  }),
                )
              }
            />
            On
          </label>
          <Button type="submit" variant="outline">
            Save settings
          </Button>
        </div>
      </form>
    </Section>
  );
}
function Triggers({
  extension,
  act,
}: {
  extension: Extension;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const manifest = extension.manifest as ExtensionManifest;
  return (
    <Section title="Triggers">
      {manifest.triggers.map((trigger) => (
        <div
          key={trigger.name}
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
        >
          <div className="min-w-0">
            <span className="font-medium">{trigger.name}</span>{" "}
            <span className="text-muted-foreground">
              {trigger.type === "cron"
                ? `${trigger.cron} (${trigger.timezone})`
                : "webhook"}
            </span>
            {trigger.type === "webhook" && (
              <code className="mt-1 block break-all text-xs text-muted-foreground">
                {`${location.origin}/api/hooks/${extension.id}/${trigger.name}/${extension.webhookToken}`}
              </code>
            )}
          </div>
          <div className="flex gap-2">
            {trigger.type === "webhook" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (
                    confirm(
                      "Make a new webhook address? The old one stops working.",
                    )
                  )
                    void act(() =>
                      call(`/api/extensions/${extension.id}`, "PATCH", {
                        rotateWebhook: true,
                      }),
                    );
                }}
              >
                New address
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={!extension.enabled}
              onClick={() =>
                void act(() =>
                  call(`/api/extensions/${extension.id}`, "POST", {
                    action: "run",
                    trigger: trigger.name,
                  }),
                )
              }
            >
              Run now
            </Button>
          </div>
        </div>
      ))}
    </Section>
  );
}
function Subscriptions({
  id,
  detail,
  act,
}: {
  id: string;
  detail: Detail;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const { tree } = useTree();
  const [sessionId, setSessionId] = useState("");
  const [types, setTypes] = useState("");
  const subscribed = new Set(
    detail.subscriptions.map((item) => item.sessionId),
  );
  const workspace = (workspaceId: string) =>
    tree.workspaces.find((item) => item.id === workspaceId)?.name ?? "";
  return (
    <Section title="Sends new events to">
      {detail.subscriptions.length ? (
        detail.subscriptions.map((subscription) => (
          <div
            key={subscription.id}
            className="flex items-center justify-between gap-2 text-sm"
          >
            <span className="min-w-0 truncate">
              {subscription.session
                ? `${workspace(subscription.session.workspaceId)} / ${subscription.session.title}`
                : subscription.sessionId}
              {subscription.types.length > 0 && (
                <span className="text-muted-foreground">
                  {" "}
                  · only {subscription.types.join(", ")}
                </span>
              )}
              {subscription.createdBy !== "owner" && (
                <span className="text-muted-foreground"> · by its agent</span>
              )}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void act(() =>
                  call(`/api/extensions/${id}`, "POST", {
                    action: "unsubscribe",
                    sessionId: subscription.sessionId,
                  }),
                )
              }
            >
              Remove
            </Button>
          </div>
        ))
      ) : (
        <p className="text-sm text-muted-foreground">
          No conversation yet. Events are kept but nobody is told.
        </p>
      )}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void act(async () => {
            await call(`/api/extensions/${id}`, "POST", {
              action: "subscribe",
              sessionId,
              ...(types.trim() ? { types } : {}),
            });
            setSessionId("");
            setTypes("");
          });
        }}
      >
        <select
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
          value={sessionId}
          onChange={(event) => setSessionId(event.target.value)}
          required
        >
          <option value="">Choose a conversation…</option>
          {tree.sessions
            .filter((session) => !subscribed.has(session.id))
            .map((session) => (
              <option key={session.id} value={session.id}>
                {workspace(session.workspaceId)} / {session.title}
              </option>
            ))}
        </select>
        <Input
          className="w-40"
          placeholder="Only types (optional)"
          value={types}
          onChange={(event) => setTypes(event.target.value)}
        />
        <Button variant="outline" disabled={!sessionId}>
          Add
        </Button>
      </form>
    </Section>
  );
}
function Runs({ runs }: { runs: ExtensionRun[] }) {
  return (
    <Section title="Recent runs">
      {runs.length ? (
        <div className="grid gap-1">
          {runs.map((run) => (
            <details
              key={run.id}
              className="rounded-md border px-3 py-2 text-sm"
            >
              <summary className="flex cursor-pointer flex-wrap gap-x-3">
                <span>{timeAgo(run.createdAt)}</span>
                <span className="text-muted-foreground">{run.trigger}</span>
                <span
                  className={
                    run.status === "failed" ? "text-danger" : "text-foreground"
                  }
                >
                  {run.status}
                  {run.status === "completed" ? `, ${run.events} new` : ""}
                </span>
                <span className="text-muted-foreground">r{run.revision}</span>
              </summary>
              {run.error && (
                <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs text-danger">
                  {run.error}
                </pre>
              )}
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                {run.logs || "No output."}
              </pre>
            </details>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No runs yet.</p>
      )}
    </Section>
  );
}
function Events({ events }: { events: ExtensionEventRecord[] }) {
  if (!events.length) return null;
  return (
    <Section title="Recent events">
      <ul className="grid gap-1 text-sm">
        {events.map((event) => (
          <li key={event.id} className="min-w-0 truncate">
            <span className="text-muted-foreground">
              {timeAgo(event.createdAt)} ·{" "}
            </span>
            {event.url ? (
              <a
                href={event.url}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:underline"
              >
                {event.title}
              </a>
            ) : (
              event.title
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}
function Revisions({
  id,
  detail,
  act,
}: {
  id: string;
  detail: Detail;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  if (detail.revisions.length < 2) return null;
  return (
    <Section title="Revisions">
      {detail.revisions.map((revision) => (
        <div
          key={revision.revision}
          className="flex items-center justify-between gap-2 text-sm"
        >
          <span>
            r{revision.revision} · v{revision.manifest.version} ·{" "}
            {revision.revision === detail.extension.activeRevision
              ? "running"
              : revision.status}{" "}
            <span className="text-muted-foreground">
              {timeAgo(revision.createdAt)}
            </span>
          </span>
          {revision.status === "approved" &&
            revision.revision !== detail.extension.activeRevision && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void act(() =>
                    call(`/api/extensions/${id}`, "POST", {
                      action: "approve",
                      revision: revision.revision,
                    }),
                  )
                }
              >
                Go back to this
              </Button>
            )}
        </div>
      ))}
    </Section>
  );
}
