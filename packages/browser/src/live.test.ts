import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { BrowserHost } from "./index";
import { browserStreamWorker } from "./live";

test("the worker stream reconnects when control stops answering pings", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-live-"));
  // A connection that went dead without closing, as after a laptop sleeps:
  // the server keeps the socket but never answers.
  const server = new WebSocketServer({ port: 0, autoPong: false });
  let connections = 0;
  server.on("connection", () => {
    connections++;
  });
  await new Promise<void>((done) => server.once("listening", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const stop = new AbortController();
  const running = browserStreamWorker(
    {
      id: "worker",
      token: "token",
      serverUrl: `http://127.0.0.1:${address.port}`,
    },
    new BrowserHost(root, { backend: "managed", headless: true }),
    stop.signal,
    100,
  );
  try {
    for (let i = 0; i < 50 && connections < 2; i++)
      await new Promise((done) => setTimeout(done, 100));
    assert.ok(connections >= 2, `connected ${connections} times`);
  } finally {
    stop.abort();
    await running;
    for (const client of server.clients) client.terminate();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
