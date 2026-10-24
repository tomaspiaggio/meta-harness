import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import {
  type IntegrationConnection,
  IntegrationNotStartedError,
} from "@harness/core/integrations";
import {
  approvedDestination,
  McpHttpAdapter,
  parseMcpHttpConfig,
} from "./index";

interface Fixture {
  endpoint: string;
  server: Server;
  calls: number;
  closed: number;
  schemaVersion: number;
  mode: string;
  seenHeaders: string[];
}
async function fixture(run: (fixture: Fixture) => Promise<void>) {
  const state: Fixture = {
    endpoint: "",
    server: createServer(),
    calls: 0,
    closed: 0,
    schemaVersion: 1,
    mode: "normal",
    seenHeaders: [],
  };
  state.server.on("request", async (req, res) => {
    state.seenHeaders.push(req.headers.authorization ?? "");
    if (req.method === "DELETE") {
      state.closed++;
      res.writeHead(200).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const message = JSON.parse(body);
    if (state.mode === "malformed") {
      res.setHeader("content-type", "application/json");
      res.end("Bearer fixture-secret invalid JSON");
      return;
    }
    if (state.mode === "redirect") {
      res.writeHead(302, { location: "http://127.0.0.1:3000/api/tools" }).end();
      return;
    }
    const send = (result: unknown) => {
      res.setHeader(
        "content-type",
        state.mode === "sse" ? "text/event-stream" : "application/json",
      );
      const response = JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result,
      });
      if (state.mode === "sse")
        res.end(
          `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { data: "untrusted" } })}\n\ndata: ${response}\n\n`,
        );
      else res.end(response);
    };
    if (message.method === "initialize") {
      res.setHeader("mcp-session-id", "fixture-session");
      send({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      });
      return;
    }
    assert.equal(req.headers["mcp-session-id"], "fixture-session");
    assert.equal(req.headers["mcp-protocol-version"], "2025-06-18");
    if (message.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    if (message.method === "tools/list") {
      if (state.mode === "oversized") {
        res.setHeader("content-type", "application/json");
        res.end("x".repeat(262145));
        return;
      }
      if (state.mode === "pagination" && !message.params.cursor) {
        send({ tools: [], nextCursor: "next" });
        return;
      }
      if (state.mode === "loop") {
        send({ tools: [], nextCursor: "same" });
        return;
      }
      const inputSchema =
        state.mode === "reference"
          ? {
              type: "object",
              properties: {
                query: { $ref: "https://untrusted.invalid/schema" },
              },
            }
          : {
              type: "object",
              properties: {
                query: {
                  type: state.schemaVersion === 1 ? "string" : "number",
                },
              },
              required: ["query"],
              additionalProperties: false,
            };
      send({
        tools: [
          {
            name: "search",
            description: "Search fixture records. Bearer fixture-secret",
            inputSchema,
            ...(state.mode === "output" || state.mode === "bad-output"
              ? {
                  outputSchema: {
                    type: "object",
                    properties: { ok: { type: "boolean" } },
                    required: ["ok"],
                    additionalProperties: false,
                  },
                }
              : {}),
            annotations: { readOnlyHint: true },
          },
        ],
      });
      return;
    }
    if (message.method === "tools/call") {
      state.calls++;
      if (state.mode === "disconnect") {
        req.socket.destroy();
        return;
      }
      if (state.mode === "hang") return;
      send({
        content: [
          {
            type: "text",
            text: `Result ${JSON.stringify(message.params.arguments)} secret fixture-secret / Bearer fixture-secret`,
          },
        ],
        ...(state.mode === "output"
          ? { structuredContent: { ok: true } }
          : state.mode === "bad-output"
            ? { structuredContent: { ok: "wrong" } }
            : {}),
        isError: false,
      });
      return;
    }
    res.writeHead(400).end();
  });
  await new Promise<void>((resolve) =>
    state.server.listen(0, "127.0.0.1", resolve),
  );
  const address = state.server.address();
  assert.ok(address && typeof address !== "string");
  state.endpoint = `http://127.0.0.1:${address.port}/mcp`;
  try {
    await run(state);
  } finally {
    state.server.closeAllConnections();
    await new Promise<void>((resolve) => state.server.close(() => resolve()));
  }
}
const connection = (endpoint: string): IntegrationConnection => ({
  id: "fixture",
  integrationId: "mcp-fixture",
  adapter: "mcp",
  label: "Fixture collection",
  revision: "r1",
  enabled: true,
  config: {
    endpoint,
    allowPrivate: true,
    headerRefs: { authorization: "fixture" },
  },
});
const secretReader = {
  async read() {
    return "Bearer fixture-secret";
  },
};
test("HTTP and SSE discovery preserve schemas, distrust annotations, redact secrets, paginate and close cold sessions", () =>
  fixture(async (f) => {
    const adapter = new McpHttpAdapter(secretReader);
    const c = connection(f.endpoint);
    for (const mode of ["normal", "sse", "pagination"]) {
      f.mode = mode;
      const definition = await adapter.discover(c, AbortSignal.timeout(3000));
      assert.equal(definition.tools.length, 1);
      const tool = definition.tools[0];
      assert.ok(tool);
      assert.equal(tool.effect, "unknown");
      assert.doesNotMatch(JSON.stringify(definition), /fixture-secret/);
      assert.equal(tool.inputSchema.type, "object");
      const result = await adapter.execute({
        connection: c,
        tool,
        arguments: { query: "test" },
        constraints: {},
        workspaceId: "tech",
        signal: AbortSignal.timeout(3000),
      });
      assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
    }
    assert.equal(f.calls, 3);
    assert.equal(f.closed, 6);
    assert.ok(f.seenHeaders.every((h) => h === "Bearer fixture-secret"));
  }));
