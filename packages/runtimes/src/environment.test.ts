import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeEnvironment } from "./environment";

test("agents inherit OS essentials and their own provider authentication, never control credentials", () => {
  const source = {
    PATH: "/bin",
    HOME: "/home/agent",
    DATABASE_URL: "control-db",
    TELEGRAM_BOT_TOKEN: "bot",
    HARNESS_ADMIN_TOKEN: "admin",
    HARNESS_GOOGLE_RESOURCE_CLIENT_SECRET: "resource-client-secret",
    HARNESS_GOOGLE_RESOURCE_KEY: "resource-encryption-key",
    HARNESS_GOOGLE_RESOURCE_PREVIOUS_KEYS: "old-resource-keys",
    AWS_SECRET_ACCESS_KEY: "cloud",
    OPENAI_API_KEY: "openai",
    ANTHROPIC_API_KEY: "anthropic",
    NODE_OPTIONS: "unsafe",
  };
  assert.deepEqual(runtimeEnvironment("claude", source), {
    PATH: "/bin",
    HOME: "/home/agent",
    ANTHROPIC_API_KEY: "anthropic",
    NO_COLOR: "1",
  });
  assert.equal(
    runtimeEnvironment("codex", source).ANTHROPIC_API_KEY,
    undefined,
  );
  assert.equal(
    runtimeEnvironment("codex", source, { CRM_TOKEN: "scoped" }).CRM_TOKEN,
    "scoped",
  );
  assert.throws(
    () => runtimeEnvironment("codex", source, { NODE_OPTIONS: "unsafe" }),
    /binding/,
  );
});
