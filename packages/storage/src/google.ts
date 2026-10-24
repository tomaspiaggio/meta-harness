import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { HarnessError } from "@harness/core";
import type { SqlDatabase } from "./database";

// Structural port avoids storage depending on the Google HTTP/crypto adapter package.
export interface GoogleCredential {
  connectionId: string;
  subject: string;
  email: string;
  scopes: string[];
  cipher: string;
  revision: number;
  refreshExpiresAt?: number | null;
  status: "ready" | "reconnect" | "disconnected";
}
export interface GoogleOAuthState {
  stateHash: string;
  ownerHash: string;
  connectionId: string;
  connectionRevision: string;
  verifierCipher: string;
  nonce: string;
  scopes: string[];
  redirectUri: string;
  expiresAt: number;
}
export class GoogleAuthorizationStore {
  private lock = new AsyncLocalStorage<{
    connectionId: string;
    owner: string;
  }>();
  constructor(private db: SqlDatabase) {}
  async putState(value: GoogleOAuthState) {
    await this.db.transaction(async () => {
      await this.db
        .prepare("DELETE FROM google_oauth_states WHERE expiresAt < ?")
        .run(Date.now());
      const count = await this.db
        .prepare("SELECT COUNT(*) AS count FROM google_oauth_states")
        .get();
      if (Number(count?.count) >= 100)
        throw new HarnessError(
          "Too many pending Google connections. Wait for earlier flows to expire.",
          429,
        );
      await this.db
        .prepare(
          "INSERT INTO google_oauth_states(stateHash,ownerHash,connectionId,connectionRevision,verifierCipher,nonce,scopes,redirectUri,expiresAt) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(
          value.stateHash,
          value.ownerHash,
          value.connectionId,
          value.connectionRevision,
          value.verifierCipher,
          value.nonce,
          JSON.stringify(value.scopes),
          value.redirectUri,
          value.expiresAt,
        );
    });
  }
  async consumeState(
    stateHash: string,
    ownerHash: string,
    now: number,
  ): Promise<GoogleOAuthState | null> {
    return this.db.transaction(async () => {
      const row = await this.db
        .prepare(
          "SELECT * FROM google_oauth_states WHERE stateHash = ? AND ownerHash = ? AND expiresAt > ?",
        )
        .get(stateHash, ownerHash, now);
      if (!row) return null;
      await this.db
        .prepare("DELETE FROM google_oauth_states WHERE stateHash = ?")
        .run(stateHash);
      return {
        stateHash: String(row.stateHash),
        ownerHash: String(row.ownerHash),
        connectionId: String(row.connectionId),
        connectionRevision: String(row.connectionRevision),
        verifierCipher: String(row.verifierCipher),
        nonce: String(row.nonce),
        scopes: JSON.parse(String(row.scopes)),
        redirectUri: String(row.redirectUri),
        expiresAt: Number(row.expiresAt),
      };
    });
  }
  async getCredential(connectionId: string): Promise<GoogleCredential | null> {
    const row = await this.db
      .prepare(
        "SELECT a.connectionId,a.subject,a.email,a.scopes,a.status,a.revision,a.refreshExpiresAt,c.cipher FROM google_account_authorizations a LEFT JOIN google_credentials c ON c.connectionId = a.connectionId WHERE a.connectionId = ?",
      )
      .get(connectionId);
    return row
      ? {
          connectionId,
          subject: String(row.subject),
          email: String(row.email),
          scopes: JSON.parse(String(row.scopes)),
          status: String(row.status) as GoogleCredential["status"],
          revision: Number(row.revision),
          refreshExpiresAt:
            row.refreshExpiresAt === null ? null : Number(row.refreshExpiresAt),
          cipher: String(row.cipher ?? ""),
        }
      : null;
  }
  async saveCredential(value: GoogleCredential, expectedRevision: number) {
    const lock = this.lock.getStore();
    if (
      lock?.connectionId !== value.connectionId ||
      value.revision !== expectedRevision + 1
    )
      throw new HarnessError(
        "Google credential update requires its current lock.",
        409,
      );
    await this.db.transaction(async () => {
      const update = await this.db
        .prepare(
          "UPDATE google_account_authorizations SET subject=?,email=?,scopes=?,status=?,revision=?,refreshExpiresAt=? WHERE connectionId=? AND revision=? AND lockOwner=? AND lockUntil>?",
        )
        .run(
          value.subject,
          value.email,
          JSON.stringify(value.scopes),
          value.status,
          value.revision,
          value.refreshExpiresAt ?? null,
          value.connectionId,
          expectedRevision,
          lock.owner,
          Date.now(),
        );
      if (update.changes !== 1)
        throw new HarnessError(
          "Google authorization changed. Refresh and reconnect if needed.",
          409,
        );
      if (value.status === "disconnected") {
        await this.db
          .prepare("DELETE FROM google_credentials WHERE connectionId = ?")
          .run(value.connectionId);
        await this.db
          .prepare("DELETE FROM google_oauth_states WHERE connectionId = ?")
          .run(value.connectionId);
      } else {
        await this.db
          .prepare(
            "INSERT INTO google_credentials(connectionId,cipher,revision) VALUES (?,?,?) ON CONFLICT(connectionId) DO UPDATE SET cipher=excluded.cipher,revision=excluded.revision",
          )
          .run(value.connectionId, value.cipher, value.revision);
      }
    });
  }
  async locked<T>(connectionId: string, action: () => Promise<T>): Promise<T> {
    if (this.lock.getStore())
      throw new HarnessError(
        "Nested Google credential access is unavailable.",
        409,
      );
    const owner = randomUUID();
    const now = Date.now();
    // This short SQL transaction may retry safely; external HTTP work is outside it.
    await this.db.transaction(async () => {
      await this.db
        .prepare(
          "INSERT INTO google_account_authorizations(connectionId) VALUES (?) ON CONFLICT(connectionId) DO NOTHING",
        )
        .run(connectionId);
      const update = await this.db
        .prepare(
          "UPDATE google_account_authorizations SET lockOwner=?,lockUntil=? WHERE connectionId=? AND lockUntil<=?",
        )
        .run(owner, now + 60_000, connectionId, now);
      if (update.changes !== 1)
        throw new HarnessError(
          "Google account authorization is busy. Try again shortly.",
          409,
        );
    });
    try {
      return await this.lock.run({ connectionId, owner }, action);
    } finally {
      await this.db
        .prepare(
          "UPDATE google_account_authorizations SET lockOwner=NULL,lockUntil=0 WHERE connectionId=? AND lockOwner=?",
        )
        .run(connectionId, owner);
    }
  }
}
