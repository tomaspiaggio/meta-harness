import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BrowserAssignment } from "@harness/core/browser";
import { boxCenter } from "./grounding";
import { BrowserHost } from "./index";

test("grounding boxes are normalized 0..1000 and resolve to viewport centers", () => {
  const size = { width: 1280, height: 800 };
  assert.deepEqual(boxCenter('{"bbox_2d":[0,0,100,100]}', size), {
    x: 64,
    y: 40,
  });
  assert.deepEqual(
    boxCenter('```json\n{"bbox_2d":[500,500,500,500]}\n```', size),
    { x: 640, y: 400 },
  );
  assert.throws(() => boxCenter('{"bbox_2d":[]}', size), /not visible/);
  assert.throws(() => boxCenter('{"bbox_2d":[0,0,2000,10]}', size), /invalid/);
  assert.throws(() => boxCenter("sorry", size), /no usable box/);
});

test("real Chromium: ref, coordinate, keyboard and scroll actions use real input", {
  skip: process.env.HARNESS_TEST_BROWSER !== "1",
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-actions-"));
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(`<html><body style="margin:0">
      <label>Search <input id="q" aria-label="Search box"></label>
      <button id="go" style="position:absolute;left:600px;top:300px;width:120px;height:40px"
        onclick="document.title='clicked:'+document.getElementById('q').value">Go</button>
      <input id="pw" type="password" aria-label="Password" style="position:absolute;left:20px;top:500px">
      <div style="height:4000px"></div></body></html>`);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/`;
  const host = new BrowserHost(root, {
    backend: "managed",
    headless: true,
    allowTestLoopback: true,
  });
  let sequence = 0;
  const run = async (action: string, args: Record<string, unknown>) =>
    (
      await host.execute({
        stateKey: randomBytes(32).toString("base64"),
        identity: {
          id: "actions",
          workspaceId: "w",
          name: "Actions",
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
        },
        command: {
          id: `a-${++sequence}`,
          browserId: "actions",
          turnId: "turn",
          turnGeneration: 1,
          browserGeneration: 1,
          action,
          arguments: JSON.stringify(args),
          status: "running",
          result: null,
          error: null,
          createdAt: Date.now(),
          completedAt: null,
        },
      } as BrowserAssignment)
    ).result;
  try {
    await run("navigate", { url });
    const snapshot = String((await run("snapshot", {})).snapshot);
    const ref = snapshot.match(/textbox "Search box" \[ref=(e\d+)\]/)?.[1];
    assert.ok(ref, `Snapshot exposes refs:\n${snapshot}`);
    const typed = await run("type", { ref, text: "harness" });
    assert.equal(typed.targetLabel, "Search box");
    assert.equal(typeof typed.image, "string", "Actions return a screenshot");
    // The Go button's center, as an agent would read it off the screenshot.
    const clicked = await run("click", { x: 660, y: 320 });
    assert.equal(clicked.title, "clicked:harness");
    await run("click", { x: 100, y: 510 });
    await assert.rejects(run("type", { text: "secret" }), /manual login/);
    await run("press", { key: "Escape" });
    await run("scroll", { direction: "down", amount: 2 });
    await assert.rejects(
      run("click", { description: "the Go button" }),
      process.env.HARNESS_GROUNDING_API_KEY ? /./ : /not configured/,
    );
  } finally {
    await host.close();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
