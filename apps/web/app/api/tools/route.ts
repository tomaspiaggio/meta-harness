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
import { BRIEFS_WORKSPACE, parseBrief, parseDay } from "@harness/core/briefs";
import { filterDecisions } from "@harness/core/knowledge";
import {
  controlUpdateStatus,
  startControlUpdate,
} from "../../../server/control-update";
import { REPORT_RULES } from "../../../server/delegation";
import { flushDispatch } from "../../../server/dispatcher";
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
      "Read the full text of shared decisions. The turn instructions list only an index; pass keys from it, or a query (all words must appear in the key or content), or neither for every record. Latest revisions supersede old conversation claims. Each decision names its source session/turn; use decision_source for the full conversation behind it.",
    inputSchema: {
      type: "object",
      properties: {
        keys: { type: "array", items: text, maxItems: 50 },
        query: text,
      },
    },
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
    name: "session_send",
    description:
      "Hand work to another of the owner's sessions (find IDs with workspace_list, or create one with new_worker), or answer, give feedback or the next step on a task you already gave (pass task_id). The message is queued in that session and its agent works on it like an owner message, with its own agent, model, files and tools. When its turn ends, its report arrives here as a new message and you continue: review it against what you asked, then send feedback, answer its question, give the next step, or close it with task_close. Write self-contained instructions: the other session has not seen this conversation. Returns immediately; do not wait for the result.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { ...text, description: "Target session, for a new task" },
        new_worker: {
          type: "object",
          description:
            "Instead of session_id: create a worker session in this workspace for a new task",
          properties: {
            title: { ...text, description: "Short session name, 2-5 words" },
            agent: { type: "string", enum: ["claude", "codex"] },
          },
          required: ["title"],
        },
        title: {
          ...text,
          description:
            'For a new task: a short name the owner sees in task lists, 3-8 words, e.g. "A3 board power options"',
        },
        task_id: {
          ...text,
          description: "An open task you gave, for feedback or answers",
        },
        message: text,
      },
      required: ["message"],
    },
  },
  {
    name: "notify_owner",
    description:
      "Notify the owner on their phone when this turn ends, with a one-line message. Reports from workers and the turns that handle them do not notify the owner on their own; use this when the owner should know now: the overall goal is done, something failed that blocks the plan, or you made an important decision on their behalf. For a question only the owner can answer, use request_input instead. Do not use it for routine progress.",
    inputSchema: {
      ...object,
      properties: { message: text },
      required: ["message"],
    },
  },
  {
    name: "brief_publish",
    description:
      "Publish (or replace) one workspace's daily brief: a headline, 3–5 highlights and the full HTML brief. Only the Daily briefs session can publish.",
    inputSchema: {
      ...object,
      properties: {
        day: { type: "string", description: "YYYY-MM-DD" },
        workspace_id: text,
        title: text,
        highlights: { type: "array", items: text, minItems: 1, maxItems: 6 },
        html: text,
        sources: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: { session_id: text, decision_key: text },
          },
        },
      },
      required: ["day", "workspace_id", "title", "highlights", "html"],
    },
  },
  {
    name: "brief_list",
    description:
      "List the daily briefs written so far (newest first): day, workspace, headline and highlights. Filter by workspace_id or day; with neither, returns each workspace's latest. Useful for continuity and for summaries such as an investor update.",
    inputSchema: {
      ...object,
      properties: {
        workspace_id: text,
        day: { type: "string", description: "YYYY-MM-DD" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
  },
  {
    name: "brief_get",
    description: "Read one daily brief in full, including its HTML.",
    inputSchema: {
      ...object,
      properties: { id: text },
      required: ["id"],
    },
  },
  {
    name: "session_note",
    description:
      "Send a note to another of the owner's sessions to coordinate, for example to agree an interface, ask what it changed or tell it a branch is ready. It arrives there as a message and its agent may reply with session_note; the planning session is not woken. Use it instead of asking the planner to relay. Do not use it to hand out work (that is session_send, for planning sessions) or to acknowledge; write one self-contained note with what you need and by when. If you are waiting for the reply to continue a task, say so in task_report and end your turn: the reply arrives as a new message here.",
    inputSchema: {
      ...object,
      properties: { session_id: text, message: text },
      required: ["session_id", "message"],
    },
  },
  {
    name: "continue_on",
    description:
      "Continue this conversation in a new step that runs only on machines with these labels (an empty list: any machine), for example to verify on the machine with the chip tools after coding elsewhere, or to go back to any machine afterwards. Check machines_list first. Only move at a natural break: files, clones and uncommitted work stay on this machine, so commit and push what the next step needs before calling this. If the next step runs on another machine, its agent starts fresh with the conversation so far instead of your memory. Write the message as a self-contained note to yourself (what to do next, which branch or commit, how to check it) and give the owner a one-sentence reason. Then end your turn; the step is queued and does not wait for you. On a task from another session, call task_report done only in the last step.",
    inputSchema: {
      ...object,
      properties: {
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Labels the next machine must have; [] for any",
        },
        message: text,
        reason: text,
      },
      required: ["labels", "message", "reason"],
    },
  },
  {
    name: "machine_update",
    description:
      "Update one of the owner's machines to a commit on main (default: the commit control runs). The machine stops taking new work, prepares the release while its running turns finish (including yours if you run there), restarts into it, and goes back to its previous release by itself if the new one fails to start or reach control within 5 minutes. Only one machine updates at a time, and control refuses when no other machine could run agents meanwhile. Follow progress with machines_list; cancel: true stops an update that hasn't restarted yet. If you are on that machine, end your turn after calling this and continue_on another machine to check the result.",
    inputSchema: {
      ...object,
      properties: {
        machine: { type: "string", description: "Machine name or ID" },
        commit: {
          type: "string",
          description: "Commit on main, 7 to 40 hex digits; default control's",
        },
        cancel: { type: "boolean" },
      },
      required: ["machine"],
    },
  },
  {
    name: "control_update",
    description:
      "Update the control server itself to a commit on main. It runs outside the server: fetches and checks the commit, pauses the control host's worker while another machine can run agents and waits for its turns, builds the release at low priority, backs up the database, restarts the server and checks it comes back on the new commit; if it doesn't within 3 minutes it restores the previous release by itself. Takes about 5-10 minutes; running turns elsewhere survive the short restart. Call with status: true to read progress (also in machines_list as control).",
    inputSchema: {
      ...object,
      properties: {
        commit: {
          type: "string",
          description: "Commit on main, 7 to 40 hex digits",
        },
        status: { type: "boolean" },
      },
    },
  },
  {
    name: "machines_list",
    description:
      "The owner's machines with their host names, labels (agents, browser, tools such as asap7), whether each is online and whether it is paused, plus the labels this session and this step require. A paused machine is being updated and takes new work again shortly; it is not offline. Use it to decide where work can run and to explain waits.",
    inputSchema: { ...object, properties: {} },
  },
  {
    name: "task_report",
    description: `Report on the task this turn is working on (only for turns that work on a task from another session). status: progress (a checkpoint; you keep working), done, question (you need an answer from the session that gave the task; end your turn after this), or blocked. Only the last done/question/blocked report of a turn is sent, when the turn ends. ${REPORT_RULES}`,
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["progress", "done", "question", "blocked"],
        },
        summary: text,
      },
      required: ["status", "summary"],
    },
  },
  {
    name: "task_list",
    description:
      "Tasks this session gave to other sessions or received, with where each stands (queued, working, waiting-on-owner, done, question, blocked, accepted, cancelled), the latest progress note and report.",
    inputSchema: { ...object, properties: {} },
  },
  {
    name: "task_close",
    description:
      "Close a task you gave once its result is accepted (or cancel one that is no longer needed). Closed tasks stop reporting here.",
    inputSchema: {
      ...object,
      properties: {
        task_id: text,
        outcome: { type: "string", enum: ["accepted", "cancelled"] },
        note: text,
      },
      required: ["task_id", "outcome"],
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
      'Drive the workspace browser like a person: look at the returned screenshot, then click/type/scroll with real mouse and keyboard input. The screenshot is the 1280x800 viewport and its pixels are click coordinates. Say WHERE to act with ONE of: description (plain language, e.g. "the white text area inside the message box, left of Send"; resolved visually on hosts with grounding enabled), x and y read from the latest screenshot, ref from the snapshot action (e.g. e12), or selector (CSS, last resort). Actions: navigate(url); screenshot; snapshot (accessibility tree with refs); read(optional selector: text + refs); click(target, button?, double?); type(target?, text, overwrite?, submit?) types into the target or the focused field with real keystrokes (fill = type with overwrite); press(key, e.g. Enter, Tab, Escape, ArrowDown, ControlOrMeta+A); hover(target); scroll(direction up|down, amount 1-10, optional target); select(target, value) for dropdowns (clicking a dropdown returns its options instead of opening an invisible native popup); wait(seconds<=10); sheet_read(gid,start_row,max_rows,max_columns) for Google Sheets cell values (an opened editor is not proof its cells were read); status; needs_login. Native alerts are acknowledged and confirm/prompt dialogs cancelled automatically, reported in dialogs; passkey prompts are suppressed so sites offer another sign-in method. Each action returns the new screenshot: verify the effect before continuing; if a click missed, adjust coordinates or use a ref. Logins are per browser host; never ask for or type passwords. If an account is signed out, navigate to the page you need, fill in what you already know (for example the account email from the conversation), then call needs_login and finish the turn; the owner is shown only the fields the page still asks for and signs in privately. click, type, fill, press and select need a random operation_id; reuse it only to retry the same logical step. Ambiguous results must be reconciled, not repeated. The owner shares this browser and may use it while you wait; if the page changed unexpectedly, re-check it before acting.',
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
    // Room for a daily brief's HTML (MAX_BRIEF_HTML) after JSON escaping.
    const message = await readJson(request, 524288);
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
          ...tools.filter(
            (tool) =>
              tool.name !== "brief_publish" ||
              session.workspaceId === BRIEFS_WORKSPACE,
          ),
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
        result = filterDecisions(await store.getSharedDecisions(), args);
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
      } else if (parameters?.name === "session_send") {
        const taskTurnId = `task:${createHash("sha256")
          .update(`${grant.turnId}:${String(id)}`)
          .digest("hex")
          .slice(0, 32)}`;
        let toSessionId =
          typeof args.session_id === "string" ? args.session_id : "";
        const worker = args.new_worker as
          | { title?: unknown; agent?: unknown }
          | undefined;
        if (worker && !args.task_id) {
          // A retried call reuses the session its first attempt created.
          const sent = await store.getTurn(taskTurnId).catch(() => null);
          toSessionId =
            sent?.sessionId ??
            (
              await store.createSession(
                session.workspaceId,
                requiredText(worker.title, "Worker title", 60),
                worker.agent === "claude" || worker.agent === "codex"
                  ? worker.agent
                  : undefined,
              )
            ).id;
          if (!sent)
            await store.renameSession(
              toSessionId,
              requiredText(worker.title, "Worker title", 60),
            );
        }
        const { delegation, turn: sent } = await store.sendDelegation({
          turnId: taskTurnId,
          callerTurnId: turn.id,
          message: requiredText(args.message, "Message", 20000),
          ...(typeof args.title === "string" ? { title: args.title } : {}),
          ...(typeof args.task_id === "string" && args.task_id
            ? { delegationId: args.task_id }
            : {
                toSessionId: requiredText(toSessionId, "Session ID", 100),
              }),
        });
        await flushDispatch();
        result = {
          task_id: delegation.id,
          round: delegation.rounds,
          queued_turn: sent.id,
          note: "Queued. Its report will arrive in this session as a new message when that turn ends; finish your turn instead of waiting.",
        };
      } else if (parameters?.name === "notify_owner") {
        await store.addOwnerAlert(
          turn.id,
          requiredText(args.message, "Message", 300),
        );
        result = { notifies: "when this turn ends" };
      } else if (parameters?.name === "brief_publish") {
        if (session.workspaceId !== BRIEFS_WORKSPACE)
          throw new HarnessError(
            "Only the Daily briefs session publishes briefs.",
            403,
          );
        const brief = await store.publishBrief(parseBrief(args), turn.id);
        result = { published: brief.id, day: brief.day, title: brief.title };
      } else if (parameters?.name === "brief_list") {
        result = await store.listBriefs({
          ...(typeof args.workspace_id === "string"
            ? { workspaceId: args.workspace_id }
            : {}),
          ...(args.day === undefined ? {} : { day: parseDay(args.day) }),
          limit: typeof args.limit === "number" ? args.limit : 30,
        });
      } else if (parameters?.name === "brief_get") {
        result = await store.getBrief(requiredText(args.id, "Brief ID", 100));
      } else if (parameters?.name === "session_note") {
        const sent = await store.sendNote({
          turnId: `note:${createHash("sha256")
            .update(`${grant.turnId}:${String(id)}`)
            .digest("hex")
            .slice(0, 32)}`,
          callerTurnId: turn.id,
          toSessionId: requiredText(args.session_id, "Session ID", 100),
          message: requiredText(args.message, "Message", 20000),
        });
        await flushDispatch();
        result = {
          queued_turn: sent.id,
          note: "Sent. A reply, if any, arrives here as a new message. Continue other work or end your turn.",
        };
      } else if (parameters?.name === "continue_on") {
        const next = await store.continueOn({
          turnId: `continue:${createHash("sha256")
            .update(`${grant.turnId}:${String(id)}`)
            .digest("hex")
            .slice(0, 32)}`,
          callerTurnId: turn.id,
          labels: args.labels,
          message: requiredText(args.message, "Message", 20000),
          reason: requiredText(args.reason, "Reason", 500),
        });
        await flushDispatch();
        result = {
          queued_turn: next.id,
          labels: next.requiredLabels?.split(",") ?? [],
          note: "Queued after this turn. End your turn now; the next step continues from your note.",
        };
      } else if (parameters?.name === "control_update") {
        result =
          args.status === true
            ? {
                build: process.env.HARNESS_BUILD,
                update: controlUpdateStatus(),
              }
            : {
                update: startControlUpdate(
                  args.commit,
                  `agent: ${session.title} (${session.id})`,
                ),
                note: "Started. Check control_update with status: true every few minutes; the server restarts near the end.",
              };
      } else if (parameters?.name === "machine_update") {
        const wanted = requiredText(args.machine, "Machine", 100);
        const worker = (await store.listWorkers()).find(
          (item) =>
            !item.draining &&
            (item.id === wanted ||
              item.name.toLowerCase() === wanted.toLowerCase() ||
              item.report?.hostname.toLowerCase() === wanted.toLowerCase()),
        );
        if (!worker) throw new HarnessError(`No machine named ${wanted}.`, 404);
        if (args.cancel === true) {
          await store.cancelWorkerUpdate(worker.id);
          result = { machine: worker.name, cancelled: true };
        } else {
          const commit = args.commit ?? process.env.HARNESS_BUILD;
          const update = await store.requestWorkerUpdate(
            worker.id,
            commit,
            `agent: ${session.title} (${session.id})`,
          );
          result = {
            machine: worker.name,
            update,
            on_this_machine: worker.id === grant.workerId,
            note:
              worker.id === grant.workerId
                ? "This is the machine you run on: it waits for your turn to end. End your turn now and continue_on another machine to check machines_list."
                : "Check machines_list for progress: preparing, waiting, restarting, then done or failed.",
          };
        }
      } else if (parameters?.name === "machines_list") {
        const { workerLabels, labelList } = await import(
          "@harness/core/scheduling"
        );
        const workers = await store.listWorkers();
        result = {
          control: {
            build: process.env.HARNESS_BUILD ?? null,
            update: controlUpdateStatus(),
          },
          machines: workers
            .filter((worker) => worker.report)
            .map((worker) => ({
              name: worker.name,
              host: worker.report?.hostname,
              labels: workerLabels(worker),
              online: !!worker.seenAt && worker.seenAt > Date.now() - 30000,
              paused: !!worker.draining || !!worker.report?.draining,
              build: worker.report?.build ?? null,
              can_update: !!worker.report?.updatable,
              ...(worker.update ? { update: worker.update } : {}),
            })),
          session_labels: labelList(session.requiredLabels),
          step_labels: labelList(turn.requiredLabels),
          this_machine:
            workers.find((worker) => worker.id === grant.workerId)?.name ??
            null,
        };
      } else if (parameters?.name === "task_report") {
        const delegation = await store.reportDelegation(
          turn.id,
          requiredText(args.status, "Status", 20),
          requiredText(args.summary, "Report", 20000),
        );
        result = {
          task_id: delegation.id,
          note:
            args.status === "progress"
              ? "Progress recorded. Keep working."
              : "Recorded. It is sent to the session that gave the task when this turn ends.",
        };
      } else if (parameters?.name === "task_list") {
        const tasks = await store.delegationsForSession(session.id);
        result = {
          tasks,
          // Notes the sessions on these tasks exchanged, for the planner to follow.
          notes: await store.notesAmong([
            ...new Set(tasks.flatMap((task) => [task.from.id, task.to.id])),
          ]),
        };
      } else if (parameters?.name === "task_close")
        result = await store.closeDelegation(
          requiredText(args.task_id, "Task ID", 100),
          session.id,
          args.outcome === "cancelled" ? "cancelled" : "accepted",
          typeof args.note === "string" ? args.note : undefined,
        );
      else if (parameters?.name === "browser_action") {
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
