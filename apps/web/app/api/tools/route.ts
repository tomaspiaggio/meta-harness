import {
  decisionSource,
  listWorkspacesWithSessions,
  readSession,
  searchHistory,
} from "../../../server/history";
import "../../../server/integration-adapters";
export const maxDuration = 60;

import { createHash } from "node:crypto";
import { HarnessError, requiredText } from "@harness/core";
import { verifyAttemptGrant } from "../../../server/grants";
import { failure, readJson } from "../../../server/http";
import {
  callIntegrationTool,
  integrationToolDescriptors,
} from "../../../server/integrations";
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
      "Read current shared decisions before answering or acting; latest revisions supersede old conversation claims. Each decision names its source session/turn; use decision_source for the full conversation behind it.",
    inputSchema: { ...object, properties: {} },
  },
  {
    name: "decision_source",
    description:
      "Read the conversation that produced a shared decision (any workspace): the decision, its revision history, and the turns around the one that wrote it. Use when a decision lacks the rationale or detail you need.",
    inputSchema: {
      type: "object",
      properties: {
        key: text,
        revision: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: 12 },
      },
      required: ["key"],
    },
  },
  {
    name: "session_read",
    description:
      "Read another (or this) conversation of the owner, in any workspace, a page of turns at a time. Pass around_turn_id to center on a turn, or before (from olderPage) to page back.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: text,
        around_turn_id: text,
        before: { type: "number" },
        limit: { type: "integer", minimum: 1, maximum: 12 },
      },
      required: ["session_id"],
    },
  },
  {
    name: "history_search",
    description:
      "Search the owner's past conversations across all workspaces for words or a phrase. Returns session IDs, turn IDs and excerpts to open with session_read.",
    inputSchema: {
      type: "object",
      properties: {
        query: text,
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
    },
  },
  {
    name: "workspace_list",
    description:
      "List the owner's workspaces and their recent sessions (IDs and titles).",
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
      'Drive the workspace browser like a person: look at the returned screenshot, then click/type/scroll with real mouse and keyboard input. The screenshot is the 1280x800 viewport and its pixels are click coordinates. Say WHERE to act with ONE of: description (plain language, e.g. "the white text area inside the message box, left of Send"; resolved visually on hosts with grounding enabled), x and y read from the latest screenshot, ref from the snapshot action (e.g. e12), or selector (CSS, last resort). Actions: navigate(url); screenshot; snapshot (accessibility tree with refs); read(optional selector: text + refs); click(target, button?, double?); type(target?, text, overwrite?, submit?) types into the target or the focused field with real keystrokes (fill = type with overwrite); press(key, e.g. Enter, Tab, Escape, ArrowDown, ControlOrMeta+A); hover(target); scroll(direction up|down, amount 1-10, optional target); select(target, value) for dropdowns (clicking a dropdown returns its options instead of opening an invisible native popup); wait(seconds<=10); sheet_read(gid,start_row,max_rows,max_columns) for Google Sheets cell values (an opened editor is not proof its cells were read); status; needs_login. Native alerts are acknowledged and confirm/prompt dialogs cancelled automatically, reported in dialogs; passkey prompts are suppressed so sites offer another sign-in method. Each action returns the new screenshot: verify the effect before continuing; if a click missed, adjust coordinates or use a ref. Logins are per browser host; never ask for or type passwords. If an account is signed out, navigate to the page you need, call needs_login, and finish the turn so the owner signs in privately. click, type, fill, press and select need a random operation_id; reuse it only to retry the same logical step. Ambiguous results must be reconciled, not repeated. While the owner controls the browser, stop and finish your turn.',
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
            "snapshot",
            "click",
            "type",
            "fill",
            "press",
            "hover",
            "scroll",
            "select",
            "wait",
            "read",
            "sheet_read",
            "needs_login",
          ],
        },
        url: text,
        description: text,
        x: { type: "number", minimum: 0, maximum: 1279 },
        y: { type: "number", minimum: 0, maximum: 799 },
        ref: text,
        selector: text,
        key: text,
        value: text,
        overwrite: { type: "boolean" },
        submit: { type: "boolean" },
        double: { type: "boolean" },
        button: { type: "string", enum: ["left", "right"] },
        direction: { type: "string", enum: ["up", "down"] },
        amount: { type: "integer", minimum: 1, maximum: 10 },
        seconds: { type: "number", minimum: 0, maximum: 10 },
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
    if (message.method === "tools/list") {
      const turn = await store.getTurn(grant.turnId);
      const session = await store.getSession(turn.sessionId);
      return reply({
        tools: [
          ...tools,
          ...(await integrationToolDescriptors(store, session.workspaceId)),
        ],
      });
    }
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
      else if (parameters?.name === "decision_source")
        result = await decisionSource(store, args);
      else if (parameters?.name === "session_read")
        result = await readSession(store, args);
      else if (parameters?.name === "history_search")
        result = await searchHistory(store, args);
      else if (parameters?.name === "workspace_list")
        result = await listWorkspacesWithSessions(store);
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
      } else if (parameters?.name?.startsWith("integration_"))
        result = await callIntegrationTool(
          store,
          grant,
          session.workspaceId,
          parameters.name,
          args,
          request.signal,
        );
      else throw new HarnessError("Unknown tool.", 404);
      const external =
        parameters?.name?.startsWith("integration_") &&
        result &&
        typeof result === "object" &&
        "result" in result
          ? (result as { result: unknown }).result
          : undefined;
      const output =
        external && typeof external === "object"
          ? (external as Record<string, unknown>)
          : undefined;
      return reply({
        content: [{ type: "text", text: JSON.stringify(result) }],
        ...(output?.structuredContent &&
        typeof output.structuredContent === "object"
          ? { structuredContent: output.structuredContent }
          : {}),
        ...(output?.isError === true ? { isError: true } : {}),
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
