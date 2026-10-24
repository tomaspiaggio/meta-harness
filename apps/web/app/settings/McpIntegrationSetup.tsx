"use client";
import type { IntegrationConnection } from "@harness/core/integrations";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
export function McpIntegrationSetup() {
  const [label, setLabel] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [header, setHeader] = useState("Authorization");
  const [secret, setSecret] = useState("");
  const [allowPrivate, setAllowPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [health, setHealth] = useState<
    {
      connectionId: string;
      status: string;
      error: string | null;
      testedAt: number;
    }[]
  >([]);
  async function refreshHealth() {
    try {
      const response = await fetch("/api/integrations/mcp");
      if (response.ok) setHealth(await response.json());
    } catch {
      /* Owner can explicitly retry status. */
    }
  }
  return (
    <details className="rounded-lg border bg-background/40">
      <summary className="cursor-pointer px-4 py-3 font-serif text-lg leading-tight select-none">
        MCP server
        <span className="ml-2 font-sans text-xs text-muted-foreground">
          Add a remote HTTP tool collection
        </span>
      </summary>
      <form
        className="grid gap-2 border-t px-4 py-3"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          setNotice("");
          try {
            const response = await fetch("/api/integrations/mcp", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                label,
                config: {
                  endpoint,
                  allowPrivate,
                  headerRefs: secret ? { [header]: secret } : {},
                },
              }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error);
            setNotice(
              "Connection discovered. Review and save the tools each workspace may use.",
            );
            window.dispatchEvent(new Event("integrations-changed"));
            await refreshHealth();
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label
          htmlFor="mcp-label"
          className="grid gap-1 text-xs text-muted-foreground"
        >
          Connection label
          <Input
            id="mcp-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            required
            maxLength={100}
          />
        </label>
        <label
          htmlFor="mcp-endpoint"
          className="grid gap-1 text-xs text-muted-foreground"
        >
          Streamable HTTP endpoint
          <Input
            id="mcp-endpoint"
            type="url"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://tools.example.com/mcp"
            required
          />
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            className="accent-primary"
            checked={allowPrivate}
            onChange={(e) => setAllowPrivate(e.target.checked)}
          />
          Approve this private or loopback destination from the control server
        </label>
        <label
          htmlFor="mcp-header"
          className="grid gap-1 text-xs text-muted-foreground"
        >
          Authentication header
          <Input
            id="mcp-header"
            value={header}
            onChange={(e) => setHeader(e.target.value)}
            placeholder="Authorization"
          />
        </label>
        <label
          htmlFor="mcp-secret"
          className="grid gap-1 text-xs text-muted-foreground"
        >
          Server-side secret reference (optional)
          <Input
            id="mcp-secret"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="work-mcp-authorization"
          />
        </label>
        <p className="text-xs text-muted-foreground">
          Configure HARNESS_SECRET_BINDINGS to map this reference to a
          JOB_SECRET_ environment variable on the control server. Its value is
          the complete header value, including Bearer when required. Enter only
          the reference here.
        </p>
        <p className="text-xs text-muted-foreground">
          Supports protocol 2025-06-18, JSON and SSE responses, up to 100 tools.
          Each discovered tool starts with unknown effect and requires an
          operation ID. Upstream read-only annotations do not grant access.
          OAuth-only servers and stdio need a later release.
        </p>
        <Button disabled={busy} type="submit" className="justify-self-start">
          {busy ? "Testing discovery…" : "Test and add MCP connection"}
        </Button>
        {error && (
          <p
            role="alert"
            className="rounded-md bg-danger-soft px-3 py-2 text-danger"
          >
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-primary">
            {notice}
          </p>
        )}
      </form>
      <div className="space-y-1 px-4 pb-3">
        <Button size="sm" variant="ghost" onClick={() => void refreshHealth()}>
          Refresh last explicit tests
        </Button>
        {health.map((item) => (
          <p key={item.connectionId} className="text-xs text-muted-foreground">
            {item.connectionId}: {item.status} ·{" "}
            {new Date(item.testedAt).toLocaleString()}
            {item.error ? ` — ${item.error}` : ""}
          </p>
        ))}
      </div>
    </details>
  );
}

export function McpConnectionSettings({
  connection,
}: {
  connection: IntegrationConnection;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (connection.adapter !== "mcp") return null;
  const refs =
    connection.config.headerRefs &&
    typeof connection.config.headerRefs === "object"
      ? Object.entries(connection.config.headerRefs)
          .map(([header, reference]) => `${header}=${reference}`)
          .join("\n")
      : "";
  return (
    <details key={connection.revision}>
      <summary>Edit MCP endpoint and secret references</summary>
      <form
        className="grid gap-2 py-2"
        onSubmit={async (event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          setError("");
          setBusy(true);
          try {
            const headerRefs: Record<string, string> = {};
            for (const line of String(data.get("headers") ?? "").split("\n")) {
              if (!line.trim()) continue;
              const split = line.indexOf("=");
              if (split < 1)
                throw new Error("Use Header=secret-reference, one per line.");
              headerRefs[line.slice(0, split).trim()] = line
                .slice(split + 1)
                .trim();
            }
            const response = await fetch("/api/integrations/mcp", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                connectionId: connection.id,
                expectedRevision: connection.revision,
                config: {
                  endpoint: data.get("endpoint"),
                  allowPrivate: data.get("private") === "on",
                  headerRefs,
                },
              }),
            });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error);
            window.dispatchEvent(new Event("integrations-changed"));
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Endpoint{" "}
          <input
            name="endpoint"
            type="url"
            defaultValue={String(connection.config.endpoint ?? "")}
            required
            className="w-full rounded border p-1"
          />
        </label>
        <label>
          <input
            name="private"
            type="checkbox"
            defaultChecked={connection.config.allowPrivate === true}
          />{" "}
          Approve reachable private or loopback destination
        </label>
        <label>
          Header=secret-reference, one per line{" "}
          <textarea
            name="headers"
            defaultValue={refs}
            className="w-full rounded border p-1"
          />
        </label>
        <p>
          Use secret references only. Saving tests discovery and requires
          reviewing workspace grants again.
        </p>
        <Button type="submit" variant="outline" disabled={busy}>
          {busy ? "Testing…" : "Test and save endpoint"}
        </Button>
        {error && <p role="alert">{error}</p>}
      </form>
    </details>
  );
}
