import { HarnessError, requiredText } from "./index";
import type { JsonObject, JsonValue } from "./integrations";

/**
 * Extensions are owner-approved scripts that watch the outside world without an
 * agent. They run on any worker with a matching runtime, emit events, and the
 * harness turns new events into messages for the sessions that subscribed.
 * The contract is the manifest below; extensions live outside this repository.
 */
export const EXTENSION_RUNTIMES = ["deno"] as const;
export type ExtensionRuntime = (typeof EXTENSION_RUNTIMES)[number];
export type ExtensionTrigger =
  | { name: string; type: "cron"; cron: string; timezone: string }
  | { name: string; type: "webhook" };
export interface ExtensionConfigField {
  type: "string" | "number" | "integer" | "boolean";
  title: string;
  description?: string;
  /** Stored encrypted and never shown again after saving. */
  secret?: boolean;
  enum?: (string | number)[];
  default?: string | number | boolean;
}
export interface ExtensionManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  runtime: ExtensionRuntime;
  /** Hosts the script may reach. Nothing else on the network or disk. */
  permissions: { net: string[] };
  timeoutSeconds: number;
  config: {
    properties: Record<string, ExtensionConfigField>;
    required: string[];
  };
  triggers: ExtensionTrigger[];
}
export interface ExtensionEvent {
  /** Stable identity; an event with a key already seen is dropped. */
  key: string;
  type: string;
  title: string;
  text: string;
  url: string | null;
  data: JsonValue;
}
export interface ExtensionRunResult {
  events: ExtensionEvent[];
  state: { set: JsonObject; delete: string[] };
  logs: string;
  error: string | null;
}
export const MAX_EXTENSION_CODE = 512 * 1024;
export const MAX_EXTENSION_STATE = 256 * 1024;
export const MAX_RUN_EVENTS = 100;
export const MAX_RUN_LOGS = 16384;
export const MAX_WEBHOOK_BYTES = 256 * 1024;

const ID = /^[a-z0-9][a-z0-9-]{1,48}$/;
const NAME = /^[a-zA-Z0-9_-]{1,40}$/;
/** A host name, optionally with a port, as Deno's --allow-net accepts it. */
const HOST =
  /^(?=.{1,253}(:\d{1,5})?$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(:\d{1,5})?$/;

const bytes = (text: string) => new TextEncoder().encode(text).length;
const object = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HarnessError(`${name} must be an object.`);
  return value as Record<string, unknown>;
};
const optionalText = (value: unknown, name: string, max: number) =>
  value === undefined ? undefined : requiredText(value, name, max);

function parseField(name: string, value: unknown): ExtensionConfigField {
  const field = object(value, `Setting ${name}`);
  if (
    field.type !== "string" &&
    field.type !== "number" &&
    field.type !== "integer" &&
    field.type !== "boolean"
  )
    throw new HarnessError(
      `Setting ${name} must be a string, number, integer or boolean.`,
    );
  const result: ExtensionConfigField = {
    type: field.type,
    title: optionalText(field.title, `Setting ${name} title`, 80) ?? name,
  };
  const description = optionalText(
    field.description,
    `Setting ${name} description`,
    500,
  );
  if (description) result.description = description;
  if (field.secret === true || field.format === "password") {
    if (field.type !== "string")
      throw new HarnessError(`Secret setting ${name} must be a string.`);
    result.secret = true;
  }
  if (field.enum !== undefined) {
    if (
      !Array.isArray(field.enum) ||
      !field.enum.length ||
      field.enum.length > 50 ||
      !field.enum.every(
        (item) =>
          (typeof item === "string" && item.length <= 200) ||
          typeof item === "number",
      )
    )
      throw new HarnessError(`Setting ${name} has an invalid list of choices.`);
    result.enum = field.enum as (string | number)[];
  }
  if (field.default !== undefined) {
    if (result.secret)
      throw new HarnessError(`Secret setting ${name} cannot have a default.`);
    result.default = configValue(name, result, field.default);
  }
  return result;
}
/** Checks one setting against its field; secrets are plain strings here. */
export function configValue(
  name: string,
  field: ExtensionConfigField,
  value: unknown,
): string | number | boolean {
  const valid =
    field.type === "string"
      ? typeof value === "string" && value.length <= 4096
      : field.type === "boolean"
        ? typeof value === "boolean"
        : typeof value === "number" &&
          Number.isFinite(value) &&
          (field.type === "number" || Number.isSafeInteger(value));
  if (!valid)
    throw new HarnessError(
      `${field.title || name} must be ${field.type === "integer" ? "a whole number" : `a ${field.type}`}.`,
    );
  if (field.enum && !field.enum.includes(value as string | number))
    throw new HarnessError(
      `${field.title || name} must be one of ${field.enum.join(", ")}.`,
    );
  return value as string | number | boolean;
}

