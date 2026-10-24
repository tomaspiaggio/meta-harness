import assert from "node:assert/strict";
import { test } from "node:test";
import { createGoogleAdapter } from "./google";
import {
  assertRangeAllowed,
  googleConstraints,
  googleDefinition,
  parseA1,
} from "./google-tools";
import type { HttpFetch } from "./http";

const connection = {
  id: "fixture-work",
  integrationId: "google-workspace",
  adapter: "native" as const,
  label: "Work",
  revision: "v1",
  enabled: true,
  config: { adapterId: "google" },
};
function fixture(respond: (url: URL) => unknown, connections: string[] = []) {
  const calls: URL[] = [];
  const adapter = createGoogleAdapter({
    pageKey: new Uint8Array(32).fill(3),
    now: () => 1_800_000_000_000,
    access: {
      async withAccess(id, scopes, signal, action) {
        connections.push(id);
        assert.ok(scopes[0].startsWith("https://www.googleapis.com/auth/"));
        signal.throwIfAborted();
        return action("fixture-access-token-secret");
      },
    },
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      calls.push(url);
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer fixture-access-token-secret",
      );
      assert.equal(init?.redirect, "error");
      const value = respond(url);
      return value instanceof Response ? value : Response.json(value);
    }) as HttpFetch,
  });
  const call = async (
    id: string,
    args: Record<string, unknown>,
    constraints = {},
    account = connection,
  ) =>
    adapter.execute({
      connection: account,
      tool: googleDefinition.tools.find((tool) => tool.id === id)!,
      arguments: args as never,
      constraints,
      workspaceId: "tech",
      signal: new AbortController().signal,
    });
  return { adapter, calls, call };
}
test("Google definitions expose seven strict bounded readonly tools and finite sheet ranges", () => {
  assert.equal(googleDefinition.tools.length, 7);
  assert.ok(
    googleDefinition.tools.every(
      (tool) =>
        tool.effect === "read" &&
        tool.description.length > 60 &&
        tool.inputSchema.additionalProperties === false,
    ),
  );
  assert.deepEqual(parseA1("'Owner''s tab'!A1:D20"), {
    tab: "Owner's tab",
    firstCol: 1,
    lastCol: 4,
    firstRow: 1,
    lastRow: 20,
  });
  for (const range of [
    "A1:D20",
    "Sheet1!A:A",
    "Sheet1!A1:Z1000",
    "Sheet1!A20:B1",
    "Sheet1!A1:ZZZ1",
  ])
    assert.throws(() => parseA1(range));
  const constraints = googleConstraints({
    sheetRanges: { sheet: ["'Tab'!A1:D20"] },
  });
  assertRangeAllowed("sheet", "Tab!B2:C10", constraints);
  assert.throws(() => assertRangeAllowed("sheet", "Other!B2:C10", constraints));
  assert.throws(() => assertRangeAllowed("sheet", "Tab!B2:E10", constraints));
  assert.throws(() => googleConstraints({ folders: ["unimplemented"] }));
});
test("Gmail pagination tokens are bound to account, query, workspace policy and revision", async () => {
  const { call, calls } = fixture(() => ({
    threads: [{ id: "thread1", snippet: "External snippet" }],
    nextPageToken: "google-opaque-page",
  }));
  const first = (await call(
    "gmail.search",
    { query: "from:alice", limit: 2 },
    { gmailLabelIds: ["INBOX"] },
  )) as { data: { nextPageToken: string } };
  const cursor = first.data.nextPageToken;
  assert.ok(cursor);
  assert.ok(!cursor.includes("google-opaque-page"));
  await call(
    "gmail.search",
    { query: "from:alice", limit: 2, pageToken: cursor },
    { gmailLabelIds: ["INBOX"] },
  );
  assert.equal(calls[1].searchParams.get("pageToken"), "google-opaque-page");
  assert.equal(calls[1].searchParams.get("labelIds"), "INBOX");
  await assert.rejects(
    call(
      "gmail.search",
      { query: "from:bob", limit: 2, pageToken: cursor },
      { gmailLabelIds: ["INBOX"] },
    ),
    /different account/,
  );
  await assert.rejects(
    call(
      "gmail.search",
      { query: "from:alice", limit: 2, pageToken: cursor },
      {},
      { ...connection, id: "fixture-personal" },
    ),
    /different account/,
  );
  await assert.rejects(
    call(
      "gmail.search",
      { query: "from:alice", limit: 2, pageToken: `${cursor}bad` },
      { gmailLabelIds: ["INBOX"] },
    ),
    /different account/,
  );
  await assert.rejects(
    call("gmail.search", { query: "", arbitrary: true }),
    /Invalid Google/,
  );
});
test("Gmail MIME reads plain text only, bounds content and denies mixed-label threads", async () => {
  const body = "External message. ".repeat(5000);
  const { call } = fixture(() => ({
    id: "thread",
    messages: [
      {
        id: "message",
        threadId: "thread",
        labelIds: ["INBOX"],
        payload: {
          mimeType: "multipart/mixed",
          parts: [
            {
              mimeType: "text/plain",
              body: { data: Buffer.from(body).toString("base64url") },
            },
            {
              mimeType: "text/html",
              body: {
                data: Buffer.from("<script>untrusted</script>").toString(
                  "base64url",
                ),
              },
            },
            {
              mimeType: "text/plain",
              filename: "secret.txt",
              body: { attachmentId: "attachment" },
            },
          ],
        },
      },
    ],
  }));
  const result = await call(
    "gmail.read_thread",
    { threadId: "thread" },
    { gmailLabelIds: ["INBOX"] },
  );
  const serialized = JSON.stringify(result);
  assert.ok(serialized.includes('"attachmentsOmitted":true'));
  assert.ok(serialized.includes('"truncated":true'));
  assert.ok(!serialized.includes("<script>"));
  assert.ok(!serialized.includes("fixture-access-token-secret"));
  assert.ok(Buffer.byteLength(serialized) < 65_536);
  await assert.rejects(
    call(
      "gmail.read_thread",
      { threadId: "thread" },
      { gmailLabelIds: ["SENT"] },
    ),
    /outside the workspace/,
  );
});
test("Drive search escapes literals, supports shared drives and filters file grants", async () => {
  const { call, calls } = fixture(() => ({
    files: [
      { id: "allowed", name: "Selected" },
      { id: "denied", name: "Private" },
    ],
    incompleteSearch: true,
    nextPageToken: "page2",
  }));
  const result = await call(
    "drive.search",
    { query: "owner's \\ notes", limit: 10 },
    { fileIds: ["allowed"] },
  );
  assert.ok(!JSON.stringify(result).includes("Private"));
  assert.equal(calls[0].searchParams.get("supportsAllDrives"), "true");
  assert.equal(
    calls[0].searchParams.get("q"),
    "trashed = false and name contains 'owner\\'s \\\\ notes'",
  );
  await assert.rejects(
    call("drive.get_file", { fileId: "denied" }, { fileIds: ["allowed"] }),
    /outside/,
  );
  assert.equal(calls.length, 1);
});
test("Docs reads nested tabs/table text; Sheets preserves requested representations and constraints", async () => {
  const { call, calls } = fixture((url) => {
    if (url.hostname === "docs.googleapis.com")
      return {
        documentId: "doc",
        revisionId: "revision",
        title: "Doc",
        tabs: [
          {
            tabProperties: { tabId: "tab1", title: "Root" },
            documentTab: {
              body: {
                content: [
                  {
                    paragraph: {
                      elements: [{ textRun: { content: "Root text\n" } }],
                    },
                  },
                ],
              },
            },
            childTabs: [
              {
                tabProperties: { tabId: "child", title: "Child" },
                documentTab: {
                  body: {
                    content: [
                      {
                        table: {
                          tableRows: [
                            {
                              tableCells: [
                                {
                                  content: [
                                    {
                                      paragraph: {
                                        elements: [
                                          {
                                            textRun: {
                                              content: "Nested cell\n",
                                            },
                                          },
                                        ],
                                      },
                                    },
                                  ],
                                },
                              ],
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
        ],
      };
    return {
      range: "'Tab'!A1:C2",
      majorDimension: "ROWS",
      values: [
        ["=SUM(A2:B2)", 42, true],
        ["formatted", 1.2, false],
      ],
    };
  });
  const docs = await call("docs.read", { documentId: "doc" });
  assert.ok(JSON.stringify(docs).includes("Nested cell"));
  assert.equal(calls[0].searchParams.get("includeTabsContent"), "true");
  for (const [representation, googleValue] of [
    ["formatted", "FORMATTED_VALUE"],
    ["raw", "UNFORMATTED_VALUE"],
    ["formula", "FORMULA"],
  ]) {
    const result = await call(
      "sheets.read_range",
      { spreadsheetId: "sheet", range: "'Tab'!A1:C2", representation },
      { sheetRanges: { sheet: ["Tab!A1:D10"] } },
    );
    assert.ok(JSON.stringify(result).includes('"untrustedContent":true'));
    assert.equal(
      calls.at(-1)?.searchParams.get("valueRenderOption"),
      googleValue,
    );
  }
  await assert.rejects(
    call(
      "sheets.read_range",
      { spreadsheetId: "sheet", range: "Other!A1:B2" },
      { sheetRanges: { sheet: ["Tab!A1:D10"] } },
    ),
    /outside/,
  );
});
test("Google HTTP failures are sanitized and quota errors do not blindly retry", async () => {
  const { call, calls } = fixture(
    () =>
      new Response(
        '{"error":"fixture-access-token-secret private user content"}',
        { status: 429 },
      ),
  );
  await assert.rejects(
    call("gmail.search", { query: "test" }),
    (error: Error) =>
      error.message.includes("rate limit") && !error.message.includes("secret"),
  );
  assert.equal(calls.length, 1);
  const big = fixture(() => new Response("x".repeat(1_048_577)));
  await assert.rejects(
    big.call("gmail.search", { query: "test" }),
    /read limit/,
  );
});
