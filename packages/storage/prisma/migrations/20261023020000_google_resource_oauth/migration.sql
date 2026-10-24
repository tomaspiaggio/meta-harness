
CREATE TABLE IF NOT EXISTS google_account_authorizations (
 "connectionId" TEXT PRIMARY KEY REFERENCES integration_connections(id) ON DELETE CASCADE,
 subject TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', scopes TEXT NOT NULL DEFAULT '[]',
 status TEXT NOT NULL DEFAULT 'disconnected', revision INTEGER NOT NULL DEFAULT 0,
 "lockOwner" TEXT, "lockUntil" INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS google_credentials (
 "connectionId" TEXT PRIMARY KEY REFERENCES google_account_authorizations("connectionId") ON DELETE CASCADE,
 cipher TEXT NOT NULL, revision INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS google_oauth_states (
 "stateHash" TEXT PRIMARY KEY, "ownerHash" TEXT NOT NULL,
 "connectionId" TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
 "connectionRevision" TEXT NOT NULL, "verifierCipher" TEXT NOT NULL, nonce TEXT NOT NULL,
 scopes TEXT NOT NULL, "redirectUri" TEXT NOT NULL, "expiresAt" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS google_oauth_expiry ON google_oauth_states("expiresAt");
