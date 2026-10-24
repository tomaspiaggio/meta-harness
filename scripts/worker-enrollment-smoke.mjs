import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const base = process.env.HARNESS_URL;
assert.ok(
  base &&
    ["127.0.0.1", "localhost"].includes(new URL(base).hostname) &&
    new URL(base).port !== "3000",
  "Use an isolated local fixture stack, never personal port 3000",
);
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".data/browser-cache");
const require = createRequire(import.meta.url);
const { chromium } = require(
  require.resolve("patchright", { paths: [resolve("packages/browser")] }),
);
const run = promisify(execFile);
const session = `worker-enroll-${crypto.randomUUID().slice(0, 8)}`;
const cli = (...args) =>
  run("agent-browser", ["--session", session, ...args], {
    env: {
      ...process.env,
      AGENT_BROWSER_EXECUTABLE_PATH: chromium.executablePath(),
    },
  });
const evaluate = async (expression) =>
  JSON.parse((await cli("eval", expression)).stdout);
const created = [];
try {
  await cli("open", `${base}/settings`);
  for (let i = 0; i < 50; i++) {
    if (
      await evaluate(
        'Boolean(document.querySelector("#worker-control-url") && document.querySelector("input[aria-label=\\"New machine name\\"]"))',
      )
    )
      break;
    await delay(100);
  }
  assert.equal(
    await evaluate(
      'document.querySelector("#worker-control-url").closest("[data-slot=card]").querySelectorAll("input").length',
    ),
    2,
  );
  await evaluate(
    'document.querySelector("#worker-control-url").closest("details").open = true',
  );
  await cli("fill", "#worker-control-url", base);
  await cli(
    "fill",
    'input[aria-label="New machine name"]',
    "Agent setup fixture",
  );
  await evaluate(`(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async text => { window.__copiedWorkerSetup = text; }
    }});
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { window.__workerGuide = blob; return create(blob); };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { window.__workerFilename = this.download; return click.call(this); };
    return true;
  })()`);
  await cli("find", "role", "button", "click", "--name", "Create setup");
  let guide;
  for (let i = 0; i < 50; i++) {
    guide = await evaluate(`(async () => {
      if (!window.__copiedWorkerSetup) return null;
      const markdown = window.__copiedWorkerSetup;
      const match = markdown.match(/\x60\x60\x60json\\n([\\s\\S]*?)\\n\x60\x60\x60/);
      return { markdown, credential: match && JSON.parse(match[1]) };
    })()`);
    if (guide) break;
    await delay(100);
  }
  assert.ok(guide, "Enrollment must copy the setup prompt");
  if (guide.credential?.id) created.push(guide.credential.id);
  assert.equal(
    await evaluate(
      'document.body.innerText.includes("Paste the setup into a coding agent on that machine")',
    ),
    true,
  );
  assert.equal(
    await evaluate("Boolean(window.__workerGuide)"),
    false,
    "Enrollment must not download a file automatically",
  );
  await cli("find", "role", "button", "click", "--name", "Download");
  const download = await evaluate(
    "(async () => ({markdown:await window.__workerGuide.text(),filename:window.__workerFilename,type:window.__workerGuide.type}))()",
  );
  assert.equal(download.filename, "Agent-setup-fixture-setup.md");
  assert.match(download.type, /^text\/markdown/);
  assert.equal(
    download.markdown,
    guide.markdown,
    "Download reuses the same enrollment",
  );
  await evaluate(
    'navigator.clipboard.writeText = async () => {throw new Error("Clipboard denied")}; true',
  );
  await cli("find", "role", "button", "click", "--name", "Copy again");
  assert.equal(
    await evaluate('document.querySelector("textarea[readonly]")?.value'),
    guide.markdown,
  );
  await evaluate(
    "navigator.clipboard.writeText = async text => {window.__copiedWorkerSetup = text}; true",
  );
  await cli("find", "role", "button", "click", "--name", "Copy setup");
  assert.equal(
    await evaluate('Boolean(document.querySelector("textarea[readonly]"))'),
    false,
  );
  assert.ok(
    guide.credential?.id && guide.credential.token,
    "Guide contains the new worker credential",
  );
  assert.equal(guide.credential.serverUrl, base);
  assert.match(guide.markdown, /HARNESS_BROWSER_BACKEND=managed/);
  assert.match(guide.markdown, /pnpm browser:install/);
  const response = await fetch(`${base}/api/worker?action=report`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-worker-id": guide.credential.id,
      authorization: `Bearer ${guide.credential.token}`,
    },
    body: JSON.stringify({
      report: {
        hostname: "onboarding-fixture",
        providers: ["demo"],
        labels: [],
        maxAgents: 1,
        memoryBudgetMiB: 4096,
        cpuSlots: 2,
        maxBuilds: 1,
        maxBrowsers: 0,
        availableMemoryMiB: 8192,
        reserveMemoryMiB: 512,
        loadPerCpu: 0,
        maxLoadPerCpu: 2,
        draining: false,
      },
    }),
  });
  assert.equal(
    response.status,
    200,
    "Downloaded credential must authenticate as the enrolled worker",
  );
  const workers = await fetch(`${base}/api/workers`).then((r) => r.json());
  const online = workers.find((w) => w.id === guide.credential.id);
  assert.ok(online?.seenAt, "Worker becomes Online with that credential");
  assert.equal(
    online.token,
    undefined,
    "Worker list must not expose the credential",
  );
  const invalid = await fetch(`${base}/api/workers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Invalid fixture",
      serverUrl: "https://example.test/not-an-origin",
      format: "markdown",
    }),
  });
  assert.equal(invalid.status, 400);
  const forbidden = await fetch(`${base}/api/workers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin: "https://example.test",
    },
    body: JSON.stringify({
      name: "Forbidden fixture",
      serverUrl: base,
      format: "markdown",
    }),
  });
  assert.equal(forbidden.status, 403);
  console.log(
    "Headless worker enrollment passed: two fields, copied agent prompt, optional Markdown download, clipboard-denied recovery, usable scoped credential, Online report, invalid URL and cross-origin rejection. Fixture records retained.",
  );
} finally {
  await cli("close").catch(() => {});
  for (const id of created)
    await fetch(`${base}/api/workers`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
}
