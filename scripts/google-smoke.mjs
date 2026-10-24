import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { HarnessStore } from "../packages/storage/src/application.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const { exportJWK, generateKeyPair, SignJWT } = await import(
  require.resolve("jose")
);
const directory = await mkdtemp(join(tmpdir(), "fixture-google-stack-"));
const port = Number(process.env.HARNESS_GOOGLE_FIXTURE_PORT ?? 3212);
assert.ok(port !== 3000, "Never use the production port for fixtures.");
const base = `http://127.0.0.1:${port}`;
const key = randomBytes(32);
const keys = await generateKeyPair("RS256");
const jwk = await exportJWK(keys.publicKey);
const ACCESS = "fixture-smoke-google-access-secret";
const REFRESH = "fixture-smoke-google-refresh-secret";
let nonce = "";
let logs = "";
let providerCalls = 0;
let tokenCalls = 0;
const provider = createServer(async (request, response) => {
  try {
    const target = new URL(String(request.headers["x-fixture-target"]));
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = new URLSearchParams(Buffer.concat(chunks).toString());
    let value;
    if (target.href === "https://www.googleapis.com/oauth2/v3/certs")
      value = { keys: [jwk] };
    else if (target.href === "https://oauth2.googleapis.com/token") {
      tokenCalls++;
      assert.equal(body.get("client_secret"), "fixture-resource-secret");
      const identity = await new SignJWT({
        nonce,
        email: "fixture@example.test",
        email_verified: true,
      })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer("https://accounts.google.com")
        .setAudience("fixture-resource-client")
        .setSubject("fixture-account")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey);
      value = {
        access_token: ACCESS,
        refresh_token: REFRESH,
        token_type: "Bearer",
        id_token: identity,
        scope:
          "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/documents.readonly https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/calendar.events.readonly",
      };
    } else {
      providerCalls++;
      assert.equal(request.headers.authorization, `Bearer ${ACCESS}`);
      if (
        target.hostname === "sheets.googleapis.com" &&
        target.pathname.includes("/values/")
      )
        value = {
          range: "Tab!A1:B2",
          majorDimension: "ROWS",
          values: [
            ["Fixture CRM", 42],
            [true, "=SUM(B1)"],
          ],
        };
      else if (target.hostname === "sheets.googleapis.com")
        value = {
          spreadsheetId: "fixture-sheet",
          properties: { title: "CRM" },
          sheets: [
            {
              properties: {
                sheetId: 0,
                title: "Tab",
                gridProperties: { rowCount: 100, columnCount: 10 },
              },
            },
          ],
        };
      else if (target.pathname.includes("/calendar/v3/"))
        value = {
          timeZone: "UTC",
          items: [
            {
              id: "fixture-event",
              summary: "Daily CRM review",
              start: { dateTime: "2026-10-23T09:00:00Z" },
              end: { dateTime: "2026-10-23T09:30:00Z" },
            },
          ],
        };
      else if (target.hostname === "docs.googleapis.com")
        value = {
          documentId: "fixture-doc",
          title: "Fixture",
          tabs: [
            {
              tabProperties: { tabId: "tab", title: "Main" },
              documentTab: {
                body: {
                  content: [
                    {
                      paragraph: {
                        elements: [
                          { textRun: { content: "Fixture Docs content" } },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          ],
        };
      else if (target.pathname.endsWith("/threads/fixture-thread"))
        value = {
          id: "fixture-thread",
          messages: [
            {
              id: "fixture-message",
              threadId: "fixture-thread",
              payload: {
                mimeType: "text/plain",
                body: {
                  data: Buffer.from("Fixture Gmail content").toString(
                    "base64url",
                  ),
                },
              },
            },
          ],
        };
      else if (target.pathname.endsWith("/threads"))
        value = {
          threads: [{ id: "fixture-thread", snippet: "Fixture Gmail" }],
        };
      else if (target.pathname.endsWith("/files/fixture-file"))
        value = { id: "fixture-file", name: "Fixture", mimeType: "text/plain" };
      else if (target.pathname.endsWith("/files"))
        value = { files: [{ id: "fixture-file", name: "Fixture" }] };
      else throw new Error("Unknown provider fixture request.");
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  } catch {
    response.writeHead(500);
    response.end("Fixture rejected request.");
  }
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const env = {
  ...process.env,
  DATABASE_URL: "",
  HARNESS_HOSTED: "0",
  VERCEL: "",
  HARNESS_REQUIRE_AUTH: "0",
  HARNESS_BIND_HOST: "127.0.0.1",
  HARNESS_DATA_DIR: directory,
  HARNESS_CONTROL_URL: undefined,
  HARNESS_WORKER_TOKEN_FILE: "",
  HARNESS_WORKER_DATA_DIR: join(directory, "fixture-worker"),
  HARNESS_BROWSER_CACHE_DIR: join(directory, "fixture-browser-cache"),
  HARNESS_BROWSER_ENABLED: "0",
  HARNESS_SANDBOX_ENABLED: "0",
  PORT: String(port),
  HARNESS_GRANT_KEY: key.toString("base64url"),
  WORKFLOW_TARGET_WORLD: "local",
  WORKFLOW_LOCAL_DATA_DIR: join(directory, "workflow"),
  WORKFLOW_LOCAL_BASE_URL: base,
  NEXT_TELEMETRY_DISABLED: "1",
  HARNESS_MEMORY_RESERVE_MIB: "0",
  HARNESS_MAX_LOAD_PER_CPU: "10000",
  HARNESS_PROVIDERS: "demo",
  HARNESS_GOOGLE_RESOURCE_CLIENT_ID: "fixture-resource-client",
  HARNESS_GOOGLE_RESOURCE_CLIENT_SECRET: "fixture-resource-secret",
  HARNESS_GOOGLE_RESOURCE_REDIRECT_URI: `${base}/api/integrations/google/callback`,
  HARNESS_GOOGLE_RESOURCE_KEY: randomBytes(32).toString("base64url"),
  HARNESS_GOOGLE_RESOURCE_KEY_ID: "fixture",
  HARNESS_GOOGLE_RESOURCE_PREVIOUS_KEYS: "",
  HARNESS_GOOGLE_FIXTURE_ORIGIN: `http://127.0.0.1:${provider.address().port}`,
  NODE_OPTIONS: "",
};
const children = [];
let store;
function launch(cwd, args, extraEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...env, ...extraEnv },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      logs = (logs + chunk).slice(-24_000);
    });
  return child;
}
async function api(path, body, cookie = "", extra = {}) {
  const response = await fetch(`${base}/api/${path}`, {
    ...(body === undefined
      ? {}
      : { method: "POST", body: JSON.stringify(body) }),
    headers: { "content-type": "application/json", cookie, ...extra },
    redirect: "manual",
  });
  return response;
}
async function json(path, body, cookie = "") {
  const response = await api(path, body, cookie);
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value;
}
try {
  launch(join(root, "apps/web"), [
    "--import",
    join(root, "scripts/fixture/google-fetch.mjs"),
    require.resolve("next/dist/bin/next"),
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ]);
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await api("integrations/google/status")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(250);
  }
  assert.ok(ready, "Fixture web did not start.");
  const start = await api("integrations/google/start", {
    label: "Fixture Work",
    groups: ["gmail", "drive", "docs", "sheets", "calendar"],
  });
  if (!start.ok) throw new Error(await start.text());
  const authorization = new URL((await start.json()).authorizationUrl);
  nonce = authorization.searchParams.get("nonce");
  const flow = start.headers.get("set-cookie").split(";")[0];
  const callback = await api(
    `integrations/google/callback?state=${authorization.searchParams.get("state")}&code=fixture-code`,
    undefined,
    flow,
  );
  assert.equal(callback.headers.get("location"), "/settings?google=connected");
  const status = await json("integrations/google/status");
  const account = status.connections[0];
  assert.equal(account.status, "ready");
  assert.equal(account.accountEmail, "fixture@example.test");
  const collections = await json("integrations");
  const definition = collections.definitions.find(
    (value) => value.id === "google-workspace",
  );
  await json("integrations", {
    action: "binding",
    binding: {
      workspaceId: "tech",
      connectionId: account.id,
      revision: "fixture-binding",
      connectionRevision: account.revision,
      integrationRevision: definition.revision,
      toolIds: definition.tools.map((tool) => tool.id),
      constraints: {},
      enabled: true,
    },
  });
  store = new HarnessStore(join(directory, "harness.sqlite"));
  await store.ready;
  const worker = await store.createWorker("fixture-google-gateway");
  await store.reportWorker(worker.id, {
    hostname: "fixture",
    providers: ["demo"],
    labels: [],
    maxAgents: 1,
    memoryBudgetMiB: 4096,
    cpuSlots: 2,
    maxBuilds: 1,
    maxBrowsers: 0,
    availableMemoryMiB: 8192,
    reserveMemoryMiB: 0,
    loadPerCpu: 0,
    maxLoadPerCpu: 10000,
    draining: false,
  });
  await store.createTask({
    id: "fixture-google-task",
    workspaceId: "tech",
    title: "Fixture Google",
    objective: "Fixture reads",
    provider: "demo",
    profile: "standard",
    priority: 0,
  });
  for (const id of await store.pendingDispatch()) await store.enqueue(id);
  const claim = await store.claimForWorker(worker.id);
  assert.ok(claim);
  const grant = {
    workerId: worker.id,
    turnId: claim.claim.turn.id,
    generation: claim.claim.turn.generation,
    expiresAt: Date.now() + 60_000,
    purpose: "tools",
  };
  const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
  const token = `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
  const rpc = async (method, params) => {
    const response = await api(
      "tools",
      { jsonrpc: "2.0", id: crypto.randomUUID(), method, params },
      "",
      { authorization: `Bearer ${token}` },
    );
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    assert.ok(!result.result?.isError, JSON.stringify(result));
    return result.result;
  };
  const listed = (await rpc("tools/list")).tools;
  const cases = {
    "gmail.search": { query: "fixture" },
    "gmail.read_thread": { threadId: "fixture-thread" },
    "drive.search": { query: "Fixture" },
    "drive.get_file": { fileId: "fixture-file" },
    "docs.read": { documentId: "fixture-doc" },
    "sheets.metadata": { spreadsheetId: "fixture-sheet" },
    "sheets.read_range": {
      spreadsheetId: "fixture-sheet",
      range: "Tab!A1:B2",
      representation: "raw",
    },
    "calendar.list_events": {
      calendarId: "primary",
      timeMin: "2026-10-23T00:00:00Z",
      timeMax: "2026-10-24T00:00:00Z",
      timeZone: "UTC",
    },
  };
  for (const [id, args] of Object.entries(cases)) {
    const descriptor = listed.find((tool) =>
      tool.description.includes(
        definition.tools.find((tool) => tool.id === id).description,
      ),
    );
    assert.ok(descriptor, id);
    const result = await rpc("tools/call", {
      name: descriptor.name,
      arguments: { operation_id: `fixture-${id}`, arguments: args },
    });
    const text = JSON.stringify(result);
    assert.ok(!text.includes(ACCESS) && !text.includes(REFRESH));
    assert.match(text, /completed/);
  }
  assert.equal(providerCalls, 8);
  assert.equal(tokenCalls, 9);
  await store.completeWorkerTurn(
    worker.id,
    grant.turnId,
    grant.generation,
    "interrupted",
    "Fixture gateway reads finished without starting an agent execution.",
  );
  await json("integrations/google/disconnect", {
    connectionId: account.id,
    expectedRevision: account.revision,
  });
  assert.equal(
    (await json("integrations/google/status")).connections[0].status,
    "disconnected",
  );
  assert.ok(
    !JSON.stringify(
      await store
        .databaseConnection()
        .prepare("SELECT * FROM operation_ledger")
        .all(),
    ).includes(ACCESS),
  );
  assert.ok(!logs.includes(ACCESS) && !logs.includes(REFRESH));
  launch(join(root, "apps/worker"), ["--import", "tsx", "src/index.ts"]);
  const pnpmEntry = Reflect.get(process.env, "npm_execpath");
  assert.ok(pnpmEntry, "Run this fixture through pnpm smoke:google.");
  const smoke = launch(root, [pnpmEntry, "smoke"], {
    HARNESS_URL: base,
  });
  const code = await new Promise((resolve) => smoke.once("exit", resolve));
  assert.equal(code, 0, "Common Workflow + worker smoke failed.");
  console.log(
    "Google production fixture passed: owner resource OAuth, eight gateway reads, encrypted credentials, disconnect, receipt/log token checks and common Workflow smoke.",
  );
} catch (error) {
  console.error(
    logs.replaceAll(ACCESS, "[REDACTED]").replaceAll(REFRESH, "[REDACTED]"),
  );
  throw error;
} finally {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, 5000);
    await exited;
    clearTimeout(timer);
  }
  await store?.close();
  await new Promise((resolve) => provider.close(resolve));
  provider.closeAllConnections();
  await rm(directory, { recursive: true, force: true });
}
