"use client";
import type {
  IntegrationConnection,
  IntegrationDefinition,
  WorkspaceIntegrationBinding,
} from "@harness/core/integrations";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Integrations</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p>
          Connections are described tool collections. Select tools explicitly
          for each workspace. Reconnect or rediscover requires reviewing changed
          grants.
        </p>
        {setup}
        {error && <p role="alert">{error}</p>}
        {state.connections.map((connection) => {
          const definition = state.definitions.find(
            (d) => d.id === connection.integrationId,
          );
          return (
            <div key={connection.id} className="space-y-2 rounded border p-3">
              <strong>{connection.label}</strong>
              <p>{definition?.description}</p>
              <p>
                {connection.adapter} ·{" "}
                {connection.enabled ? "Enabled" : "Disabled"} ·{" "}
                {definition?.tools.length ?? 0} tools
              </p>
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
                <label>
                  Label{" "}
                  <input
                    name="label"
                    defaultValue={connection.label}
                    maxLength={100}
                    required
                    className="rounded border p-1"
                  />
                </label>
                <label>
                  <input
                    name="enabled"
                    type="checkbox"
                    defaultChecked={connection.enabled}
                  />{" "}
                  Enabled
                </label>
                <Button type="submit" variant="outline">
                  Save connection
                </Button>
              </form>
              {connectionSetup?.(connection)}
              <Button
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
              </Button>{" "}
              <Button
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
                variant="outline"
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
                    className="rounded border p-2"
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
                    <strong>{workspace.name}</strong>
                    {stale && (
                      <p>
                        Tool or connection revision changed. Review and save to
                        accept.
                      </p>
                    )}
                    <label className="block">
                      <input
                        type="checkbox"
                        name="enabled"
                        defaultChecked={old?.enabled ?? false}
                        key={`enabled-${old?.revision}`}
                      />{" "}
                      Enable selected tools
                    </label>
                    {definition?.tools.map((tool) => (
                      <label
                        key={`${old?.revision}-${definition.revision}-${tool.id}`}
                        className="block"
                      >
                        <input
                          type="checkbox"
                          name="tools"
                          value={tool.id}
                          defaultChecked={
                            old?.toolIds.includes(tool.id) ?? false
                          }
                        />{" "}
                        {tool.name} ({tool.effect}) — {tool.description}
                      </label>
                    ))}
                    <Button type="submit" variant="outline">
                      Save reviewed access
                    </Button>
                  </form>
                );
              })}
            </div>
          );
        })}
        {state.connections.length === 0 && (
          <p>
            No connections configured. Adding a connection grants no workspace
            access.
          </p>
        )}
        <Button
          variant="outline"
          onClick={() => void load().catch((e) => setError(e.message))}
        >
          Refresh integrations
        </Button>
      </CardContent>
    </Card>
  );
}
