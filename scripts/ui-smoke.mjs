// Compatibility entrypoint: the old queued-frame UI has been replaced.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const child = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    fileURLToPath(new URL("./browser-live-smoke.mjs", import.meta.url)),
  ],
  { stdio: "inherit", env: process.env },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
