import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { GET as callback } from "../../../apps/web/app/api/integrations/google/callback/route";
import { POST as disconnect } from "../../../apps/web/app/api/integrations/google/disconnect/route";
import { POST as start } from "../../../apps/web/app/api/integrations/google/start/route";
import { GET as status } from "../../../apps/web/app/api/integrations/google/status/route";
import { loginCookie } from "../../../apps/web/server/security";
import { HarnessStore } from "../../storage/src/application";
import { GoogleAuthorizationStore } from "../../storage/src/google";
import { GOOGLE_SCOPES } from "./google-tools";

test("actual owner resource routes complete signed consent fixtures, reject CSRF/replay and disconnect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fixture-google-oauth-"));
  const variables = {
    HARNESS_DATA_DIR: directory,
    HARNESS_REQUIRE_AUTH: "1",
    HARNESS_BIND_HOST: "127.0.0.1",
    HARNESS_GOOGLE_RESOURCE_CLIENT_ID: "fixture-resource-client",
    HARNESS_GOOGLE_RESOURCE_CLIENT_SECRET: "fixture-resource-client-secret",
    HARNESS_GOOGLE_RESOURCE_REDIRECT_URI:
      "http://127.0.0.1:3212/api/integrations/google/callback",
    HARNESS_GOOGLE_RESOURCE_KEY: Buffer.alloc(32, 4).toString("base64url"),
  };
  const previous = Object.fromEntries(
    Object.keys(variables).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, variables);
  const shared = globalThis as typeof globalThis & {
    harnessStore?: Promise<HarnessStore>;
  };
  const previousStore = shared.harnessStore;
  const store = new HarnessStore(":memory:");
  await store.ready;
  shared.harnessStore = Promise.resolve(store);
  const originalFetch = globalThis.fetch;
  const keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  let nonce = "";
  let tokenCalls = 0;
  const headers = {
    host: "127.0.0.1:3212",
    "content-type": "application/json",
    origin: "http://127.0.0.1:3212",
  };
  const request = (path: string, body?: unknown, cookie = "", extra = {}) =>
    new Request(`http://127.0.0.1:3212/api/integrations/google/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...headers, cookie, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://www.googleapis.com/oauth2/v3/certs")
        return Response.json({ keys: [jwk] });
      assert.equal(
        url,
        "https://oauth2.googleapis.com/token",
        "fixture blocks unknown outbound requests",
      );
      tokenCalls++;
      const body = new URLSearchParams(String(init?.body));
      assert.equal(
        body.get("client_id"),
        variables.HARNESS_GOOGLE_RESOURCE_CLIENT_ID,
      );
      assert.equal(body.get("grant_type"), "authorization_code");
      const idToken = await new SignJWT({
        nonce,
        email: "fixture@example.test",
        email_verified: true,
      })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer("https://accounts.google.com")
        .setAudience(variables.HARNESS_GOOGLE_RESOURCE_CLIENT_ID)
        .setSubject("fixture-subject")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey);
      return Response.json({
        access_token: "fixture-route-access-secret",
        refresh_token: "fixture-route-refresh-secret",
        token_type: "Bearer",
        scope: `openid email ${GOOGLE_SCOPES.gmail}`,
        id_token: idToken,
      });
    };
    assert.equal(
      (await start(request("start", { label: "Work", groups: ["gmail"] })))
        .status,
      401,
    );
    const owner = `harness_session=${loginCookie()}`;
    assert.equal(
      (
        await start(
          request("start", { label: "Work", groups: ["gmail"] }, owner, {
            origin: "https://evil.example",
          }),
        )
      ).status,
      403,
    );
    const response = await start(
      request("start", { label: "Fixture Work", groups: ["gmail"] }, owner),
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    const authorization = new URL(payload.authorizationUrl);
    nonce = authorization.searchParams.get("nonce") ?? "";
    const flow = response.headers.get("set-cookie")?.split(";")[0];
    assert.ok(flow);
    assert.ok(response.headers.get("set-cookie")?.includes("HttpOnly"));
    const browser = `${owner}; ${flow}`;
    const state = authorization.searchParams.get("state") ?? "";
    const wrong = await callback(
      request(
        `callback?code=fixture-code&state=${state}`,
        undefined,
        `${owner}; harness_google_resource=${"a".repeat(43)}`,
        { "sec-fetch-site": "cross-site" },
      ),
    );
    assert.equal(wrong.headers.get("location"), "/settings?google=failed");
    assert.equal(tokenCalls, 0);
    const completed = await callback(
      request(`callback?code=fixture-code&state=${state}`, undefined, browser, {
        "sec-fetch-site": "cross-site",
      }),
    );
    assert.equal(completed.status, 303);
    assert.equal(
      completed.headers.get("location"),
      "/settings?google=connected",
    );
    assert.equal(tokenCalls, 1);
    assert.equal(
      (
        await callback(
          request(
            `callback?code=fixture-code&state=${state}`,
            undefined,
            browser,
          ),
        )
      ).headers.get("location"),
      "/settings?google=failed",
    );
    assert.equal(tokenCalls, 1);
    const result = await status(request("status", undefined, owner));
    assert.equal(result.status, 200);
    const account = (await result.json()).connections[0];
    assert.equal(account.accountEmail, "fixture@example.test");
    assert.equal(account.status, "ready");
    assert.deepEqual(
      await store.listIntegrationBindings(),
      [],
      "consent grants no implicit workspace access",
    );
    const repository = new GoogleAuthorizationStore(store.databaseConnection());
    const stored = await repository.getCredential(account.id);
    assert.ok(stored);
    assert.ok(!JSON.stringify(stored).includes("fixture-route-refresh-secret"));
    delete process.env.HARNESS_GOOGLE_RESOURCE_KEY;
    const disconnected = await disconnect(
      request(
        "disconnect",
        { connectionId: account.id, expectedRevision: account.revision },
        owner,
      ),
    );
    assert.equal(disconnected.status, 200);
    assert.equal(
      (await repository.getCredential(account.id))?.status,
      "disconnected",
    );
    assert.deepEqual(
      await store
        .databaseConnection()
        .prepare("SELECT * FROM google_credentials")
        .all(),
      [],
    );
  } finally {
    globalThis.fetch = originalFetch;
    shared.harnessStore = previousStore;
    await store.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
