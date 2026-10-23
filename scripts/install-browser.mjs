import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const cli = join(
  dirname(
    require.resolve("patchright/package.json", {
      paths: [resolve(root, "packages/browser")],
    }),
  ),
  "cli.js",
);
const child = spawn(process.execPath, [cli, "install", "chromium"], {
  stdio: "inherit",
  env: {
    ...process.env,
    PLAYWRIGHT_SKIP_BROWSER_GC: "1",
    PLAYWRIGHT_BROWSERS_PATH: resolve(
      process.env.HARNESS_BROWSER_CACHE_DIR ??
        resolve(root, ".data/browser-cache"),
    ),
  },
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
