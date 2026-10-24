import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { BrowserBroker, browserTool } from "../apps/web/server/browser.ts";
import { HarnessStore } from "../packages/storage/src/application.ts";
import { browserFixture } from "./browser-live-fixture.mjs";

const base = process.env.HARNESS_URL ?? "http://localhost:3199";
const directory = process.env.HARNESS_SMOKE_DATA_DIR;
assert(
  directory &&
    basename(directory).includes("fixture") &&
    new URL(base).port !== "3000",
  "Use an isolated fixture stack",
);
const token = existsSync(join(directory, "admin-token"))
  ? readFileSync(join(directory, "admin-token"), "utf8").trim()
  : null;
const headers = {
  "Content-Type": "application/json",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
};
async function api(path, body) {
  const response = await fetch(`${base}/api/${path}`, {
    headers,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  assert(response.ok, `${path}: ${JSON.stringify(value)}`);
  return value;
}
const liveFixture = await browserFixture();
const fixture = liveFixture.server;
const pageUrl =
  process.env.HARNESS_LIVE_TEST_URL ??
  `http://127.0.0.1:${fixture.address().port}/`;
const run = promisify(execFile);
const require = createRequire(import.meta.url);
const { chromium } = require(
  require.resolve("patchright", { paths: [resolve("packages/browser")] }),
);
const browserName = `live-ui-${crypto.randomUUID().slice(0, 8)}`;
const cli = (...args) =>
  run("agent-browser", ["--session", browserName, ...args], {
    env: {
      ...process.env,
      AGENT_BROWSER_EXECUTABLE_PATH: chromium.executablePath(),
    },
    maxBuffer: 4 * 1024 * 1024,
  });
async function evaluate(js) {
  const { stdout } = await cli("eval", js);
  return JSON.parse(stdout.trim());
}
async function until(predicate, label) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await delay(100);
  }
  throw Error(label);
}
async function ready() {
  await until(
    () =>
      evaluate('Boolean(document.querySelector("canvas[data-ready=true]"))'),
    "No live frame",
  );
}
async function clickPage(x, y) {
  await evaluate(
    'document.querySelector("canvas").scrollIntoView({block:"center"});true',
  );
  const rect = JSON.parse(
    await evaluate(
      'JSON.stringify((()=>{const r=document.querySelector("canvas").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})())',
    ),
  );
  const scale = Math.min(rect.width / 1280, rect.height / 800);
  await cli(
    "mouse",
    "move",
    String(Math.round(rect.x + (rect.width - 1280 * scale) / 2 + x * scale)),
    String(Math.round(rect.y + (rect.height - 800 * scale) / 2 + y * scale)),
  );
  await cli("mouse", "down");
  await cli("mouse", "up");
}
let workspace;
let session;
try {
  workspace = await api("workspaces", {
    name: "Live browser acceptance fixture",
    instructions: "Fixture only; no model calls",
  });
  session = await api("sessions", {
    workspaceId: workspace.id,
    title: "Direct browser input fixture",
    provider: "demo",
  });
  if (token) {
    await cli("open", `${base}/login`);
    assert(
      await evaluate(
        `fetch('/api/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({token:${JSON.stringify(token)}}) }).then(r=>r.ok)`,
      ),
      "Fixture owner login failed",
    );
  }
  await cli("open", `${base}/?workspace=${workspace.id}&session=${session.id}`);
  await cli("find", "role", "button", "click", "--name", "Open browser");
  await ready();
  assert.match(
    await evaluate(
      'document.querySelector("[data-testid=browser-stream-status]").textContent',
    ),
    /Watching/,
  );
  const before = await api(
    `state?workspace=${workspace.id}&session=${session.id}`,
  );
  await cli("find", "role", "button", "click", "--name", "Take control");
  await ready();
  await cli("find", "label", "Browser address", "fill", pageUrl);
  await cli("find", "role", "button", "click", "--name", "Go", "--exact");
  await until(
    () =>
      evaluate(
        `document.querySelector('[aria-label="Browser address"]').value.includes("127.0.0.1")`,
      ),
    "Navigation not visible",
  );
  await delay(1000);
  await clickPage(550, 280);
  await cli("press", "h");
  await cli("press", "i");
  if (!process.env.HARNESS_LIVE_TEST_URL)
    await until(
      () => Promise.resolve(liveFixture.observation.user === "hi"),
      "Native typing did not reach the remote page",
    );
  await cli("press", "Tab");
  await evaluate(
    `(()=>{const data=new DataTransfer();data.setData('text/plain','fixture-only-password');document.querySelector('canvas').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));return true})()`,
  );
  if (!process.env.HARNESS_LIVE_TEST_URL)
    await until(
      () =>
        Promise.resolve(
          liveFixture.observation.password === "fixture-only-password",
        ),
      "Paste did not reach remote password field",
    );
  await cli("press", "Backspace");
  if (!process.env.HARNESS_LIVE_TEST_URL)
    await until(
      () =>
        Promise.resolve(
          liveFixture.observation.password === "fixture-only-passwor",
        ),
      "Backspace was not forwarded",
    );
  await clickPage(550, 465);
  if (!process.env.HARNESS_LIVE_TEST_URL)
    await until(
      () => Promise.resolve(liveFixture.observation.clicks === 1),
      "Click did not activate remote button",
    );
  const frames = await evaluate(
    'Number(document.querySelector("canvas").dataset.frameSequence)',
  );
  await delay(1200);
  const next = await evaluate(
    'Number(document.querySelector("canvas").dataset.frameSequence)',
  );
  assert(
    next - frames >= 4,
    `Stream too slow: ${next - frames} frames in 1.2s`,
  );
  const status = await evaluate(
    'document.querySelector("[data-testid=browser-stream-status]").textContent',
  );
  assert.match(status, /Live/);
  const latency = Number(status.match(/(\d+) ms/)?.[1]);
  assert(latency < 1000, `Input acknowledgement too slow: ${status}`);
  await cli("screenshot", `/tmp/${browserName}.png`);
  // Fetch a two-chunk credential-shaped file through the encrypted owner stream.
  // Intercept the final Blob in this isolated UI so no real Downloads folder is used.
  await evaluate(
    `(()=>{const original=URL.createObjectURL;URL.createObjectURL=function(blob){window.__fixtureDownload=blob.text();return original.call(this,blob)};return true})()`,
  );
  await clickPage(120, 670);
  await until(
    () =>
      evaluate(
        'document.body.textContent.includes("Download fixture-oauth.json")',
      ),
    "Worker download never appeared",
  );
  await cli(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Download fixture-oauth.json",
    "--exact",
  );
  await until(
    () => evaluate("Boolean(window.__fixtureDownload)"),
    "Encrypted file did not reach the owner",
  );
  assert(
    await evaluate(
      'window.__fixtureDownload.then(text=>{const value=JSON.parse(text);return value.client_secret==="fixture-secret-only"&&value.padding.length===90000})',
    ),
    "Downloaded credential fixture was truncated or changed",
  );
  await cli("press", "Escape");
  await until(
    () =>
      evaluate(
        'document.querySelector("[data-testid=browser-stream-status]").textContent.includes("Watching")',
      ),
    "Escape did not release control",
  );
  await ready();
  const after = await api(
    `state?workspace=${workspace.id}&session=${session.id}`,
  );
  assert.equal(
    after.turns.length,
    before.turns.length,
    "Inspecting/releasing the browser sent a message",
  );
  // Exercise a real agent browser read and its UI activity through the same broker,
  // without buying a model call or letting a fixture's Demo lane race the claim.
  const store = new HarnessStore(join(directory, "harness.sqlite"));
  await store.ready;
  const workers = await store.listWorkers();
  let cleanup;
  let finished = false;
  try {
    for (const worker of workers) await store.drainWorker(worker.id, true);
    const driver = await store.createWorker(
      "Browser acceptance driver fixture",
    );
    await store.reportWorker(driver.id, {
      hostname: "fixture-driver",
      providers: ["demo"],
      labels: [],
      maxAgents: 1,
      memoryBudgetMiB: 1024,
      cpuSlots: 1,
      maxBuilds: 0,
      maxBrowsers: 0,
      availableMemoryMiB: 4096,
      reserveMemoryMiB: 128,
      loadPerCpu: 0,
      maxLoadPerCpu: 2,
      draining: false,
      browserHost: false,
    });
    const turnId = crypto.randomUUID();
    await store.createTurn(
      turnId,
      session.id,
      "Read the controlled browser fixture",
    );
    const task = await store.taskForSession(session.id);
    if (task)
      await store.updateTask(task.id, {
        priority: 100,
        targetWorkerId: driver.id,
      });
    await store.enqueue(turnId);
    const claim = await store.claimForWorker(driver.id);
    assert.equal(claim.claim.turn.id, turnId);
    cleanup = {
      workerId: driver.id,
      turnId,
      generation: claim.claim.turn.generation,
    };
    const output = await browserTool(
      {
        workerId: driver.id,
        turnId,
        generation: claim.claim.turn.generation,
        expiresAt: Date.now() + 60000,
        purpose: "tools",
      },
      { action: "read" },
      store,
    );
    assert(output.result, "Agent read has no result");
    assert.equal(
      output.image,
      undefined,
      "Read previews must not spend model vision tokens",
    );
    const screenshot = await browserTool(
      {
        workerId: driver.id,
        turnId,
        generation: claim.claim.turn.generation,
        expiresAt: Date.now() + 60000,
        purpose: "tools",
      },
      { action: "screenshot" },
      store,
    );
    assert(screenshot.image, "Agent screenshot has no image");
    await store.saveCheckpoint(
      driver.id,
      turnId,
      claim.claim.turn.generation,
      crypto.randomUUID(),
      { version: 1, files: [] },
    );
    await store.completeWorkerTurn(
      driver.id,
      turnId,
      claim.claim.turn.generation,
      "completed",
    );
    finished = true;
    const activity = await api(
      `browser?workspace=${workspace.id}&session=${session.id}`,
    );
    assert(
      activity.steps.some(
        (step) => step.label === "Captured screenshot" && step.image,
      ),
      "No browser action screenshot in activity",
    );
    assert(
      activity.steps.some(
        (step) => step.label.startsWith("Read ") && step.image,
      ),
      "Page read has no history preview",
    );
    assert.deepEqual(
      activity.steps.map((step) => step.createdAt),
      [...activity.steps.map((step) => step.createdAt)].sort((a, b) => a - b),
      "History is not chronological",
    );
    assert(
      activity.steps.every((step) => !step.label.includes("http")),
      "Raw URLs should be details, not action labels",
    );
    assert(
      !JSON.stringify(activity.steps).includes("fixture-only-passwor"),
      "Manual password leaked into history",
    );
    await until(
      () => evaluate('document.body.textContent.includes("Browser activity")'),
      "Activity timeline did not render",
    );
    await cli(
      "find",
      "role",
      "button",
      "click",
      "--name",
      "Close browser view",
    );
    await evaluate(
      `[...document.querySelectorAll('[aria-label="Browser activity"] button[aria-expanded]')].forEach((button) => button.getAttribute("aria-expanded") === "false" && button.click());true`,
    );
    await evaluate(
      `document.querySelector('[aria-label="Browser steps, oldest first"]').scrollIntoView({block:"start"});true`,
    );
    await until(
      () =>
        evaluate(
          `document.querySelectorAll('[aria-label="Browser steps, oldest first"] img').length >= 2`,
        ),
      "Timeline thumbnails missing from UI",
    );
    assert.equal(
      await evaluate(
        "document.documentElement.scrollWidth > window.innerWidth",
      ),
      false,
      "Activity timeline overflows",
    );
    await evaluate(
      `document.querySelector('button[aria-label^="View step"]').click();true`,
    );
    await until(
      () =>
        evaluate(
          `Boolean(document.querySelector('[role="dialog"][aria-label^="Step"] img'))`,
        ),
      "Screenshot viewer did not open",
    );
    await evaluate(
      `document.querySelector('[role="dialog"] button[aria-label="Close"]').click();true`,
    );
    await cli("screenshot", `/tmp/${browserName}-activity.png`);
    const identity = (
      await api(`browser?workspace=${workspace.id}&session=${session.id}`)
    ).browser;
    const manualRows = await store
      .databaseConnection()
      .prepare(
        "SELECT COUNT(*) AS count FROM browser_commands WHERE browserId = ? AND action = 'manual'",
      )
      .get(identity.id);
    assert.equal(
      Number(manualRows.count),
      0,
      "Live password input passed through the SQL command queue",
    );
    await store.requestInput(
      `${identity.id}:acceptance-login`,
      session.id,
      null,
      "browser-login",
      "Use interactive sign-in",
    );
  } finally {
    if (cleanup && !finished)
      await store
        .completeWorkerTurn(
          cleanup.workerId,
          cleanup.turnId,
          cleanup.generation,
          "failed",
          "Acceptance fixture failed; no model was run",
        )
        .catch(() => {});
    if (cleanup) await store.drainWorker(cleanup.workerId, true);
    for (const worker of workers)
      await store.drainWorker(worker.id, !!worker.draining);
    await store.close();
  }

  await cli("reload");
  await until(
    () =>
      evaluate(
        '[...document.querySelectorAll("button")].some(button => button.textContent.trim() === "1. Take control to sign in")',
      ),
    "A login wait did not expose Sign in",
  );
  await cli(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "1. Take control to sign in",
    "--exact",
  );
  await ready();
  await cli("focus", "canvas");
  await cli("press", "Escape");
  await ready();
  const waiting = await api(
    `state?workspace=${workspace.id}&session=${session.id}`,
  );
  assert.equal(
    waiting.turns.length,
    before.turns.length + 1,
    "Release during login sent a message",
  );
  assert(
    waiting.inputRequests.some((input) => input.kind === "browser-login"),
    "Release silently resolved a login wait",
  );
  await cli(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "1. Take control to sign in",
    "--exact",
  );
  await ready();
  await cli(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "2. Done — continue task",
    "--exact",
  );
  await ready();
  const resumed = await api(
    `state?workspace=${workspace.id}&session=${session.id}`,
  );
  assert.equal(
    resumed.turns.length,
    before.turns.length + 2,
    "Explicit Continue did not submit exactly one instruction",
  );
  assert(
    !resumed.inputRequests.some((input) => input.kind === "browser-login"),
    "Explicit Continue left the login wait pending",
  );
  await cli("find", "role", "button", "click", "--name", "Close browser view");
  await cli("find", "role", "button", "click", "--name", "Open browser");
  await ready();
  assert.equal(
    (await api(`state?workspace=${workspace.id}&session=${session.id}`)).turns
      .length,
    before.turns.length + 2,
  );
  await cli("set", "viewport", "390", "844");
  await cli("open", `${base}/schedules`);
  assert.equal(
    await evaluate("document.documentElement.scrollWidth > window.innerWidth"),
    false,
    "Mobile viewport overflows",
  );
  console.log(
    JSON.stringify({
      passed: true,
      host: (
        await api(`browser?workspace=${workspace.id}&session=${session.id}`)
      ).host,
      framesIn1_2s: next - frames,
      inputAckMs: latency,
      screenshot: `/tmp/${browserName}.png`,
      activityScreenshot: `/tmp/${browserName}-activity.png`,
      encryptedDownload: true,
      sessionId: session.id,
      workspaceId: workspace.id,
    }),
  );
} catch (error) {
  await cli("screenshot", `/tmp/${browserName}-failure.png`).catch(() => {});
  console.error(
    await evaluate(
      `document.querySelector('[aria-label="Workspace browser"]')?.textContent`,
    ).catch(() => "No browser panel"),
  );
  throw error;
} finally {
  if (workspace && session) {
    const state = await api(
      `browser?workspace=${workspace.id}&session=${session.id}`,
    ).catch(() => null);
    if (state?.browser?.mode === "human")
      await api("browser", {
        action: "return",
        workspaceId: workspace.id,
        sessionId: session.id,
        generation: state.browser.generation,
      }).catch(() => {});
  }
  await cli("close").catch(() => {});
  if (workspace) {
    const cleanup = new HarnessStore(join(directory, "harness.sqlite"));
    await cleanup.ready;
    try {
      const broker = new BrowserBroker(cleanup);
      const browser = await broker.forWorkspace(workspace.id);
      if (browser?.workerId && browser.mode === "agent")
        await broker.release(browser.workerId, browser.id, browser.generation);
    } finally {
      await cleanup.close();
    }
  }
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
}
