import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BrowserAssignment } from "@harness/core/browser";
import { BrowserActionNotStarted, BrowserHost } from "./index";
import { personalChromeEndpoint } from "./personal-chrome";

test("personal Chrome discovery reads a local endpoint and explains missing connection without launching another browser", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chrome-discovery-"));
  try {
    await assert.rejects(
      personalChromeEndpoint(directory),
      /chrome:\/\/inspect.*current logins/,
    );
    for (const value of [
      "9222\n/devtools/browser/abc\nextra",
      "0\n/devtools/browser/abc",
      "9222\n//other-host/path",
      "9222\n/devtools/browser/abc?secret=x",
    ]) {
      await writeFile(join(directory, "DevToolsActivePort"), value);
      await assert.rejects(
        personalChromeEndpoint(directory),
        /Connect your existing Chrome/,
      );
    }
    await writeFile(
      join(directory, "DevToolsActivePort"),
      "53214\n/devtools/browser/abc-123\n",
    );
    assert.equal(
      await personalChromeEndpoint(directory),
      "ws://127.0.0.1:53214/devtools/browser/abc-123",
    );
    const host = new BrowserHost(join(directory, "harness"), {
      backend: "personal-chrome",
      chromeDirectory: join(directory, "missing"),
    });
    try {
      await assert.rejects(
        host.execute(assignment("missing")),
        (error: unknown) =>
          error instanceof BrowserActionNotStarted &&
          /Connect your existing Chrome/.test(error.message),
      );
      assert.equal(host.active().length, 0);
    } finally {
      await host.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function assignment(
  id: string,
  action = "status",
  args = {},
): BrowserAssignment {
  return {
    identity: {
      id,
      workspaceId: "fixture",
      name: "Personal Chrome fixture",
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
      stateCipher: "must-not-import-managed-profile-state",
      updatedAt: Date.now(),
    },
    stateKey: randomBytes(32).toString("base64"),
    command: {
      id: crypto.randomUUID(),
      browserId: id,
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
  };
}

test("real Chrome attachment reuses existing authentication, preserves unrelated tabs, exports no credentials and disconnects without closing Chrome", {
  skip: process.env.HARNESS_TEST_BROWSER !== "1",
  timeout: 60000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "personal-chrome-fixture-"));
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      "<html><body><h1 id='auth'></h1><script>document.querySelector('#auth').textContent = document.cookie.includes('existing-login=yes') && localStorage.getItem('account') === 'existing-owner' ? 'Already signed in' : 'Login required';</script></body></html>",
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const { chromium } = await import("patchright");
  const connect = chromium.connectOverCDP.bind(chromium);
  const connections = t.mock.method(chromium, "connectOverCDP", connect);
  const chromeDirectory = join(root, "chrome");
  const chrome = await chromium.launchPersistentContext(chromeDirectory, {
    channel: "chromium",
    headless: true,
    args: ["--remote-debugging-port=0"],
  });
  const ownerTab = chrome.pages()[0];
  const host = new BrowserHost(join(root, "harness"), {
    backend: "personal-chrome",
    chromeDirectory,
    allowTestLoopback: true,
  });
  try {
    await ownerTab.goto(url);
    await chrome.addCookies([{ name: "existing-login", value: "yes", url }]);
    await ownerTab.evaluate(() => {
      localStorage.setItem("account", "existing-owner");
    });
    await ownerTab.reload();
    const baselinePages = chrome.pages().length;
    const output = await host.execute(assignment("reuse", "navigate", { url }));
    assert.equal(typeof output.result.image, "string");
    assert.equal(
      output.stateCipher,
      undefined,
      "Personal cookies must never be exported",
    );
    const read = await host.execute(assignment("reuse", "read"));
    assert.match(String(read.result.text), /Already signed in/);
    assert.equal(chrome.pages().length, baselinePages + 1);
    assert.equal(ownerTab.url(), `${url}/`);
    assert.equal(await ownerTab.locator("h1").innerText(), "Already signed in");

    await host.synchronize([]);
    assert.equal(
      chrome.pages().length,
      baselinePages,
      "Release closes only the owned background tab",
    );
    await ownerTab.reload();
    assert.equal(
      await ownerTab.locator("h1").innerText(),
      "Already signed in",
      "Original Chrome remains running and signed in",
    );

    // Idle cleanup closes our tab while preserving the approved transport.
    await host.execute(assignment("again", "navigate", { url }));
    assert.equal(
      connections.mock.callCount(),
      1,
      "Idle cleanup must not require another Chrome connection approval",
    );
    await host.close();
    assert.equal(chrome.pages().length, baselinePages);
    await ownerTab.reload();
    assert.equal(await ownerTab.locator("h1").innerText(), "Already signed in");

    const restricted = new BrowserHost(join(root, "harness"), {
      backend: "personal-chrome",
      chromeDirectory,
    });
    try {
      await restricted.execute(assignment("restricted"));
      await assert.rejects(
        restricted.execute(assignment("restricted", "navigate", { url })),
        /Private-network/,
      );
      await ownerTab.reload();
      assert.equal(
        await ownerTab.locator("h1").innerText(),
        "Already signed in",
        "Harness network policy does not intercept personal tabs",
      );
      await restricted.forget("restricted");
      await ownerTab.reload();
      assert.equal(chrome.pages().length, baselinePages);
    } finally {
      await restricted.close();
    }
  } finally {
    await host.close();
    await chrome.close();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
