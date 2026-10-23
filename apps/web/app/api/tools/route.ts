export const maxDuration = 60;

import { createHash } from "node:crypto";
import { HarnessError, requiredText } from "@harness/core";
import { verifyAttemptGrant } from "../../../server/grants";
import { failure, readJson } from "../../../server/http";
import { sameOrigin } from "../../../server/security";
import { getStore } from "../../../server/store";

const object = { type: "object", additionalProperties: false };
const text = { type: "string" };
const tools = [
  {
    name: "session_title",
    description:
      "Suggest a useful 2–5 word title (at most 45 characters) for this conversation. Do this near the start of new work when the current title just repeats the user's message. Manual titles are protected. This affects only this session's title.",
    inputSchema: {
      ...object,
      properties: { title: text },
      required: ["title"],
    },
  },
  {
    name: "operation_list",
    description:
      "Read this session’s unfinished external operations. Reconcile unknown outcomes against the current browser; never repeat a mutation with a fresh ID to bypass its ledger.",
    inputSchema: { ...object, properties: {} },
  },
  {
    name: "memory_get",
    description:
      "Read current shared decisions before answering or acting; latest revisions supersede old conversation claims.",
    inputSchema: { ...object, properties: {} },
  },
  {
    name: "schedule_propose",
    description:
      "Propose an inactive one-time or recurring schedule. Always store the exact future prompt. The user must review and activate it; never claim it is active. Defaults to this persistent session. kind=reminder posts text without an agent. Cron requires five fields and an IANA timezone.",
    inputSchema: {
      type: "object",
      properties: {
        id: text,
        revision: { type: "integer" },
        name: text,
        prompt: text,
        kind: { type: "string", enum: ["agent", "reminder"] },
        trigger: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["once", "cron"] },
            at: {
              type: "number",
              description: "Absolute Unix milliseconds for a one-time trigger",
            },
            expression: text,
            timezone: text,
          },
          required: ["type"],
        },
        maxLatenessMs: { type: "number" },
      },
      required: ["name", "prompt", "kind", "trigger"],
    },
  },
  {
    name: "schedule_list",
    description:
      "List this session's durable schedules and their activation state.",
    inputSchema: { ...object, properties: {} },
  },
  {
    name: "schedule_manage",
    description:
      "Pause or delete a schedule in this session. Changing a prompt or resuming requires a new schedule_propose review draft with its current revision; activation always requires the owner UI.",
    inputSchema: {
      ...object,
      properties: {
        id: text,
        revision: { type: "integer" },
        action: { type: "string", enum: ["pause", "delete"] },
      },
      required: ["id", "revision", "action"],
    },
  },
  {
    name: "request_input",
    description:
      "Persist a question requiring the user. Then end the turn; do not keep an agent process waiting. The answer will continue the same session.",
    inputSchema: {
      ...object,
      properties: { question: text },
      required: ["question"],
    },
  },
  {
    name: "browser_action",
    description:
      "Use the available workspace browser host; it may run on the Pi or another eligible machine and does not require the Mac. Each host has its own login state. If the required account is signed out, navigate to its login page, call needs_login and finish the turn so the owner can sign in through interactive takeover. Never require a Mac login or copy credentials between hosts. Actions: status, navigate(url), screenshot, click(selector), fill(selector,text), read(optional selector; includes accessibility), sheet_read(gid,start_row,max_rows,max_columns), needs_login. For Google Sheets CRM, navigate to the sheet then use sheet_read to get actual bounded cell rows through the signed-in HTML view. Do not report CRM contents as read merely because the editor opened. Provide a random operation_id for each new logical navigation or mutation; reuse that same ID across retries and later turns of this conversation. Read, sheet_read and screenshot need no ID. Ambiguous results must be reconciled, not repeated. A confirmed connection failure before execution can be retried with the same operation_id after Chrome is connected; the harness retains separate attempt history. While the user controls the browser, stop interacting and finish your turn. Never request or capture credentials in chat.",
    inputSchema: {
      type: "object",
      properties: {
        operation_id: text,
        action: {
          type: "string",
          enum: [
            "status",
            "navigate",
            "screenshot",
            "click",
            "fill",
            "read",
            "sheet_read",
            "needs_login",
          ],
        },
        url: text,
        selector: text,
        gid: text,
        start_row: { type: "integer", minimum: 1, maximum: 100000 },
        max_rows: { type: "integer", minimum: 1, maximum: 50 },
        max_columns: { type: "integer", minimum: 1, maximum: 26 },
        text,
      },
      required: ["action"],
    },
  },
];

