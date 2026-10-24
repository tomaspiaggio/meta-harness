"use client";
import type {
  IntegrationConnection,
  IntegrationDefinition,
  WorkspaceIntegrationBinding,
} from "@harness/core/integrations";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
export type IntegrationSetupProps = { onCreated: () => void };
export function Integrations({
  setup,
  connectionSetup,
}: {
  setup?: React.ReactNode;
  connectionSetup?: (connection: IntegrationConnection) => React.ReactNode;
}) {
  const [state, setState] = useState<{
    connections: IntegrationConnection[];
    definitions: IntegrationDefinition[];
    bindings: WorkspaceIntegrationBinding[];
    workspaces: { id: string; name: string }[];
  }>({ connections: [], definitions: [], bindings: [], workspaces: [] });
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const response = await fetch("/api/integrations");
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    setState(body);
  }, []);
  useEffect(() => {
    const refresh = () => {
      void load().catch((e) => setError(e.message));
    };
    refresh();
    window.addEventListener("integrations-changed", refresh);
    return () => window.removeEventListener("integrations-changed", refresh);
  }, [load]);
  async function action(body: unknown) {
    setError("");
    try {
      const response = await fetch("/api/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      // Google setup progress and workspace limits read the same grants.
      window.dispatchEvent(new Event("integrations-changed"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Integrations</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          Connections are described tool collections. Select tools explicitly
          for each workspace. Reconnect or rediscover requires reviewing changed
          grants.
        </p>
        {setup}
        {error && (
          <p
            role="alert"
            className="rounded-md bg-danger-soft px-3 py-2 text-danger"
          >
            {error}
          </p>
        )}
        {state.connections.length > 0 && (
          <h3 className="pt-2 font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
            Connections
          </h3>
        )}
        {state.connections.map((connection) => {
          const definition = state.definitions.find(
            (d) => d.id === connection.integrationId,
          );
          return (
            <div
              key={connection.id}
              className="space-y-3 rounded-lg border bg-background/40 p-4"
            >
              <div className="space-y-1">
                <p className="flex flex-wrap items-center gap-2">
                  <strong className="font-medium">{connection.label}</strong>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${connection.enabled ? "bg-success-soft text-success" : "bg-muted text-muted-foreground"}`}
                  >
                    {connection.enabled ? "Enabled" : "Disabled"}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {definition?.name ?? connection.adapter} ·{" "}
                  {definition?.tools.length ?? 0} tools
                  {definition?.description
                    ? ` · ${definition.description}`
                    : ""}
                </p>
              </div>
              <form
                className="flex flex-wrap items-center gap-2"
                key={connection.revision}
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  void action({
                    action: "connection",
                    expectedRevision: connection.revision,
                    connection: {
                      ...connection,
                      label: String(form.get("label") ?? ""),
                      enabled: form.get("enabled") === "on",
                      revision: crypto.randomUUID(),
                    },
                  });
                }}
              >
                <label
                  htmlFor={`connection-label-${connection.id}`}
                  className="flex min-w-48 flex-1 items-center gap-2"
                >
                  <span className="text-xs text-muted-foreground">Label</span>
                  <Input
                    id={`connection-label-${connection.id}`}
                    name="label"
                    defaultValue={connection.label}
                    maxLength={100}
                    required
                    className="h-8"
                  />
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    name="enabled"
                    type="checkbox"
                    className="accent-primary"
                    defaultChecked={connection.enabled}
                  />
                  Enabled
                </label>
                <Button type="submit" size="sm" variant="outline">
                  Save connection
                </Button>
              </form>
              {connectionSetup?.(connection)}
              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void action({
                      action: "discover",
                      connectionId: connection.id,
                      expectedRevision: connection.revision,
                    })
                  }
                >
                  Test and discover
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void action({
                      action: "disable",
                      connectionId: connection.id,
                      expectedRevision: connection.revision,
                    })
                  }
                >
                  Disable connection
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger hover:text-danger"
                  onClick={() =>
                    void action({
                      action: "delete",
                      connectionId: connection.id,
                      expectedRevision: connection.revision,
                    })
                  }
                >
                  Delete connection
                </Button>
              </div>
              {state.workspaces.map((workspace) => {
                const old = state.bindings.find(
                  (b) =>
                    b.workspaceId === workspace.id &&
                    b.connectionId === connection.id,
                );
                const stale =
                  old &&
                  (old.connectionRevision !== connection.revision ||
                    old.integrationRevision !== definition?.revision);
                return (
                  <form
                    key={workspace.id}
                    className="space-y-2 rounded-md border bg-card p-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const data = new FormData(e.currentTarget);
                      void action({
                        action: "binding",
                        expectedRevision: old?.revision,
                        binding: {
                          workspaceId: workspace.id,
                          connectionId: connection.id,
                          revision: crypto.randomUUID(),
                          connectionRevision: connection.revision,
                          integrationRevision: definition?.revision,
                          toolIds: data.getAll("tools"),
                          constraints: old?.constraints ?? {},
                          enabled: data.get("enabled") === "on",
                        },
                      });
                    }}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <strong className="font-medium">{workspace.name}</strong>
                      {stale ? (
                        <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning">
                          Review needed
                        </span>
                      ) : old?.enabled && old.toolIds.length ? (
                        <span className="rounded-full bg-success-soft px-2 py-0.5 text-xs font-medium text-success">
                          {old.toolIds.length} granted
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          No access
                        </span>
                      )}
                    </div>
                    {stale && (
                      <p className="text-xs text-warning">
                        Tool or connection revision changed. Review and save to
                        accept.
                      </p>
                    )}
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        className="accent-primary"
                        name="enabled"
                        defaultChecked={old?.enabled ?? false}
                        key={`enabled-${old?.revision}`}
                      />
                      Enable selected tools
                    </label>
                    <div className="grid gap-1 sm:grid-cols-2">
                      {definition?.tools.map((tool) => (
                        <label
                          key={`${old?.revision}-${definition.revision}-${tool.id}`}
                          className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-accent/60"
                          title={tool.description}
                        >
                          <input
                            type="checkbox"
                            name="tools"
                            className="mt-0.5 accent-primary"
                            value={tool.id}
                            defaultChecked={
                              old?.toolIds.includes(tool.id) ?? false
                            }
                          />
                          <span className="block min-w-0">
                            <span className="font-mono text-xs">
                              {tool.name}
                            </span>{" "}
                            <span className="text-xs text-muted-foreground">
                              {tool.effect}
                            </span>
                            <span className="line-clamp-2 text-xs text-muted-foreground">
                              {tool.description}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                    <Button type="submit" size="sm" variant="outline">
                      Save reviewed access
                    </Button>
                  </form>
                );
              })}
            </div>
          );
        })}
        {state.connections.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No connections configured. Adding a connection grants no workspace
            access.
          </p>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void load().catch((e) => setError(e.message))}
        >
          Refresh integrations
        </Button>
      </CardContent>
    </Card>
  );
}
