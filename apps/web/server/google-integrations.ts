import { randomBytes, randomUUID } from "node:crypto";
import { HarnessError } from "@harness/core";
import { createGoogleAdapter, googleDefinition } from "@harness/integrations";
import {
  GoogleOAuthBroker,
  type GoogleOAuthConfig,
  oauthHash,
} from "@harness/integrations/oauth";
import { GoogleAuthorizationStore } from "@harness/storage/google";
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
  const url = new URL(redirectUri);
  if (url.pathname !== "/api/integrations/google/callback")
    throw new HarnessError(
      "Register the exact /api/integrations/google/callback redirect URI.",
      503,
    );
  return { clientId, clientSecret, redirectUri, keyId, keys };
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
export function googleOwnerBinding(request: Request, flowCookie: string) {
  // Tie resource consent to the exact authenticated owner session and browser flow cookie.
  return oauthHash(
    JSON.stringify([
      cookie(request, "harness_owner") ??
        cookie(request, "harness_session") ??
        request.headers.get("authorization") ??
        "local-loopback-owner",
      flowCookie,
    ]),
  );
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
