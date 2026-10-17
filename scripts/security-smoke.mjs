import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "meta-security-"));
const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
let logs = "";
const child = spawn(
  process.execPath,
  ["scripts/dev.mjs", "--production", "--control-only"],
  {
    cwd: root,
    env: {
      ...process.env,
      HARNESS_DATA_DIR: directory,
      HARNESS_BIND_HOST: "0.0.0.0",
      HARNESS_REQUIRE_AUTH: "1",
      PORT: String(port),
      WORKFLOW_TARGET_WORLD: "local",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  },
);
child.stdout.on("data", (chunk) => {
  logs = (logs + chunk).slice(-8000);
});
child.stderr.on("data", (chunk) => {
  logs = (logs + chunk).slice(-8000);
});
try {
  let ready = false;
  for (let i = 0; i < 75; i++) {
    try {
      const response = await fetch(`${base}/api/state`);
      if (response.status === 401) {
        ready = true;
        break;
      }
    } catch {}
    await delay(200);
  }
  assert.ok(ready, `Network gateway did not become ready. ${logs}`);
  const token = (await readFile(join(directory, "admin-token"), "utf8")).trim();
  const authorization = `Bearer ${token}`;
  assert.equal(
    (
      await fetch(`${base}/api/state`, {
        headers: { authorization: "Bearer wrong" },
      })
    ).status,
    401,
  );
  assert.equal(
    (await fetch(`${base}/api/state`, { headers: { authorization } })).status,
    200,
  );
  for (const path of [
    "/.well-known/workflow/v1/flow",
    "/%2ewell-known/workflow/v1/flow",
    "/_next/%252e%252e/.well-known/workflow/v1/flow",
  ]) {
    assert.equal(
      (
        await fetch(`${base}${path}`, {
          headers: { host: "localhost", authorization },
        })
      ).status,
      404,
    );
  }
  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(
    (
      await fetch(`${base}/api/state`, {
        headers: { cookie: cookie.split(";")[0] },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${base}/api/tasks`, {
        headers: { authorization, origin: "https://untrusted.invalid" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${base}/api/worker/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    401,
  );
  const input = {
    id: crypto.randomUUID(),
    workspaceId: "tech",
    title: "Gateway dispatch",
    objective: "Disposable gateway test",
    provider: "demo",
  };
  assert.equal(
    (
      await fetch(`${base}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify(input),
      })
    ).status,
    201,
  );
  let queued = false;
  for (let i = 0; i < 75; i++) {
    const response = await fetch(`${base}/api/tasks`, {
      headers: { authorization },
    });
    const state = await response.json();
    if (
      state.tasks.some(
        (task) => task.id === input.id && task.status === "queued",
      )
    ) {
      queued = true;
      break;
    }
    await delay(200);
  }
  assert.ok(
    queued,
    `Internal workflow callback failed behind gateway. ${logs}`,
  );
  console.log(
    "Security smoke passed: admin/cookie auth, origin checks, scoped worker rejection, hidden engine routes, private workflow dispatch.",
  );
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise((resolve) => child.once("exit", resolve));
    process.kill(-child.pid, "SIGTERM");
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, 5000);
    await closed;
    clearTimeout(timer);
  }
  await rm(directory, { recursive: true, force: true });
}