/** Stateless Streamable HTTP MCP. Its bearer identity is one fenced attempt. */
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const grant = verifyAttemptGrant(
      request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
    );
    const store = await getStore();
    await store.assertAssignment(
      grant.workerId,
      grant.turnId,
      grant.generation,
    );
    const message = await readJson(request, 65536);
    const id = message.id;
    const reply = (result: unknown) =>
      Response.json(
        { jsonrpc: "2.0", id, result },
        { headers: { "Cache-Control": "no-store" } },
      );
    if (message.method === "initialize")
      return reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "meta-harness", version: "1.0.0" },
      });
    if (
      message.method === "notifications/initialized" ||
      message.method === "notifications/cancelled"
    )
      return new Response(null, { status: 202 });
    if (message.method === "ping") return reply({});
    if (message.method === "tools/list") return reply({ tools });
    if (message.method !== "tools/call")
      return Response.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" },
      });
    const parameters = message.params as
      | { name?: string; arguments?: Record<string, unknown> }
      | undefined;
    const args = parameters?.arguments ?? {};
    const turn = await store.getTurn(grant.turnId);
    const session = await store.getSession(turn.sessionId);
    let result: unknown;
    try {
      if (parameters?.name === "session_title") {
        await store.generatedTitle(
          session.id,
          requiredText(args.title, "Title", 45),
          true,
        );
        result = { title: (await store.getSession(session.id)).title };
      } else if (parameters?.name === "operation_list")
        result = await store.unfinishedOperations(session.id);
      else if (parameters?.name === "memory_get")
        result = await store.getSharedDecisions();
      else if (parameters?.name === "schedule_list")
        result = await store.listSchedules(session.id);
      else if (parameters?.name === "schedule_propose") {
        const scheduleId =
          typeof args.id === "string"
            ? requiredText(args.id, "Schedule ID", 100)
            : `proposal-${createHash("sha256")
                .update(`${grant.turnId}:${String(id)}`)
                .digest("hex")
                .slice(0, 32)}`;
        if (args.id) {
          const old = await store.getSchedule(scheduleId);
          if (old.sessionId !== session.id)
            throw new HarnessError("Schedule is outside this session.", 403);
        }
        result = await store.draftSchedule(
          scheduleId,
          { ...args, sessionId: session.id },
          typeof args.revision === "number" ? args.revision : undefined,
        );
      } else if (parameters?.name === "schedule_manage") {
        const schedule = await store.getSchedule(
          requiredText(args.id, "Schedule ID", 100),
        );
        if (schedule.sessionId !== session.id)
          throw new HarnessError("Schedule is outside this session.", 403);
        if (
          typeof args.revision !== "number" ||
          !Number.isSafeInteger(args.revision) ||
          (args.action !== "pause" && args.action !== "delete")
        )
          throw new HarnessError("Invalid schedule action or revision.");
        result = await store.changeSchedule(
          schedule.id,
          args.revision,
          args.action,
        );
      } else if (parameters?.name === "request_input") {
        result = await store.requestInput(
          `input-${createHash("sha256")
            .update(`${grant.turnId}:${String(id)}`)
            .digest("hex")
            .slice(0, 32)}`,
          session.id,
          turn.id,
          "question",
          requiredText(args.question, "Question", 4000),
        );
      } else if (parameters?.name === "browser_action") {
        const { browserTool } = await import("../../../server/browser");
        const browser = await browserTool(grant, args);
        if (browser.image)
          return reply({
            content: [
              { type: "text", text: JSON.stringify(browser.result) },
              { type: "image", data: browser.image, mimeType: "image/jpeg" },
            ],
          });
        result = browser.result;
      } else throw new HarnessError("Unknown tool.", 404);
      return reply({
        content: [{ type: "text", text: JSON.stringify(result) }],
      });
    } catch (error) {
      return reply({
        isError: true,
        content: [
          {
            type: "text",
            text:
              error instanceof HarnessError
                ? error.message
                : "The tool could not complete. Inspect its durable status before repeating a mutation.",
          },
        ],
      });
    }
  } catch (error) {
    return failure(error);
  }
}
