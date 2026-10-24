CREATE TABLE IF NOT EXISTS integration_definitions (
 id TEXT PRIMARY KEY, revision TEXT NOT NULL, record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS integration_connections (
 id TEXT PRIMARY KEY, "integrationId" TEXT NOT NULL REFERENCES integration_definitions(id), revision TEXT NOT NULL, record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS integration_bindings (
 "workspaceId" TEXT NOT NULL REFERENCES workspaces(id), "connectionId" TEXT NOT NULL REFERENCES integration_connections(id), revision TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY("workspaceId", "connectionId")
);
