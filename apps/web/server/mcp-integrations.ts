import { randomUUID } from "node:crypto";
import { HarnessError, requiredText } from "@harness/core";
import type { IntegrationConnection } from "@harness/core/integrations";
import { McpHttpAdapter, parseMcpHttpConfig } from "@harness/mcp";
import { McpDiscoveryStore } from "@harness/storage/mcp";
import { registerIntegrationAdapter } from "./integrations";
import { EnvironmentSecrets } from "./secrets";
import { getStore } from "./store";

const adapter = new McpHttpAdapter(new EnvironmentSecrets(), {
  blockedOrigins: [
    process.env.HARNESS_PUBLIC_URL ?? "",
    process.env.HARNESS_CONTROL_URL ?? "",
    `http://127.0.0.1:${process.env.PORT ?? 3000}`,
    `http://localhost:${process.env.PORT ?? 3000}`,
  ],
});
registerIntegrationAdapter({
  id: "mcp",
  execute: (input) => adapter.execute(input),
  async discover(connection, signal) {
    const store = await getStore();
    const snapshots = new McpDiscoveryStore(store.databaseConnection());
    try {
      const definition = await adapter.discover(connection, signal);
      await snapshots.save(connection.id, definition);
      return definition;
    } catch (error) {
      await snapshots.save(
        connection.id,
        null,
        error instanceof HarnessError ? error.message : "MCP discovery failed.",
      );
      throw error;
    }
  },
});
export async function createMcpConnection(body: Record<string, unknown>) {
  const config = parseMcpHttpConfig(body.config);
  const id = randomUUID();
  const connection: IntegrationConnection = {
    id,
    integrationId: `mcp-${id}`,
    adapter: "mcp",
    label: requiredText(body.label, "Connection label", 100),
    revision: randomUUID(),
    enabled: true,
    config: {
      endpoint: config.endpoint,
      allowPrivate: config.allowPrivate,
      headerRefs: config.headerRefs,
    },
  };
  const definition = await adapter.discover(
    connection,
    AbortSignal.timeout(15000),
  );
  const store = await getStore();
  return store.databaseConnection().transaction(async () => {
    await store.putIntegrationDefinition(definition);
    await store.putIntegrationConnection(connection);
    await new McpDiscoveryStore(store.databaseConnection()).save(
      connection.id,
      definition,
    );
    return { connection, definition };
  });
}
export async function reviseMcpConnection(body: Record<string, unknown>) {
  const store = await getStore();
  const current = (await store.listIntegrationConnections()).find(
    (c) => c.id === body.connectionId,
  );
  if (current?.adapter !== "mcp" || current.revision !== body.expectedRevision)
    throw new HarnessError("MCP connection revision conflict.", 409);
  const config = parseMcpHttpConfig(body.config);
  const connection: IntegrationConnection = {
    ...current,
    revision: randomUUID(),
    config: {
      endpoint: config.endpoint,
      allowPrivate: config.allowPrivate,
      headerRefs: config.headerRefs,
    },
  };
  const definition = await adapter.discover(
    connection,
    AbortSignal.timeout(15000),
  );
  return store.databaseConnection().transaction(async () => {
    await store.putIntegrationConnection(connection, current.revision);
    const old = (await store.listIntegrationDefinitions()).find(
      (d) => d.id === definition.id,
    );
    if (old?.revision !== definition.revision)
      await store.putIntegrationDefinition(definition, old?.revision);
    await new McpDiscoveryStore(store.databaseConnection()).save(
      connection.id,
      definition,
    );
    return { connection, definition };
  });
}
