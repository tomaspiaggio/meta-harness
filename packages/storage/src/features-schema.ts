export const featureSchema = `
CREATE TABLE IF NOT EXISTS deleted_resources (kind TEXT NOT NULL, id TEXT NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY(kind,id));
CREATE TABLE IF NOT EXISTS worker_cleanup (workerId TEXT NOT NULL REFERENCES workers(id), kind TEXT NOT NULL, resourceId TEXT NOT NULL, PRIMARY KEY(workerId,kind,resourceId));
CREATE TABLE IF NOT EXISTS cleanup_jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, nextAt INTEGER NOT NULL, leaseUntil INTEGER, error TEXT);

CREATE TABLE IF NOT EXISTS schedules (
 id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id), name TEXT NOT NULL,
 prompt TEXT NOT NULL, kind TEXT NOT NULL, trigger TEXT NOT NULL, maxLatenessMs INTEGER NOT NULL,
 revision INTEGER NOT NULL, status TEXT NOT NULL, nextAt INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules(status, nextAt);
CREATE TABLE IF NOT EXISTS schedule_occurrences (
 id TEXT PRIMARY KEY, scheduleId TEXT NOT NULL REFERENCES schedules(id), revision INTEGER NOT NULL,
 plannedAt INTEGER NOT NULL, firedAt INTEGER NOT NULL, turnId TEXT REFERENCES turns(id), outcome TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
 id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id), name TEXT NOT NULL,
 mediaType TEXT NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL, objectKey TEXT NOT NULL, createdAt INTEGER NOT NULL
 ,status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS turn_attachments (
 turnId TEXT NOT NULL REFERENCES turns(id), attachmentId TEXT NOT NULL REFERENCES attachments(id),
 PRIMARY KEY(turnId, attachmentId)
);
CREATE TABLE IF NOT EXISTS channel_bindings (
 sessionId TEXT PRIMARY KEY REFERENCES sessions(id), platform TEXT NOT NULL, chatId TEXT NOT NULL,
 topicId TEXT, title TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, UNIQUE(platform, chatId, topicId)
);
CREATE TABLE IF NOT EXISTS notification_outbox (
 id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id), kind TEXT NOT NULL,
 referenceId TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 nextAt INTEGER NOT NULL, leaseUntil INTEGER, receipt TEXT, error TEXT, createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_due ON notification_outbox(status, nextAt);
CREATE TABLE IF NOT EXISTS browser_identities (
 id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL,
 workerId TEXT, status TEXT NOT NULL DEFAULT 'idle', mode TEXT NOT NULL DEFAULT 'agent',
 generation INTEGER NOT NULL DEFAULT 0, leaseUntil INTEGER, userPublicKey TEXT, expiresAt INTEGER,
 lastUrl TEXT, frame TEXT, frameAt INTEGER, error TEXT, stateCipher TEXT, updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS browser_polls (
 id TEXT PRIMARY KEY, workerId TEXT NOT NULL REFERENCES workers(id), commands TEXT NOT NULL, createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS browser_commands (
 id TEXT PRIMARY KEY, browserId TEXT NOT NULL REFERENCES browser_identities(id),
 turnId TEXT REFERENCES turns(id), turnGeneration INTEGER, browserGeneration INTEGER NOT NULL,
 action TEXT NOT NULL, arguments TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 result TEXT, error TEXT, createdAt INTEGER NOT NULL, completedAt INTEGER
);
CREATE INDEX IF NOT EXISTS browser_commands_queue ON browser_commands(status, createdAt);
CREATE TABLE IF NOT EXISTS owner_sessions (
 id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oidc_states (
 id TEXT PRIMARY KEY, verifier TEXT NOT NULL, nonce TEXT NOT NULL, expiresAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS input_requests (
 id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id), turnId TEXT REFERENCES turns(id),
 kind TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL, response TEXT,
 createdAt INTEGER NOT NULL, resolvedAt INTEGER
);
CREATE TABLE IF NOT EXISTS workspace_resources (
 workspaceId TEXT PRIMARY KEY REFERENCES workspaces(id), policy TEXT NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sandbox_jobs (
 id TEXT PRIMARY KEY, turnId TEXT NOT NULL REFERENCES turns(id), workerId TEXT, sandboxId TEXT,
 status TEXT NOT NULL, expiresAt INTEGER NOT NULL, error TEXT, createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS operation_ledger (
 id TEXT PRIMARY KEY, turnId TEXT NOT NULL REFERENCES turns(id), hash TEXT NOT NULL, state TEXT NOT NULL,
 receipt TEXT, error TEXT, updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS worker_grants (
 workerId TEXT PRIMARY KEY REFERENCES workers(id), turnId TEXT NOT NULL REFERENCES turns(id), expiresAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS title_jobs (
 sessionId TEXT PRIMARY KEY REFERENCES sessions(id), status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 leaseUntil INTEGER, error TEXT, createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS telegram_inbox (
 id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, leaseUntil INTEGER, error TEXT, createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS telegram_updates (
 id TEXT PRIMARY KEY, sessionId TEXT REFERENCES sessions(id), result TEXT, createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule_wakes (
 id TEXT PRIMARY KEY, scheduleId TEXT NOT NULL REFERENCES schedules(id), revision INTEGER NOT NULL,
 dueAt INTEGER NOT NULL, runId TEXT, leaseUntil INTEGER, createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_waiters (
 runId TEXT PRIMARY KEY, turnId TEXT NOT NULL REFERENCES turns(id), createdAt INTEGER NOT NULL, deliveredAt INTEGER
);
CREATE TABLE IF NOT EXISTS workflow_wakeups (
 turnId TEXT PRIMARY KEY REFERENCES turns(id), createdAt INTEGER NOT NULL, deliveredAt INTEGER
);
CREATE TABLE IF NOT EXISTS integration_definitions (
 id TEXT PRIMARY KEY, revision TEXT NOT NULL, record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS integration_connections (
 id TEXT PRIMARY KEY, integrationId TEXT NOT NULL REFERENCES integration_definitions(id), revision TEXT NOT NULL, record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS integration_bindings (
 workspaceId TEXT NOT NULL REFERENCES workspaces(id), connectionId TEXT NOT NULL REFERENCES integration_connections(id), revision TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(workspaceId, connectionId)
);
`;
