#!/usr/bin/env node
// Writes Google resource OAuth settings into a local .env without echoing values.
// Usage: pnpm google:resource-env [--env .env] [--client-json path] [--redirect url]
// Owner sign-in settings are never modified, and an existing valid encryption key
// is kept: replacing it would make stored Google refresh tokens undecryptable.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs, parseEnv } from "node:util";

const CALLBACK = "/api/integrations/google/callback";
const KEY = /^[A-Za-z0-9_-]{43}$/;

export function resourceEnvUpdates(current, input) {
  const updates = {
    HARNESS_GOOGLE_RESOURCE_CLIENT_ID: input.clientId,
    HARNESS_GOOGLE_RESOURCE_CLIENT_SECRET: input.clientSecret,
    HARNESS_GOOGLE_RESOURCE_REDIRECT_URI: input.redirectUri,
  };
  if (!KEY.test(current.HARNESS_GOOGLE_RESOURCE_KEY ?? "")) {
    if (current.HARNESS_GOOGLE_RESOURCE_KEY)
      throw new Error(
        "HARNESS_GOOGLE_RESOURCE_KEY exists but is invalid. Fix or remove it deliberately; it was not replaced.",
      );
    updates.HARNESS_GOOGLE_RESOURCE_KEY = randomBytes(32).toString("base64url");
    updates.HARNESS_GOOGLE_RESOURCE_KEY_ID =
      current.HARNESS_GOOGLE_RESOURCE_KEY_ID ?? "primary";
  }
  for (const [name, value] of Object.entries(updates))
    if (!value || /[\r\n"'\s#]/.test(value))
      throw new Error(`${name} is empty or contains unsupported characters.`);
  const url = new URL(updates.HARNESS_GOOGLE_RESOURCE_REDIRECT_URI);
  if (url.pathname !== CALLBACK || url.search || url.hash)
    throw new Error(`The redirect URI must end with exactly ${CALLBACK}.`);
  return updates;
}

export function applyEnvUpdates(text, updates) {
  const remaining = new Map(Object.entries(updates));
  const lines = text.split("\n").map((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match || !remaining.has(match[1])) return line;
    const value = remaining.get(match[1]);
    remaining.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  if (lines.length && lines.at(-1) === "") lines.pop();
  for (const [name, value] of remaining) lines.push(`${name}=${value}`);
  return `${lines.join("\n")}\n`;
}

function hidden(question) {
  return new Promise((resolvePrompt, reject) => {
    if (!process.stdin.isTTY)
      return reject(new Error("Run interactively or pass --client-json."));
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rl._writeToOutput = (chunk) => {
      if (chunk.includes(question)) process.stdout.write(chunk);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolvePrompt(answer.trim());
    });
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      env: { type: "string", default: ".env" },
      "client-json": { type: "string" },
      redirect: { type: "string" },
    },
  });
  const path = resolve(values.env);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const current = parseEnv(text);
  let clientId;
  let clientSecret;
  if (values["client-json"]) {
    const json = JSON.parse(readFileSync(values["client-json"], "utf8"));
    const client = json.web;
    if (!client)
      throw new Error("Use a Web application OAuth client JSON (web).");
    clientId = client.client_id;
    clientSecret = client.client_secret;
  } else {
    clientId = await hidden("Resource OAuth client ID (hidden): ");
    clientSecret = await hidden("Resource OAuth client secret (hidden): ");
  }
  const origin = current.HARNESS_PUBLIC_URL
    ? new URL(current.HARNESS_PUBLIC_URL).origin
    : `http://localhost:${current.PORT ?? 3000}`;
  const redirectUri = values.redirect ?? `${origin}${CALLBACK}`;
  const updates = resourceEnvUpdates(current, {
    clientId,
    clientSecret,
    redirectUri,
  });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, applyEnvUpdates(text, updates), { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  console.log(`Updated ${path} (mode 600):`);
  for (const name of Object.keys(updates)) console.log(`  set ${name}`);
  if ("HARNESS_GOOGLE_RESOURCE_KEY" in updates)
    console.log(
      "  Back up HARNESS_GOOGLE_RESOURCE_KEY separately from the database.",
    );
  else console.log("  kept existing HARNESS_GOOGLE_RESOURCE_KEY");
  if (clientId === current.GOOGLE_CLIENT_ID)
    console.log(
      "  Note: this is the owner sign-in client. A separate Web client is recommended.",
    );
  console.log(`Authorized redirect URI to register: ${redirectUri}`);
  console.log("Restart the control server, then open Settings → Integrations.");
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
