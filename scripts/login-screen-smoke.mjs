import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { basename, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const base = process.env.HARNESS_URL;
assert(
  base &&
    ["localhost", "127.0.0.1"].includes(new URL(base).hostname) &&
    new URL(base).port !== "3000",
  "Use an isolated local Google setup fixture",
);
assert(/fixture/.test(basename(process.env.HARNESS_SMOKE_DATA_DIR ?? "")));
let statusResponse;
for (let attempt = 0; attempt < 50; attempt++) {
  statusResponse = await fetch(`${base}/api/auth/status`).catch(
    () => undefined,
  );
  if (statusResponse?.status === 200) break;
  await delay(200);
}
assert(statusResponse, "Fixture control did not start");
assert.equal(
  statusResponse.status,
  200,
  "Missing Google credentials must not crash login readiness",
);
const status = await statusResponse.json();
assert.equal(status.mode, "google");
assert.equal(status.configured, false);
assert.deepEqual(Object.keys(status).sort(), [
  "configured",
  "hosted",
  "message",
  "mode",
]);
const require = createRequire(import.meta.url);
const { chromium } = require(
  require.resolve("patchright", { paths: [resolve("packages/browser")] }),
);
const run = promisify(execFile);
const session = `login-screen-${Date.now()}`;
const cli = (...args) =>
  run("agent-browser", ["--session", session, ...args], {
    env: {
      ...process.env,
      AGENT_BROWSER_EXECUTABLE_PATH: chromium.executablePath(),
    },
  });
try {
  await cli("open", `${base}/login`);
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const { stdout } = await cli(
      "eval",
      'JSON.stringify({inputs:document.querySelectorAll("input").length,text:document.body.textContent,disabled:[...document.querySelectorAll("button")].find(b=>b.textContent.includes("Continue with Google"))?.disabled})',
    );
    const value = JSON.parse(JSON.parse(stdout.trim()));
    if (value.text.includes("setup is pending") && value.disabled) {
      assert.equal(value.inputs, 0);
      assert(!value.text.toLowerCase().includes("access token"));
      ready = true;
      break;
    }
    await delay(150);
  }
  assert(ready, "Google setup message and disabled button did not render");
  assert.equal(
    (
      await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "old-fixture-token" }),
      })
    ).status,
    403,
  );
  assert.equal((await fetch(`${base}/api/workspaces`)).status, 503);
  assert.equal(
    (
      await fetch(`${base}/api/workers`, {
        headers: { authorization: "Bearer old-fixture-token" },
      })
    ).status,
    503,
  );
  await cli("screenshot", `/tmp/${session}.png`);
  console.log(
    JSON.stringify({
      passed: true,
      screenshot: `/tmp/${session}.png`,
      tokenForm: false,
      protectedData: "denied",
    }),
  );
} finally {
  await cli("close").catch(() => {});
}