export function parseExtensionManifest(value: unknown): ExtensionManifest {
  const input = object(value, "Manifest");
  const id = requiredText(input.id, "Extension ID", 50);
  if (!ID.test(id))
    throw new HarnessError(
      "Extension ID must be 2–50 lowercase letters, digits or dashes.",
    );
  const runtime = input.runtime ?? "deno";
  if (!EXTENSION_RUNTIMES.includes(runtime as ExtensionRuntime))
    throw new HarnessError(
      `Runtime must be one of ${EXTENSION_RUNTIMES.join(", ")}.`,
    );
  const permissions = object(input.permissions ?? {}, "Permissions");
  const net = permissions.net ?? [];
  if (
    !Array.isArray(net) ||
    net.length > 20 ||
    !net.every((host) => typeof host === "string" && HOST.test(host))
  )
    throw new HarnessError(
      "Network permissions must list up to 20 exact host names, like oauth.reddit.com.",
    );
  const timeoutSeconds = input.timeoutSeconds ?? 60;
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isSafeInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 300
  )
    throw new HarnessError("Timeout must be 1–300 seconds.");
  const config = object(input.config ?? {}, "Config");
  const rawProperties = object(config.properties ?? {}, "Config properties");
  const names = Object.keys(rawProperties);
  if (names.length > 30)
    throw new HarnessError("An extension has at most 30 settings.");
  const properties: Record<string, ExtensionConfigField> = {};
  for (const name of names) {
    if (!NAME.test(name))
      throw new HarnessError(
        `Setting name ${name} must be letters, digits, dashes or underscores.`,
      );
    properties[name] = parseField(name, rawProperties[name]);
  }
  const required = config.required ?? [];
  if (
    !Array.isArray(required) ||
    !required.every(
      (name) => typeof name === "string" && Object.hasOwn(properties, name),
    )
  )
    throw new HarnessError("Required settings must name declared settings.");
  if (!Array.isArray(input.triggers) || !input.triggers.length)
    throw new HarnessError("An extension needs at least one trigger.");
  if (input.triggers.length > 10)
    throw new HarnessError("An extension has at most 10 triggers.");
  const triggers = input.triggers.map((raw): ExtensionTrigger => {
    const trigger = object(raw, "Trigger");
    const name = requiredText(trigger.name, "Trigger name", 40);
    if (!NAME.test(name))
      throw new HarnessError(
        `Trigger name ${name} must be letters, digits, dashes or underscores.`,
      );
    if (trigger.type === "webhook") return { name, type: "webhook" };
    if (trigger.type !== "cron")
      throw new HarnessError(`Trigger ${name} must be cron or webhook.`);
    const cron = requiredText(trigger.cron, `Trigger ${name} cron`, 100);
    if (cron.split(/\s+/).length !== 5)
      throw new HarnessError(
        `Trigger ${name} needs a five-field cron expression (minute hour day month weekday).`,
      );
    const timezone =
      optionalText(trigger.timezone, `Trigger ${name} timezone`, 100) ?? "UTC";
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
    } catch {
      throw new HarnessError(`Trigger ${name} needs a valid IANA timezone.`);
    }
    return { name, type: "cron", cron, timezone };
  });
  if (new Set(triggers.map((trigger) => trigger.name)).size !== triggers.length)
    throw new HarnessError("Trigger names must be different.");
  return {
    id,
    name: requiredText(input.name, "Extension name", 80),
    description: requiredText(input.description, "Extension description", 1000),
    version: requiredText(input.version, "Extension version", 40),
    runtime: runtime as ExtensionRuntime,
    permissions: { net: [...new Set(net as string[])] },
    timeoutSeconds,
    config: { properties, required: required as string[] },
    triggers,
  };
}
export function parseExtensionCode(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    bytes(value) > MAX_EXTENSION_CODE
  )
    throw new HarnessError(
      `Extension code must be one module of at most ${MAX_EXTENSION_CODE / 1024} KB.`,
    );
  if (!/\bexport\s+default\b/.test(value))
    throw new HarnessError(
      "Extension code must export a default function: export default async function run(context) { … }.",
    );
  return value;
}
/** Settings checked against the manifest; secrets are kept apart by the caller. */
export function parseExtensionConfig(
  manifest: ExtensionManifest,
  value: unknown,
): Record<string, string | number | boolean> {
  const input = object(value ?? {}, "Settings");
  const result: Record<string, string | number | boolean> = {};
  for (const [name, raw] of Object.entries(input)) {
    const field = manifest.config.properties[name];
    if (!field) throw new HarnessError(`Unknown setting ${name}.`);
    if (raw === null || raw === "") continue;
    result[name] = configValue(name, field, raw);
  }
  return result;
}
/** Settings the manifest requires but neither the owner nor a default supplied. */
export function missingSettings(
  manifest: ExtensionManifest,
  present: Iterable<string>,
): string[] {
  const have = new Set(present);
  return manifest.config.required.filter(
    (name) =>
      !have.has(name) &&
      manifest.config.properties[name]?.default === undefined,
  );
}

