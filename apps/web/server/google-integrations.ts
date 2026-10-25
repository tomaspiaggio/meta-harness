import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessError } from "@harness/core";
import { createGoogleAdapter, googleDefinition } from "@harness/integrations";
import {
  GoogleOAuthBroker,
  type GoogleOAuthConfig,
  oauthHash,
} from "@harness/integrations/oauth";
import { dataDirectory } from "@harness/storage";
import { GoogleAuthorizationStore } from "@harness/storage/google";
import {
  googleAuthEnabled,
  googleOwnerAuth,
  googleOwnerConfig,
  requireGoogleOwner,
} from "./google-auth";
import { cookie, hosted } from "./hosted-auth";
import { registerIntegrationAdapter } from "./integrations";
import { encryptionKey } from "./keys";
import { getStore } from "./store";

const RESOURCE_VARIABLES = [
  "HARNESS_GOOGLE_RESOURCE_CLIENT_ID",
  "HARNESS_GOOGLE_RESOURCE_CLIENT_SECRET",
  "HARNESS_GOOGLE_RESOURCE_REDIRECT_URI",
  "HARNESS_GOOGLE_RESOURCE_KEY",
] as const;
type ResourceVariable = (typeof RESOURCE_VARIABLES)[number];
const storedClientPath = () =>
  join(dataDirectory(), "google-resource-client.json");

/**
 * Settings can save the OAuth client instead of editing the control server's
 * environment. The secret is sealed with the control encryption key; the token
 * key is generated once and kept, because stored refresh tokens depend on it.
 * Deployment variables, when present, always take precedence.
 */
function storedClient(): Partial<Record<ResourceVariable, string>> {
  if (hosted()) return {};
  try {
    const path = storedClientPath();
    if (!existsSync(path)) return {};
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      clientId: string;
      redirectUri: string;
      tokenKey: string;
      secret: { iv: string; tag: string; data: string };
    };
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(encryptionKey("google-resource-client"), "base64"),
      Buffer.from(value.secret.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(value.secret.tag, "base64"));
    return {
      HARNESS_GOOGLE_RESOURCE_CLIENT_ID: value.clientId,
      HARNESS_GOOGLE_RESOURCE_CLIENT_SECRET: Buffer.concat([
        decipher.update(Buffer.from(value.secret.data, "base64")),
        decipher.final(),
      ]).toString("utf8"),
      HARNESS_GOOGLE_RESOURCE_REDIRECT_URI: value.redirectUri,
      HARNESS_GOOGLE_RESOURCE_KEY: value.tokenKey,
    };
  } catch {
    return {};
  }
}
function resourceValue(name: ResourceVariable): string | undefined {
  return process.env[name] || storedClient()[name];
}
export function saveGoogleResourceClient(
  request: Request,
  clientId: string,
  clientSecret: string,
) {
  if (hosted())
    throw new HarnessError(
      "Hosted deployments configure Google through their environment.",
      409,
    );
  if (RESOURCE_VARIABLES.some((name) => process.env[name]))
    throw new HarnessError(
      "This server's environment already configures Google access. Change it there.",
      409,
    );
  if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId.trim()))
    throw new HarnessError(
      "That does not look like a Google OAuth client ID (it ends in .apps.googleusercontent.com).",
    );
  if (clientSecret.trim().length < 10 || clientSecret.length > 200)
    throw new HarnessError(
      "Paste the client secret from the same OAuth client.",
    );
  const tokenKey =
    storedClient().HARNESS_GOOGLE_RESOURCE_KEY ??
    randomBytes(32).toString("base64url");
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(encryptionKey("google-resource-client"), "base64"),
    iv,
  );
  const data = Buffer.concat([
    cipher.update(clientSecret.trim(), "utf8"),
    cipher.final(),
  ]);
  const path = storedClientPath();
  writeFileSync(
    `${path}.tmp`,
    JSON.stringify({
      clientId: clientId.trim(),
      redirectUri: googleResourceSetup(request).expectedRedirectUri,
      tokenKey,
      secret: {
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64"),
      },
    }),
    { mode: 0o600 },
  );
  renameSync(`${path}.tmp`, path);
}

