import type { IntegrationDefinition } from "@harness/core/integrations";
import type { SqlDatabase } from "./database";
export class McpDiscoveryStore {
  constructor(private db: SqlDatabase) {}
  async save(
    connectionId: string,
    definition: IntegrationDefinition | null,
    error?: string,
  ) {
    await this.db
      .prepare(
        "INSERT INTO mcp_discovery_snapshots(connectionId,revision,descriptors,status,error,testedAt) VALUES (?,?,?,?,?,?) ON CONFLICT(connectionId) DO UPDATE SET revision=excluded.revision,descriptors=COALESCE(excluded.descriptors,mcp_discovery_snapshots.descriptors),status=excluded.status,error=excluded.error,testedAt=excluded.testedAt",
      )
      .run(
        connectionId,
        definition?.revision ?? null,
        definition ? JSON.stringify(definition) : null,
        definition ? "ready" : "error",
        error?.slice(0, 500) ?? null,
        Date.now(),
      );
  }
  async list() {
    return this.db
      .prepare(
        "SELECT connectionId,revision,status,error,testedAt FROM mcp_discovery_snapshots",
      )
      .all();
  }
}
