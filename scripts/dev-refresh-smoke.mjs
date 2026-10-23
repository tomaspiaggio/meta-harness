import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const base = process.env.HARNESS_URL ?? "http://127.0.0.1:3000";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname))
  throw new Error("Use an isolated local development stack.");
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
  const r = await fetch(`${base}/api/${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  assert.ok(r.ok, JSON.stringify(data));
  return data;
}
const browser = await chromium.launch({
  headless: true,
  channel: "chromium",
});
let workspace;
try {
  const page = await browser.newPage();
  workspace = await api("workspaces", {
    name: "Refresh regression fixture",
    instructions: "Model-free fixture",
  });
  const session = await api("sessions", {
    workspaceId: workspace.id,
    title: "Refresh regression",
    provider: "demo",
  });
  await page.goto(`${base}/?workspace=${workspace.id}&session=${session.id}`);
  await page
    .getByRole("textbox", { name: "Your instruction", exact: true })
    .waitFor();
  await page.waitForTimeout(3000);
  const navigations = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  await page
    .getByRole("textbox", { name: "Your instruction", exact: true })
    .fill("Keep this unsent draft through database writes");
  await api("turns", {
    id: crypto.randomUUID(),
    sessionId: session.id,
    prompt: "Write the Demo checkpoint fixture",
  });
  await page.waitForTimeout(12000);
  assert.deepEqual(
    navigations,
    [],
    "Runtime DB/checkpoint writes must not reload the app",
  );
  assert.equal(
    await page
      .getByRole("textbox", { name: "Your instruction", exact: true })
      .inputValue(),
    "Keep this unsent draft through database writes",
  );
  console.log(
    "Development refresh gate passed: DB, worker and checkpoint writes caused no page reload and preserved the unsent draft.",
  );
} finally {
  await browser.close();
  if (workspace)
    await api("workspaces", { id: workspace.id, confirm: true }, "DELETE");
}
