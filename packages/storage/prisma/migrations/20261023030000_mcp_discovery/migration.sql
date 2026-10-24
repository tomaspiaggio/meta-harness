CREATE TABLE mcp_discovery_snapshots (
 "connectionId" TEXT PRIMARY KEY REFERENCES integration_connections(id) ON DELETE CASCADE, revision TEXT,
 descriptors TEXT, status TEXT NOT NULL, error TEXT, "testedAt" BIGINT NOT NULL
);
