import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { HarnessStore } from "../packages/storage/src/application.ts";

const base = process.env.HARNESS_URL;
const directory = process.env.HARNESS_SMOKE_DATA_DIR;
assert.ok(
  base &&
    ["127.0.0.1", "localhost"].includes(new URL(base).hostname) &&
    new URL(base).port !== "3000",
  "Use a separate local fixture stack, not the personal port 3000",
);
assert.ok(
  directory && /fixture/.test(basename(directory)),
  "Point HARNESS_SMOKE_DATA_DIR at that fixture database",
);
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".data/browser-cache");
const require = createRequire(import.meta.url);
const imported = await import(
  pathToFileURL(
    require.resolve("patchright", { paths: [resolve("packages/browser")] }),
  ).href
);
const { chromium } = imported.default ?? imported;
const sessionName = `login-ui-${crypto.randomUUID().slice(0, 8)}`;
const run = promisify(execFile);
const cli = (...args) =>
  run("agent-browser", ["--session", sessionName, ...args], {
    env: {
      ...process.env,
      AGENT_BROWSER_EXECUTABLE_PATH: chromium.executablePath(),
    },
  });
async function api(path, body) {
  const r = await fetch(
    `${base}/api/${path}`,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  const data = await r.json();
  assert.ok(r.ok, JSON.stringify(data));
  return data;
}
const workspace = await api("workspaces", {
  name: "Login UI fixture",
  instructions: "No model calls or external accounts",
});
const session = await api("sessions", {
  workspaceId: workspace.id,
  title: "Login UI fixture",
  provider: "demo",
});
const store = new HarnessStore(join(resolve(directory), "harness.sqlite"));
await store.ready;
async function until(expression, message) {
  for (let i = 0; i < 90; i++) {
    const { stdout } = await cli("eval", `Boolean(${expression})`);
    if (stdout.trim() === "true") return;
    await delay(500);
  }
  throw Error(message);
}
try {
  await cli("open", `${base}/?workspace=${workspace.id}&session=${session.id}`);
  await until(
    'document.querySelector("[aria-label=\\"Open browser\\"]")',
    "Composer browser shortcut missing",
  );
  let result = await cli(
    "eval",
    'document.querySelectorAll("[aria-label=\\"Workspace browser\\"]").length',
  );
  assert.equal(
    result.stdout.trim(),
    "0",
    "An idle conversation must have no browser card",
  );
  const { browser } = await api("browser", {
    workspaceId: workspace.id,
    sessionId: session.id,
    action: "enable",
  });
  await store.requestInput(
    `${browser.id}:fixture-login-${session.id}`,
    session.id,
    null,
    "browser-login",
    "Old non-actionable instruction",
  );
  await until(
    '[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Sign in")',
    "A real login request must automatically expose the Sign in action",
  );
  result = await cli(
    "eval",
    'document.body.textContent.includes("Old non-actionable instruction")',
  );
  assert.equal(
    result.stdout.trim(),
    "false",
    "Do not leave the old passive browser-panel banner",
  );
  await cli("find", "role", "button", "click", "--name", "Sign in");
  await until(
    'document.querySelector("img[alt=\\"Current browser page\\"]")',
    "One click must open the interactive browser view",
  );
  await cli("find", "role", "button", "click", "--name", "Return to agent");
  await until(
    '!document.querySelector("[aria-label=\\"Workspace browser\\"]")',
    "Browser card must disappear after returning control",
  );
  const state = await api(
    `state?workspace=${workspace.id}&session=${session.id}`,
  );
  assert.ok(!state.inputRequests.some((r) => r.kind === "browser-login"));
  await cli("find", "role", "button", "click", "--name", "Open browser");
  await until(
    'document.querySelector("[aria-label=\\"Workspace browser\\"]")',
    "Explicit open must still work",
  );
  await cli("find", "role", "button", "click", "--name", "Close browser view");
  await until(
    '!document.querySelector("[aria-label=\\"Workspace browser\\"]")',
    "Explicit close must hide the view",
  );
  console.log(
    "Headless agent-browser login UI passed: no idle card, automatic sign-in action, one-click live frame, resolved request, automatic hide, explicit open/close. Fixture records retained.",
  );
} finally {
  await cli("close").catch(() => {});
  await store.close();
}
