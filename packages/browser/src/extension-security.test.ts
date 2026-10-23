import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { ExtensionRelay } from "./extension-relay";

test("extension relay rejects missing credentials, website origins and invalid pairing without opening browser tabs", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-relay-auth-"));
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((done) => probe.close(() => done()));
  const config = {
    port: address.port,
    token: randomBytes(32).toString("base64url"),
  };
  const path = join(root, "pairing.json");
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const relay = new ExtensionRelay(config, path);
  await relay.start();
  const denied = async (path: string, headers: Record<string, string>) => {
    const ws = new WebSocket(`ws://127.0.0.1:${config.port}${path}`, {
      headers,
    });
    await assert.rejects(
      new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      }),
    );
    ws.terminate();
  };
  try {
    await denied("/cdp", {});
    await denied("/cdp", {
      Authorization: `Bearer ${config.token}`,
      Origin: "https://example.com",
    });
    await denied("/extension", { Origin: "https://example.com" });
    const ws = new WebSocket(`ws://127.0.0.1:${config.port}/extension`, {
      origin: `chrome-extension://${"a".repeat(32)}`,
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const closed = new Promise<number>((resolve) => ws.once("close", resolve));
    ws.send(JSON.stringify({ type: "hello", token: "invalid" }));
    assert.equal(await closed, 1008);
    assert.equal(relay.connected(), false);
    assert.throws(() => relay.endpoint(), /extension once/);
  } finally {
    await relay.close();
    await rm(root, { recursive: true, force: true });
  }
});
