import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { HarnessError } from "@harness/core";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { GoogleAccess } from "./google";
import { GOOGLE_SCOPES, type GoogleGroup } from "./google-tools";
import { boundedResponse, type HttpFetch, string } from "./http";

export interface GoogleCredential {
  connectionId: string;
  subject: string;
  email: string;
  scopes: string[];
  cipher: string;
  revision: number;
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
export interface GoogleCredentialStore {
  putState(state: GoogleOAuthState): Promise<void>;
  consumeState(
    stateHash: string,
    ownerHash: string,
    now: number,
  ): Promise<GoogleOAuthState | null>;
  getCredential(connectionId: string): Promise<GoogleCredential | null>;
  saveCredential(
    value: GoogleCredential,
    expectedRevision: number,
  ): Promise<void>;
  /** Cross-process lease serializes refresh rotation and disconnect. Must not retry action. */
  locked<T>(connectionId: string, action: () => Promise<T>): Promise<T>;
}
export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** keyId identifies a dedicated 32-byte key; old keys permit rotation without losing accounts. */
  keyId: string;
  keys: Record<string, Uint8Array>;
}
export class GoogleTokenCipher {
  constructor(private config: Pick<GoogleOAuthConfig, "keyId" | "keys">) {
    if (
      !/^[A-Za-z0-9_-]{1,40}$/.test(config.keyId) ||
      config.keys[config.keyId]?.length !== 32
    )
      throw new HarnessError(
        "Configure the Google resource encryption key before connecting accounts.",
        503,
      );
  }
  seal(value: string, purpose: string): string {
    const iv = randomBytes(12);
    const keyId = this.config.keyId;
    const cipher = createCipheriv("aes-256-gcm", this.config.keys[keyId], iv);
    cipher.setAAD(
      Buffer.from(`harness:google-resource:v1:${purpose}:${keyId}`),
    );
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [
      "v1",
      keyId,
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      data.toString("base64url"),
    ].join(".");
  }
  open(value: string, purpose: string): string {
    try {
      const [version, keyId, iv, tag, data, extra] = value.split(".");
      const key = this.config.keys[keyId];
      if (
        version !== "v1" ||
        extra ||
        key?.length !== 32 ||
        Buffer.from(iv, "base64url").length !== 12 ||
        Buffer.from(tag, "base64url").length !== 16
      )
        throw new Error();
      const cipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(iv, "base64url"),
      );
      cipher.setAAD(
        Buffer.from(`harness:google-resource:v1:${purpose}:${keyId}`),
      );
      cipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        cipher.update(Buffer.from(data, "base64url")),
        cipher.final(),
      ]).toString("utf8");
    } catch {
      throw new HarnessError(
        "Google credential cannot be decrypted. Restore its encryption key or reconnect.",
        503,
      );
    }
  }
}
export const oauthHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const googleKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
  { timeoutDuration: 10_000, cooldownDuration: 30_000 },
);
export class GoogleOAuthBroker implements GoogleAccess {
  readonly cipher: GoogleTokenCipher;
  private http: HttpFetch;
  private now: () => number;
  constructor(
    private options: {
      config: GoogleOAuthConfig;
      store: GoogleCredentialStore;
      fetch?: HttpFetch;
      now?: () => number;
      verifyKey?: JWTVerifyGetKey;
      /** Must fence connection revision/disable in the same control process before and after remote work. */
      assertConnection: (
        connectionId: string,
        expectedRevision?: string,
      ) => Promise<void>;
    },
  ) {
    const redirect = new URL(options.config.redirectUri);
    if (
      redirect.username ||
      redirect.password ||
      redirect.hash ||
      redirect.search ||
      (redirect.protocol !== "https:" &&
        !(
          redirect.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(redirect.hostname)
        ))
    )
      throw new HarnessError(
        "Google resource redirect URI must be HTTPS or loopback HTTP.",
        503,
      );
    this.cipher = new GoogleTokenCipher(options.config);
    this.http = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }
  async start(input: {
    connectionId: string;
    connectionRevision: string;
    ownerBinding: string;
    groups: GoogleGroup[];
  }) {
    await this.options.assertConnection(
      input.connectionId,
      input.connectionRevision,
    );
    if (
      !input.groups.length ||
      input.groups.some((group) => !(group in GOOGLE_SCOPES))
    )
      throw new HarnessError("Select one or more Google read groups.");
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const scopes = [
      "openid",
      "email",
      ...new Set(input.groups.map((group) => GOOGLE_SCOPES[group])),
    ];
    const value: GoogleOAuthState = {
      stateHash: oauthHash(state),
      ownerHash: oauthHash(input.ownerBinding),
      connectionId: input.connectionId,
      connectionRevision: input.connectionRevision,
      verifierCipher: this.cipher.seal(verifier, `oauth:${oauthHash(state)}`),
      nonce,
      scopes,
      redirectUri: this.options.config.redirectUri,
      expiresAt: this.now() + 600_000,
    };
    await this.options.store.putState(value);
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    for (const [key, item] of Object.entries({
      client_id: this.options.config.clientId,
      redirect_uri: value.redirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      state,
      nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent select_account",
    }))
      url.searchParams.set(key, item);
    return url.toString();
  }
  private async tokenRequest(
    body: Record<string, string>,
    signal: AbortSignal,
  ) {
    let response: Response;
    try {
      response = await this.http("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.options.config.clientId,
          client_secret: this.options.config.clientSecret,
          ...body,
        }),
        signal,
        redirect: "error",
      });
    } catch {
      throw new HarnessError(
        "Google authorization transport failed. Reconnect if needed.",
        502,
      );
    }
    const text = await boundedResponse(response, 65_536);
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text);
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error();
    } catch {
      throw new HarnessError(
        "Google authorization returned an invalid response.",
        502,
      );
    }
    if (!response.ok || data.error)
      return {
        ok: false as const,
        invalidGrant: data.error === "invalid_grant",
      };
    if (
      !string(data.access_token) ||
      string(data.access_token).length > 16_384 ||
      data.token_type !== "Bearer"
    )
      throw new HarnessError(
        "Google authorization did not return usable access.",
        502,
      );
    return { ok: true as const, data };
  }
  async complete(input: {
    state: string;
    code: string;
    ownerBinding: string;
    callbackUri: string;
    signal: AbortSignal;
  }) {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(input.state) ||
      input.code.length < 1 ||
      input.code.length > 4096
    )
      throw new HarnessError("Google authorization response is invalid.", 403);
    const saved = await this.options.store.consumeState(
      oauthHash(input.state),
      oauthHash(input.ownerBinding),
      this.now(),
    );
    if (
      !saved ||
      saved.redirectUri !== input.callbackUri ||
      saved.redirectUri !== this.options.config.redirectUri
    )
      throw new HarnessError(
        "Google authorization expired, was already used, or belongs to another owner session.",
        403,
      );
    await this.options.assertConnection(
      saved.connectionId,
      saved.connectionRevision,
    );
    const result = await this.tokenRequest(
      {
        code: input.code,
        code_verifier: this.cipher.open(
          saved.verifierCipher,
          `oauth:${saved.stateHash}`,
        ),
        redirect_uri: saved.redirectUri,
        grant_type: "authorization_code",
      },
      input.signal,
    );
    if (!result.ok)
      throw new HarnessError(
        "Google authorization failed. Start connecting again.",
        403,
      );
    let claims: { sub: string; email: string };
    try {
      const { payload } = await jwtVerify(
        string(result.data.id_token),
        this.options.verifyKey ?? googleKeys,
        {
          issuer: ["https://accounts.google.com", "accounts.google.com"],
          audience: this.options.config.clientId,
          algorithms: ["RS256"],
          currentDate: new Date(this.now()),
        },
      );
      if (
        payload.nonce !== saved.nonce ||
        typeof payload.sub !== "string" ||
        typeof payload.email !== "string" ||
        payload.email_verified !== true ||
        payload.email.length > 320 ||
        payload.sub.length > 255 ||
        (payload.azp && payload.azp !== this.options.config.clientId)
      )
        throw new Error();
      claims = { sub: payload.sub, email: payload.email };
    } catch {
      throw new HarnessError(
        "Google account identity could not be verified.",
        403,
      );
    }
    const scopes = string(result.data.scope).split(/\s+/).filter(Boolean);
    if (
      !scopes.includes("openid") ||
      !scopes.some((scope) =>
        Object.values(GOOGLE_SCOPES).includes(
          scope as (typeof GOOGLE_SCOPES)[GoogleGroup],
        ),
      )
    )
      throw new HarnessError(
        "No Google data scopes were granted. Connect again and select read access.",
        403,
      );
    await this.options.store.locked(saved.connectionId, async () => {
      await this.options.assertConnection(
        saved.connectionId,
        saved.connectionRevision,
      );
      const previous = await this.options.store.getCredential(
        saved.connectionId,
      );
      if (
        previous &&
        previous.status !== "disconnected" &&
        previous.subject !== claims.sub
      )
        throw new HarnessError(
          "Reconnect must use the same Google account. Add a separate connection for another account.",
          409,
        );
      const refresh =
        string(result.data.refresh_token) ||
        (previous?.subject === claims.sub && previous.status === "ready"
          ? this.cipher.open(previous.cipher, `refresh:${saved.connectionId}`)
          : "");
      if (!refresh || refresh.length > 16_384)
        throw new HarnessError(
          "Google did not issue offline access. Reconnect with consent; existing credentials were preserved.",
          409,
        );
      await this.options.store.saveCredential(
        {
          connectionId: saved.connectionId,
          subject: claims.sub,
          email: claims.email,
          scopes,
          cipher: this.cipher.seal(refresh, `refresh:${saved.connectionId}`),
          revision: (previous?.revision ?? 0) + 1,
          status: "ready",
        },
        previous?.revision ?? 0,
      );
    });
    return {
      connectionId: saved.connectionId,
      accountEmail: claims.email,
      grantedGroups: (Object.keys(GOOGLE_SCOPES) as GoogleGroup[]).filter(
        (group) => scopes.includes(GOOGLE_SCOPES[group]),
      ),
    };
  }
  async withAccess<T>(
    connectionId: string,
    requiredScopes: string[],
    signal: AbortSignal,
    action: (accessToken: string) => Promise<T>,
    expectedRevision?: string,
  ): Promise<T> {
    const grant = await this.options.store.locked(connectionId, async () => {
      await this.options.assertConnection(connectionId, expectedRevision);
      const credential = await this.options.store.getCredential(connectionId);
      if (!credential || credential.status !== "ready")
        throw new HarnessError(
          "Connect or reconnect this Google account in Settings → Integrations.",
          403,
        );
      if (requiredScopes.some((scope) => !credential.scopes.includes(scope)))
        throw new HarnessError(
          "This Google account is missing the requested read scope. Upgrade access in Settings → Integrations.",
          403,
        );
      const result = await this.tokenRequest(
        {
          refresh_token: this.cipher.open(
            credential.cipher,
            `refresh:${connectionId}`,
          ),
          grant_type: "refresh_token",
        },
        signal,
      );
      if (!result.ok) {
        // Return, rather than throw inside transaction, so reconnect state commits.
        if (result.invalidGrant)
          await this.options.store.saveCredential(
            {
              ...credential,
              revision: credential.revision + 1,
              status: "reconnect",
            },
            credential.revision,
          );
        return { error: true as const };
      }
      const scopes = result.data.scope
        ? string(result.data.scope).split(/\s+/).filter(Boolean)
        : credential.scopes;
      const refresh = string(result.data.refresh_token);
      if (refresh.length > 16_384)
        throw new HarnessError(
          "Google refresh returned invalid credentials.",
          502,
        );
      const next = {
        ...credential,
        scopes,
        revision: credential.revision + 1,
        cipher: refresh
          ? this.cipher.seal(refresh, `refresh:${connectionId}`)
          : credential.cipher,
      };
      await this.options.store.saveCredential(next, credential.revision);
      if (requiredScopes.some((scope) => !scopes.includes(scope)))
        return { error: true as const };
      return {
        error: false as const,
        token: string(result.data.access_token),
        revision: next.revision,
      };
    });
    if (grant.error)
      throw new HarnessError(
        "Google authorization is no longer usable. Reconnect this account.",
        403,
      );
    await this.options.assertConnection(connectionId, expectedRevision);
    const result = await action(grant.token);
    await this.options.assertConnection(connectionId, expectedRevision);
    const current = await this.options.store.getCredential(connectionId);
    if (!current || current.status !== "ready")
      throw new HarnessError(
        "Google access was disconnected while reading.",
        403,
      );
    return result;
  }
  async disconnect(connectionId: string, expectedCredentialRevision: number) {
    return this.options.store.locked(connectionId, async () => {
      const credential = await this.options.store.getCredential(connectionId);
      if (!credential) return;
      if (credential.revision !== expectedCredentialRevision)
        throw new HarnessError(
          "Google account changed. Refresh Settings and try again.",
          409,
        );
      // Local disconnect is reliable even while Google is unavailable; provider revocation is an explicit separate owner action.
      await this.options.store.saveCredential(
        {
          ...credential,
          cipher: "",
          scopes: [],
          status: "disconnected",
          revision: credential.revision + 1,
        },
        credential.revision,
      );
    });
  }
  async rotateKey(connectionId: string) {
    return this.options.store.locked(connectionId, async () => {
      const credential = await this.options.store.getCredential(connectionId);
      if (!credential || credential.status === "disconnected") return;
      await this.options.store.saveCredential(
        {
          ...credential,
          cipher: this.cipher.seal(
            this.cipher.open(credential.cipher, `refresh:${connectionId}`),
            `refresh:${connectionId}`,
          ),
          revision: credential.revision + 1,
        },
        credential.revision,
      );
    });
  }
}
