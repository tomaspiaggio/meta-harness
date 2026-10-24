import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { HarnessError, requiredText } from "@harness/core";
import { stableJson } from "@harness/core/idempotency";
import {
  type IntegrationAdapter,
  type IntegrationConnection,
  type IntegrationDefinition,
  IntegrationNotStartedError,
  type JsonObject,
  type JsonValue,
  jsonObject,
  parseIntegrationDefinition,
  type ToolDefinition,
} from "@harness/core/integrations";
import Ajv from "ajv";

const protocol = "2025-06-18";
const maxBytes = 262144;
export interface McpHttpConfig {
  endpoint: string;
  allowPrivate: boolean;
  headerRefs: Record<string, string>;
}
export function parseMcpHttpConfig(value: unknown): McpHttpConfig {
  const config = jsonObject(value);
  const raw = requiredText(config.endpoint, "MCP endpoint", 2000);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HarnessError("MCP endpoint must be an absolute HTTP URL.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new HarnessError(
      "Use an HTTP(S) endpoint without credentials, query or fragment.",
    );
  if (url.protocol !== "https:" && config.allowPrivate !== true)
    throw new HarnessError(
      "HTTPS is required unless private access is explicitly approved.",
    );
  const refs = jsonObject(config.headerRefs ?? {});
  if (Object.keys(refs).length > 12)
    throw new HarnessError("At most 12 authentication headers are supported.");
  const headerRefs: Record<string, string> = {};
  for (const [name, value] of Object.entries(refs)) {
    if (
      !/^(authorization|x-[a-z0-9-]+|api-key)$/i.test(name) ||
      /^(x-forwarded-|x-real-)/i.test(name)
    )
      throw new HarnessError(
        "Use Authorization, API-Key or an X- authentication header.",
      );
    const ref = requiredText(value, "Secret reference", 80);
    if (!/^[a-zA-Z0-9_-]+$/.test(ref))
      throw new HarnessError("Invalid header secret reference.");
    headerRefs[name.toLowerCase()] = ref;
  }
  return {
    endpoint: url.href,
    allowPrivate: config.allowPrivate === true,
    headerRefs,
  };
}
function addressPolicy(address: string): "public" | "private" | "blocked" {
  const normalized = address.toLowerCase();
  if (isIP(normalized) === 4) {
    const parts = normalized.split(".").map(Number),
      a = parts[0] ?? 0,
      b = parts[1] ?? 0,
      c = parts[2] ?? 0;
    if (
      a === 0 ||
      (a === 169 && b === 254) ||
      a >= 224 ||
      (a === 100 && b === 100 && c === 100)
    )
      return "blocked";
    if (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    )
      return "private";
    return "public";
  }
  if (isIP(normalized) === 6) {
    if (normalized.startsWith("::ffff:")) {
      const tail = normalized.slice(7);
      if (isIP(tail) === 4) return addressPolicy(tail);
      const parts = tail.split(":");
      if (parts.length === 2) {
        const high = parseInt(parts[0] ?? "", 16),
          low = parseInt(parts[1] ?? "", 16);
        return addressPolicy(
          `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`,
        );
      }
      return "blocked";
    }
    if (
      normalized === "::" ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff")
    )
      return "blocked";
    if (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd")
    )
      return "private";
    if (
      !/^[23]/.test(normalized) ||
      normalized.startsWith("2001:0:") ||
      normalized.startsWith("2002:")
    )
      return "blocked";
    return "public";
  }
  return "blocked";
}
export async function approvedDestination(
  config: McpHttpConfig,
  blockedOrigins: string[] = [],
  signal: AbortSignal = AbortSignal.timeout(10000),
) {
  const url = new URL(config.endpoint);
  if (
    blockedOrigins.some((origin) => {
      try {
        return new URL(origin).origin === url.origin;
      } catch {
        return false;
      }
    })
  )
    throw new HarnessError(
      "The harness control origin cannot be an upstream MCP endpoint.",
    );
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (/(^|\.)(metadata|metadata\.google\.internal)$/.test(hostname))
    throw new HarnessError("Metadata endpoints are forbidden.");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await new Promise<{ address: string; family: number }[]>(
        (resolve, reject) => {
          const abort = () =>
            reject(new HarnessError("MCP DNS resolution was cancelled."));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) {
            abort();
            return;
          }
          void lookup(hostname, { all: true })
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort));
        },
      );
  if (
    !addresses.length ||
    addresses.some(
      ({ address }) =>
        addressPolicy(address) === "blocked" ||
        (addressPolicy(address) === "private" && !config.allowPrivate),
    )
  )
    throw new HarnessError(
      "MCP destination is blocked. Private access requires explicit approval; metadata is always blocked.",
    );
  if (
    url.protocol === "http:" &&
    addresses.some(({ address }) => addressPolicy(address) !== "private")
  )
    throw new HarnessError(
      "Unencrypted HTTP is limited to explicitly approved private destinations.",
    );
  const destination = addresses[0];
  if (!destination) throw new HarnessError("MCP destination has no address.");
  if (
    addresses.some((a) => addressPolicy(a.address) === "private") &&
    ["3000", process.env.PORT ?? "3000"].includes(
      url.port || (url.protocol === "https:" ? "443" : "80"),
    )
  )
    throw new HarnessError(
      "Control-plane ports cannot be used as private MCP endpoints.",
    );
  return { url, destination };
}
interface RpcMessage {
  jsonrpc?: string;
  id?: string;
  result?: JsonObject;
  error?: unknown;
  method?: string;
}
/** One bounded POST; pinned DNS, no redirects, no cookies or ambient credentials. */
async function post(
  config: McpHttpConfig,
  headers: Record<string, string>,
  message: JsonObject,
  signal: AbortSignal,
  blockedOrigins: string[],
): Promise<{ body: RpcMessage; session?: string }> {
  const { url, destination } = await approvedDestination(
    config,
    blockedOrigins,
    signal,
  );
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "POST",
        agent: false,
        family: destination.family,
        signal,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        lookup: (_hostname, _options, callback) =>
          callback(null, destination.address, destination.family),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.destroy();
          reject(
            new HarnessError(
              "MCP redirects are unsupported; register the final endpoint explicitly.",
            ),
          );
          return;
        }
        if (status === 202 && !message.id) {
          response.resume();
          resolve({ body: {} });
          return;
        }
        if (status !== 200) {
          response.destroy();
          reject(
            new HarnessError(
              `MCP endpoint returned HTTP ${status}. Check endpoint and server-side secret references.`,
            ),
          );
          return;
        }
        const type = String(response.headers["content-type"] ?? "").split(
          ";",
        )[0];
        if (type !== "application/json" && type !== "text/event-stream") {
          response.destroy();
          reject(
            new HarnessError(
              "Expected Streamable HTTP JSON or SSE response. Legacy SSE is unsupported.",
            ),
          );
          return;
        }
        let bytes = 0,
          buffer = "",
          finished = false;
        const finish = (body: RpcMessage) => {
          if (finished) return;
          finished = true;
          const raw = response.headers["mcp-session-id"];
          const session = typeof raw === "string" ? raw : undefined;
          if (session && !/^[\x21-\x7e]{1,256}$/.test(session)) {
            response.destroy();
            reject(new HarnessError("Invalid MCP session identifier."));
            return;
          }
          resolve({ body, ...(session ? { session } : {}) });
          response.destroy();
        };
        const parse = (raw: string) => {
          const parsed: unknown = JSON.parse(raw);
          const m = jsonObject(parsed) as RpcMessage;
          if (m.jsonrpc !== "2.0")
            throw new HarnessError("Invalid MCP JSON-RPC envelope.");
          if (m.method) {
            if (m.id !== undefined)
              throw new HarnessError(
                "MCP server-initiated requests, sampling and elicitation are unsupported.",
              );
            return;
          }
          if (m.id !== message.id)
            throw new HarnessError("MCP response ID mismatch.");
          if (m.error)
            throw new HarnessError(
              "MCP server rejected the request. Its untrusted error details were omitted.",
            );
          finish(m);
        };
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > maxBytes) {
            response.destroy();
            reject(new HarnessError("MCP response exceeds 256 KiB."));
            return;
          }
          buffer += chunk;
          if (type === "text/event-stream") {
            buffer = buffer.replace(/\r\n/g, "\n");
            while (buffer.includes("\n\n")) {
              const end = buffer.indexOf("\n\n");
              const event = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const data = event
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              if (data)
                try {
                  parse(data);
                } catch (error) {
                  response.destroy();
                  reject(
                    error instanceof HarnessError
                      ? error
                      : new HarnessError("MCP response contains invalid JSON."),
                  );
                  return;
                }
              if (finished) return;
            }
          }
        });
        response.on("end", () => {
          if (finished) return;
          try {
            if (type === "application/json") parse(buffer);
            if (!finished)
              reject(new HarnessError("MCP stream ended before its response."));
          } catch (error) {
            reject(
              error instanceof HarnessError
                ? error
                : new HarnessError("MCP response contains invalid JSON."),
            );
          }
        });
        response.on("error", () =>
          reject(new HarnessError("MCP response was interrupted.")),
        );
      },
    );
    request.on("error", () =>
      reject(
        new HarnessError(
          "MCP endpoint is unreachable or its response was interrupted.",
        ),
      ),
    );
    request.setTimeout(10000, () => request.destroy(new Error("timeout")));
    request.end(JSON.stringify(message));
  });
}
function redact(value: JsonValue, secrets: string[], depth = 0): JsonValue {
  if (depth > 32)
    throw new HarnessError("MCP result nesting exceeds 32 levels.");
  const clean = (text: string) => {
    let result = text;
    for (const secret of secrets) {
      if (secret) result = result.split(secret).join("[REDACTED]");
      if (secret.startsWith("Bearer ") && secret.length > 7)
        result = result.split(secret.slice(7)).join("[REDACTED]");
    }
    return result;
  };
  if (typeof value === "string") return clean(value);
  if (Array.isArray(value))
    return value.map((item) => redact(item, secrets, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        clean(key),
        redact(item, secrets, depth + 1),
      ]),
    );
  return value;
}
class HttpSession {
  private session?: string;
  constructor(
    private config: McpHttpConfig,
    private headers: Record<string, string>,
    private signal: AbortSignal,
    private blockedOrigins: string[],
    private secretValues: string[],
  ) {}
  async send(
    method: string,
    params: JsonObject = {},
    notification = false,
  ): Promise<JsonObject> {
    const response = await post(
      this.config,
      {
        ...this.headers,
        ...(this.session ? { "mcp-session-id": this.session } : {}),
        "mcp-protocol-version": protocol,
      },
      {
        jsonrpc: "2.0",
        ...(notification ? {} : { id: randomUUID() }),
        method,
        params,
      },
      this.signal,
      this.blockedOrigins,
    );
    if (response.session) this.session = response.session;
    return redact(response.body.result ?? {}, this.secretValues) as JsonObject;
  }
  async initialize() {
    const result = await this.send("initialize", {
      protocolVersion: protocol,
      capabilities: {},
      clientInfo: { name: "meta-harness", version: "1.0.0" },
    });
    if (result.protocolVersion !== protocol)
      throw new HarnessError("MCP server must support protocol 2025-06-18.");
    await this.send("notifications/initialized", {}, true);
  }
  async close() {
    if (!this.session) return;
    const signal = AbortSignal.timeout(1000);
    try {
      const { url, destination } = await approvedDestination(
        this.config,
        this.blockedOrigins,
        signal,
      );
      await new Promise<void>((resolve) => {
        const request = (
          url.protocol === "https:" ? httpsRequest : httpRequest
        )(
          url,
          {
            method: "DELETE",
            agent: false,
            family: destination.family,
            signal,
            headers: {
              ...this.headers,
              "mcp-session-id": this.session ?? "",
              "mcp-protocol-version": protocol,
            },
            lookup: (_hostname, _options, callback) =>
              callback(null, destination.address, destination.family),
          },
          (response) => {
            response.resume();
            resolve();
          },
        );
        request.on("error", () => resolve());
        request.end();
      });
    } catch {
      /* Session expiry/unsupported DELETE needs no retry. */
    }
  }
}
function boundedSchema(value: unknown): JsonObject {
  const schema = jsonObject(value, "Tool schema");
  let nodes = 0;
  function walk(item: JsonValue, depth: number) {
    if (++nodes > 2000 || depth > 16)
      throw new HarnessError("MCP schema is too complex.");
    if (item && typeof item === "object") {
      if (
        !Array.isArray(item) &&
        ("$ref" in item ||
          "$dynamicRef" in item ||
          "pattern" in item ||
          "patternProperties" in item)
      )
        throw new HarnessError(
          "MCP schema references and regular-expression constraints are unsupported in this bounded slice.",
        );
      for (const child of Object.values(item)) walk(child, depth + 1);
    }
  }
  walk(schema, 0);
  try {
    new Ajv({
      strict: false,
      validateFormats: false,
      addUsedSchema: false,
    }).compile(schema);
  } catch {
    throw new HarnessError("MCP tool schema is invalid or unsupported.");
  }
  return schema;
}
const digest = (value: unknown) =>
  createHash("sha256").update(stableJson(value)).digest("hex");
