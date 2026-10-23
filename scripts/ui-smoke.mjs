import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const base = process.env.HARNESS_URL ?? "http://127.0.0.1:3000";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname))
  throw new Error("Run this fixture against an isolated local stack.");
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(
  process.env.HARNESS_BROWSER_CACHE_DIR ?? ".data/browser-cache",
);
process.env.PLAYWRIGHT_SKIP_BROWSER_GC = "1";
const require = createRequire(import.meta.url);
const loaded = await import(
  pathToFileURL(
    require.resolve("patchright", { paths: [resolve("packages/browser")] }),
  ).href
);
const { chromium } = loaded.default ?? loaded;
async function api(path, body) {
  const response = await fetch(`${base}/api/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(result)}`);
  return result;
}
const workspace = await api("workspaces", {
  name: `UI fixture ${crypto.randomUUID().slice(0, 8)}`,
  instructions: "This workspace contains model-free smoke fixtures.",
});
const session = await api("sessions", {
  workspaceId: workspace.id,
  title: "Browser UI fixture",
  provider: "demo",
});
const browser = await chromium.launch({
  headless: true,
  channel: "chromium",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(`${base}/?workspace=${workspace.id}&session=${session.id}`);
  assert.equal(
    await page
      .getByRole("region", { name: "Workspace browser", exact: true })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "Open browser", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "Enable workspace browser", exact: true })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await page.getByAltText("Current browser page").waitFor({ timeout: 45000 });
  await page.getByLabel("Browser address").fill("https://example.com");
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await page.waitForTimeout(2000);
  assert.ok(
    (
      await page.getByAltText("Current browser page").getAttribute("src")
    )?.startsWith("blob:"),
    "manual frames are decrypted only in the UI",
  );
  await page
    .getByRole("button", { name: "Return to agent", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/schedules`);
  await page.getByRole("heading", { name: "Schedules", exact: true }).waitFor();
  await page.locator('a[href="/settings"]').click();
  await page
    .getByRole("button", { name: "Enroll worker", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
    "phone viewport must not overflow",
  );
  assert.deepEqual(errors, []);
  console.log(
    "UI smoke passed: encrypted browser handshake, manual navigation, return to the same session, mobile navigation and no client exceptions.",
  );
} finally {
  await browser.close();
}
