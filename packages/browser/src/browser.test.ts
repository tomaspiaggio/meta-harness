import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BrowserAssignment, BrowserIdentity } from "@harness/core/browser";
import { decryptBytes, encryptBytes, openState } from "./crypto";
import { BrowserHost, validateBrowserUrl } from "./index";

test("browser URL validation rejects private control-plane and credential-bearing targets", async () => {
  for (const value of [
    "file:///etc/passwd",
    "http://127.0.0.1:3000",
    "http://169.254.169.254/",
    "http://[::1]/",
    "http://user:secret@example.com/",
    "http://10.0.0.1/",
  ]) {
    await assert.rejects(validateBrowserUrl(value));
    await assert.rejects(validateBrowserUrl(value, false, "resource"));
  }
  const longUrl = `https://8.8.8.8/?query=${"a".repeat(8000)}`;
  await assert.rejects(validateBrowserUrl(longUrl));
  assert.equal(await validateBrowserUrl(longUrl, false, "resource"), longUrl);
  await assert.rejects(
    validateBrowserUrl(
      `https://8.8.8.8/?q=${"a".repeat(65536)}`,
      false,
      "resource",
    ),
  );
});
test("real Chromium: screenshots, encrypted takeover, no model capture during login, portable supported state", {
  skip: process.env.HARNESS_TEST_BROWSER !== "1",
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-browser-"));
  const server = createServer((request, response) => {
    if (request.url === "/download") {
      response.setHeader(
        "Content-Disposition",
        'attachment; filename="fixture-oauth.json"',
      );
      response.end('{"client_secret":"fixture-secret-only"}');
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      '<html><body><h1>Fixture tickets $173</h1><input style="position:absolute;left:20px;top:80px;width:200px;height:40px" id="password" type="password" autocomplete="current-password"><button onclick="localStorage.setItem(\'loggedIn\',\'yes\');document.cookie=\'fixture=logged-in; SameSite=Lax\'">Login</button></body></html>',
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const stateKey = randomBytes(32).toString("base64");
  const identity: BrowserIdentity = {
    id: "fixture",
    workspaceId: "business",
    name: "Fixture",
    workerId: "worker",
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
  };
  const host = new BrowserHost(root, {
    backend: "managed",
    headless: true,
    allowTestLoopback: true,
  });
  let sequence = 0;
  const assignment = (
    action: string,
    args: Record<string, unknown>,
  ): BrowserAssignment => ({
    identity: { ...identity },
    stateKey,
    command: {
      id: `command-${++sequence}`,
      browserId: identity.id,
      turnId: "turn",
      turnGeneration: 1,
      browserGeneration: identity.generation,
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
    const starting = host.livePage(assignment("manual", {}));
    assert.equal(
      host.active()[0]?.id,
      identity.id,
      "Pending launch must retain its broker assignment",
    );
    const concurrent = host.livePage(assignment("manual", {}));
    assert.equal(
      (await starting).current(),
      (await concurrent).current(),
      "Concurrent views must share one persistent-profile launch",
    );
    const navigation = await host.execute(assignment("navigate", { url }));
    assert.equal(typeof navigation.result.image, "string");
    const pointed = await host.execute(assignment("click", { selector: "h1" }));
    assert.ok(pointed.result.point, "Clicks record where the agent clicked");
    const page = (await host.livePage(assignment("manual", {}))).current();
    assert.deepEqual(
      await page.evaluate(() => [
        /HeadlessChrome/.test(navigator.userAgent),
        Boolean(document.getElementById("__harness-cursor")),
      ]),
      [false, true],
      "Headless pages report an ordinary user agent and draw the agent cursor",
    );
    assert.match(
      String((await host.execute(assignment("read", {}))).result.text),
      /173/,
    );
    await assert.rejects(
      host.execute(
        assignment("fill", { selector: "#password", text: "secret" }),
      ),
      /manual|password/i,
    );
    const user = createECDH("prime256v1");
    user.generateKeys();
    identity.mode = "human";
    identity.generation++;
    identity.userPublicKey = user.getPublicKey().toString("base64");
    identity.expiresAt = Date.now() + 60000;
    await assert.rejects(
      host.execute(assignment("read", {})),
      /manual|human|paused/i,
    );
    const first = await host.execute(assignment("manual", {}));
    assert.equal(first.stateCipher, undefined);
    assert.equal(first.result.image, undefined);
    const frame = first.result.frame as {
      publicKey: string;
      iv: string;
      ciphertext: string;
    };
    const key = user.computeSecret(Buffer.from(frame.publicKey, "base64"));
    const jpeg = decryptBytes(key, frame);
    assert.equal(jpeg[0], 255);
    assert.equal(jpeg[1], 216);
    await host.execute(
      assignment("manual", {
        input: encryptBytes(
          key,
          Buffer.from(JSON.stringify({ type: "click", x: 30, y: 90 })),
        ),
      }),
    );
    await host.execute(
      assignment("manual", {
        input: encryptBytes(
          key,
          Buffer.from(
            JSON.stringify({ type: "text", text: "private-password" }),
          ),
        ),
      }),
    );
    await host.execute(
      assignment("manual", {
        input: encryptBytes(
          key,
          Buffer.from(JSON.stringify({ type: "key", key: "Tab" })),
        ),
      }),
    );
    await host.execute(
      assignment("manual", {
        input: encryptBytes(
          key,
          Buffer.from(JSON.stringify({ type: "key", key: "Enter" })),
        ),
      }),
    );
    identity.mode = "agent";
    identity.generation++;
    identity.userPublicKey = null;
    const returned = await host.execute(assignment("read", {}));
    assert.equal(
      typeof returned.result.image,
      "string",
      "Reads retain owner thumbnails",
    );
    const live = await host.livePage(assignment("manual", {}));
    assert(live.downloads);
    await live.current().evaluate((url: string) => {
      const link = document.createElement("a");
      link.href = url;
      link.click();
    }, `${url}/download`);
    let items = await live.downloads.list();
    for (let attempt = 0; !items.length && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      items = await live.downloads.list();
    }
    assert.equal(items[0]?.name, "fixture-oauth.json");
    const chunk = await live.downloads.chunk(items[0].id, 0);
    assert.equal(
      Buffer.from(chunk.bytes, "base64").toString(),
      '{"client_secret":"fixture-secret-only"}',
    );
    assert.equal(chunk.done, true);
    await assert.rejects(live.downloads.chunk("../../profile", 0));
    await assert.rejects(live.downloads.chunk(items[0].id, -1));
    assert.ok(returned.stateCipher);
    assert.doesNotMatch(String(returned.result.text), /private-password/);
    const state = openState<{ cookies: unknown[]; origins: unknown[] }>(
      stateKey,
      returned.stateCipher,
    );
    assert.ok(state.cookies.length);
    assert.ok(state.origins.length);
    await host.close();
    identity.stateCipher = returned.stateCipher;
    const restored = new BrowserHost(join(root, "relocated"), {
      backend: "managed",
      headless: true,
      allowTestLoopback: true,
    });
    try {
      const result = await restored.execute(assignment("navigate", { url }));
      assert.ok(result.stateCipher);
      assert.ok(
        openState<{ cookies: unknown[] }>(stateKey, result.stateCipher).cookies
          .length,
      );
    } finally {
      await restored.close();
    }
  } finally {
    await host.close();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
test("real Chromium: sessions share logins but each acts in its own tab", {
  skip: process.env.HARNESS_TEST_BROWSER !== "1",
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-browser-tabs-"));
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    if (request.url === "/login") response.setHeader("Set-Cookie", "who=owner");
    response.end(
      `<html><head><title>${request.url}</title></head><body><h1>${request.url} ${request.headers.cookie ?? "no cookie"}</h1><button id="pop" onclick="window.open('/popup')">Pop</button></body></html>`,
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const identity: BrowserIdentity = {
    id: "tabs",
    workspaceId: "business",
    name: "Tabs",
    workerId: "worker",
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
  };
  const host = new BrowserHost(root, {
    backend: "managed",
    headless: true,
    allowTestLoopback: true,
  });
  let sequence = 0;
  const assignment = (
    tab: string,
    action: string,
    args: Record<string, unknown> = {},
  ): BrowserAssignment => ({
    identity: { ...identity },
    stateKey: randomBytes(32).toString("base64"),
    command: {
      id: `command-${++sequence}`,
      browserId: identity.id,
      turnId: "turn",
      turnGeneration: 1,
      browserGeneration: identity.generation,
      action,
      arguments: JSON.stringify(args),
      status: "running",
      result: null,
      error: null,
      createdAt: Date.now(),
      completedAt: null,
      tab,
    },
  });
  const read = async (tab: string) =>
    String((await host.execute(assignment(tab, "read"))).result.text);
  try {
    await host.execute(
      assignment("reddit", "navigate", { url: `${url}/login` }),
    );
    await host.execute(
      assignment("discord", "navigate", { url: `${url}/discord` }),
    );
    // Discord's navigation didn't move Reddit's page, and the login is shared.
    assert.match(await read("reddit"), /\/login/);
    assert.match(await read("discord"), /\/discord who=owner/);
    const reddit = await host.livePage(assignment("reddit", "manual"));
    const discord = await host.livePage(assignment("discord", "manual"));
    assert.match(reddit.current().url(), /\/login$/);
    assert.match(discord.current().url(), /\/discord$/);
    // A popup takes over the tab that opened it, and only that one.
    const seen: string[] = [];
    reddit.onPage((page) => seen.push(page.url()));
    await host.execute(assignment("reddit", "click", { selector: "#pop" }));
    for (let i = 0; i < 50 && !/popup/.test(reddit.current().url()); i++)
      await new Promise((done) => setTimeout(done, 100));
    assert.match(reddit.current().url(), /\/popup$/);
    assert.match(discord.current().url(), /\/discord$/);
    assert.match(await read("reddit"), /\/popup/);
    await reddit.current().close();
    assert.match(reddit.current().url(), /\/login$/);
    assert.ok(seen.length >= 2);
    // Sessions beyond the limit close the least recently used tab.
    for (let index = 0; index < 8; index++)
      await host.execute(
        assignment(`extra-${index}`, "navigate", {
          url: `${url}/extra-${index}`,
        }),
      );
    const pages = reddit.current().context().pages();
    assert.ok(pages.filter((page) => !page.isClosed()).length <= 6);
    assert.match(await read("extra-7"), /\/extra-7/);
  } finally {
    await host.close();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