test("schema revisions reject before action and interrupted dispatched calls remain unknown", () =>
  fixture(async (f) => {
    const adapter = new McpHttpAdapter(secretReader);
    const c = connection(f.endpoint);
    const d = await adapter.discover(c, AbortSignal.timeout(3000));
    const tool = d.tools[0];
    assert.ok(tool);
    f.schemaVersion = 2;
    await assert.rejects(
      adapter.execute({
        connection: c,
        tool,
        arguments: { query: "old" },
        constraints: {},
        workspaceId: "tech",
        signal: AbortSignal.timeout(3000),
      }),
      IntegrationNotStartedError,
    );
    assert.equal(f.calls, 0);
    f.schemaVersion = 1;
    f.mode = "disconnect";
    await assert.rejects(
      adapter.execute({
        connection: c,
        tool,
        arguments: { query: "old" },
        constraints: {},
        workspaceId: "tech",
        signal: AbortSignal.timeout(3000),
      }),
      /unknown/,
    );
    assert.equal(f.calls, 1);
  }));
test("discovery bounds schemas, content and pagination; redirects do not forward credentials", () =>
  fixture(async (f) => {
    const adapter = new McpHttpAdapter(secretReader);
    for (const mode of [
      "reference",
      "oversized",
      "loop",
      "redirect",
      "malformed",
    ]) {
      f.mode = mode;
      await assert.rejects(
        adapter.discover(connection(f.endpoint), AbortSignal.timeout(3000)),
      );
    }
    assert.equal(f.calls, 0);
  }));
test("network and header policy block metadata, control endpoints and implicit private access", async () => {
  for (const endpoint of [
    "http://127.0.0.1:3000/mcp",
    "https://169.254.169.254/mcp",
    "https://[::ffff:169.254.169.254]/mcp",
    "https://100.100.100.200/mcp",
  ]) {
    await assert.rejects(
      approvedDestination(parseMcpHttpConfig({ endpoint, allowPrivate: true })),
    );
  }
  await assert.rejects(
    approvedDestination(
      parseMcpHttpConfig({ endpoint: "https://127.0.0.1:3433/mcp" }),
    ),
  );
  await assert.rejects(
    approvedDestination(
      parseMcpHttpConfig({ endpoint: "https://example.com/mcp" }),
      ["https://example.com"],
    ),
  );
  for (const config of [
    { endpoint: "http://example.com/mcp" },
    { endpoint: "https://user:secret@example.com/mcp" },
    { endpoint: "https://example.com/mcp?token=secret" },
    { endpoint: "https://example.com/mcp", headerRefs: { host: "fixture" } },
  ])
    assert.throws(() => parseMcpHttpConfig(config));
});
test("cancellation closes owned transport and never implicitly retries the call", () =>
  fixture(async (f) => {
    const adapter = new McpHttpAdapter(secretReader),
      c = connection(f.endpoint);
    const d = await adapter.discover(c, AbortSignal.timeout(3000));
    const tool = d.tools[0];
    assert.ok(tool);
    f.mode = "hang";
    await assert.rejects(
      adapter.execute({
        connection: c,
        tool,
        arguments: { query: "hang" },
        constraints: {},
        workspaceId: "tech",
        signal: AbortSignal.timeout(100),
      }),
      /unknown/,
    );
    assert.equal(f.calls, 1);
    assert.equal(f.closed, 2);
  }));

test("output schemas validate structured results before receipt projection", () =>
  fixture(async (f) => {
    const adapter = new McpHttpAdapter(secretReader),
      c = connection(f.endpoint);
    f.mode = "output";
    const definition = await adapter.discover(c, AbortSignal.timeout(3000));
    const tool = definition.tools[0];
    assert.ok(tool?.outputSchema);
    const result = await adapter.execute({
      connection: c,
      tool,
      arguments: { query: "test" },
      constraints: {},
      workspaceId: "tech",
      signal: AbortSignal.timeout(3000),
    });
    assert.match(JSON.stringify(result), /structuredContent/);
    f.mode = "bad-output";
    await assert.rejects(
      adapter.execute({
        connection: c,
        tool,
        arguments: { query: "test" },
        constraints: {},
        workspaceId: "tech",
        signal: AbortSignal.timeout(3000),
      }),
      /unknown/,
    );
  }));

test("redaction preserves JSON types when a credential token resembles JSON syntax", () =>
  fixture(async (f) => {
    const adapter = new McpHttpAdapter({
        async read() {
          return "Bearer true";
        },
      }),
      c = connection(f.endpoint);
    const definition = await adapter.discover(c, AbortSignal.timeout(3000));
    const tool = definition.tools[0];
    assert.ok(tool);
    const result = await adapter.execute({
      connection: c,
      tool,
      arguments: { query: "true" },
      constraints: {},
      workspaceId: "tech",
      signal: AbortSignal.timeout(3000),
    });
    assert.match(JSON.stringify(result), /REDACTED/);
  }));
