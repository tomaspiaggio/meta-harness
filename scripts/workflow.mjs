import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
if (existsSync(".env")) process.loadEnvFile(".env");
const require = createRequire(import.meta.url);
const workflowDist = dirname(
  require.resolve("workflow/next", { paths: [join(root, "apps/web")] }),
);
const child = spawn(
  process.execPath,
  [join(workflowDist, "../bin/run.js"), ...process.argv.slice(2)],
  {
    cwd: join(root, "apps/web"),
    env: {
      ...process.env,
      WORKFLOW_LOCAL_DATA_DIR: join(
        resolve(process.env.HARNESS_DATA_DIR ?? join(root, ".data")),
        "workflow",
      ),
    },
    stdio: "inherit",
  },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
