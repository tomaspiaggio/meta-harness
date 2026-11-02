import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { HarnessError } from "@harness/core";
import {
  type ExtensionManifest,
  MAX_EXTENSION_CODE,
  parseExtensionConfig,
} from "@harness/core/extensions";
import type { HarnessStore } from "@harness/storage/application";
import type { Extension } from "@harness/storage/extensions";
import { flushDispatch } from "./dispatcher";
import { encryptionKey } from "./keys";
import { getStore } from "./store";

const key = () => Buffer.from(encryptionKey("extension-secrets"), "base64");
function seal(values: Record<string, string>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(values), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), data]
    .map((part) => part.toString("base64"))
    .join(".");
}
function open(sealed: string | null): Record<string, string> {
  if (!sealed) return {};
  const [iv, tag, data] = sealed
    .split(".")
    .map((part) => Buffer.from(part, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"),
  );
}
/** Plain settings with defaults filled in, plus the opened secrets. */
export function runConfig(
  manifest: ExtensionManifest,
  config: Record<string, string | number | boolean>,
  sealed: string | null,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [name, field] of Object.entries(manifest.config.properties))
    if (field.default !== undefined) result[name] = field.default;
  const secrets = open(sealed);
  for (const [name, value] of Object.entries(config))
    if (!manifest.config.properties[name]?.secret) result[name] = value;
  for (const [name, value] of Object.entries(secrets))
    if (manifest.config.properties[name]?.secret) result[name] = value;
  return result;
}
/**
 * Saves the owner's settings. Secret values are sealed with the server's key;
 * an empty secret keeps the stored one and null clears it.
 */
export async function saveSettings(
  store: HarnessStore,
  id: string,
  input: Record<string, unknown>,
): Promise<Extension> {
  const extension = await store.extensions.get(id);
  const manifest =
    extension.manifest ??
    extension.proposal?.manifest ??
    (() => {
      throw new HarnessError("This extension has no manifest yet.", 409);
    })();
  const change: Parameters<HarnessStore["extensions"]["configure"]>[1] = {};
  if (typeof input.enabled === "boolean") change.enabled = input.enabled;
  if (input.requiredLabels !== undefined)
    change.requiredLabels = input.requiredLabels;
  if (input.rotateWebhook === true) change.rotateWebhook = true;
  if (input.config !== undefined) {
    if (
      !input.config ||
      typeof input.config !== "object" ||
      Array.isArray(input.config)
    )
      throw new HarnessError("Settings must be an object.");
    const raw = input.config as Record<string, unknown>;
    const plain: Record<string, unknown> = {};
    const secretChanges: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(raw))
      (manifest.config.properties[name]?.secret ? secretChanges : plain)[name] =
        value;
    change.config = parseExtensionConfig(manifest, plain);
    if (Object.keys(secretChanges).length) {
      const secrets = open(await store.extensions.sealedSecrets(id));
      for (const [name, value] of Object.entries(secretChanges)) {
        if (value === null) delete secrets[name];
        else if (value !== "")
          secrets[name] = String(
            parseExtensionConfig(manifest, { [name]: value })[name],
          );
      }
      const names = Object.keys(secrets);
      change.secrets = names.length ? { sealed: seal(secrets), names } : null;
    }
  }
  return store.extensions.configure(id, change);
}
/** Timers, stuck runs and history; part of the control's maintenance loop. */
export async function dispatchExtensions(): Promise<void> {
  const store = await getStore();
  await store.extensions.tick();
}
/** Records a worker's result and starts the turns it delivered. */
export async function completeExtensionRun(
  store: HarnessStore,
  workerId: string,
  runId: string,
  result: Parameters<HarnessStore["extensions"]["complete"]>[2],
) {
  const outcome = await store.extensions.complete(workerId, runId, result);
  if (outcome.turns.length) await flushDispatch();
  return outcome;
}
/**
 * Reads an extension package the owner points at: a manifest.json URL whose
 * "main" (default main.ts) sits next to it. Only https, small files.
 */
export async function fetchExtensionPackage(
  url: string,
): Promise<{ manifest: unknown; code: string }> {
  let base: URL;
  try {
    base = new URL(url);
  } catch {
    throw new HarnessError("Paste the URL of an extension's manifest.json.");
  }
  if (base.protocol !== "https:" || base.username || base.password)
    throw new HarnessError("Extension URLs must be plain https links.");
  const read = async (target: URL, max: number) => {
    const response = await fetch(target, {
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new HarnessError(
        `Could not download ${target.pathname} (${response.status}).`,
        502,
      );
    const text = await response.text();
    if (text.length > max)
      throw new HarnessError(`${target.pathname} is too large.`, 413);
    return text;
  };
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await read(base, 64 * 1024));
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("The manifest is not valid JSON.");
  }
  const main = typeof manifest.main === "string" ? manifest.main : "main.ts";
  if (!/^[\w./-]{1,200}$/.test(main) || main.includes(".."))
    throw new HarnessError("The manifest's main must be a relative file name.");
  const codeUrl = new URL(main, base);
  if (codeUrl.origin !== base.origin)
    throw new HarnessError("The script must come from the manifest's site.");
  return { manifest, code: await read(codeUrl, MAX_EXTENSION_CODE) };
}
