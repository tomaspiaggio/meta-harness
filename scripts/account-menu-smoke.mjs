import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const base = process.env.HARNESS_URL;
const directory = process.env.HARNESS_SMOKE_DATA_DIR;
assert(
  base &&
    new URL(base).port !== "3000" &&
    ["localhost", "127.0.0.1"].includes(new URL(base).hostname),
);
assert(directory && basename(directory).includes("fixture"));
const token = (await readFile(join(directory, "admin-token"), "utf8")).trim();
const require = createRequire(import.meta.url);
const { chromium } = require(
  require.resolve("patchright", { paths: [resolve("packages/browser")] }),
);
const run = promisify(execFile);
const session = `account-menu-${Date.now()}`;
const cli = (...args) =>
  run("agent-browser", ["--session", session, ...args], {
    env: {
      ...process.env,
      AGENT_BROWSER_EXECUTABLE_PATH: chromium.executablePath(),
    },
  });
const evaluate = async (js) =>
  JSON.parse((await cli("eval", js)).stdout.trim());
try {
  await cli("open", `${base}/login`);
  assert(
    await evaluate(
      `fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:${JSON.stringify(token)}})}).then(r=>r.ok)`,
    ),
  );
  // Google profile fields and revocation use signed SDK route tests. This UI
  // fixture exercises the generic account fallback and a real owner-cookie logout.
  await cli("open", base);
  await cli(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Account menu",
    "--exact",
  );
  await cli("wait", "--text", "Your account");
  await cli("press", "Escape");
  assert.equal(
    await evaluate("Boolean(document.querySelector('[role=\"menu\"]'))"),
    false,
  );
  await cli("set", "viewport", "390", "844");
  await cli(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Account menu",
    "--exact",
  );
  assert.equal(
    await evaluate("document.documentElement.scrollWidth > window.innerWidth"),
    false,
  );
  await cli("screenshot", `/tmp/${session}.png`);
  await cli("set", "offline", "on");
  await cli(
    "find",
    "role",
    "menuitem",
    "click",
    "--name",
    "Sign out",
    "--exact",
  );
  await cli("wait", "[role=alert]");
  await cli("set", "offline", "off");
  assert(await evaluate('fetch("/api/workspaces").then(r=>r.ok)'));
  await cli(
    "find",
    "role",
    "menuitem",
    "click",
    "--name",
    "Sign out",
    "--exact",
  );
  await cli("wait", "--url", "**/login");
  assert.equal(
    await evaluate('fetch("/api/workspaces").then(r=>r.status)'),
    401,
  );
  console.log(
    JSON.stringify({
      passed: true,
      accountFallback: true,
      mobile: true,
      escape: true,
      logoutFailureRecovery: true,
      logout: true,
      screenshot: `/tmp/${session}.png`,
    }),
  );
} finally {
  await cli("close").catch(() => {});
}
