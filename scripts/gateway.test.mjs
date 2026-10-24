import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createGateway, publicPath } from "./gateway.mjs";

test("gateway admits only the public UI/API surface, regardless of encoded internal paths", () => {
  for (const path of [
    "/",
    "/tasks",
    "/knowledge",
    "/api/decisions",
    "/login",
    "/api/worker/native-append",
    "/api/worker?action=claim",
    "/api/tasks",
    "/api/preferences",
    "/api/auth/sign-in/social",
    "/api/auth/callback/google",
    "/api/auth/get-session",
    "/api/auth/profile",
    "/api/auth/sign-out",
    "/_next/static/app.js",
  ])
    assert.equal(publicPath(path), true, path);
  for (const path of [
    "/.well-known/workflow/v1/flow",
    "/%2ewell-known/workflow/v1/flow",
    "/api/../.well-known/workflow/v1/flow",
    "/api/%2e%2e/.well-known/workflow/v1/flow",
    "/api/worker/claim/extra",
    "/api/auth/sign-up/email",
    "/api/auth/callback/github",
    "/_next/%2e%2e/.well-known/workflow/v1/flow",
    "/_next/%252e%252e/.well-known/workflow/v1/flow",
    "http://attacker.invalid/api/state",
    "//attacker.invalid/api/state",
  ])
    assert.equal(publicPath(path), false, path);
});
test("gateway streams public requests and strips client-supplied proxy identity headers", async () => {
  const upstream = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        path: request.url,
        forwardedHost: request.headers["x-forwarded-host"] ?? null,
        proto: request.headers["x-forwarded-proto"],
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const gateway = createGateway(upstream.address().port);
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${gateway.address().port}`;
  try {
    const allowed = await fetch(`${base}/api/state?workspace=tech`, {
      headers: {
        "x-forwarded-host": "attacker.invalid",
        "x-forwarded-proto": "https",
      },
    });
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), {
      path: "/api/state?workspace=tech",
      forwardedHost: null,
      proto: "http",
    });
    assert.equal(
      (
        await fetch(`${base}/.well-known/workflow/v1/flow`, {
          headers: { host: "localhost" },
        })
      ).status,
      404,
    );
  } finally {
    gateway.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => gateway.close(resolve)),
      new Promise((resolve) => upstream.close(resolve)),
    ]);
  }
});

test("development gateway forwards same-origin HMR without exposing production or internal upgrades", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(
    new URL("../packages/browser/package.json", import.meta.url),
  );
  const { WebSocket, WebSocketServer } = require("ws");
  const server = createServer();
  const wss = new WebSocketServer({ server });
  let seen;
  wss.on("connection", (ws, request) => {
    seen = request;
    ws.on("message", (bytes) => ws.send(bytes));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const gateway = createGateway(server.address().port, { development: true });
  const production = createGateway(server.address().port);
  await Promise.all(
    [gateway, production].map(
      (s) => new Promise((resolve) => s.listen(0, "127.0.0.1", resolve)),
    ),
  );
  const connect = (proxy, path, origin) =>
    new Promise((resolve, reject) => {
      const host = `127.0.0.1:${proxy.address().port}`;
      const ws = new WebSocket(`ws://${host}${path}`, {
        origin: origin ?? `http://${host}`,
        headers: { "x-forwarded-host": "attacker.invalid" },
        handshakeTimeout: 1000,
      });
      ws.on("error", reject);
      ws.once("unexpected-response", (_req, response) => {
        response.resume();
        ws.terminate();
        reject(new Error(`HTTP ${response.statusCode}`));
      });
      ws.once("open", () => resolve(ws));
    });
  try {
    await assert.rejects(connect(production, "/_next/hmr"), /HTTP 404/);
    await assert.rejects(
      connect(gateway, "/_next/hmr", "http://attacker.invalid"),
      /HTTP 403/,
    );
    await assert.rejects(
      connect(gateway, "/.well-known/workflow/v1/flow"),
      /HTTP 404/,
    );
    const ws = await connect(gateway, "/_next/hmr?id=fixture");
    const received = new Promise((resolve) =>
      ws.once("message", (bytes) => resolve(bytes.toString())),
    );
    ws.send("development fixture");
    assert.equal(await received, "development fixture");
    assert.equal(seen.url, "/_next/hmr?id=fixture");
    assert.equal(seen.headers["x-forwarded-host"], undefined);
    assert.equal(seen.headers.host, `127.0.0.1:${gateway.address().port}`);
    const closed = new Promise((resolve) => ws.once("close", resolve));
    gateway.close();
    await closed;
  } finally {
    for (const ws of wss.clients) ws.terminate();
    await Promise.all(
      [gateway, production].map(
        (s) => new Promise((resolve) => s.close(resolve)),
      ),
    );
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});
