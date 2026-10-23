import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const base = process.env.HARNESS_URL ?? "http://127.0.0.1:3000";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname))
  throw new Error("Use an isolated local fixture stack.");
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".data/browser-cache");
process.env.PLAYWRIGHT_SKIP_BROWSER_GC = "1";
const require = createRequire(import.meta.url);
const loaded = await import(
  pathToFileURL(
    require.resolve("patchright", { paths: [resolve("packages/browser")] }),
  ).href
);
const { chromium } = loaded.default ?? loaded;
async function api(path, body, method = "POST") {
  const r = await fetch(
    `${base}/api/${path}`,
    body
      ? {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  const data = await r.json();
  assert.ok(r.ok, JSON.stringify(data));
  return data;
}
const workers = await api("workers");
assert.ok(
  workers.every(
    (worker) =>
      !worker.report?.providers.some((provider) => provider !== "demo"),
  ),
  "This fixture requires Demo-only workers, so no live native turn can execute",
);
const original = await api("preferences");
const workspace = await api("workspaces", {
  name: "Model preferences fixture",
  instructions:
    "Demo-only fixture stack. Native turns deliberately remain queued.",
});
const browser = await chromium.launch({
  headless: true,
  channel: "chromium",
});
try {
  const page = await browser.newPage({
    viewport: { width: 1320, height: 950 },
  });
  await page.goto(`${base}/settings`);
  await page.getByLabel("Default agent", { exact: true }).selectOption("codex");
  await page
    .getByLabel("Default model", { exact: true })
    .selectOption("gpt-6.1-sol");
  await page
    .getByRole("button", { name: "Save defaults", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Agent defaults saved." })
    .waitFor();
  await page.goto(`${base}/?workspace=${workspace.id}`);
  await page.getByLabel("Model", { exact: true }).selectOption("gpt-6.1-sol");
  assert.equal(
    await page
      .getByRole("radio", { name: "Codex", exact: true })
      .getAttribute("data-state"),
    "on",
  );
  const session = await api("sessions", {
    workspaceId: workspace.id,
    title: "Model continuity",
  });
  assert.equal(session.provider, "codex");
  assert.equal(session.model, "gpt-6.1-sol");
  await api("turns", {
    id: crypto.randomUUID(),
    sessionId: session.id,
    prompt: "First frozen model",
  });
  await page.goto(`${base}/?workspace=${workspace.id}&session=${session.id}`);
  const changed = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/sessions") &&
      response.request().method() === "PATCH" &&
      response.request().postDataJSON()?.action === "model",
  );
  await page
    .getByLabel("Session model", { exact: true })
    .selectOption("gpt-6-luna");
  await changed;
  await api("turns", {
    id: crypto.randomUUID(),
    sessionId: session.id,
    prompt: "Second frozen model",
  });
  let state = await api(
    `state?workspace=${workspace.id}&session=${session.id}`,
  );
  assert.deepEqual(
    state.turns.map((turn) => turn.model),
    ["gpt-6.1-sol", "gpt-6-luna"],
  );
  assert.equal(
    state.sessions.find((item) => item.id === session.id).provider,
    "codex",
  );
  await page.reload();
  await page.getByLabel("Session model", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Session model", { exact: true }).inputValue(),
    "gpt-6-luna",
  );
  await api(
    "preferences",
    { provider: "claude", models: { claude: "opus", codex: "gpt-6.1-sol" } },
    "PATCH",
  );
  const next = await api("sessions", {
    workspaceId: workspace.id,
    title: "Claude default",
  });
  assert.equal(next.provider, "claude");
  assert.equal(next.model, "opus");
  state = await api(`state?workspace=${workspace.id}&session=${session.id}`);
  assert.equal(
    state.sessions.find((item) => item.id === session.id).model,
    "gpt-6-luna",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
    "Model controls must fit a phone viewport",
  );
  console.log(
    "Model UI gate passed: saved defaults, new-session inheritance, session selector persistence, immutable queued models, unchanged provider/session identity and mobile layout. No live model calls.",
  );
} finally {
  await browser.close();
  await api("preferences", original, "PATCH");
  await api("workspaces", { id: workspace.id, confirm: true }, "DELETE");
}
