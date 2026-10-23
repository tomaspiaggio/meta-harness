import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { BrowserAssignment } from "@harness/core/browser";
import { BrowserHost } from "./index";

test("extension-backed Patchright uses existing login without Chrome debugging approval, preserves focus and reconnects after idle", {
  skip: process.env.HARNESS_TEST_BROWSER !== "1",
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-extension-"));
  const fixture = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.setHeader(
      "Content-Security-Policy",
      "require-trusted-types-for 'script'; trusted-types 'none'",
    );
    if (!request.headers.cookie?.includes("existing=yes")) {
      response.writeHead(403);
      response.end("Login required");
      return;
    }
    response.end(
      request.url?.includes("/htmlview/sheet")
        ? '<table class="waffle"><tr><th>1</th><td>Company</td><td>Status</td></tr><tr><th>2</th><td>Fixture customer</td><td>Follow up</td></tr></table>'
        : "<h1>Signed in CRM</h1><canvas aria-label='CRM grid'></canvas>",
    );
  });
  await new Promise<void>((done) => fixture.listen(0, "127.0.0.1", done));
  const address = fixture.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/spreadsheets/d/fixture/edit#gid=1`;
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const relayAddress = probe.address();
  assert.ok(relayAddress && typeof relayAddress !== "string");
  await new Promise<void>((done) => probe.close(() => done()));
  const pairing = {
    port: relayAddress.port,
    token: randomBytes(32).toString("base64url"),
  };
  const path = join(root, "pairing.json");
  await writeFile(path, JSON.stringify(pairing), { mode: 0o600 });
  const previous = process.env.HARNESS_BROWSER_EXTENSION_CONFIG;
  process.env.HARNESS_BROWSER_EXTENSION_CONFIG = path;
  const host = new BrowserHost(join(root, "host"), {
    backend: "extension",
    allowTestLoopback: true,
  });
  await host.initialize();
  const { chromium } = await import("patchright");
  const extension = resolve("apps/browser-extension/dist");
  const chrome = await chromium.launchPersistentContext(join(root, "chrome"), {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const assignment = (action: string, args = {}): BrowserAssignment => ({
    identity: {
      id: "extension-crm",
      workspaceId: "business",
      name: "CRM",
      workerId: "fixture",
      status: "ready",
      mode: "agent",
      generation: 1,
      leaseUntil: Date.now() + 60000,
      userPublicKey: null,
      expiresAt: null,
      lastUrl: null,
      frame: null,
      frameAt: null,
      error: null,
      stateCipher: null,
      updatedAt: Date.now(),
    },
    stateKey: randomBytes(32).toString("base64"),
    command: {
      id: crypto.randomUUID(),
      browserId: "extension-crm",
      turnId: null,
      turnGeneration: null,
      browserGeneration: 1,
      action,
      arguments: JSON.stringify(args),
      status: "running",
      result: null,
      error: null,
      createdAt: Date.now(),
      completedAt: null,
    },
  });
  try {
    const worker =
      chrome.serviceWorkers()[0] ??
      (await chrome.waitForEvent("serviceworker"));
    const id = worker.url().split("/")[2];
    await chrome.addCookies([{ name: "existing", value: "yes", url }]);
    const ownerTab = chrome.pages()[0];
    await ownerTab.goto(url);
    const setup = await chrome.newPage();
    await setup.goto(`chrome-extension://${id}/options.html`);
    await setup
      .locator("#code")
      .fill(Buffer.from(JSON.stringify(pairing)).toString("base64"));
    await setup.getByRole("button", { name: "Connect", exact: true }).click();
    for (let i = 0; i < 100 && !host.extensionConnected(); i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      host.extensionConnected(),
      true,
      "One-time pairing must connect without any debugging approval",
    );
    await setup.close();
    await ownerTab.bringToFront();
    const baseline = chrome.pages().length;
    const active = await worker.evaluate(
      "chrome.tabs.query({ active: true }).then(tabs => tabs[0]?.id)",
    );
    const result = await host.execute(assignment("navigate", { url }));
    assert.equal(result.stateCipher, undefined);
    assert.match(
      String((await host.execute(assignment("read"))).result.text),
      /Signed in CRM/,
    );
    const sheet = await host.execute(
      assignment("sheet_read", { max_rows: 2, max_columns: 2 }),
    );
    assert.deepEqual(sheet.result.rows, [
      { row: 1, cells: ["Company", "Status"] },
      { row: 2, cells: ["Fixture customer", "Follow up"] },
    ]);
    assert.equal(chrome.pages().length, baseline + 1);
    assert.equal(
      await worker.evaluate(
        "chrome.tabs.query({ active: true }).then(tabs => tabs[0]?.id)",
      ),
      active,
      "Automation must not steal foreground focus",
    );
    await host.synchronize([]);
    assert.equal(chrome.pages().length, baseline);
    await host.execute(assignment("navigate", { url }));
    assert.match(
      String((await host.execute(assignment("read"))).result.text),
      /Signed in CRM/,
    );
    await host.close();
    assert.equal(chrome.pages().length, baseline);
    await ownerTab.reload();
    assert.match(await ownerTab.locator("body").innerText(), /Signed in CRM/);
    // Restart the worker-side relay. The extension keeps its pairing and reconnects
    // through its normal alarm handler; no setup page or approval is involved.
    await host.initialize();
    await worker.evaluate(
      "chrome.alarms.create('reconnect', { when: Date.now() + 100 })",
    );
    for (let i = 0; i < 200 && !host.extensionConnected(); i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      host.extensionConnected(),
      true,
      "Pairing survives a worker relay restart",
    );
    await host.execute(assignment("navigate", { url }));
    assert.match(
      String((await host.execute(assignment("read"))).result.text),
      /Signed in CRM/,
    );
    assert.equal(
      await worker.evaluate(
        "chrome.tabs.query({ active: true }).then(tabs => tabs[0]?.id)",
      ),
      active,
    );
  } finally {
    await host.close();
    await chrome.close();
    if (previous === undefined)
      delete process.env.HARNESS_BROWSER_EXTENSION_CONFIG;
    else process.env.HARNESS_BROWSER_EXTENSION_CONFIG = previous;
    await new Promise<void>((done) => fixture.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
