import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEnvUpdates, resourceEnvUpdates } from "./google-resource-env.mjs";

const input = {
  clientId: "resource-client.apps.googleusercontent.com",
  clientSecret: "fixture-secret",
  redirectUri: "http://localhost:3000/api/integrations/google/callback",
};

test("resource env generates a key once and preserves unrelated settings", () => {
  const updates = resourceEnvUpdates({ GOOGLE_CLIENT_ID: "owner" }, input);
  assert.match(updates.HARNESS_GOOGLE_RESOURCE_KEY, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(updates.HARNESS_GOOGLE_RESOURCE_KEY_ID, "primary");
  const text = applyEnvUpdates(
    "# owner\nGOOGLE_CLIENT_ID=owner\nHARNESS_GOOGLE_RESOURCE_CLIENT_ID=old\n",
    updates,
  );
  assert.match(text, /^# owner\nGOOGLE_CLIENT_ID=owner\n/);
  assert.equal(text.match(/HARNESS_GOOGLE_RESOURCE_CLIENT_ID=/g).length, 1);
  assert.match(text, new RegExp(`CLIENT_ID=${input.clientId}\n`));
  assert.ok(text.endsWith("\n"));
});

test("resource env keeps an existing valid key and refuses an invalid one", () => {
  const key = "A".repeat(43);
  const kept = resourceEnvUpdates({ HARNESS_GOOGLE_RESOURCE_KEY: key }, input);
  assert.equal("HARNESS_GOOGLE_RESOURCE_KEY" in kept, false);
  assert.throws(
    () => resourceEnvUpdates({ HARNESS_GOOGLE_RESOURCE_KEY: "short" }, input),
    /was not replaced/,
  );
});

test("resource env rejects a wrong callback path and unsafe values", () => {
  assert.throws(
    () =>
      resourceEnvUpdates(
        {},
        {
          ...input,
          redirectUri: "http://localhost:3000/api/auth/callback/google",
        },
      ),
    /exactly \/api\/integrations\/google\/callback/,
  );
  assert.throws(
    () => resourceEnvUpdates({}, { ...input, clientSecret: "a b" }),
    /unsupported characters/,
  );
});