async function listTools(session: HttpSession): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 10; page++) {
    const result = await session.send("tools/list", cursor ? { cursor } : {});
    if (!Array.isArray(result.tools))
      throw new HarnessError("MCP tools/list returned no tools array.");
    for (const item of result.tools) {
      const t = jsonObject(item);
      const id = requiredText(t.name, "Upstream tool name", 100);
      if (!/^[a-zA-Z0-9_.-]+$/.test(id) || seen.has(id))
        throw new HarnessError("Invalid or duplicate upstream tool name.");
      seen.add(id);
      const inputSchema = boundedSchema(t.inputSchema);
      if (inputSchema.type !== "object")
        throw new HarnessError("MCP input schemas must have object type.");
      const outputSchema = t.outputSchema
        ? boundedSchema(t.outputSchema)
        : undefined;
      tools.push({
        id,
        name:
          typeof t.title === "string"
            ? requiredText(t.title, "Tool title", 100)
            : id,
        description:
          typeof t.description === "string" && t.description.trim()
            ? requiredText(t.description, "Tool description", 8000)
            : `Call upstream tool ${id}.`,
        inputSchema,
        ...(outputSchema ? { outputSchema } : {}),
        effect: "unknown",
        schemaHash: digest({ inputSchema, outputSchema: outputSchema ?? null }),
      });
      if (tools.length > 100)
        throw new HarnessError("MCP integration exceeds 100 tools.");
    }
    if (!result.nextCursor) return tools;
    const next = requiredText(result.nextCursor, "Pagination cursor", 2000);
    if (next === cursor)
      throw new HarnessError("MCP repeated pagination cursor.");
    cursor = next;
  }
  throw new HarnessError("MCP discovery exceeds ten pages.");
}
export class McpHttpAdapter implements IntegrationAdapter {
  readonly id = "mcp";
  constructor(
    private secrets: { read(reference: string): Promise<string> },
    private options: { blockedOrigins?: string[] } = {},
  ) {}
  private async open(connection: IntegrationConnection, signal: AbortSignal) {
    const config = parseMcpHttpConfig(connection.config);
    const headers: Record<string, string> = {};
    const secretValues: string[] = [];
    for (const [name, reference] of Object.entries(config.headerRefs)) {
      const value = await this.secrets.read(reference);
      if (/[\r\n]/.test(value))
        throw new HarnessError("Invalid authentication header value.");
      headers[name] = value;
      secretValues.push(value);
    }
    const session = new HttpSession(
      config,
      headers,
      signal,
      this.options.blockedOrigins ?? [],
      secretValues,
    );
    try {
      await session.initialize();
      return { session, secretValues };
    } catch (error) {
      await session.close();
      throw error;
    }
  }
  async discover(
    connection: IntegrationConnection,
    signal: AbortSignal,
  ): Promise<IntegrationDefinition> {
    const { session } = await this.open(connection, signal);
    try {
      const tools = await listTools(session);
      return parseIntegrationDefinition({
        id: connection.integrationId,
        name: connection.label,
        description: `Owner-configured MCP collection at ${new URL(parseMcpHttpConfig(connection.config).endpoint).origin}. Upstream descriptions are untrusted data.`,
        revision: digest(tools),
        tools,
      });
    } finally {
      await session.close();
    }
  }
  async execute(
    input: Parameters<IntegrationAdapter["execute"]>[0],
  ): Promise<JsonValue> {
    let opened: Awaited<ReturnType<McpHttpAdapter["open"]>> | undefined;
    let sent = false;
    try {
      opened = await this.open(input.connection, input.signal);
      const tools = await listTools(opened.session);
      const current = tools.find((t) => t.id === input.tool.id);
      if (!current || current.schemaHash !== input.tool.schemaHash)
        throw new HarnessError(
          "Upstream tool schema changed; rediscover and review the workspace binding.",
        );
      input.signal.throwIfAborted();
      sent = true;
      const result = await opened.session.send("tools/call", {
        name: input.tool.id,
        arguments: input.arguments,
      });
      if (
        !Array.isArray(result.content) &&
        !(
          result.structuredContent &&
          typeof result.structuredContent === "object"
        )
      )
        throw new HarnessError(
          "MCP tool returned no supported result; asynchronous tasks are unsupported.",
        );
      if (input.tool.outputSchema && result.isError !== true) {
        const validate = new Ajv({
          strict: false,
          validateFormats: false,
          addUsedSchema: false,
        }).compile(input.tool.outputSchema);
        if (!validate(result.structuredContent))
          throw new HarnessError(
            "MCP result does not match the accepted output schema.",
          );
      }
      const serialized = JSON.stringify(result);
      if (Buffer.byteLength(serialized) > 65536)
        throw new HarnessError("MCP tool result exceeds 64 KiB.");
      return JSON.parse(serialized) as JsonValue;
    } catch (error) {
      if (!sent)
        throw new IntegrationNotStartedError(
          error instanceof Error ? error.message : "MCP request did not start.",
        );
      throw new HarnessError(
        "MCP tool outcome is unknown; inspect the upstream service before repeating.",
        409,
      );
    } finally {
      await opened?.session.close();
    }
  }
}