const jsonSize = (value: unknown) => bytes(JSON.stringify(value));
function parseEvent(value: unknown): ExtensionEvent {
  const input = object(value, "Event");
  const key = requiredText(
    typeof input.key === "number" ? String(input.key) : input.key,
    "Event key",
    200,
  );
  const url = input.url == null ? null : requiredText(input.url, "URL", 2000);
  if (url && !/^https?:\/\//.test(url))
    throw new HarnessError("Event links must be http(s) URLs.");
  const data = (input.data ?? null) as JsonValue;
  if (jsonSize(data) > 16384)
    throw new HarnessError("Event data must be at most 16 KB.");
  return {
    key,
    type: optionalText(input.type, "Event type", 60) ?? "event",
    title: requiredText(input.title, "Event title", 300),
    text: input.text == null ? "" : String(input.text).slice(0, 8000),
    url,
    data,
  };
}
/** What a worker reports after running a script; bounded before storage. */
export function parseExtensionRunResult(value: unknown): ExtensionRunResult {
  const input = object(value, "Run result");
  const events = input.events ?? [];
  if (!Array.isArray(events) || events.length > MAX_RUN_EVENTS)
    throw new HarnessError(
      `A run may emit at most ${MAX_RUN_EVENTS} events. Keep the rest for the next run.`,
    );
  const state = object(input.state ?? {}, "State");
  const set = object(state.set ?? {}, "State changes") as JsonObject;
  const deleted = state.delete ?? [];
  if (
    !Array.isArray(deleted) ||
    !deleted.every((key) => typeof key === "string" && key.length <= 200) ||
    Object.keys(set).some((key) => key.length > 200)
  )
    throw new HarnessError("State keys must be at most 200 characters.");
  if (jsonSize(set) > MAX_EXTENSION_STATE)
    throw new HarnessError(
      `Extension state must be at most ${MAX_EXTENSION_STATE / 1024} KB.`,
    );
  return {
    events: events.map(parseEvent),
    state: { set, delete: deleted as string[] },
    logs: typeof input.logs === "string" ? input.logs.slice(-MAX_RUN_LOGS) : "",
    error:
      input.error == null ? null : String(input.error).slice(0, 4000) || null,
  };
}
/** How a batch of new events reads in a subscribed conversation. */
export function eventMessage(
  extension: { name: string },
  trigger: string,
  events: Pick<ExtensionEvent, "title" | "text" | "url" | "type">[],
  maxChars = 20000,
): string {
  const head = `[${extension.name} · ${trigger}] ${events.length === 1 ? "1 new event" : `${events.length} new events`}`;
  let body = "";
  let shown = 0;
  for (const event of events) {
    const part = `\n\n### ${event.title}${event.type !== "event" ? ` (${event.type})` : ""}${event.text ? `\n${event.text}` : ""}${event.url ? `\n${event.url}` : ""}`;
    if (head.length + body.length + part.length > maxChars) break;
    body += part;
    shown++;
  }
  return shown < events.length
    ? `${head}${body}\n\n…and ${events.length - shown} more not shown.`
    : `${head}${body}`;
}
