import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BrowserAssignment } from "@harness/core/browser";
import { BrowserHost } from "./index";
import { parseSheetHtml, sheetReadTarget } from "./sheets";

test("HTML-view sheet reads exclude column letters, decode cells and enforce the requested rows", () => {
  const options = sheetReadTarget(
    "https://docs.google.com/spreadsheets/d/fixture/edit#gid=42",
    { max_rows: 2, max_columns: 3 },
  );
  const result = parseSheetHtml(
    '<table class="waffle"><tr><th></th><td>A</td><td>B</td><td>C</td></tr><tr><th>1</th><td>Name</td><td>Status</td><td>Notes</td></tr><tr><th>2</th><td>A &amp; B</td><td></td><td><span>Follow up</span><script>private()</script></td></tr><tr><th>3</th><td>Outside range</td></tr></table>',
    options,
  );
  assert.deepEqual(result.rows, [
    { row: 1, cells: ["Name", "Status", "Notes"] },
    { row: 2, cells: ["A & B", "", "Follow up"] },
  ]);
  assert.throws(
    () => parseSheetHtml("<h1>Sign in</h1>", options),
    /readable HTML table/,
  );
});

test("sheet reads stay in the current signed-in document and bound row/column access", () => {
  const target = sheetReadTarget(
    "https://docs.google.com/spreadsheets/d/fixture/edit#gid=42",
    { start_row: 2, max_rows: 3, max_columns: 4 },
  );
  assert.equal(
    new URL(target.url).pathname,
    "/spreadsheets/d/fixture/htmlview/sheet",
  );
  assert.equal(new URL(target.url).searchParams.get("range"), "A2:D4");
  assert.equal(target.gid, "42");
  const account = sheetReadTarget(
    "https://docs.google.com/spreadsheets/u/1/d/fixture/edit?authuser=1#gid=9",
    {},
  );
  assert.equal(
    new URL(account.url).pathname,
    "/spreadsheets/u/1/d/fixture/htmlview/sheet",
  );
  assert.equal(new URL(account.url).searchParams.get("authuser"), "1");
  for (const source of [
    "https://example.com/spreadsheets/d/fixture/edit",
    "file:///spreadsheets/d/fixture/edit",
    "https://docs.google.com/document/d/fixture/edit",
  ])
    assert.throws(() => sheetReadTarget(source, {}));
  for (const args of [
    { gid: "../escape" },
    { max_rows: 10000 },
    { start_row: 0 },
    { max_columns: 27 },
  ])
    assert.throws(() =>
      sheetReadTarget(
        "https://docs.google.com/spreadsheets/d/fixture/edit",
        args,
      ),
    );
});

test("real browser reads authenticated CRM cells behind a canvas editor without changing the page or exporting credentials", {
  skip: process.env.HARNESS_TEST_BROWSER !== "1",
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-crm-read-"));
  let deny = false;
  let reads = 0;
  let calendarLoads = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.setHeader(
      "Content-Security-Policy",
      "require-trusted-types-for 'script'; trusted-types 'none'",
    );
    const url = new URL(request.url ?? "/", "http://fixture");
    if (url.pathname === "/calendar-events") {
      calendarLoads++;
      assert.ok((request.url?.length ?? 0) > 8000);
      setTimeout(() => response.end("Calendar fixture loaded"), 700);
    } else if (url.pathname.endsWith("/htmlview/sheet")) {
      reads++;
      assert.equal(request.method, "GET");
      assert.match(request.headers.cookie ?? "", /fixture-login=existing/);
      assert.equal(url.searchParams.get("gid"), "42");
      if (deny) {
        response.writeHead(403);
        response.end("Access denied");
        return;
      }
      response.end(
        '<table class="waffle"><thead><tr><th></th><th>A</th><th>B</th><th>C</th></tr></thead><tbody><tr><th>1</th><td>Company</td><td>Status</td><td>Follow-up</td></tr><tr><th>2</th><td>Fixture customer</td><td>Ready</td><td></td></tr></tbody></table>',
      );
    } else {
      response.setHeader(
        "Set-Cookie",
        "fixture-login=existing; HttpOnly; SameSite=Lax",
      );
      response.end(
        '<body aria-busy="true"><h1>Fixture CRM editor</h1><canvas aria-label="Sheet grid"></canvas><button aria-label="Open calendar event">+</button><input type="password" value="must-not-expose-password"><script>fetch("/calendar-events?query="+"a".repeat(8000)).then(r=>r.text()).then(text=>{const p=document.createElement("p");p.textContent=text;document.body.append(p);document.body.setAttribute("aria-busy","false")})</script>',
      );
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/spreadsheets/d/fixture/edit#gid=42`;
  const host = new BrowserHost(root, {
    backend: "managed",
    allowTestLoopback: true,
    headless: true,
  });
  const assignment = (action: string, args = {}): BrowserAssignment => ({
    identity: {
      id: "crm",
      workspaceId: "business",
      name: "CRM fixture",
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
      browserId: "crm",
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
    await host.execute(assignment("navigate", { url }));
    const before = await host.execute(assignment("read"));
    assert.match(String(before.result.text), /Calendar fixture loaded/);
    assert.equal(before.result.loading, false);
    assert.equal(calendarLoads, 1);
    assert.doesNotMatch(String(before.result.text), /Fixture customer/);
    assert.match(String(before.result.accessibility), /Open calendar event/);
    assert.doesNotMatch(
      JSON.stringify(before.result),
      /must-not-expose-password/,
    );
    const result = await host.execute(
      assignment("sheet_read", { max_rows: 2, max_columns: 3 }),
    );
    assert.deepEqual(result.result.rows, [
      { row: 1, cells: ["Company", "Status", "Follow-up"] },
      { row: 2, cells: ["Fixture customer", "Ready", ""] },
    ]);
    assert.equal(reads, 1);
    const after = await host.execute(assignment("read"));
    assert.equal(after.result.url, before.result.url);
    assert.equal(after.result.title, before.result.title);
    deny = true;
    await assert.rejects(host.execute(assignment("sheet_read")), /403/);
  } finally {
    await host.close();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
