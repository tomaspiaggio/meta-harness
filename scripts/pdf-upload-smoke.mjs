import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
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
const workspace = await api("workspaces", {
  name: "PDF regression fixture",
  instructions: "Model-free fixture",
});
const session = await api("sessions", {
  workspaceId: workspace.id,
  title: "PDF uploads",
  provider: "demo",
});
const browser = await chromium.launch({
  headless: true,
  channel: "chromium",
});
try {
  const page = await browser.newPage();
  const failures = [];
  page.on("response", (r) => {
    if (r.url().includes("/api/attachments") && !r.ok())
      failures.push(r.status());
  });
  await page.goto(`${base}/?workspace=${workspace.id}&session=${session.id}`);
  await page
    .getByRole("textbox", { name: "Your instruction", exact: true })
    .waitFor();
  const bytes = Buffer.alloc(6 * 1024 * 1024, 32);
  bytes.write("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
  const name = "Review résumé.pdf";
  await page
    .getByLabel("Attach files", { exact: true })
    .setInputFiles({ name, mimeType: "application/pdf", buffer: bytes });
  // This is the original bug seam: clearing the picker emptied its live FileList.
  await page
    .getByRole("button", { name: `Remove ${name}`, exact: true })
    .waitFor({ timeout: 5000 });
  await page
    .getByRole("textbox", { name: "Your instruction", exact: true })
    .fill("Inspect this PDF fixture");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  let accepted;
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await api(
      `state?workspace=${workspace.id}&session=${session.id}`,
    );
    accepted = state.turns.find((turn) =>
      turn.attachments?.some((file) => file.name === name),
    );
    if (accepted) break;
    await page.waitForTimeout(150);
  }
  assert.ok(
    accepted,
    "The submitted turn must actually include the selected PDF",
  );
  const attachment = accepted.attachments.find((file) => file.name === name);
  const download = await fetch(`${base}/api/attachments?id=${attachment.id}`);
  assert.ok(download.ok);
  assert.equal(
    createHash("sha256")
      .update(Buffer.from(await download.arrayBuffer()))
      .digest("hex"),
    createHash("sha256").update(bytes).digest("hex"),
  );
  let finished;
  for (let attempt = 0; attempt < 150; attempt++) {
    const state = await api(
      `state?workspace=${workspace.id}&session=${session.id}`,
    );
    finished = state.turns.find((turn) => turn.id === accepted.id);
    if (["failed", "interrupted"].includes(finished.status))
      throw new Error(finished.error);
    if (finished.status === "completed") break;
    await page.waitForTimeout(150);
  }
  assert.equal(finished.status, "completed");
  if (process.env.HARNESS_SMOKE_DATA_DIR) {
    const path = join(
      resolve(process.env.HARNESS_SMOKE_DATA_DIR),
      "worker-cache",
      finished.workerId,
      "sessions",
      session.id,
      ".harness-attachments",
      `${attachment.id}-${attachment.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120)}`,
    );
    assert.equal(
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
      attachment.hash,
      "The worker must receive the original PDF bytes",
    );
  }
  // Picker reset must still allow selecting the same file again.
  await page
    .getByLabel("Attach files", { exact: true })
    .setInputFiles({ name, mimeType: "application/pdf", buffer: bytes });
  await page
    .getByRole("button", { name: `Remove ${name}`, exact: true })
    .waitFor();
  assert.deepEqual(failures, []);
  console.log(
    "PDF UI gate passed: file-picker retention, 6 MiB upload, accented filename, integrity verification, turn association, worker delivery and same-file reselection.",
  );
} finally {
  await browser.close();
  await api("workspaces", { id: workspace.id, confirm: true }, "DELETE");
}
