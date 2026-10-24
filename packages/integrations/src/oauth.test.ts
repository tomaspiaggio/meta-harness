import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { HarnessStore } from "../../storage/src/application";
import { GoogleAuthorizationStore } from "../../storage/src/google";
import { GOOGLE_SCOPES, googleDefinition } from "./google-tools";
import type { HttpFetch } from "./http";
import {
  GoogleOAuthBroker,
  type GoogleOAuthConfig,
  GoogleTokenCipher,
} from "./oauth";

const keyPair = generateKeyPair("RS256");
const config: GoogleOAuthConfig = {
  clientId: "fixture-client",
  clientSecret: "fixture-client-secret",
  redirectUri: "http://127.0.0.1:3212/api/integrations/google/callback",
  keyId: "v1",
  keys: { v1: new Uint8Array(32).fill(7) },
};
const REFRESH = "fixture-refresh-secret-original";
const ACCESS = "fixture-access-secret-original";
async function fixture(
  run: (value: Awaited<ReturnType<typeof setup>>) => Promise<void>,
) {
  const f = await setup();
  try {
    await run(f);
  } finally {
    await f.store.close();
  }
}
async function setup() {
  const store = new HarnessStore(":memory:");
  await store.ready;
  await store.putIntegrationDefinition(googleDefinition);
  for (const id of ["work", "personal"])
    await store.putIntegrationConnection({
      id,
      integrationId: googleDefinition.id,
      adapter: "native",
      label: id,
      revision: "c1",
      enabled: true,
      config: { adapterId: "google" },
    });
  const repository = new GoogleAuthorizationStore(store.databaseConnection());
  const keys = await keyPair;
  const jwk = await exportJWK(keys.publicKey);
  let nonce = "";
  let subject = "fixture-subject";
  let email = "owner@example.test";
  let refresh: string | undefined = REFRESH;
  let scopes = [
    "openid",
    "email",
    GOOGLE_SCOPES.gmail,
    GOOGLE_SCOPES.sheets,
  ].join(" ");
  let invalidGrant = false;
  let refreshRequests = 0;
  let exchangeRequests = 0;
  let enabled = true;
  let providerFailure = false;
  let nonceOverride: string | undefined;
  const tokenFetch: HttpFetch = async (input, init) => {
    assert.equal(String(input), "https://oauth2.googleapis.com/token");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("client_secret"), config.clientSecret);
    if (body.get("grant_type") === "refresh_token") {
      refreshRequests++;
      assert.ok(body.get("refresh_token")?.startsWith("fixture-refresh"));
      if (invalidGrant)
        return Response.json(
          {
            error: "invalid_grant",
            error_description: `${REFRESH} sensitive-provider-detail`,
          },
          { status: 400 },
        );
      return Response.json({
        access_token: ACCESS,
        token_type: "Bearer",
        scope: scopes,
        ...(refresh ? { refresh_token: refresh } : {}),
      });
    }
    exchangeRequests++;
    assert.equal(body.get("redirect_uri"), config.redirectUri);
    assert.ok(body.get("code_verifier"));
    if (providerFailure)
      return Response.json(
        { error: "invalid_request", token: REFRESH },
        { status: 400 },
      );
    const token = await new SignJWT({
      nonce: nonceOverride ?? nonce,
      email,
      email_verified: true,
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://accounts.google.com")
      .setAudience(config.clientId)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);
    return Response.json({
      access_token: ACCESS,
      token_type: "Bearer",
      scope: scopes,
      id_token: token,
      ...(refresh ? { refresh_token: refresh } : {}),
    });
  };
  const broker = new GoogleOAuthBroker({
    config,
    store: repository,
    fetch: tokenFetch,
    verifyKey: createLocalJWKSet({ keys: [jwk] }),
    assertConnection: async (id, expectedRevision) => {
      const connection = (await store.listIntegrationConnections()).find(
        (c) => c.id === id,
      );
      assert.ok(connection);
      if (
        !enabled ||
        !connection.enabled ||
        (expectedRevision && connection.revision !== expectedRevision)
      )
        throw new Error("fixture connection disabled or changed");
    },
  });
  const begin = async (id = "work") => {
    const url = new URL(
      await broker.start({
        connectionId: id,
        connectionRevision: "c1",
        ownerBinding: "fixture-owner-browser-session",
        groups: ["gmail", "sheets"],
      }),
    );
    nonce = url.searchParams.get("nonce") ?? "";
    return url;
  };
  const complete = (
    url: URL,
    ownerBinding = "fixture-owner-browser-session",
    callbackUri = config.redirectUri,
  ) =>
    broker.complete({
      state: url.searchParams.get("state") ?? "",
      code: "fixture-code",
      ownerBinding,
      callbackUri,
      signal: AbortSignal.timeout(5000),
    });
  return {
    store,
    repository,
    broker,
    begin,
    complete,
    set(values: {
      subject?: string;
      email?: string;
      refresh?: string | null;
      scopes?: string;
      invalidGrant?: boolean;
      enabled?: boolean;
      providerFailure?: boolean;
      nonceOverride?: string;
    }) {
      if (values.subject) subject = values.subject;
      if (values.email) email = values.email;
      if ("refresh" in values) refresh = values.refresh ?? undefined;
      if (values.scopes !== undefined) scopes = values.scopes;
      if (values.invalidGrant !== undefined) invalidGrant = values.invalidGrant;
      if (values.enabled !== undefined) enabled = values.enabled;
      if (values.providerFailure !== undefined)
        providerFailure = values.providerFailure;
      if (values.nonceOverride !== undefined)
        nonceOverride = values.nonceOverride;
    },
    counts: () => ({ refreshRequests, exchangeRequests }),
  };
}
test("resource OAuth is offline incremental PKCE with hashed single-use owner-bound state and signed account identity", () =>
  fixture(async (f) => {
    const url = await f.begin();
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("include_granted_scopes"), "true");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.ok(url.searchParams.get("scope")?.includes(GOOGLE_SCOPES.gmail));
    const rows = await f.store
      .databaseConnection()
      .prepare("SELECT * FROM google_oauth_states")
      .all();
    assert.equal(rows.length, 1);
    assert.ok(
      !JSON.stringify(rows).includes(url.searchParams.get("state") ?? ""),
    );
    assert.ok(!JSON.stringify(rows).includes("fixture-owner-browser-session"));
    await assert.rejects(
      f.complete(url, "another-owner-session"),
      /another owner/,
    );
    assert.equal(f.counts().exchangeRequests, 0);
    const result = await f.complete(url);
    assert.equal(result.accountEmail, "owner@example.test");
    assert.deepEqual(result.grantedGroups.sort(), ["gmail", "sheets"]);
    await assert.rejects(f.complete(url), /already used/);
    const stored = await f.repository.getCredential("work");
    assert.ok(stored);
    assert.ok(!JSON.stringify(stored).includes(REFRESH));
    assert.ok(!JSON.stringify(stored).includes(ACCESS));
    assert.equal(f.broker.cipher.open(stored.cipher, "refresh:work"), REFRESH);
    await assert.rejects(
      f.repository.locked("work", () =>
        f.repository.locked("work", async () => {}),
      ),
      /Nested/,
    );
  }));
