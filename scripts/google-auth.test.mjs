import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  allowedGoogleOwner,
  createGoogleOwnerAuth,
  googleOwnerConfig,
  requireGoogleOwner,
} from "../apps/web/server/google-auth.ts";
import { authorizeAdmin } from "../apps/web/server/security.ts";
import { HarnessStore } from "../packages/storage/src/application.ts";

const owner = "tomas.piaggio12@gmail.com";
const config = {
  origin: "https://harness.example.test",
  secret: randomBytes(48).toString("base64url"),
  clientId: "fixture-google-client",
  clientSecret: "fixture-only-client-secret",
  emails: [owner],
};
function applyCookies(jar, response) {
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0];
    const at = pair.indexOf("=");
    if (/Max-Age=0(?:;|$)/i.test(cookie)) jar.delete(pair.slice(0, at));
    else jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
}
const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

test("Google owner configuration fails closed and never inherits token/loopback access", async () => {
  const prior = { ...process.env };
  try {
    process.env.HARNESS_AUTH = "google";
    process.env.HARNESS_PUBLIC_URL = config.origin;
    delete process.env.BETTER_AUTH_SECRET;
    assert.throws(googleOwnerConfig, /disabled/);
    await assert.rejects(
      authorizeAdmin(new Request(`${config.origin}/api/state`)),
      /disabled/,
    );
    Object.assign(process.env, {
      BETTER_AUTH_SECRET: config.secret,
      GOOGLE_CLIENT_ID: config.clientId,
      GOOGLE_CLIENT_SECRET: config.clientSecret,
      HARNESS_OWNER_EMAILS: owner,
    });
    assert.equal(googleOwnerConfig().emails[0], owner);
    await assert.rejects(
      authorizeAdmin(
        new Request(`${config.origin}/api/state`, {
          headers: {
            authorization: "Bearer old-local-token",
            cookie: "harness_session=old-cookie",
          },
        }),
      ),
      /allowed Google/,
    );
    process.env.HARNESS_PUBLIC_URL = "http://jetdad.tomhom";
    assert.throws(googleOwnerConfig, /HTTPS/);
    assert.ok(
      allowedGoogleOwner({ email: owner.toUpperCase(), emailVerified: true }, [
        owner,
      ]),
    );
    for (const user of [
      { email: owner, emailVerified: false },
      { email: "stranger@gmail.com", emailVerified: true },
      { email: "tomas.piaggio12+other@gmail.com", emailVerified: true },
    ])
      assert.equal(allowedGoogleOwner(user, [owner]), false);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in prior)) delete process.env[key];
    Object.assign(process.env, prior);
  }
});

test("Google OAuth validates state and verified owner, survives restart, and revokes immediately without another database", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-google-auth-fixture-"));
  const store = new HarnessStore(join(root, "db.sqlite"));
  await store.ready;
  const ledger = async () => store;
  const originalFetch = globalThis.fetch;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: "fixture-kid",
    alg: "RS256",
    use: "sig",
  };
  let email = owner,
    verified = true,
    nonce,
    exchanges = 0;
  globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://oauth2.googleapis.com/token") {
      exchanges++;
      const now = Math.floor(Date.now() / 1000);
      const encode = (value) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
      const payload = `${encode({ alg: "RS256", kid: "fixture-kid", typ: "JWT" })}.${encode({ iss: "https://accounts.google.com", aud: config.clientId, sub: "fixture-google-subject", email, email_verified: verified, name: "Fixture owner", iat: now, exp: now + 600, nonce })}`;
      const jwt = `${payload}.${sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url")}`;
      return Response.json({
        access_token: "fixture-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid email profile",
        id_token: jwt,
      });
    }
    if (url === "https://www.googleapis.com/oauth2/v3/certs")
      return Response.json({ keys: [jwk] });
    throw new Error(
      `Unexpected fixture network request: ${new URL(url).origin}`,
    );
  };
  let loginAttempt = 0;
  const start = async (auth) => {
    const response = await auth.handler(
      new Request(`${config.origin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          origin: config.origin,
          "x-forwarded-for": `192.0.2.${++loginAttempt}`,
        },
        body: JSON.stringify({
          provider: "google",
          callbackURL: "/",
          errorCallbackURL: "/login",
        }),
      }),
    );
    assert.equal(response.status, 200);
    const authorization = new URL((await response.json()).url);
    assert.equal(authorization.origin, "https://accounts.google.com");
    assert.equal(
      authorization.searchParams.get("redirect_uri"),
      `${config.origin}/api/auth/callback/google`,
    );
    assert.ok(authorization.searchParams.get("code_challenge"));
    nonce = authorization.searchParams.get("nonce") ?? undefined;
    const jar = new Map();
    applyCookies(jar, response);
    return { jar, state: authorization.searchParams.get("state") };
  };
  const callback = async (auth, flow, withCookie = true) => {
    const response = await auth.handler(
      new Request(
        config.origin +
          "/api/auth/callback/google?code=fixture-code&state=" +
          flow.state,
        { headers: withCookie ? { cookie: cookieHeader(flow.jar) } : {} },
      ),
    );
    applyCookies(flow.jar, response);
    return response;
  };
  try {
    const auth = createGoogleOwnerAuth(config, ledger);
    const forged = await start(auth);
    await callback(auth, forged, false);
    assert.equal(
      exchanges,
      0,
      "Missing state cookie must fail before Google token exchange",
    );
    email = "stranger@gmail.com";
    const denied = await start(auth);
    await callback(auth, denied);
    assert.equal(
      await auth.api.getSession({
        headers: new Headers({ cookie: cookieHeader(denied.jar) }),
      }),
      null,
    );
    email = owner;
    verified = false;
    const unverified = await start(auth);
    await callback(auth, unverified);
    assert.equal(
      await auth.api.getSession({
        headers: new Headers({ cookie: cookieHeader(unverified.jar) }),
      }),
      null,
    );
    verified = true;
    const valid = await start(auth);
    const response = await callback(auth, valid);
    assert.equal(response.status, 302);
    const headers = new Headers({ cookie: cookieHeader(valid.jar) });
    const signed = await requireGoogleOwner(auth, config, ledger, headers);
    assert.equal(signed.user.email, owner);
    assert.ok(await store.ownerSession(signed.session.token));
    assert.equal(
      [...valid.jar.keys()].some((key) => key.includes("account_data")),
      false,
      "Google token material is not retained in an account cookie",
    );
    const restarted = createGoogleOwnerAuth(config, ledger);
    assert.equal(
      (await requireGoogleOwner(restarted, config, ledger, headers)).user.email,
      owner,
    );
    await assert.rejects(
      requireGoogleOwner(
        restarted,
        { emails: ["someone-else@gmail.com"] },
        ledger,
        headers,
      ),
      /allowed Google/,
    );
    const tampered = new Map(valid.jar);
    for (const [key, value] of tampered)
      if (key.includes("session_data"))
        tampered.set(key, `${value.slice(0, -2)}xx`);
    await assert.rejects(
      requireGoogleOwner(
        restarted,
        config,
        ledger,
        new Headers({ cookie: cookieHeader(tampered) }),
      ),
      /allowed Google/,
    );
    await store.revokeOwnerSession(signed.session.token);
    await assert.rejects(
      requireGoogleOwner(restarted, config, ledger, headers),
      /allowed Google/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await store.close();
  }
});
