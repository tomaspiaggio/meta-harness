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
  const v = await r.json();
  assert.ok(r.ok, JSON.stringify(v));
  return v;
}
const workspace = await api("workspaces", {
  name: `Delete fixture ${crypto.randomUUID().slice(0, 6)}`,
  instructions: "Disposable deletion fixture",
});
const session = await api("sessions", {
  workspaceId: workspace.id,
  title: "Delete this conversation",
  provider: "demo",
});
const sibling = await api("sessions", {
  workspaceId: workspace.id,
  title: "Keep until workspace deletion",
  provider: "demo",
});
const browser = await chromium.launch({
  headless: true,
  channel: "chromium",
});
try {
  const page = await browser.newPage({
    viewport: { width: 1300, height: 900 },
  });
  await page.goto(`${base}/?workspace=${workspace.id}&session=${session.id}`);
  await page
    .getByRole("button", {
      name: `Delete session ${session.title}`,
      exact: true,
    })
    .click();
  await page.getByRole("alertdialog").waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.ok(
    (await api("workspaces")).sessions.some((s) => s.id === session.id),
  );
  const rejected = await fetch(`${base}/api/sessions`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: session.id }),
  });
  assert.equal(rejected.status, 400);
  await api("turns", {
    id: crypto.randomUUID(),
    sessionId: session.id,
    prompt: "Work to be stopped by deletion",
  });
  let running = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await api(
      `state?workspace=${workspace.id}&session=${session.id}`,
    );
    if (state.turns.some((turn) => turn.status === "running")) {
      running = true;
      break;
    }
    await page.waitForTimeout(100);
  }
  assert.ok(
    running,
    "The deletion fixture must actually interrupt running work",
  );
  await page
    .getByRole("button", {
      name: `Delete session ${session.title}`,
      exact: true,
    })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete session", exact: true })
    .click();
  await page.getByRole("alertdialog").waitFor({ state: "hidden" });
  await page.waitForURL((url) => !url.searchParams.has("session"));
  assert.ok(
    !(await api("workspaces")).sessions.some((s) => s.id === session.id),
  );
  assert.ok(
    (await api("workspaces")).sessions.some((s) => s.id === sibling.id),
  );
  await page
    .getByRole("button", {
      name: `Delete workspace ${workspace.name}`,
      exact: true,
    })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete workspace", exact: true })
    .click();
  await page.getByRole("alertdialog").waitFor({ state: "hidden" });
  assert.ok(
    !(await api("workspaces")).workspaces.some((w) => w.id === workspace.id),
  );
  assert.ok(
    !(await api("workspaces")).sessions.some((s) => s.id === sibling.id),
  );
  await page.waitForURL(
    (url) => url.searchParams.get("workspace") !== workspace.id,
  );
  console.log(
    "Deletion UI passed: confirmation/cancel, required consent, active conversation deletion, sibling isolation, workspace cascade and navigation recovery.",
  );
} finally {
  await browser.close();
  await api("workspaces", { id: workspace.id, confirm: true }, "DELETE");
}
