import assert from "node:assert/strict";
import { test } from "node:test";
import { workerOnboarding } from "../apps/web/server/worker-onboarding.ts";

test("worker handoff carries one usable scoped credential and agent-led setup without extra enrollment inputs", () => {
  const credential = {
    id: "fixture-worker",
    token: "fixture-worker-token-only",
    serverUrl: "https://harness.example.test",
  };
  const { filename, markdown } = workerOnboarding("Raspberry Pi", credential);
  assert.equal(filename, "Raspberry-Pi-setup.md");
  const blocks = [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)];
  assert.equal(blocks.length, 1);
  assert.deepEqual(JSON.parse(blocks[0][1]), credential);
  assert.match(
    markdown,
    /git clone --branch main https:\/\/github.com\/tomaspiaggio\/meta-harness.git/,
  );
  assert.match(markdown, /https:\/\/harness.example.test\/settings/);
  assert.match(markdown, /HARNESS_PROVIDERS=demo HARNESS_BROWSER_ENABLED=0/);
  assert.match(
    markdown,
    /HARNESS_WORKER_TOKEN_FILE=~\/\.config\/meta-harness\/worker.json pnpm browser:pair/,
  );
  assert.match(markdown, /chrome:\/\/extensions/);
  assert.match(markdown, /headless Pi/);
  assert.doesNotMatch(markdown, /HARNESS_ADMIN_TOKEN|HARNESS_ENCRYPTION_KEY/);
});

test("device labels cannot add Markdown instructions or unsafe download paths", () => {
  const { filename, markdown } = workerOnboarding("Pi\n```<script>../../", {
    id: "fixture",
    token: "fixture-token",
    serverUrl: "https://harness.example.test",
  });
  assert.match(filename, /^[a-zA-Z0-9_-]+\.md$/);
  assert.equal(markdown.split("\n")[0].includes("<script>"), false);
  assert.equal(markdown.split("\n")[0].includes("```"), false);
});
