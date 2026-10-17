import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ControlStore } from "../packages/storage/src/control.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
if (existsSync(".env")) process.loadEnvFile(".env");
const value = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const directory = resolve(process.env.HARNESS_DATA_DIR ?? join(root, ".data"));
const store = new ControlStore(join(directory, "harness.sqlite"));
try {
  const revoke = value("--revoke");
  if (revoke) {
    store.revokeWorker(revoke);
    console.log(`Revoked worker ${revoke}.`);
  } else {
    const name = value("--name");
    const serverUrl = value("--url");
    const output = value("--out");
    if (!name || !serverUrl || !output)
      throw new Error(
        "Usage: pnpm worker:enroll --name pi --url https://control.example --out /secure/path/pi.json",
      );
    const url = new URL(serverUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error("Use a bare HTTP(S) control origin.");
    const path = resolve(output);
    if (existsSync(path))
      throw new Error("Credential output already exists. Choose a new file.");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const identity = store.createWorker(name);
    writeFileSync(
      path,
      JSON.stringify({ ...identity, serverUrl: url.origin }, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      `Enrolled ${name} (${identity.id}). Credential written to ${path}.`,
    );
  }
} finally {
  store.close();
}
