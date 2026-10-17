import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
if (existsSync(".env")) process.loadEnvFile(".env");
const args = process.argv.slice(2);
const credential = args.indexOf("--credential");
if (credential >= 0) {
  if (!args[credential + 1])
    throw new Error("--credential requires a file path.");
  process.env.HARNESS_WORKER_TOKEN_FILE = resolve(args[credential + 1]);
}
const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  cwd: join(root, "apps/worker"),
  env: {
    ...process.env,
    HARNESS_DATA_DIR: resolve(
      process.env.HARNESS_DATA_DIR ?? join(root, ".data"),
    ),
  },
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 0;
});
