import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { allowedSecretVariable } from "@harness/core/resources";
import {
  mintAttemptGrant,
  verifyAttemptGrant,
} from "../../../apps/web/server/grants";
import {
  authorizeOwner,
  hostedConfiguration,
  ownerAllowed,
  publicOrigin,
} from "../../../apps/web/server/hosted-auth";
import { authorizeAdmin, sameOrigin } from "../../../apps/web/server/security";

test("hosted owner checks fail closed and never inherit loopback administrator bypass", async () => {
  const prior = { ...process.env };
  try {
    delete process.env.VERCEL;
    process.env.HARNESS_HOSTED = "1";
    process.env.HARNESS_PUBLIC_URL = "https://control.example";
    delete process.env.DATABASE_URL;
    assert.throws(hostedConfiguration, /disabled/);
    Object.assign(process.env, {
      DATABASE_URL: "postgresql://fixture.invalid/unused",
      HARNESS_OIDC_ISSUER: "https://issuer.example",
      HARNESS_OIDC_CLIENT_ID: "fixture",
      HARNESS_OWNER_SUBJECTS: "owner-subject",
      HARNESS_OWNER_EMAILS: "owner@example.com",
      HARNESS_GRANT_KEY: randomBytes(32).toString("base64url"),
      HARNESS_REQUIRE_AUTH: "0",
      HARNESS_BIND_HOST: "127.0.0.1",
    });
    hostedConfiguration();
    assert.ok(ownerAllowed({ sub: "owner-subject" }));
    assert.ok(
      !ownerAllowed({
        sub: "stranger",
        email: "owner@example.com",
        email_verified: false,
      }),
    );
    assert.ok(
      ownerAllowed({
        sub: "stranger",
        email: "OWNER@example.com",
        email_verified: true,
      }),
    );
    await assert.rejects(
      authorizeOwner(new Request("https://control.example/api/state")),
      (error) =>
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 401,
    );
    await assert.rejects(
      authorizeAdmin(
        new Request("https://control.example/api/state", {
          headers: {
            authorization: "Bearer old-local-token",
            cookie: "harness_session=local-cookie",
          },
        }),
      ),
      (error) =>
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 401,
    );
    assert.throws(
      () =>
        sameOrigin(
          new Request("https://control.example/api/turns", {
            headers: {
              origin: "https://attacker.example",
              host: "control.example",
            },
          }),
        ),
      /Cross-origin/,
    );
    process.env.HARNESS_PUBLIC_URL = "http://control.example";
    assert.throws(publicOrigin, /HTTPS/);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in prior)) delete process.env[key];
    Object.assign(process.env, prior);
  }
});
test("attempt capabilities reject tampering and secret bindings cannot alter native replay/sandbox behavior", () => {
  const previous = process.env.HARNESS_GRANT_KEY;
  try {
    process.env.HARNESS_GRANT_KEY = randomBytes(32).toString("base64url");
    const token = mintAttemptGrant("worker", "turn", 7);
    assert.equal(verifyAttemptGrant(token).generation, 7);
    assert.throws(() => verifyAttemptGrant(`${token}x`), /Invalid/);
    assert.throws(() => verifyAttemptGrant("not-a-capability"), /Invalid/);
    for (const name of [
      "CLAUDE_CODE_RESUME_INTERRUPTED_TURN",
      "NODE_OPTIONS",
      "HARNESS_WORKER_TOKEN_FILE",
      "DYLD_INSERT_LIBRARIES",
      "GIT_SSH_COMMAND",
      "HOME",
    ])
      assert.equal(allowedSecretVariable(name), false, name);
    for (const name of [
      "CRM_API_TOKEN",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ])
      assert.ok(allowedSecretVariable(name), name);
  } finally {
    if (previous === undefined) delete process.env.HARNESS_GRANT_KEY;
    else process.env.HARNESS_GRANT_KEY = previous;
  }
});