export function googleResourceConfig(): GoogleOAuthConfig {
  const clientId = resourceValue("HARNESS_GOOGLE_RESOURCE_CLIENT_ID");
  const clientSecret = resourceValue("HARNESS_GOOGLE_RESOURCE_CLIENT_SECRET");
  const redirectUri = resourceValue("HARNESS_GOOGLE_RESOURCE_REDIRECT_URI");
  const keyId = process.env.HARNESS_GOOGLE_RESOURCE_KEY_ID ?? "primary";
  const encoded = resourceValue("HARNESS_GOOGLE_RESOURCE_KEY");
  if (
    !clientId ||
    !clientSecret ||
    !redirectUri ||
    !encoded ||
    !/^[A-Za-z0-9_-]{43}$/.test(encoded)
  )
    throw new HarnessError(
      "Google resource OAuth is not configured. Set its separate client, redirect URI and encryption key.",
      503,
    );
  const keys: Record<string, Uint8Array> = {
    [keyId]: Buffer.from(encoded, "base64url"),
  };
  const old = process.env.HARNESS_GOOGLE_RESOURCE_PREVIOUS_KEYS;
  if (old) {
    try {
      const values: unknown = JSON.parse(old);
      if (!values || typeof values !== "object" || Array.isArray(values))
        throw new Error();
      for (const [id, value] of Object.entries(values)) {
        if (
          !/^[A-Za-z0-9_-]{1,40}$/.test(id) ||
          typeof value !== "string" ||
          !/^[A-Za-z0-9_-]{43}$/.test(value) ||
          id === keyId
        )
          throw new Error();
        keys[id] = Buffer.from(value, "base64url");
      }
    } catch {
      throw new HarnessError(
        "Google previous encryption key configuration is invalid.",
        503,
      );
    }
  }
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new HarnessError(
      "HARNESS_GOOGLE_RESOURCE_REDIRECT_URI is not a valid URL.",
      503,
    );
  }
  if (url.pathname !== GOOGLE_RESOURCE_CALLBACK)
    throw new HarnessError(
      "Register the exact /api/integrations/google/callback redirect URI.",
      503,
    );
  return { clientId, clientSecret, redirectUri, keyId, keys };
}
const GOOGLE_RESOURCE_CALLBACK = "/api/integrations/google/callback";
export type GoogleResourceSetup = {
  configured: boolean;
  source: "environment" | "settings" | null;
  canSave: boolean;
  // Names only. Values, lengths and prefixes of secrets never leave the process.
  missing: string[];
  invalid: string[];
  expectedRedirectUri: string;
  redirectUri: string | null;
  // Set when this page is open on another origin; consent must start there.
  openAt: string | null;
  reusesOwnerClient: boolean;
};
// Non-secret readiness for Settings. Owner sign-in never implies resource consent.
export function googleResourceSetup(request: Request): GoogleResourceSetup {
  const fromEnvironment = RESOURCE_VARIABLES.some((name) => process.env[name]);
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...(fromEnvironment ? {} : storedClient()),
  };
  const missing = RESOURCE_VARIABLES.filter((name) => !env[name]);
  const invalid: string[] = [];
  if (
    env.HARNESS_GOOGLE_RESOURCE_KEY &&
    !/^[A-Za-z0-9_-]{43}$/.test(env.HARNESS_GOOGLE_RESOURCE_KEY)
  )
    invalid.push("HARNESS_GOOGLE_RESOURCE_KEY");
  // Behind the launcher gateway request.url names the private Next port; the
  // browser-facing origin is the configured owner origin or the Host header.
  const url = new URL(request.url);
  const host = request.headers.get("host");
  let origin = host ? `${url.protocol}//${host}` : url.origin;
  if (googleAuthEnabled())
    try {
      origin = googleOwnerConfig().origin;
    } catch {
      // Owner setup readiness is reported separately; keep the Host origin.
    }
  const expectedRedirectUri = `${origin}${GOOGLE_RESOURCE_CALLBACK}`;
  let redirectUri: string | null = null;
  let openAt: string | null = null;
  if (env.HARNESS_GOOGLE_RESOURCE_REDIRECT_URI) {
    try {
      const configured = new URL(env.HARNESS_GOOGLE_RESOURCE_REDIRECT_URI);
      redirectUri = configured.href;
      if (
        configured.pathname !== GOOGLE_RESOURCE_CALLBACK ||
        configured.search ||
        configured.hash
      )
        invalid.push("HARNESS_GOOGLE_RESOURCE_REDIRECT_URI");
      else if (configured.host !== host?.toLowerCase())
        openAt = configured.origin;
    } catch {
      invalid.push("HARNESS_GOOGLE_RESOURCE_REDIRECT_URI");
    }
  }
  if (
    env.HARNESS_GOOGLE_RESOURCE_KEY_ID &&
    !/^[A-Za-z0-9_-]{1,40}$/.test(env.HARNESS_GOOGLE_RESOURCE_KEY_ID)
  )
    invalid.push("HARNESS_GOOGLE_RESOURCE_KEY_ID");
  let configured = !missing.length && !invalid.length;
  if (configured)
    try {
      googleResourceConfig();
    } catch {
      configured = false;
      invalid.push("HARNESS_GOOGLE_RESOURCE_PREVIOUS_KEYS");
    }
  return {
    configured,
    source: fromEnvironment
      ? "environment"
      : missing.length < RESOURCE_VARIABLES.length
        ? "settings"
        : null,
    canSave: !hosted() && !fromEnvironment,
    missing,
    invalid,
    expectedRedirectUri,
    redirectUri,
    openAt,
    reusesOwnerClient:
      !!env.HARNESS_GOOGLE_RESOURCE_CLIENT_ID &&
      env.HARNESS_GOOGLE_RESOURCE_CLIENT_ID === env.GOOGLE_CLIENT_ID,
  };
}
export async function googleBroker() {
  const store = await getStore();
  return new GoogleOAuthBroker({
    config: googleResourceConfig(),
    store: new GoogleAuthorizationStore(store.databaseConnection()),
    assertConnection: async (id, revision) => {
      const connection = (await store.listIntegrationConnections()).find(
        (value) => value.id === id,
      );
      if (
        !connection?.enabled ||
        connection.adapter !== "native" ||
        connection.integrationId !== googleDefinition.id ||
        connection.config.adapterId !== "google" ||
        (revision && connection.revision !== revision)
      )
        throw new HarnessError(
          "Google connection is disabled, changed or unavailable. Review Settings → Integrations.",
          403,
        );
    },
  });
}
export async function googleOwnerBinding(request: Request, flowCookie: string) {
  // Consent follows the verified owner session, not a serialized/refreshable cookie
  // or a shared fallback when Better Auth owns authentication.
  const principal = googleAuthEnabled()
    ? (
        await requireGoogleOwner(
          googleOwnerAuth(),
          googleOwnerConfig(),
          getStore,
          request.headers,
        )
      ).session.token
    : (cookie(request, "harness_owner") ??
      cookie(request, "harness_session") ??
      request.headers.get("authorization") ??
      "local-loopback-owner");
  return oauthHash(JSON.stringify([principal, flowCookie]));
}
export function googleFlowCookie(request: Request) {
  const previous = cookie(request, "harness_google_resource");
  return previous && /^[A-Za-z0-9_-]{43}$/.test(previous)
    ? previous
    : randomBytes(32).toString("base64url");
}
export async function ensureGoogleDefinition() {
  const store = await getStore();
  const old = (await store.listIntegrationDefinitions()).find(
    (definition) => definition.id === googleDefinition.id,
  );
  if (!old || old.revision !== googleDefinition.revision)
    await store.putIntegrationDefinition(googleDefinition, old?.revision);
}
export async function invalidateGoogleBindings(
  connectionId: string,
  expectedRevision: string,
) {
  const store = await getStore();
  const connection = (await store.listIntegrationConnections()).find(
    (value) => value.id === connectionId,
  );
  if (!connection || connection.revision !== expectedRevision)
    throw new HarnessError("Connection changed. Refresh Settings.", 409);
  return store.putIntegrationConnection(
    { ...connection, revision: randomUUID() },
    expectedRevision,
  );
}
// Register lazily: a read/discovery never loads keys or starts background clients at idle.
registerIntegrationAdapter({
  id: "google",
  async discover() {
    return googleDefinition;
  },
  async execute(input) {
    const broker = await googleBroker();
    const config = googleResourceConfig();
    const adapter = createGoogleAdapter({
      access: broker,
      pageKey: config.keys[config.keyId],
    });
    return adapter.execute(input);
  },
});