test("resource OAuth rejects wrong redirect and signed wrong nonce without leaking provider secrets", () =>
  fixture(async (f) => {
    await assert.rejects(
      f.complete(
        await f.begin(),
        "fixture-owner-browser-session",
        "http://127.0.0.1:3212/wrong",
      ),
      /expired/,
    );
    f.set({ nonceOverride: "wrong" });
    await assert.rejects(
      f.complete(await f.begin()),
      /identity could not be verified/,
    );
    f.set({ providerFailure: true });
    await assert.rejects(
      f.complete(await f.begin()),
      (e: Error) =>
        !e.message.includes(REFRESH) && /authorization failed/.test(e.message),
    );
    assert.equal(await f.repository.getCredential("work"), null);
  }));
test("missing refresh preserves existing account; wrong reconnect account cannot overwrite it; separate accounts remain distinct", () =>
  fixture(async (f) => {
    f.set({ refresh: null });
    await assert.rejects(f.complete(await f.begin()), /did not issue offline/);
    f.set({ refresh: REFRESH });
    await f.complete(await f.begin());
    const first = await f.repository.getCredential("work");
    f.set({ refresh: null });
    await f.complete(await f.begin());
    const second = await f.repository.getCredential("work");
    assert.ok(second && first && second.revision > first.revision);
    assert.equal(f.broker.cipher.open(second.cipher, "refresh:work"), REFRESH);
    f.set({
      subject: "other-subject",
      email: "other@example.test",
      refresh: "fixture-refresh-personal",
    });
    await assert.rejects(f.complete(await f.begin()), /same Google account/);
    await f.complete(await f.begin("personal"));
    assert.equal(
      (await f.repository.getCredential("personal"))?.email,
      "other@example.test",
    );
    assert.equal(
      (await f.repository.getCredential("work"))?.email,
      "owner@example.test",
    );
  }));
