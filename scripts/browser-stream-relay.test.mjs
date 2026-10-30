import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { createGateway } from "./gateway.mjs";

const require = createRequire(
  new URL("../packages/browser/package.json", import.meta.url),
);
const WebSocket = require("ws");
const event = (socket, type) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", listener);
      reject(Error(`No ${type}`));
    }, 3000);
    const listener = (raw) => {
      const value = JSON.parse(raw);
      if (value.type === type) {
        clearTimeout(timer);
        socket.off("message", listener);
        resolve(value);
      }
    };
    socket.on("message", listener);
  });

test("live relay authenticates upgrades, preserves origin/host, isolates workers, and fences EVERY input", {
  timeout: 15000,
}, async () => {
  let generation = 1;
  let mode = "agent";
  let owner = true;
  let enrolled = true;
  const upstream = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    const query = new URL(request.url, "http://fixture").searchParams;
    if (query.get("role") === "worker") {
      if (
        !enrolled ||
        request.headers.authorization !== "Bearer fixture-worker"
      ) {
        response.writeHead(401);
        response.end('{"error":"Worker revoked"}');
        return;
      }
      response.end(
        JSON.stringify({
          role: "worker",
          workerId: request.headers["x-worker-id"],
        }),
      );
      return;
    }
    if (
      !owner ||
      request.headers.cookie !== "fixture-owner=yes" ||
      request.headers.origin !== `http://${request.headers.host}`
    ) {
      response.writeHead(401);
      response.end('{"error":"Unauthorized owner"}');
      return;
    }
    response.end(
      JSON.stringify({
        role: "viewer",
        workerId: "worker-one",
        browserId: "browser",
        mode,
        generation,
        assignment: {},
        publicKey: "fixture-public-key",
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const gateway = createGateway(upstream.address().port);
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${gateway.address().port}`;
  const url = `ws://${host}/api/browser-stream`;
  const sockets = [];
  const connect = (suffix, headers = {}) => {
    const ws = new WebSocket(url + suffix, {
      origin: headers.origin ?? `http://${host}`,
      headers,
    });
    ws.on("error", () => {});
    sockets.push(ws);
    return ws;
  };
  try {
    const denied = connect("?browser=browser");
    const rejected = await new Promise((resolve) =>
      denied.on("unexpected-response", (_request, response) => {
        resolve(response.statusCode);
        response.resume();
        denied.terminate();
      }),
    );
    assert.equal(rejected, 401);
    const cross = connect("?browser=browser", {
      cookie: "fixture-owner=yes",
      origin: "http://attacker.invalid",
    });
    assert.equal(
      await new Promise((resolve) =>
        cross.on("unexpected-response", (_request, response) => {
          resolve(response.statusCode);
          response.resume();
          cross.terminate();
        }),
      ),
      401,
    );
    const worker = connect("?role=worker", {
      authorization: "Bearer fixture-worker",
      "x-worker-id": "worker-one",
    });
    await event(worker, "ready");
    const nextOpen = event(worker, "open");
    const viewer = connect("?browser=browser", { cookie: "fixture-owner=yes" });
    const open = await nextOpen;
    const other = connect("?role=worker", {
      authorization: "Bearer fixture-worker",
      "x-worker-id": "worker-two",
    });
    await event(other, "ready");
    let wrongWorkerFrame = false;
    viewer.on("message", (raw) => {
      if (JSON.parse(raw).frame?.ciphertext === "wrong-worker")
        wrongWorkerFrame = true;
    });
    other.send(
      JSON.stringify({
        type: "frame",
        viewId: open.viewId,
        frame: { ciphertext: "wrong-worker" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(wrongWorkerFrame, false);
    const frame = event(viewer, "frame");
    worker.send(
      JSON.stringify({
        type: "frame",
        viewId: open.viewId,
        frame: { ciphertext: "opaque" },
      }),
    );
    assert.equal((await frame).frame.ciphertext, "opaque");
    // The owner and the agent share the browser: an open view sends input
    // without a takeover lease.
    const shared = event(worker, "input");
    viewer.send(
      JSON.stringify({
        type: "input",
        id: "shared",
        input: { ciphertext: "opaque" },
      }),
    );
    assert.equal((await shared).id, "shared");
    viewer.close();
    await once(viewer, "close");
    mode = "human";
    const inputOpen = event(worker, "open");
    const controller = connect("?browser=browser", {
      cookie: "fixture-owner=yes",
    });
    await inputOpen;
    const input = event(worker, "input");
    controller.send(
      JSON.stringify({
        type: "input",
        id: "one",
        input: { iv: "opaque", ciphertext: "encrypted-only" },
      }),
    );
    assert.equal((await input).id, "one");
    generation++;
    const fence = event(controller, "error");
    controller.send(
      JSON.stringify({
        type: "input",
        id: "stale",
        input: { ciphertext: "opaque" },
      }),
    );
    assert.match((await fence).error, /control changed/i);
    await once(controller, "close");
    const revokedOpen = event(worker, "open");
    const revoked = connect("?browser=browser", {
      cookie: "fixture-owner=yes",
    });
    await revokedOpen;
    enrolled = false;
    const revokedError = event(revoked, "error");
    revoked.send(
      JSON.stringify({
        type: "input",
        id: "revoked",
        input: { ciphertext: "opaque" },
      }),
    );
    assert.match((await revokedError).error, /revoked/i);
    owner = false;
  } finally {
    for (const ws of sockets) ws.terminate();
    upstream.closeAllConnections();
    gateway.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => gateway.close(resolve)),
      new Promise((resolve) => upstream.close(resolve)),
    ]);
  }
});

test("a client that resets while its upgrade is being authorized doesn't crash the gateway", {
  timeout: 15000,
}, async () => {
  const upstream = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(401);
      response.end('{"error":"Unauthorized"}');
    }, 500);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const gateway = createGateway(upstream.address().port);
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const port = gateway.address().port;
  const { connect } = await import("node:net");
  const client = connect(port, "127.0.0.1");
  await once(client, "connect");
  client.write(
    "GET /api/browser-stream HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  client.resetAndDestroy();
  // Authorization answers after the reset; the gateway must still serve.
  await new Promise((resolve) => setTimeout(resolve, 800));
  const response = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(response.status, 404);
  gateway.close();
  upstream.close();
});
