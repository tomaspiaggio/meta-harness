import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extensionPairing } from "../packages/browser/src/extension-relay.ts";

if (existsSync(".env")) process.loadEnvFile(".env");
const directory = resolve(process.env.HARNESS_DATA_DIR ?? ".data");
const credential =
  process.env.HARNESS_WORKER_TOKEN_FILE ?? join(directory, "local-worker.json");
if (!existsSync(credential))
  throw new Error(
    "Enroll/start the worker on this machine first, then run pnpm browser:pair.",
  );
const { id } = JSON.parse(readFileSync(credential, "utf8"));
if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
  throw new Error("Invalid worker identity.");
const cache = resolve(
  process.env.HARNESS_WORKER_DATA_DIR ?? join(directory, "worker-cache", id),
);
const path =
  process.env.HARNESS_BROWSER_EXTENSION_CONFIG ??
  join(cache, "browser-extension.json");
const { port, token } = await extensionPairing(path);
console.log(
  `Load this folder once in chrome://extensions (Developer mode → Load unpacked):\n${resolve("apps/browser-extension/dist")}\n`,
);
console.log(
  "Open the Meta Harness Browser extension. Paste this code there, not in chat:\n",
);
console.log(Buffer.from(JSON.stringify({ port, token })).toString("base64"));
