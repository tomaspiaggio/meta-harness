import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { WorkerClient } from "../apps/worker/src/client.ts";

test("a running turn's requests ride out a control stall; claims fail fast", async () => {
  let healthyAt = Date.now() + 1500;
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(new URL(request.url, "http://x").searchParams.get("action"));
    if (Date.now() < healthyAt) {
      // What the proxy returns while control is down.
      response.writeHead(502, { "content-type": "text/plain" });
      response.end("Control plane unavailable");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = new WorkerClient(
      {
        id: "w",
        token: "t",
        serverUrl: `http://127.0.0.1:${server.address().port}/`,
      },
      5000,
    );
    assert.deepEqual(await client.post("event", { turnId: "x" }), { ok: true });
    assert.ok(seen.filter((action) => action === "event").length > 3);
    healthyAt = Date.now() + 60000;
    const started = Date.now();
    await assert.rejects(client.post("claim", {}));
    assert.ok(Date.now() - started < 3000, "claims keep their short retry");
    await assert.rejects(client.post("heartbeat", {}));
    assert.ok(Date.now() - started >= 5000, "turn requests retry for retryMs");
  } finally {
    server.close();
  }
});
