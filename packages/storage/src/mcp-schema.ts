export const mcpSchema = `
CREATE TABLE IF NOT EXISTS mcp_discovery_snapshots (
 connectionId TEXT PRIMARY KEY REFERENCES integration_connections(id) ON DELETE CASCADE, revision TEXT,
 descriptors TEXT, status TEXT NOT NULL, error TEXT, testedAt INTEGER NOT NULL
);
`;
