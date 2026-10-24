import { randomBytes, randomUUID } from "node:crypto";
import { HarnessError } from "@harness/core";
import { createGoogleAdapter, googleDefinition } from "@harness/integrations";
import {
  GoogleOAuthBroker,
  type GoogleOAuthConfig,
  oauthHash,
} from "@harness/integrations/oauth";
import { GoogleAuthorizationStore } from "@harness/storage/google";
import {
  googleAuthEnabled,
  googleOwnerAuth,
  googleOwnerConfig,
  requireGoogleOwner,
} from "./google-auth";
import { cookie } from "./hosted-auth";
import { registerIntegrationAdapter } from "./integrations";
import { getStore } from "./store";

export function googleResourceConfig(): GoogleOAuthConfig {
  const clientId = process.env.HARNESS_GOOGLE_RESOURCE_CLIENT_ID;
  const clientSecret = process.env.HARNESS_GOOGLE_RESOURCE_CLIENT_SECRET;
  const redirectUri = process.env.HARNESS_GOOGLE_RESOURCE_REDIRECT_URI;
  const keyId = process.env.HARNESS_GOOGLE_RESOURCE_KEY_ID ?? "primary";
  const encoded = process.env.HARNESS_GOOGLE_RESOURCE_KEY;
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
  const env = process.env;
  const missing = [
    "HARNESS_GOOGLE_RESOURCE_CLIENT_ID",
    "HARNESS_GOOGLE_RESOURCE_CLIENT_SECRET",
    "HARNESS_GOOGLE_RESOURCE_REDIRECT_URI",
    "HARNESS_GOOGLE_RESOURCE_KEY",
  ].filter((name) => !env[name]);
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
