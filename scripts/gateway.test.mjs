import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createGateway, publicPath } from "./gateway.mjs";

test("gateway admits only the public UI/API surface, regardless of encoded internal paths", () => {
  for (const path of [
    "/",
    "/tasks",
    "/login",
    "/api/worker/native-append",
    "/api/tasks",
    "/_next/static/app.js",
  ])
    assert.equal(publicPath(path), true, path);
  for (const path of [
    "/.well-known/workflow/v1/flow",
    "/%2ewell-known/workflow/v1/flow",
    "/api/../.well-known/workflow/v1/flow",
    "/api/%2e%2e/.well-known/workflow/v1/flow",
    "/api/worker/claim/extra",
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
