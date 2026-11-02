/** Owner-approved scripts, their runs, and the events they hand to sessions. */
export const extensionSchema = `
CREATE TABLE IF NOT EXISTS extensions (
 id TEXT PRIMARY KEY, activeRevision INTEGER, enabled INTEGER NOT NULL DEFAULT 0,
 config TEXT NOT NULL DEFAULT '{}', secrets TEXT, requiredLabels TEXT, webhookToken TEXT NOT NULL,
 createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS extension_revisions (
 extensionId TEXT NOT NULL REFERENCES extensions(id), revision INTEGER NOT NULL, manifest TEXT NOT NULL,
 code TEXT NOT NULL, hash TEXT NOT NULL, status TEXT NOT NULL, proposedBy TEXT NOT NULL, note TEXT,
 createdAt INTEGER NOT NULL, decidedAt INTEGER, PRIMARY KEY(extensionId, revision)
);
CREATE TABLE IF NOT EXISTS extension_timers (
 extensionId TEXT NOT NULL REFERENCES extensions(id), trigger TEXT NOT NULL, revision INTEGER NOT NULL,
 nextAt INTEGER NOT NULL, PRIMARY KEY(extensionId, trigger)
);
CREATE TABLE IF NOT EXISTS extension_runs (
 id TEXT PRIMARY KEY, extensionId TEXT NOT NULL REFERENCES extensions(id), revision INTEGER NOT NULL,
 trigger TEXT NOT NULL, input TEXT, status TEXT NOT NULL, workerId TEXT, leaseUntil INTEGER,
 events INTEGER NOT NULL DEFAULT 0, logs TEXT, error TEXT, createdAt INTEGER NOT NULL,
 startedAt INTEGER, finishedAt INTEGER
);
CREATE INDEX IF NOT EXISTS extension_runs_status ON extension_runs(status, createdAt);
CREATE INDEX IF NOT EXISTS extension_runs_extension ON extension_runs(extensionId, createdAt);
CREATE TABLE IF NOT EXISTS extension_state (
 extensionId TEXT NOT NULL REFERENCES extensions(id), key TEXT NOT NULL, value TEXT NOT NULL,
 PRIMARY KEY(extensionId, key)
);
CREATE TABLE IF NOT EXISTS extension_events (
 id TEXT PRIMARY KEY, extensionId TEXT NOT NULL REFERENCES extensions(id), key TEXT NOT NULL,
 runId TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, url TEXT, data TEXT,
 createdAt INTEGER NOT NULL, UNIQUE(extensionId, key)
);
CREATE INDEX IF NOT EXISTS extension_events_recent ON extension_events(extensionId, createdAt);
CREATE TABLE IF NOT EXISTS extension_subscriptions (
 id TEXT PRIMARY KEY, extensionId TEXT NOT NULL REFERENCES extensions(id),
 sessionId TEXT NOT NULL REFERENCES sessions(id), types TEXT, createdBy TEXT NOT NULL,
 createdAt INTEGER NOT NULL, UNIQUE(extensionId, sessionId)
);
CREATE TABLE IF NOT EXISTS extension_deliveries (
 turnId TEXT PRIMARY KEY, extensionId TEXT NOT NULL, runId TEXT NOT NULL, events INTEGER NOT NULL,
 createdAt INTEGER NOT NULL
);
`;