test("refresh rotation, scope loss and invalid_grant are persisted and never loop; disconnect erases token", () =>
  fixture(async (f) => {
    await f.complete(await f.begin());
    f.set({ refresh: "fixture-refresh-rotated" });
    const signal = AbortSignal.timeout(5000);
    const result = await f.broker.withAccess(
      "work",
      [GOOGLE_SCOPES.gmail],
      signal,
      async (token) => {
        assert.equal(token, ACCESS);
        return { result: "safe" };
      },
      "c1",
    );
    assert.deepEqual(result, { result: "safe" });
    const rotated = await f.repository.getCredential("work");
    assert.ok(rotated);
    assert.equal(
      f.broker.cipher.open(rotated.cipher, "refresh:work"),
      "fixture-refresh-rotated",
    );
    await assert.rejects(
      f.broker.withAccess("work", [GOOGLE_SCOPES.docs], signal, async () => {}),
      /missing/,
    );
    assert.equal(f.counts().refreshRequests, 1);
    f.set({ scopes: "openid email" });
    await assert.rejects(
      f.broker.withAccess("work", [GOOGLE_SCOPES.gmail], signal, async () =>
        assert.fail("must not execute"),
      ),
      /no longer usable/,
    );
    assert.equal(
      (await f.repository.getCredential("work"))?.scopes.includes(
        GOOGLE_SCOPES.gmail,
      ),
      false,
    );
    f.set({ scopes: `openid email ${GOOGLE_SCOPES.gmail}` });
    await f.complete(await f.begin());
    f.set({ invalidGrant: true });
    await assert.rejects(
      f.broker.withAccess(
        "work",
        [GOOGLE_SCOPES.gmail],
        signal,
        async () => {},
      ),
      /Reconnect/,
    );
    assert.equal(
      (await f.repository.getCredential("work"))?.status,
      "reconnect",
    );
    const count = f.counts().refreshRequests;
    await assert.rejects(
      f.broker.withAccess(
        "work",
        [GOOGLE_SCOPES.gmail],
        signal,
        async () => {},
      ),
      /reconnect/,
    );
    assert.equal(f.counts().refreshRequests, count);
    const credential = await f.repository.getCredential("work");
    assert.ok(credential);
    await f.broker.disconnect("work", credential.revision);
    assert.equal((await f.repository.getCredential("work"))?.cipher, "");
    assert.deepEqual(
      await f.store
        .databaseConnection()
        .prepare("SELECT * FROM google_credentials")
        .all(),
      [],
    );
  }));
test("credential leases fence concurrent rotations across repository instances; expired state and revoked connection never execute", () =>
  fixture(async (f) => {
    await f.complete(await f.begin());
    const other = new GoogleAuthorizationStore(f.store.databaseConnection());
    await f.repository.locked("work", async () => {
      await assert.rejects(
        other.locked("work", async () =>
          assert.fail("concurrent token request"),
        ),
        /busy/,
      );
    });
    const url = await f.begin();
    await f.store
      .databaseConnection()
      .prepare("UPDATE google_oauth_states SET expiresAt=0")
      .run();
    await assert.rejects(f.complete(url), /expired/);
    f.set({ enabled: false });
    await assert.rejects(
      f.broker.withAccess(
        "work",
        [GOOGLE_SCOPES.gmail],
        AbortSignal.timeout(5000),
        async () => assert.fail("disabled"),
      ),
      /disabled/,
    );
    assert.equal(f.counts().refreshRequests, 0);
  }));
test("dedicated authenticated encryption supports explicit key rotation and rejects cross-account ciphertext", () =>
  fixture(async (f) => {
    await f.complete(await f.begin());
    const value = await f.repository.getCredential("work");
    assert.ok(value);
    assert.throws(
      () => f.broker.cipher.open(value.cipher, "refresh:personal"),
      /cannot be decrypted/,
    );
    assert.throws(
      () => new GoogleTokenCipher({ keyId: "missing", keys: {} }),
      /encryption key/,
    );
    const cipher = new GoogleTokenCipher({
      keyId: "v2",
      keys: { v2: new Uint8Array(32).fill(9), v1: config.keys.v1 },
    });
    const rotated = cipher.seal(
      cipher.open(value.cipher, "refresh:work"),
      "refresh:work",
    );
    assert.ok(rotated.startsWith("v1.v2."));
    assert.equal(cipher.open(rotated, "refresh:work"), REFRESH);
    assert.throws(
      () =>
        new GoogleTokenCipher({
          keyId: "v2",
          keys: { v2: config.keys.v1 },
        }).open(rotated, "refresh:work"),
      /cannot be decrypted/,
    );
  }));
