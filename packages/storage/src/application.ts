import { createHash } from "node:crypto";
import {
  HarnessError,
  isTerminal,
  type Provider,
  requiredText,
  type Session,
  type Turn,
} from "@harness/core";
import {
  type Attachment,
  attachmentName,
  MAX_TURN_ATTACHMENTS,
} from "@harness/core/attachments";
import {
  nextOccurrence,
  parseScheduleDraft,
  type Schedule,
  type ScheduleOccurrence,
} from "@harness/core/automations";
import {
  BRIEFS_WORKSPACE,
  type Brief,
  type BriefInput,
  type BriefSummary,
  dayBounds,
} from "@harness/core/briefs";
import {
  type BrowserCommand,
  browserCommandNotStarted,
} from "@harness/core/browser";
import { stableJson } from "@harness/core/idempotency";
import {
  type IntegrationConnection,
  type IntegrationDefinition,
  parseIntegrationBinding,
  parseIntegrationConnection,
  parseIntegrationDefinition,
  type WorkspaceIntegrationBinding,
} from "@harness/core/integrations";
import {
  type AgentDefaults,
  defaultAgentDefaults,
  parseAgentDefaults,
  parseModel,
} from "@harness/core/models";
import {
  parseLabels,
  type WorkerRecord,
  type WorkerReport,
} from "@harness/core/scheduling";
import { ControlStore } from "./control";
import { connectPostgres, LocalDatabase, type SqlDatabase } from "./database";
import { deleteResource } from "./deletion";
import { featureSchema } from "./features-schema";

export interface ChannelBinding {
  sessionId: string;
  platform: string;
  chatId: string;
  topicId: string | null;
  title: string;
  revision: number;
}
/** A browser or home-screen app that receives Web Push notifications. */
export interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  /** Also notify when a result is ready, not only when attention is needed. */
  results: boolean;
  createdAt: number;
  lastSeenAt: number;
  lastSentAt: number | null;
  error: string | null;
}
const pushRow = (row: Record<string, unknown>): PushSubscription => ({
  endpoint: String(row.endpoint),
  p256dh: String(row.p256dh),
  auth: String(row.auth),
  label: String(row.label),
  results: Number(row.results) === 1,
  createdAt: Number(row.createdAt),
  lastSeenAt: Number(row.lastSeenAt),
  lastSentAt: row.lastSentAt == null ? null : Number(row.lastSentAt),
  error: row.error == null ? null : String(row.error),
});
export interface Notification {
  id: string;
  sessionId: string;
  kind: string;
  referenceId: string;
  status: string;
  attempts: number;
  nextAt: number;
  leaseUntil: number | null;
  receipt: string | null;
  error: string | null;
  createdAt: number;
}
export interface InputRequest {
  id: string;
  sessionId: string;
  turnId: string | null;
  kind: string;
  message: string;
  status: string;
  response: string | null;
  createdAt: number;
  resolvedAt: number | null;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export const MAX_DELEGATION_ROUNDS = 6;
/** Notes two sessions may exchange per hour, so they cannot loop forever. */
export const MAX_NOTES_PER_HOUR = 20;
export interface SessionNote {
  turnId: string;
  fromSessionId: string;
  toSessionId: string;
  createdAt: number;
}
/** Turns an agent may queue for itself in a row before an outside message. */
export const MAX_CONTINUATIONS = 5;
export const DELEGATION_REPORTS = [
  "progress",
  "done",
  "question",
  "blocked",
] as const;
export type DelegationReportStatus = (typeof DELEGATION_REPORTS)[number];
export interface Delegation {
  id: string;
  fromSessionId: string;
  toSessionId: string;
  title: string;
  status: string;
  rounds: number;
  progress: string | null;
  progressAt: number | null;
  reportStatus: string | null;
  report: string | null;
  reportAt: number | null;
  closedNote: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface DelegationView extends Delegation {
  /** queued, working, waiting-on-owner, a report status, accepted or cancelled. */
  state: string;
  from: { id: string; title: string; workspaceId: string };
  to: { id: string; title: string; workspaceId: string };
}
export interface DelegationTurn {
  turnId: string;
  delegationId: string;
  role: "task" | "reply" | "report" | "continue";
  round: number;
  reportStatus: string | null;
  report: string | null;
  reportedAt: number | null;
  fromSessionId: string;
  toSessionId: string;
  title: string;
  status: string;
  rounds: number;
}
const optionalNumber = (value: unknown) =>
  value == null ? null : Number(value);
const optionalText = (value: unknown) => (value == null ? null : String(value));
const delegationRow = (row: Record<string, unknown>): Delegation => ({
  id: String(row.id),
  fromSessionId: String(row.fromSessionId),
  toSessionId: String(row.toSessionId),
  title: String(row.title),
  status: String(row.status),
  rounds: Number(row.rounds),
  progress: optionalText(row.progress),
  progressAt: optionalNumber(row.progressAt),
  reportStatus: optionalText(row.reportStatus),
  report: optionalText(row.report),
  reportAt: optionalNumber(row.reportAt),
  closedNote: optionalText(row.closedNote),
  createdAt: Number(row.createdAt),
  updatedAt: Number(row.updatedAt),
});
const delegationTurnRow = (row: Record<string, unknown>): DelegationTurn => ({
  turnId: String(row.turnId),
  delegationId: String(row.delegationId),
  role: String(row.role) as DelegationTurn["role"],
  round: Number(row.round),
  reportStatus: optionalText(row.reportStatus),
  report: optionalText(row.report),
  reportedAt: optionalNumber(row.reportedAt),
  fromSessionId: String(row.fromSessionId),
  toSessionId: String(row.toSessionId),
  title: String(row.title),
  status: String(row.status),
  rounds: Number(row.rounds),
});
/** First line of the task, short enough for a list. */
const delegationTitle = (message: string) => {
  const line =
    message
      .split("\n")
      .map((item) => item.replace(/^[#>*\-\s]+/, "").trim())
      .find(Boolean) ?? "Task";
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
};

/** Application persistence shared by local and hosted control planes. */
export class HarnessStore extends ControlStore {
  databaseConnection(): SqlDatabase {
    return this.db;
  }
  constructor(database?: string | SqlDatabase) {
    super(database);
    if (this.db instanceof LocalDatabase) {
      this.db.raw.exec(featureSchema);
      this.db.raw.exec(`CREATE TRIGGER IF NOT EXISTS terminal_turn_notification AFTER UPDATE OF status ON turns
        WHEN NEW.status IN ('completed', 'failed', 'interrupted') AND OLD.status NOT IN ('completed', 'failed', 'interrupted')
        BEGIN INSERT OR IGNORE INTO notification_outbox(id, sessionId, kind, referenceId, nextAt, createdAt)
        VALUES ('turn:' || NEW.id, NEW.sessionId, NEW.status, NEW.id, CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER));
        INSERT OR IGNORE INTO workflow_wakeups(turnId, createdAt) VALUES (NEW.id, CAST(unixepoch('subsec') * 1000 AS INTEGER)); END;`);
    }
  }
  async listIntegrationDefinitions(): Promise<IntegrationDefinition[]> {
    return (
      await this.db
        .prepare("SELECT record FROM integration_definitions ORDER BY id")
        .all()
    ).map((row) => parseIntegrationDefinition(JSON.parse(String(row.record))));
  }
  async listIntegrationConnections(): Promise<IntegrationConnection[]> {
    return (
      await this.db
        .prepare("SELECT record FROM integration_connections ORDER BY id")
        .all()
    ).map((row) => parseIntegrationConnection(JSON.parse(String(row.record))));
  }
  async listIntegrationBindings(
    workspaceId?: string,
  ): Promise<WorkspaceIntegrationBinding[]> {
    const rows = workspaceId
      ? await this.db
          .prepare(
            "SELECT record FROM integration_bindings WHERE workspaceId = ?",
          )
          .all(workspaceId)
      : await this.db.prepare("SELECT record FROM integration_bindings").all();
    return rows.map((row) =>
      parseIntegrationBinding(JSON.parse(String(row.record))),
    );
  }
  private async integrationRevision(
    table: string,
    id: string,
    revision: string,
    expected?: string,
  ) {
    const row = await this.db
      .prepare(`SELECT revision FROM ${table} WHERE id = ?`)
      .get(id);
    if (
      row
        ? row.revision !== expected || revision === expected
        : expected !== undefined
    )
      throw new HarnessError(
        "Integration revision conflict. Refresh and retry.",
        409,
      );
  }
  async putIntegrationDefinition(
    value: unknown,
    expectedRevision?: string,
  ): Promise<IntegrationDefinition> {
    const record = parseIntegrationDefinition(value);
    return this.transaction(async () => {
      await this.integrationRevision(
        "integration_definitions",
        record.id,
        record.revision,
        expectedRevision,
      );
      await this.db
        .prepare(
          "INSERT INTO integration_definitions(id,revision,record) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,record=excluded.record",
        )
        .run(record.id, record.revision, JSON.stringify(record));
      return record;
    });
  }
  async putIntegrationConnection(
    value: unknown,
    expectedRevision?: string,
  ): Promise<IntegrationConnection> {
    const record = parseIntegrationConnection(value);
    return this.transaction(async () => {
      await this.integrationRevision(
        "integration_connections",
        record.id,
        record.revision,
        expectedRevision,
      );
      if (
        !(await this.listIntegrationDefinitions()).some(
          (d) => d.id === record.integrationId,
        )
      )
        throw new HarnessError("Integration definition not found.", 404);
      await this.db
        .prepare(
          "INSERT INTO integration_connections(id,integrationId,revision,record) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET integrationId=excluded.integrationId,revision=excluded.revision,record=excluded.record",
        )
        .run(
          record.id,
          record.integrationId,
          record.revision,
          JSON.stringify(record),
        );
      return record;
    });
  }
  async putIntegrationBinding(
    value: unknown,
    expectedRevision?: string,
  ): Promise<WorkspaceIntegrationBinding> {
    const record = parseIntegrationBinding(value);
    return this.transaction(async () => {
      await this.getWorkspace(record.workspaceId);
      const old = (await this.listIntegrationBindings(record.workspaceId)).find(
        (b) => b.connectionId === record.connectionId,
      );
      if (
        old
          ? old.revision !== expectedRevision ||
            record.revision === expectedRevision
          : expectedRevision !== undefined
      )
        throw new HarnessError("Binding revision conflict.", 409);
      const connection = (await this.listIntegrationConnections()).find(
        (c) => c.id === record.connectionId,
      );
      const definition = (await this.listIntegrationDefinitions()).find(
        (d) => d.id === connection?.integrationId,
      );
      if (
        !connection ||
        !definition ||
        connection.revision !== record.connectionRevision ||
        definition.revision !== record.integrationRevision ||
        record.toolIds.some((id) => !definition.tools.some((t) => t.id === id))
      )
        throw new HarnessError(
          "Accept current connection and tool revisions before binding.",
          409,
        );
      await this.db
        .prepare(
          "INSERT INTO integration_bindings(workspaceId,connectionId,revision,record) VALUES (?,?,?,?) ON CONFLICT(workspaceId,connectionId) DO UPDATE SET revision=excluded.revision,record=excluded.record",
        )
        .run(
          record.workspaceId,
          record.connectionId,
          record.revision,
          JSON.stringify(record),
        );
      return record;
    });
  }
  async deleteIntegrationConnection(
    id: string,
    expectedRevision: string,
  ): Promise<void> {
    await this.transaction(async () => {
      const connection = (await this.listIntegrationConnections()).find(
        (c) => c.id === id,
      );
      if (!connection || connection.revision !== expectedRevision)
        throw new HarnessError("Connection revision conflict.", 409);
      await this.db
        .prepare("DELETE FROM integration_bindings WHERE connectionId = ?")
        .run(id);
      await this.db
        .prepare("DELETE FROM integration_connections WHERE id = ?")
        .run(id);
    });
  }
  /** Only the physical attempt that admitted I/O may finalize its receipt. */
  async integrationOperationOutcome(
    id: string,
    attemptToken: string,
    state: "succeeded" | "failed" | "unknown_outcome",
    receipt: string,
    error?: string,
  ): Promise<boolean> {
    return this.transaction(async () => {
      const row = await this.db
        .prepare("SELECT receipt,state FROM operation_ledger WHERE id = ?")
        .get(id);
      if (
        row?.state !== "running" ||
        JSON.parse(String(row.receipt ?? "{} ")).attemptToken !== attemptToken
      )
        return false;
      await this.operationOutcome(id, state, receipt, error);
      return true;
    });
  }
  async agentDefaults(): Promise<AgentDefaults> {
    const row = await this.db
      .prepare(
        "SELECT value FROM harness_settings WHERE key = 'agent-defaults'",
      )
      .get();
    return row
      ? parseAgentDefaults(JSON.parse(String(row.value)))
      : structuredClone(defaultAgentDefaults);
  }
  async setAgentDefaults(value: unknown): Promise<AgentDefaults> {
    const settings = parseAgentDefaults(value);
    await this.db
      .prepare(
        "INSERT INTO harness_settings(key,value) VALUES ('agent-defaults',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(settings));
    return settings;
  }
  override async createSession(
    workspaceId: string,
    title: string,
    provider?: Provider,
    model?: string | null,
  ): Promise<Session> {
    const defaults = await this.agentDefaults();
    const agent = provider ?? defaults.provider;
    return super.createSession(
      workspaceId,
      title,
      agent,
      model === undefined
        ? agent === "demo"
          ? null
          : defaults.models[agent]
        : parseModel(agent, model),
    );
  }
  async setSessionModel(id: string, model: unknown): Promise<Session> {
    return this.transaction(async () => {
      const session = await this.getSession(id);
      await this.db
        .prepare("UPDATE sessions SET model = ? WHERE id = ?")
        .run(parseModel(session.provider, model), id);
      return this.getSession(id);
    });
  }
  /**
   * The earlier messages and replies of a conversation, for a fresh agent that
   * continues it without its native memory (on another machine, or after the
   * first agent never started). Newest turns are kept when it is too long.
   */
  async conversationSoFar(
    turnId: string,
    maxChars = 60000,
  ): Promise<string | null> {
    const turn = await this.getTurn(turnId);
    const earlier = (await this.db
      .prepare(
        "SELECT * FROM turns WHERE sessionId = ? AND rowid < (SELECT rowid FROM turns WHERE id = ?) ORDER BY rowid DESC LIMIT 200",
      )
      .all(turn.sessionId, turnId)) as unknown as Turn[];
    if (!earlier.length) return null;
    const blocks: string[] = [];
    let used = 0;
    for (const item of earlier) {
      const output = item.output.trim();
      const reply =
        output.length > 8000
          ? `[…start of this reply omitted]\n${output.slice(-8000)}`
          : output || `(no reply; the turn ${item.status})`;
      const block = `### Message\n${item.prompt.trim()}\n\n### Your reply\n${reply}${item.error ? `\n\n(Error: ${item.error.slice(0, 500)})` : ""}`;
      if (used + block.length > maxChars && blocks.length) break;
      blocks.push(block);
      used += block.length;
    }
    const omitted = earlier.length - blocks.length;
    return `[Meta Harness: this conversation now runs on a machine where your agent has no memory of it, so it starts fresh. The conversation so far is below, oldest first; continue from it as if you remembered it.${omitted ? ` ${omitted} older turns are left out; use session_read for them.` : ""} Files, clones, installed tools and uncommitted changes from the earlier machine are not here: check what was pushed or saved before redoing work, and say so if something you need is missing.]

${blocks.reverse().join("\n\n---\n\n")}

[End of the earlier conversation. The new message follows.]`;
  }
  async deleteSession(id: string) {
    return deleteResource(this.db, "session", id);
  }
  async deleteWorkspace(id: string) {
    return deleteResource(this.db, "workspace", id);
  }
  async workerCleanup(workerId: string) {
    return this.db
      .prepare(
        `SELECT kind, id FROM deleted_resources WHERE kind IN ('session','browser') AND NOT EXISTS (SELECT 1 FROM worker_cleanup WHERE worker_cleanup.workerId = ? AND worker_cleanup.kind = deleted_resources.kind AND worker_cleanup.resourceId = deleted_resources.id) ORDER BY createdAt LIMIT 20`,
      )
      .all(workerId);
  }
  async acknowledgeCleanup(workerId: string, kind: string, id: string) {
    if (
      !(await this.db
        .prepare("SELECT 1 FROM deleted_resources WHERE kind = ? AND id = ?")
        .get(kind, id))
    )
      throw new HarnessError("Unknown cleanup resource.", 404);
    await this.db
      .prepare("INSERT OR IGNORE INTO worker_cleanup VALUES (?, ?, ?)")
      .run(workerId, kind, id);
  }
  private scheduleRow(row: Record<string, unknown>): Schedule {
    return {
      ...row,
      trigger: JSON.parse(String(row.trigger)),
      ...(typeof row.lastFiredAt === "number"
        ? { lastRun: { at: row.lastFiredAt, outcome: String(row.lastOutcome) } }
        : {}),
    } as unknown as Schedule;
  }
  async listSchedules(sessionId?: string): Promise<Schedule[]> {
    const rows = await this.db
      .prepare(
        `SELECT schedules.*, (SELECT firedAt FROM schedule_occurrences WHERE scheduleId = schedules.id ORDER BY firedAt DESC LIMIT 1) AS lastFiredAt, (SELECT COALESCE(turns.status, schedule_occurrences.outcome) FROM schedule_occurrences LEFT JOIN turns ON turns.id = schedule_occurrences.turnId WHERE schedule_occurrences.scheduleId = schedules.id ORDER BY firedAt DESC LIMIT 1) AS lastOutcome FROM schedules WHERE status != 'deleted' ${sessionId ? "AND sessionId = ?" : ""} ORDER BY updatedAt DESC LIMIT 200`,
      )
      .all(...(sessionId ? [sessionId] : []));
    return rows.map((row) => this.scheduleRow(row));
  }
  async getSchedule(id: string): Promise<Schedule> {
    const row = await this.db
      .prepare("SELECT * FROM schedules WHERE id = ?")
      .get(id);
    if (!row) throw new HarnessError("Schedule not found.", 404);
    return this.scheduleRow(row);
  }
  async draftSchedule(
    id: string,
    value: unknown,
    expectedRevision?: number,
  ): Promise<Schedule> {
    const draft = parseScheduleDraft(value);
    return this.transaction(async () => {
      await this.getSession(draft.sessionId);
      const old = await this.db
        .prepare("SELECT * FROM schedules WHERE id = ?")
        .get(id);
      const revision = old ? Number(old.revision) : 0;
      if (
        old &&
        expectedRevision === undefined &&
        old.sessionId === draft.sessionId &&
        old.name === draft.name &&
        old.prompt === draft.prompt &&
        old.kind === draft.kind &&
        old.trigger === JSON.stringify(draft.trigger) &&
        Number(old.maxLatenessMs) === draft.maxLatenessMs
      )
        return this.scheduleRow(old);
      if (old && expectedRevision !== revision)
        throw new HarnessError(
          "Schedule changed. Review its latest revision.",
          409,
        );
      if (old && old.sessionId !== draft.sessionId)
        throw new HarnessError(
          "A schedule's destination cannot change while editing. Create a new draft instead.",
          409,
        );
      if (!old && expectedRevision !== undefined && expectedRevision !== 0)
        throw new HarnessError("Schedule not found.", 404);
      const now = Date.now();
      await this.db
        .prepare(`INSERT INTO schedules(id, sessionId, name, prompt, kind, trigger, maxLatenessMs, revision, status, nextAt, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?) ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, prompt = excluded.prompt, kind = excluded.kind, trigger = excluded.trigger,
        maxLatenessMs = excluded.maxLatenessMs, revision = excluded.revision, status = 'draft', nextAt = NULL, updatedAt = excluded.updatedAt`)
        .run(
          id,
          draft.sessionId,
          draft.name,
          draft.prompt,
          draft.kind,
          JSON.stringify(draft.trigger),
          draft.maxLatenessMs,
          revision + 1,
          now,
          now,
        );
      await this.notify(
        `schedule:${id}:${revision + 1}`,
        draft.sessionId,
        "schedule-review",
        id,
      );
      return this.getSchedule(id);
    });
  }
  async changeSchedule(
    id: string,
    revision: number,
    action: "activate" | "pause" | "delete",
    now = Date.now(),
  ): Promise<Schedule> {
    return this.transaction(async () => {
      const schedule = await this.getSchedule(id);
      if (schedule.revision !== revision)
        throw new HarnessError(
          "Schedule changed. Review its latest revision.",
          409,
        );
      if (schedule.status === "deleted")
        throw new HarnessError("Schedule was deleted.", 409);
      const nextAt =
        action === "activate" ? nextOccurrence(schedule.trigger, now) : null;
      if (action === "activate" && nextAt === null)
        throw new HarnessError(
          "This one-time date has passed. Edit the draft before activating it.",
        );
      await this.db
        .prepare(
          "UPDATE schedules SET revision = revision + 1, status = ?, nextAt = ?, updatedAt = ? WHERE id = ?",
        )
        .run(
          action === "activate"
            ? "active"
            : action === "pause"
              ? "paused"
              : "deleted",
          nextAt,
          now,
          id,
        );
      return this.getSchedule(id);
    });
  }
  async dueSchedules(now = Date.now()): Promise<Schedule[]> {
    return (
      await this.db
        .prepare(
          "SELECT * FROM schedules WHERE status = 'active' AND nextAt <= ? ORDER BY nextAt LIMIT 20",
        )
        .all(now)
    ).map((row) => this.scheduleRow(row));
  }
  async scheduledOccurrence(
    id: string,
    revision: number,
    plannedAt: number,
    now = Date.now(),
    manualId?: string,
  ): Promise<ScheduleOccurrence | null> {
    return this.transaction(async () => {
      const schedule = await this.getSchedule(id);
      const occurrenceId = manualId
        ? `${id}:manual:${manualId}`
        : `${id}:${revision}:${plannedAt}`;
      const existing = await this.db
        .prepare("SELECT * FROM schedule_occurrences WHERE id = ?")
        .get(occurrenceId);
      if (existing) return { ...existing } as unknown as ScheduleOccurrence;
      if (
        schedule.revision !== revision ||
        schedule.status !== "active" ||
        (!manualId && (schedule.nextAt !== plannedAt || plannedAt > now))
      )
        return null;
      const overlap =
        !manualId &&
        schedule.kind === "agent" &&
        (await this.db
          .prepare(
            "SELECT 1 AS present FROM schedule_occurrences JOIN turns ON turns.id = schedule_occurrences.turnId WHERE schedule_occurrences.scheduleId = ? AND turns.status IN ('pending','queued','running') LIMIT 1",
          )
          .get(id));
      const skipped =
        !!overlap || (!manualId && now - plannedAt > schedule.maxLatenessMs);
      let turnId: string | null = null;
      const outcome = skipped
        ? "skipped"
        : schedule.kind === "reminder"
          ? "reminded"
          : "queued";
      if (!skipped) {
        turnId = `scheduled:${occurrenceId}`;
        await this.createTurn(
          turnId,
          schedule.sessionId,
          schedule.kind === "reminder"
            ? `[Reminder: ${schedule.name}]`
            : `[Scheduled: ${schedule.name}]\n\n${schedule.prompt}`,
        );
        if (schedule.kind === "reminder")
          await this.db
            .prepare(
              "UPDATE turns SET status = 'completed', output = ? WHERE id = ?",
            )
            .run(schedule.prompt, turnId);
      }
      await this.db
        .prepare(
          "INSERT INTO schedule_occurrences(id, scheduleId, revision, plannedAt, firedAt, turnId, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(occurrenceId, id, revision, plannedAt, now, turnId, outcome);
      if (!manualId) {
        const nextAt =
          schedule.trigger.type === "once"
            ? null
            : nextOccurrence(schedule.trigger, now);
        await this.db
          .prepare(
            "UPDATE schedules SET nextAt = ?, status = ?, updatedAt = ? WHERE id = ?",
          )
          .run(nextAt, nextAt === null ? "completed" : "active", now, id);
      }
      return {
        id: occurrenceId,
        scheduleId: id,
        revision,
        plannedAt,
        firedAt: now,
        turnId,
        outcome,
      };
    });
  }
  async scheduleHistory(id: string): Promise<ScheduleOccurrence[]> {
    return (await this.db
      .prepare(
        "SELECT schedule_occurrences.*, COALESCE(turns.status, schedule_occurrences.outcome) AS outcome FROM schedule_occurrences LEFT JOIN turns ON turns.id = schedule_occurrences.turnId WHERE schedule_occurrences.scheduleId = ? ORDER BY schedule_occurrences.firedAt DESC LIMIT 50",
      )
      .all(id)) as unknown as ScheduleOccurrence[];
  }
  async addAttachment(attachment: Attachment): Promise<Attachment> {
    attachmentName(attachment.name);
    await this.getSession(attachment.sessionId);
    return this.transaction(async () => {
      const old = await this.db
        .prepare("SELECT * FROM attachments WHERE id = ?")
        .get(attachment.id);
      if (old) {
        if (
          old.sessionId !== attachment.sessionId ||
          old.hash !== attachment.hash ||
          old.name !== attachment.name ||
          old.mediaType !== attachment.mediaType
        )
          throw new HarnessError(
            "Attachment ID already belongs to different input.",
            409,
          );
        return old as unknown as Attachment;
      }
      await this.db
        .prepare(
          "INSERT INTO attachments(id, sessionId, name, mediaType, size, hash, objectKey, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          attachment.id,
          attachment.sessionId,
          attachment.name,
          attachment.mediaType,
          attachment.size,
          attachment.hash,
          attachment.objectKey,
          attachment.createdAt,
        );
      return attachment;
    });
  }
  async getAttachment(id: string): Promise<Attachment> {
    const row = await this.db
      .prepare("SELECT * FROM attachments WHERE id = ?")
      .get(id);
    if (!row) throw new HarnessError("Attachment not found.", 404);
    return row as unknown as Attachment;
  }
  async attachmentsForTurn(id: string): Promise<Attachment[]> {
    return (await this.db
      .prepare(
        "SELECT attachments.* FROM attachments JOIN turn_attachments ON attachments.id = turn_attachments.attachmentId WHERE turn_attachments.turnId = ? ORDER BY attachments.createdAt, attachments.id",
      )
      .all(id)) as unknown as Attachment[];
  }
  async submitMessage(
    id: string,
    sessionId: string,
    prompt: string,
    attachmentIds: string[] = [],
    interruptsTurnId?: string,
  ): Promise<Turn> {
    if (
      attachmentIds.length > MAX_TURN_ATTACHMENTS ||
      new Set(attachmentIds).size !== attachmentIds.length
    )
      throw new HarnessError("Attach at most eight distinct files.");
    return this.transaction(async () => {
      const previous = await this.db
        .prepare("SELECT id FROM turns WHERE id = ?")
        .get(id);
      const existing = previous
        ? (await this.attachmentsForTurn(id))
            .map((attachment) => attachment.id)
            .sort()
        : null;
      if (
        existing &&
        JSON.stringify(existing) !== JSON.stringify([...attachmentIds].sort())
      )
        throw new HarnessError(
          "Message ID was already used with different attachments.",
          409,
        );
      for (const attachmentId of attachmentIds) {
        const attachment = await this.getAttachment(attachmentId);
        if (attachment.sessionId !== sessionId)
          throw new HarnessError("Attachment belongs to another session.", 403);
        if (attachment.status !== "ready")
          throw new HarnessError(
            "Attachment upload has not been confirmed.",
            409,
          );
      }
      const turn = await this.createTurn(
        id,
        sessionId,
        prompt,
        interruptsTurnId,
      );
      // A new message moves the conversation on; the agent asks again if it
      // still needs a sign-in.
      if (!previous)
        await this.resolveBrowserLogins(
          sessionId,
          "Superseded by a new message",
        );
      for (const attachmentId of attachmentIds)
        await this.db
          .prepare(
            "INSERT OR IGNORE INTO turn_attachments(turnId, attachmentId) VALUES (?, ?)",
          )
          .run(id, attachmentId);
      return turn;
    });
  }
  async attachmentsForSession(sessionId: string): Promise<Attachment[]> {
    return (await this.db
      .prepare(
        "SELECT DISTINCT attachments.* FROM attachments JOIN turn_attachments ON attachments.id = turn_attachments.attachmentId JOIN turns ON turns.id = turn_attachments.turnId WHERE turns.sessionId = ? AND attachments.status = 'ready' ORDER BY attachments.createdAt LIMIT 1000",
      )
      .all(sessionId)) as unknown as Attachment[];
  }
  async notify(
    id: string,
    sessionId: string,
    kind: string,
    referenceId: string,
  ): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO notification_outbox(id, sessionId, kind, referenceId, nextAt, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, sessionId, kind, referenceId, now, now);
  }
  /** A worker's task, feedback and continuation turns, and notes between sessions. */
  protected override async backgroundTurns(
    ids: string[],
  ): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const marks = ids.map(() => "?").join(",");
    return new Set(
      (
        await this.db
          .prepare(
            `SELECT turnId FROM delegation_turns WHERE role != 'report' AND turnId IN (${marks})
            UNION SELECT turnId FROM session_notes WHERE turnId IN (${marks})`,
          )
          .all(...ids, ...ids)
      ).map((row) => String(row.turnId)),
    );
  }
  /** A planner asks to tell the owner something when its current turn ends. */
  async addOwnerAlert(turnId: string, message: string): Promise<void> {
    const turn = await this.getTurn(turnId);
    await this.db
      .prepare(
        "INSERT INTO owner_alerts(turnId, sessionId, message, createdAt) VALUES (?, ?, ?, ?) ON CONFLICT(turnId) DO UPDATE SET message = excluded.message",
      )
      .run(turnId, turn.sessionId, message, Date.now());
  }
  async ownerAlert(turnId: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT message FROM owner_alerts WHERE turnId = ?")
      .get(turnId);
    return row ? String(row.message) : null;
  }
  /**
   * Work between sessions reaches the owner through the planner: a worker's
   * task turns and notes never notify, and a planner's turn that only handles
   * a report notifies when it asks the owner something or calls notify_owner.
   */
  async notificationIsQuiet(item: {
    kind: string;
    referenceId: string;
  }): Promise<boolean> {
    let turnId = item.referenceId;
    if (item.kind === "needs-input") {
      const request = await this.db
        .prepare("SELECT turnId FROM input_requests WHERE id = ?")
        .get(item.referenceId);
      if (!request?.turnId) return false;
      turnId = String(request.turnId);
    } else if (!["completed", "failed", "interrupted"].includes(item.kind))
      return false;
    if (
      await this.db
        .prepare("SELECT 1 AS quiet FROM session_notes WHERE turnId = ?")
        .get(turnId)
    )
      return true;
    const link = await this.db
      .prepare("SELECT role FROM delegation_turns WHERE turnId = ?")
      .get(turnId);
    if (!link) return false;
    if (link.role !== "report") return true;
    if (item.kind === "needs-input" || (await this.ownerAlert(turnId)))
      return false;
    return !(await this.db
      .prepare(
        "SELECT 1 AS asked FROM input_requests WHERE turnId = ? AND status = 'pending'",
      )
      .get(turnId));
  }
  async notificationHistory(
    sessionId: string,
  ): Promise<Record<string, unknown>[]> {
    return this.db
      .prepare(
        "SELECT id,kind,status,attempts,error,createdAt,receipt FROM notification_outbox WHERE sessionId = ? ORDER BY createdAt DESC LIMIT 20",
      )
      .all(sessionId);
  }
  async claimNotifications(now = Date.now()): Promise<Notification[]> {
    return this.transaction(async () => {
      const rows = await this.db
        .prepare(
          "SELECT * FROM notification_outbox WHERE (status = 'pending' AND nextAt <= ?) OR (status = 'sending' AND leaseUntil <= ?) ORDER BY createdAt LIMIT 10",
        )
        .all(now, now);
      for (const row of rows)
        await this.db
          .prepare(
            "UPDATE notification_outbox SET status = 'sending', attempts = attempts + 1, leaseUntil = ? WHERE id = ?",
          )
          .run(now + 60000, row.id);
      return rows.map((row) => ({
        ...row,
        attempts: Number(row.attempts) + 1,
      })) as unknown as Notification[];
    });
  }
  async finishNotification(
    id: string,
    receipt?: string,
    error?: string,
  ): Promise<void> {
    const row = await this.db
      .prepare("SELECT attempts FROM notification_outbox WHERE id = ?")
      .get(id);
    if (!row) throw new HarnessError("Notification not found.", 404);
    await this.db
      .prepare(
        "UPDATE notification_outbox SET status = ?, receipt = ?, error = ?, nextAt = ?, leaseUntil = NULL WHERE id = ?",
      )
      .run(
        error
          ? Number(row.attempts) >= 8
            ? "failed"
            : "pending"
          : "delivered",
        receipt ?? null,
        error?.slice(0, 500) ?? null,
        Date.now() + Math.min(3600000, 10000 * 2 ** Number(row.attempts)),
        id,
      );
  }
  async savePushSubscription(input: {
    endpoint: string;
    p256dh: string;
    auth: string;
    label: string;
    results?: boolean;
  }): Promise<PushSubscription> {
    const endpoint = requiredText(input.endpoint, "Push endpoint", 1000);
    if (!/^https:\/\//.test(endpoint))
      throw new HarnessError("Push endpoint must use HTTPS.");
    const now = Date.now();
    // Re-registering on every app open keeps the row fresh; it only changes the
    // event choice when one is given.
    await this.db
      .prepare(
        "INSERT INTO push_subscriptions(endpoint,p256dh,auth,label,results,createdAt,lastSeenAt) VALUES (?,?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,label=excluded.label,lastSeenAt=excluded.lastSeenAt,error=NULL" +
          (input.results === undefined ? "" : ",results=excluded.results"),
      )
      .run(
        endpoint,
        requiredText(input.p256dh, "Push key", 200),
        requiredText(input.auth, "Push secret", 100),
        requiredText(input.label, "Device name", 100),
        input.results ? 1 : 0,
        now,
        now,
      );
    return (await this.pushSubscription(endpoint)) as PushSubscription;
  }
  async pushSubscription(endpoint: string): Promise<PushSubscription | null> {
    const row = await this.db
      .prepare("SELECT * FROM push_subscriptions WHERE endpoint = ?")
      .get(endpoint);
    return row ? pushRow(row) : null;
  }
  async pushSubscriptions(): Promise<PushSubscription[]> {
    return (
      await this.db
        .prepare("SELECT * FROM push_subscriptions ORDER BY createdAt LIMIT 50")
        .all()
    ).map(pushRow);
  }
  async removePushSubscription(endpoint: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
      .run(endpoint);
  }
  async pushSent(endpoint: string, error?: string): Promise<void> {
    await this.db
      .prepare(
        error
          ? "UPDATE push_subscriptions SET error = ? WHERE endpoint = ?"
          : "UPDATE push_subscriptions SET lastSentAt = ?, error = NULL WHERE endpoint = ?",
      )
      .run(error ? error.slice(0, 300) : Date.now(), endpoint);
  }
  async channelBinding(sessionId: string): Promise<ChannelBinding | null> {
    return (await this.db
      .prepare("SELECT * FROM channel_bindings WHERE sessionId = ?")
      .get(sessionId)) as unknown as ChannelBinding | null;
  }
  async bindChannel(binding: Omit<ChannelBinding, "revision">): Promise<void> {
    await this.getSession(binding.sessionId);
    await this.db
      .prepare(`INSERT INTO channel_bindings(sessionId, platform, chatId, topicId, title) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET chatId = excluded.chatId, topicId = excluded.topicId, title = excluded.title, revision = channel_bindings.revision + 1`)
      .run(
        binding.sessionId,
        binding.platform,
        binding.chatId,
        binding.topicId,
        binding.title,
      );
  }
  async unbindChannel(sessionId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM channel_bindings WHERE sessionId = ?")
      .run(sessionId);
  }
  async findChannel(
    chatId: string,
    topicId: string,
  ): Promise<ChannelBinding | null> {
    return (await this.db
      .prepare(
        "SELECT * FROM channel_bindings WHERE platform = 'telegram' AND chatId = ? AND topicId = ?",
      )
      .get(chatId, topicId)) as unknown as ChannelBinding | null;
  }
  async acceptTelegram(id: string, payload: unknown): Promise<void> {
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized) > 65536)
      throw new HarnessError("Telegram update exceeds its size limit.", 413);
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO telegram_inbox(id,payload,createdAt) VALUES (?,?,?)",
      )
      .run(id, serialized, Date.now());
  }
  async pendingTelegram(): Promise<{ id: string; payload: string }[]> {
    return this.transaction(async () => {
      const now = Date.now();
      const rows = await this.db
        .prepare(
          "SELECT * FROM telegram_inbox WHERE status = 'pending' OR (status = 'processing' AND leaseUntil <= ?) ORDER BY createdAt LIMIT 3",
        )
        .all(now);
      for (const row of rows)
        await this.db
          .prepare(
            "UPDATE telegram_inbox SET status = 'processing', attempts = attempts + 1, leaseUntil = ? WHERE id = ?",
          )
          .run(now + 60000, row.id);
      return rows as unknown as { id: string; payload: string }[];
    });
  }
  async telegramStatus(id: string): Promise<string | undefined> {
    return (
      await this.db
        .prepare("SELECT status FROM telegram_inbox WHERE id = ?")
        .get(id)
    )?.status as string | undefined;
  }
  async finishTelegram(id: string, error?: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE telegram_inbox SET status = ?, error = ?, leaseUntil = ? WHERE id = ?",
      )
      .run(
        error ? "processing" : "delivered",
        error ?? null,
        error ? Date.now() + 60000 : null,
        id,
      );
  }
  async receiveTelegram(
    id: string,
    sessionId: string,
    text: string,
  ): Promise<void> {
    await this.transaction(async () => {
      if ((await this.telegramStatus(id)) === "delivered") return;
      if (text === "/stop") {
        for (const turn of await this.db
          .prepare(
            "SELECT id,status FROM turns WHERE sessionId = ? AND status IN ('pending','queued','running')",
          )
          .all(sessionId))
          if (["pending", "queued", "running"].includes(String(turn.status)))
            await this.requestStop(String(turn.id));
      } else {
        const inputs = (await this.inputsForSession(sessionId)).filter(
          (input) => input.kind !== "browser-login",
        );
        if (inputs.length === 1) await this.answerInput(inputs[0].id, text);
        else await this.telegramUpdate(id, sessionId, text);
      }
      await this.finishTelegram(id);
    });
  }
  async telegramUpdate(
    id: string,
    sessionId: string,
    prompt: string,
  ): Promise<Turn> {
    return this.transaction(async () => {
      const turn = await this.submitMessage(
        `telegram:${id}`,
        sessionId,
        prompt,
      );
      await this.db
        .prepare(
          "INSERT OR IGNORE INTO telegram_updates(id, sessionId, result, createdAt) VALUES (?, ?, ?, ?)",
        )
        .run(id, sessionId, turn.id, Date.now());
      return turn;
    });
  }
  async requestInput(
    id: string,
    sessionId: string,
    turnId: string | null,
    kind: string,
    message: string,
  ): Promise<InputRequest> {
    await this.getSession(sessionId);
    if (turnId && (await this.getTurn(turnId)).sessionId !== sessionId)
      throw new HarnessError("Input request is outside this session.", 403);
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO input_requests(id, sessionId, turnId, kind, message, status, createdAt) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
      )
      .run(id, sessionId, turnId, kind, message, Date.now());
    await this.notify(`input:${id}`, sessionId, "needs-input", id);
    return (await this.db
      .prepare("SELECT * FROM input_requests WHERE id = ?")
      .get(id)) as unknown as InputRequest;
  }
  async resolveBrowserLogins(sessionId: string, response: string) {
    await this.db
      .prepare(
        "UPDATE input_requests SET status = 'answered', response = ?, resolvedAt = ? WHERE sessionId = ? AND kind = 'browser-login' AND status = 'pending'",
      )
      .run(response, Date.now(), sessionId);
  }
  async inputsForSession(sessionId: string): Promise<InputRequest[]> {
    return (await this.db
      .prepare(
        "SELECT * FROM input_requests WHERE sessionId = ? AND status = 'pending' ORDER BY createdAt LIMIT 20",
      )
      .all(sessionId)) as unknown as InputRequest[];
  }
  /** The owner answered elsewhere or no longer needs to; nothing is sent. */
  async dismissInput(id: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE input_requests SET status = 'dismissed', resolvedAt = ? WHERE id = ? AND status = 'pending'",
      )
      .run(Date.now(), id);
  }
  async answerInput(id: string, response: string): Promise<void> {
    await this.transaction(async () => {
      const input = await this.db
        .prepare("SELECT * FROM input_requests WHERE id = ?")
        .get(id);
      if (input?.status === "answered" && input.response === response.trim())
        return;
      if (input?.status !== "pending")
        throw new HarnessError("Input request is no longer pending.", 409);
      await this.db
        .prepare(
          "UPDATE input_requests SET status = 'answered', response = ?, resolvedAt = ? WHERE id = ?",
        )
        .run(requiredText(response, "Response"), Date.now(), id);
      await this.submitMessage(
        `input:${id}`,
        String(input.sessionId),
        response,
      );
      // The owner answered a worker on a task: its continuation still works
      // on that task and reports back when it ends.
      const link = input.turnId
        ? await this.delegationForTurn(String(input.turnId))
        : null;
      if (link && link.role !== "report")
        await this.db
          .prepare(
            "INSERT OR IGNORE INTO delegation_turns(turnId, delegationId, role, round, createdAt) VALUES (?, ?, 'reply', ?, ?)",
          )
          .run(`input:${id}`, link.delegationId, link.round, Date.now());
    });
  }
  override async listSessions(workspaceId: string): Promise<Session[]> {
    const sessions = await super.listSessions(workspaceId);
    const enriched = await Promise.all(
      sessions.map(async (session) => {
        const requests = await this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM input_requests WHERE sessionId = ? AND status = 'pending'",
          )
          .get(session.id);
        const drafts = await this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM schedules WHERE sessionId = ? AND status = 'draft'",
          )
          .get(session.id);
        return {
          ...session,
          needsInputCount:
            Number(requests?.count ?? 0) + Number(drafts?.count ?? 0),
        };
      }),
    );
    return enriched.sort(
      (a, b) =>
        Number(!!(b.unreadCount || b.needsInputCount)) -
          Number(!!(a.unreadCount || a.needsInputCount)) ||
        (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0),
    );
  }
  async resourcePolicy(workspaceId: string): Promise<Record<string, unknown>> {
    const row = await this.db
      .prepare("SELECT policy FROM workspace_resources WHERE workspaceId = ?")
      .get(workspaceId);
    return row
      ? {
          timezone:
            process.env.HARNESS_TIMEZONE ??
            Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...JSON.parse(String(row.policy)),
          // Browser capability is available in every workspace. Ignore the old
          // opt-in bit without rewriting existing policies or other resources.
          browser: true,
        }
      : {
          capacity: "personal",
          secrets: [],
          browser: true,
          timezone:
            process.env.HARNESS_TIMEZONE ??
            Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
  }
  async saveResourcePolicy(
    workspaceId: string,
    policy: Record<string, unknown>,
  ): Promise<void> {
    await this.getWorkspace(workspaceId);
    await this.db
      .prepare(
        "INSERT INTO workspace_resources(workspaceId, policy, updatedAt) VALUES (?, ?, ?) ON CONFLICT(workspaceId) DO UPDATE SET policy = excluded.policy, updatedAt = excluded.updatedAt",
      )
      .run(workspaceId, JSON.stringify(policy), Date.now());
  }
  async operation(
    workerId: string,
    turnId: string,
    generation: number,
    id: string,
    argumentsValue: unknown,
    details?: unknown,
  ): Promise<{ state: string; receipt: string | null; attempt?: number }> {
    return this.transaction(async () => {
      await this.requireWorkerOwnership(workerId, turnId, generation);
      if ((await this.getTurn(turnId)).stopRequestedAt)
        throw new HarnessError("This turn is stopping.", 409);
      const digest = hash(stableJson(argumentsValue));
      const row = await this.db
        .prepare("SELECT * FROM operation_ledger WHERE id = ?")
        .get(id);
      if (row) {
        if (
          (await this.getTurn(String(row.turnId))).sessionId !==
            (await this.getTurn(turnId)).sessionId ||
          row.hash !== digest
        )
          throw new HarnessError(
            "Operation ID was reused with different arguments.",
            409,
          );
        const previous = row.receipt ? JSON.parse(String(row.receipt)) : {};
        if (
          row.state === "failed" &&
          previous?.execution === "not_started" &&
          details &&
          typeof details === "object" &&
          "retryUnstarted" in details &&
          details.retryUnstarted === true
        ) {
          const attempt = (Number(previous.attempt) || 0) + 1;
          await this.db
            .prepare(
              "UPDATE operation_ledger SET state = 'running', receipt = ?, error = NULL, updatedAt = ? WHERE id = ?",
            )
            .run(
              JSON.stringify({
                ...previous,
                ...details,
                execution: "pending",
                attempt,
              }),
              Date.now(),
              id,
            );
          return { state: "new", receipt: null, attempt };
        }
        return {
          state: String(row.state),
          receipt: row.receipt === null ? null : String(row.receipt),
        };
      }
      await this.db
        .prepare(
          "INSERT INTO operation_ledger(id, turnId, hash, state, receipt, updatedAt) VALUES (?, ?, ?, 'running', ?, ?)",
        )
        .run(
          id,
          turnId,
          digest,
          details ? JSON.stringify(details) : null,
          Date.now(),
        );
      return { state: "new", receipt: null };
    });
  }
  /** Reconcile only worker-confirmed pre-execution failures, retaining command history. */
  async reconcileUnstartedBrowserOperations(
    sessionId: string,
  ): Promise<number> {
    return this.transaction(async () => {
      const rows = await this.db
        .prepare(
          "SELECT operation_ledger.* FROM operation_ledger JOIN turns ON turns.id = operation_ledger.turnId WHERE turns.sessionId = ? AND operation_ledger.state IN ('running','unknown_outcome')",
        )
        .all(sessionId);
      let count = 0;
      for (const row of rows) {
        const details = row.receipt ? JSON.parse(String(row.receipt)) : null;
        if (
          !details?.browserId ||
          !["navigate", "click", "fill"].includes(details.action)
        )
          continue;
        const attempt = Number(details.attempt) || 0;
        const commandId = attempt
          ? `${row.id}:attempt:${attempt}`
          : String(row.id);
        const command = await this.db
          .prepare(
            "SELECT * FROM browser_commands WHERE id = ? AND browserId = ?",
          )
          .get(commandId, details.browserId);
        if (
          !command ||
          !browserCommandNotStarted(command as unknown as BrowserCommand)
        )
          continue;
        await this.operationOutcome(
          String(row.id),
          "failed",
          JSON.stringify({ ...details, execution: "not_started" }),
          String(command.error ?? "Browser action never started."),
        );
        count++;
      }
      return count;
    });
  }
  async unfinishedOperations(
    sessionId: string,
  ): Promise<{ id: string; state: string; details: unknown }[]> {
    await this.reconcileUnstartedBrowserOperations(sessionId);
    return (
      await this.db
        .prepare(
          "SELECT operation_ledger.* FROM operation_ledger JOIN turns ON turns.id = operation_ledger.turnId WHERE turns.sessionId = ? AND operation_ledger.state IN ('running','unknown_outcome') ORDER BY operation_ledger.updatedAt DESC LIMIT 30",
        )
        .all(sessionId)
    ).map((row) => ({
      id: String(row.id),
      state: String(row.state),
      details: row.receipt ? JSON.parse(String(row.receipt)) : null,
    }));
  }
  async operationOutcome(
    id: string,
    state: "succeeded" | "failed" | "unknown_outcome",
    receipt: string | null,
    error?: string,
  ): Promise<void> {
    await this.db
      .prepare(
        "UPDATE operation_ledger SET state = ?, receipt = COALESCE(?, receipt), error = ?, updatedAt = ? WHERE id = ?",
      )
      .run(state, receipt, error?.slice(0, 1000) ?? null, Date.now(), id);
  }
  override async renameSession(
    sessionId: string,
    title: string,
  ): Promise<Session> {
    return this.transaction(async () => {
      const old = await this.getSession(sessionId);
      const session = await super.renameSession(sessionId, title);
      if (old.title !== session.title)
        await this.notify(
          `title:${sessionId}:${Date.now()}`,
          sessionId,
          "title",
          sessionId,
        );
      return session;
    });
  }
  async generatedTitle(
    sessionId: string,
    title: string,
    refine = false,
  ): Promise<void> {
    return this.transaction(async () => {
      const updated = await this.db
        .prepare(
          `UPDATE sessions SET title = ?, titleSource = 'generated' WHERE id = ? AND ${refine ? "titleSource != 'manual'" : "titleSource = 'prompt'"}`,
        )
        .run(requiredText(title, "Title", 60), sessionId);
      await this.db
        .prepare(
          "UPDATE tasks SET title = (SELECT title FROM sessions WHERE id = ?) WHERE sessionId = ?",
        )
        .run(sessionId, sessionId);
      if (updated.changes)
        await this.notify(
          `title:${sessionId}:${Date.now()}`,
          sessionId,
          "title",
          sessionId,
        );
    });
  }
  async titleCandidates(): Promise<Session[]> {
    return (await this.db
      .prepare(
        "SELECT sessions.* FROM sessions WHERE titleSource = 'prompt' AND EXISTS (SELECT 1 FROM turns WHERE turns.sessionId = sessions.id) AND NOT EXISTS (SELECT 1 FROM title_jobs WHERE title_jobs.sessionId = sessions.id AND (title_jobs.status = 'completed' OR title_jobs.attempts >= 3 OR (title_jobs.status = 'running' AND title_jobs.leaseUntil > ?))) LIMIT 1",
      )
      .all(Date.now())) as unknown as Session[];
  }
  async claimTitle(sessionId: string): Promise<boolean> {
    return this.transaction(async () => {
      await this.db
        .prepare(
          "INSERT OR IGNORE INTO title_jobs(sessionId,status,createdAt) VALUES (?, 'pending', ?)",
        )
        .run(sessionId, Date.now());
      return !!(
        await this.db
          .prepare(
            "UPDATE title_jobs SET status = 'running', attempts = attempts + 1, leaseUntil = ? WHERE sessionId = ? AND attempts < 3 AND (status IN ('pending','failed') OR (status = 'running' AND leaseUntil <= ?))",
          )
          .run(Date.now() + 60000, sessionId, Date.now())
      ).changes;
    });
  }
  async finishTitle(sessionId: string, error?: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE title_jobs SET status = ?, error = ?, leaseUntil = NULL WHERE sessionId = ?",
      )
      .run(
        error ? "failed" : "completed",
        error?.slice(0, 300) ?? null,
        sessionId,
      );
  }
  async createOwnerSession(
    id: string,
    ownerId: string,
    expiresAt: number,
  ): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO owner_sessions(id, ownerId, expiresAt, createdAt) VALUES (?, ?, ?, ?)",
      )
      .run(hash(id), ownerId, expiresAt, Date.now());
  }
  async ownerSession(id: string): Promise<{ ownerId: string } | null> {
    return (await this.db
      .prepare(
        "SELECT ownerId FROM owner_sessions WHERE id = ? AND expiresAt > ?",
      )
      .get(hash(id), Date.now())) as { ownerId: string } | null;
  }
  async revokeOwnerSession(id: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM owner_sessions WHERE id = ?")
      .run(hash(id));
  }
  async saveOidcState(
    id: string,
    verifier: string,
    nonce: string,
  ): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO oidc_states(id, verifier, nonce, expiresAt) VALUES (?, ?, ?, ?)",
      )
      .run(hash(id), verifier, nonce, Date.now() + 600000);
  }
  async consumeOidcState(
    id: string,
  ): Promise<{ verifier: string; nonce: string } | null> {
    return this.transaction(async () => {
      const row = await this.db
        .prepare(
          "SELECT verifier, nonce FROM oidc_states WHERE id = ? AND expiresAt > ?",
        )
        .get(hash(id), Date.now());
      await this.db
        .prepare("DELETE FROM oidc_states WHERE id = ?")
        .run(hash(id));
      return row as { verifier: string; nonce: string } | null;
    });
  }
  override async waitingReason(turnId: string): Promise<string | null> {
    const reason = await super.waitingReason(turnId);
    if (!reason) return null;
    const turn = await this.getTurn(turnId);
    if (!["pending", "queued"].includes(turn.status)) return reason;
    const session = await this.getSession(turn.sessionId);
    const policy = await this.resourcePolicy(session.workspaceId);
    if (policy.capacity === "personal") return reason;
    const job = await this.db
      .prepare(
        "SELECT status,error FROM sandbox_jobs WHERE turnId = ? ORDER BY createdAt DESC LIMIT 1",
      )
      .get(turnId);
    if (job?.status === "failed")
      return "Sandbox provisioning needs review before another attempt. Your message is saved.";
    if (job?.status === "starting" || job?.status === "running")
      return "Waiting for the Sandbox worker to become eligible";
    if (
      process.env.HARNESS_SANDBOX_ENABLED !== "1" ||
      !process.env.HARNESS_SANDBOX_SNAPSHOT_ID
    )
      return policy.capacity === "sandbox"
        ? "Sandbox capacity is not configured. Choose personal capacity or configure a worker image."
        : `${reason}; Sandbox fallback is not configured`;
    return reason;
  }
  async createEphemeralWorker(name: string, turnId: string, expiresAt: number) {
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now() ||
      expiresAt > Date.now() + 3600000
    )
      throw new HarnessError("Invalid worker expiry.");
    return this.transaction(async () => {
      await this.getTurn(turnId);
      const worker = await this.createWorker(name);
      await this.db
        .prepare(
          "INSERT INTO worker_grants(workerId,turnId,expiresAt) VALUES (?,?,?)",
        )
        .run(worker.id, turnId, expiresAt);
      return worker;
    });
  }
  override async reportWorker(
    id: string,
    report: WorkerReport,
    now = Date.now(),
  ): Promise<string | null> {
    const grant = await this.db
      .prepare("SELECT * FROM worker_grants WHERE workerId = ?")
      .get(id);
    if (grant) {
      if (Number(grant.expiresAt) <= now)
        throw new HarnessError("Worker credential expired.", 401);
      const session = await this.getSession(
        (await this.getTurn(String(grant.turnId))).sessionId,
      );
      report = {
        ...report,
        providers: report.providers.filter(
          (provider) => provider === session.provider,
        ),
        maxAgents: 1,
        maxBrowsers: 0,
        browserHost: false,
        browserSlotsUsed: 0,
        browserMemoryMiB: 0,
        labels: ["sandbox"],
      };
    }
    return await super.reportWorker(id, report, now);
  }
  override async authenticateWorker(id: string, token: string): Promise<void> {
    await super.authenticateWorker(id, token);
    const grant = await this.db
      .prepare("SELECT * FROM worker_grants WHERE workerId = ?")
      .get(id);
    if (grant && Number(grant.expiresAt) <= Date.now())
      throw new HarnessError("Worker credential expired.", 401);
  }
  protected override async requireWorkerOwnership(
    workerId: string,
    turnId: string,
    generation: number,
  ): Promise<void> {
    await super.requireWorkerOwnership(workerId, turnId, generation);
    const worker = await this.db
      .prepare("SELECT tokenHash FROM workers WHERE id = ?")
      .get(workerId);
    const grant = await this.db
      .prepare("SELECT * FROM worker_grants WHERE workerId = ?")
      .get(workerId);
    if (
      !worker?.tokenHash ||
      (grant &&
        (grant.turnId !== turnId || Number(grant.expiresAt) <= Date.now()))
    )
      throw new HarnessError("Worker access was revoked or expired.", 403);
  }
  protected override async reason(
    turn: Turn,
    worker: WorkerRecord,
    now: number,
  ): Promise<string | null> {
    const grant = await this.db
      .prepare("SELECT * FROM worker_grants WHERE workerId = ?")
      .get(worker.id);
    if (grant && (grant.turnId !== turn.id || Number(grant.expiresAt) <= now))
      return "Worker is scoped to another task or has expired";
    const session = await this.getSession(turn.sessionId);
    const policy = await this.resourcePolicy(session.workspaceId);
    if (!grant && policy.capacity === "sandbox")
      return "This workspace prefers Sandbox capacity";
    if (grant && policy.capacity === "personal")
      return "Sandbox capacity is disabled for this workspace";
    return super.reason(turn, worker, now);
  }
  async confirmAttachment(id: string): Promise<Attachment> {
    await this.db
      .prepare("UPDATE attachments SET status = 'ready' WHERE id = ?")
      .run(id);
    return this.getAttachment(id);
  }
  async claimScheduleWake(
    id: string,
    revision: number,
    dueAt: number,
  ): Promise<string | null> {
    return this.transaction(async () => {
      const key = `${id}:${revision}:${dueAt}`;
      const now = Date.now();
      await this.db
        .prepare(
          "INSERT OR IGNORE INTO schedule_wakes(id, scheduleId, revision, dueAt, createdAt) VALUES (?, ?, ?, ?, ?)",
        )
        .run(key, id, revision, dueAt, now);
      const changed = await this.db
        .prepare(
          "UPDATE schedule_wakes SET leaseUntil = ? WHERE id = ? AND runId IS NULL AND (leaseUntil IS NULL OR leaseUntil < ?)",
        )
        .run(now + 30000, key, now);
      return changed.changes ? key : null;
    });
  }
  async attachScheduleWake(id: string, runId: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE schedule_wakes SET runId = ?, leaseUntil = NULL WHERE id = ?",
      )
      .run(runId, id);
  }
  async subscribeWorkflow(turnId: string, runId: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO workflow_waiters(runId,turnId,createdAt) VALUES (?,?,?)",
      )
      .run(runId, turnId, Date.now());
  }
  async workflowWaiters(turnId: string): Promise<{ runId: string }[]> {
    return (await this.db
      .prepare(
        "SELECT runId FROM workflow_waiters WHERE turnId = ? AND deliveredAt IS NULL",
      )
      .all(turnId)) as { runId: string }[];
  }
  async acknowledgeWorkflow(runId: string): Promise<void> {
    await this.db
      .prepare("UPDATE workflow_waiters SET deliveredAt = ? WHERE runId = ?")
      .run(Date.now(), runId);
  }
  async terminalWakeups(): Promise<Turn[]> {
    return (await this.db
      .prepare(
        "SELECT turns.* FROM turns JOIN workflow_wakeups ON workflow_wakeups.turnId = turns.id WHERE workflow_wakeups.deliveredAt IS NULL ORDER BY workflow_wakeups.createdAt LIMIT 20",
      )
      .all()) as unknown as Turn[];
  }
  async acknowledgeWakeup(id: string): Promise<void> {
    await this.db
      .prepare("UPDATE workflow_wakeups SET deliveredAt = ? WHERE turnId = ?")
      .run(Date.now(), id);
  }
  async assertAssignment(
    workerId: string,
    turnId: string,
    generation: number,
  ): Promise<void> {
    await this.requireWorkerOwnership(workerId, turnId, generation);
    if ((await this.getTurn(turnId)).stopRequestedAt)
      throw new HarnessError("This turn is stopping.", 409);
  }
  /** The delegation a turn belongs to: a task or reply it works on, or a report. */
  async delegationForTurn(turnId: string): Promise<DelegationTurn | null> {
    const row = await this.db
      .prepare(
        "SELECT delegation_turns.*, delegations.fromSessionId, delegations.toSessionId, delegations.title, delegations.status, delegations.rounds FROM delegation_turns JOIN delegations ON delegations.id = delegation_turns.delegationId WHERE delegation_turns.turnId = ?",
      )
      .get(turnId);
    return row ? delegationTurnRow(row) : null;
  }
  async getDelegation(id: string): Promise<Delegation> {
    const row = await this.db
      .prepare("SELECT * FROM delegations WHERE id = ?")
      .get(id);
    if (!row) throw new HarnessError("Task not found.", 404);
    return delegationRow(row);
  }
  /**
   * A session hands work to another session: a new task, or feedback and
   * answers on one it already gave. The message is queued in the worker
   * session; its result comes back as a report turn in the sender.
   */
  async sendDelegation(input: {
    turnId: string;
    callerTurnId: string;
    message: string;
    title?: string;
    toSessionId?: string;
    delegationId?: string;
  }): Promise<{ delegation: Delegation; turn: Turn }> {
    return this.transaction(async () => {
      const existing = await this.delegationForTurn(input.turnId);
      if (existing)
        return {
          delegation: await this.getDelegation(existing.delegationId),
          turn: await this.getTurn(input.turnId),
        };
      const caller = await this.getTurn(input.callerTurnId);
      const callerRole = await this.delegationForTurn(caller.id);
      if (callerRole && callerRole.role !== "report")
        throw new HarnessError(
          `This session is working on a task from another session; it cannot hand work to other sessions. To coordinate with another session (agree an interface, ask what it changed), send it a note with session_note. Use your own subagents for parallel work, or report back with task_report.`,
          403,
        );
      const message = requiredText(input.message, "Message", 20000);
      const now = Date.now();
      let delegation: Delegation;
      if (input.delegationId) {
        delegation = await this.getDelegation(input.delegationId);
        if (delegation.fromSessionId !== caller.sessionId)
          throw new HarnessError("That task belongs to another session.", 403);
        if (delegation.status !== "open")
          throw new HarnessError(
            `That task is ${delegation.status}. Send a new task instead.`,
            409,
          );
        if (delegation.rounds >= MAX_DELEGATION_ROUNDS)
          throw new HarnessError(
            `This task already went back and forth ${delegation.rounds} times. Accept the work with task_close, start a new task with a narrower scope, or ask the owner with request_input.`,
            409,
          );
        await this.db
          .prepare(
            "UPDATE delegations SET rounds = rounds + 1, updatedAt = ? WHERE id = ?",
          )
          .run(now, delegation.id);
        delegation = await this.getDelegation(delegation.id);
      } else {
        const toSessionId = requiredText(input.toSessionId, "Session ID", 100);
        if (toSessionId === caller.sessionId)
          throw new HarnessError("A session cannot give itself a task.");
        await this.getSession(toSessionId);
        const id = `task-${hash(input.turnId).slice(0, 12)}`;
        await this.db
          .prepare(
            "INSERT INTO delegations(id, fromSessionId, toSessionId, title, status, rounds, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'open', 1, ?, ?)",
          )
          .run(
            id,
            caller.sessionId,
            toSessionId,
            input.title?.trim()
              ? delegationTitle(input.title)
              : delegationTitle(message),
            now,
            now,
          );
        delegation = await this.getDelegation(id);
      }
      const turn = await this.createTurn(
        input.turnId,
        delegation.toSessionId,
        message,
      );
      await this.db
        .prepare(
          "INSERT INTO delegation_turns(turnId, delegationId, role, round, createdAt) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          turn.id,
          delegation.id,
          delegation.rounds === 1 ? "task" : "reply",
          delegation.rounds,
          now,
        );
      return { delegation, turn };
    });
  }
  /**
   * A note from one session to another: coordination between sessions (for
   * example two workers agreeing an interface) without handing out work. It
   * arrives as a message in the other session and does not wake the planner.
   */
  /**
   * Every workspace has one planner: its main conversation, which hands work
   * to workers. An existing session titled "Planner" is adopted; otherwise an
   * empty one is created with the default agent, which the owner can change
   * before the first message.
   */
  async ensurePlanners(): Promise<void> {
    const missing = await this.db
      .prepare(
        "SELECT id FROM workspaces WHERE id != ? AND NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.workspaceId = workspaces.id AND sessions.role = 'planner')",
      )
      .all(BRIEFS_WORKSPACE);
    for (const workspace of missing)
      try {
        await this.transaction(async () => {
          const existing = await this.db
            .prepare(
              "SELECT id FROM sessions WHERE workspaceId = ? AND lower(title) = 'planner' ORDER BY createdAt LIMIT 1",
            )
            .get(workspace.id);
          const id = existing
            ? String(existing.id)
            : (await this.createSession(String(workspace.id), "Planner")).id;
          await this.db
            .prepare(
              "UPDATE sessions SET role = 'planner', titleSource = 'manual' WHERE id = ?",
            )
            .run(id);
        });
      } catch {
        // Another request gave this workspace its planner first.
      }
  }
  /** The agent of a conversation can change until its first message. */
  async setSessionProvider(
    id: string,
    provider: Provider,
    model: string | null,
  ): Promise<Session> {
    return await this.transaction(async () => {
      await this.getSession(id);
      if (
        await this.db
          .prepare("SELECT 1 AS started FROM turns WHERE sessionId = ? LIMIT 1")
          .get(id)
      )
        throw new HarnessError(
          "The agent is fixed after the first message. Start a new session to use another one.",
        );
      await this.db
        .prepare("UPDATE sessions SET provider = ?, model = ? WHERE id = ?")
        .run(provider, parseModel(provider, model), id);
      return await this.getSession(id);
    });
  }
  /** Sessions that took tasks from another session, and sessions with work in flight. */
  async sessionActivity(): Promise<{ workers: string[]; busy: string[] }> {
    const ids = async (sql: string) =>
      (await this.db.prepare(sql).all()).map((row) => String(row.id));
    return {
      workers: await ids(
        "SELECT DISTINCT toSessionId AS id FROM delegations WHERE toSessionId != fromSessionId",
      ),
      busy: await ids(
        "SELECT DISTINCT sessionId AS id FROM turns WHERE status IN ('pending', 'queued', 'running')",
      ),
    };
  }
  /** The owner's time zone, as used for schedules and daily briefs. */
  ownerTimeZone(): string {
    return (
      process.env.HARNESS_TIMEZONE ??
      Intl.DateTimeFormat().resolvedOptions().timeZone
    );
  }
  /** Completed turns per workspace on a local day, briefs excluded. */
  async briefActivity(
    day: string,
  ): Promise<{ workspaceId: string; name: string; turns: number }[]> {
    const { start, end } = dayBounds(day, this.ownerTimeZone());
    return (
      await this.db
        .prepare(
          `SELECT workspaces.id AS "workspaceId", workspaces.name AS name, COUNT(*) AS turns
          FROM turns JOIN sessions ON sessions.id = turns.sessionId
          JOIN workspaces ON workspaces.id = sessions.workspaceId
          WHERE turns.status = 'completed' AND turns.createdAt >= ? AND turns.createdAt < ?
          AND workspaces.id != ? GROUP BY workspaces.id, workspaces.name ORDER BY workspaces.name`,
        )
        .all(start, end, BRIEFS_WORKSPACE)
    ).map((row) => ({
      workspaceId: String(row.workspaceId),
      name: String(row.name),
      turns: Number(row.turns),
    }));
  }
  /** What happened on a day, per workspace, sized for one agent prompt. */
  async briefDigest(day: string, maxChars = 90000): Promise<string> {
    const { start, end } = dayBounds(day, this.ownerTimeZone());
    const active = await this.briefActivity(day);
    const budget = Math.max(
      6000,
      Math.floor(maxChars / Math.max(1, active.length)),
    );
    const clip = (text: string, max: number) => {
      const line = text.replace(/\s+/g, " ").trim();
      return line.length > max ? `${line.slice(0, max - 1)}…` : line;
    };
    const tail = (text: string, max: number) => {
      const line = text.replace(/\s+/g, " ").trim();
      return line.length > max ? `…${line.slice(-(max - 1))}` : line;
    };
    const sections: string[] = [];
    for (const workspace of active) {
      const lines = [
        `## Workspace "${workspace.name}" (workspace_id ${workspace.workspaceId}), ${workspace.turns} completed turns`,
      ];
      const previous = await this.db
        .prepare(
          "SELECT day, title, highlights FROM briefs WHERE workspaceId = ? AND day < ? ORDER BY day DESC LIMIT 1",
        )
        .get(workspace.workspaceId, day);
      if (previous)
        lines.push(
          `Previous brief (${previous.day}): ${previous.title}. ${(JSON.parse(String(previous.highlights)) as string[]).join(" / ")}`,
        );
      const decisions = await this.db
        .prepare(
          "SELECT key, revision, content FROM decision_history WHERE workspaceId = ? AND updatedAt >= ? AND updatedAt < ? ORDER BY sequence",
        )
        .all(workspace.workspaceId, start, end);
      if (decisions.length) {
        lines.push("Decisions published that day:");
        for (const decision of decisions)
          lines.push(
            `- ${decision.key} r${decision.revision}: ${decision.content === null ? "(withdrawn)" : clip(String(decision.content), 700)}`,
          );
      }
      const turns = await this.db
        .prepare(
          `SELECT turns.prompt, turns.output, sessions.id AS "sessionId", sessions.title
          FROM turns JOIN sessions ON sessions.id = turns.sessionId
          WHERE sessions.workspaceId = ? AND turns.status = 'completed'
          AND turns.createdAt >= ? AND turns.createdAt < ?
          ORDER BY sessions.createdAt, turns.createdAt`,
        )
        .all(workspace.workspaceId, start, end);
      let used = lines.join("\n").length;
      let session = "";
      let omitted = 0;
      for (const turn of turns) {
        const heading =
          turn.sessionId === session
            ? ""
            : `\n### Session "${turn.title}" (session_id ${turn.sessionId})\n`;
        const entry = `${heading}- Asked: ${clip(String(turn.prompt), 400)}\n  Outcome: ${tail(String(turn.output), 900)}`;
        if (used + entry.length > budget) {
          omitted++;
          continue;
        }
        session = String(turn.sessionId);
        lines.push(entry);
        used += entry.length;
      }
      if (omitted)
        lines.push(
          `(${omitted} more turns not shown; read them with session_read.)`,
        );
      sections.push(lines.join("\n"));
    }
    return sections.join("\n\n");
  }
  /** The session that writes the briefs, in its own workspace. */
  async briefSession(): Promise<Session> {
    const saved = await this.db
      .prepare("SELECT value FROM harness_settings WHERE key = 'brief-session'")
      .get();
    if (saved)
      try {
        return await this.getSession(String(saved.value));
      } catch {
        // Deleted by the owner; make a new one.
      }
    if (
      !(await this.db
        .prepare("SELECT 1 FROM workspaces WHERE id = ?")
        .get(BRIEFS_WORKSPACE))
    )
      await this.db
        .prepare(
          "INSERT INTO workspaces(id, name, instructions) VALUES (?, ?, ?)",
        )
        .run(
          BRIEFS_WORKSPACE,
          "Daily briefs",
          "This workspace writes the nightly brief of each workspace's work. Ask here to rewrite or extend a brief.",
        );
    const session = await this.createSession(BRIEFS_WORKSPACE, "Daily briefs");
    await this.renameSession(session.id, "Daily briefs");
    await this.db
      .prepare(
        "INSERT INTO harness_settings(key,value) VALUES ('brief-session',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(session.id);
    return session;
  }
  /** Claims a day's run once; false when the day already has one. */
  async claimBriefRun(day: string, activity: number): Promise<boolean> {
    return (
      Number(
        (
          await this.db
            .prepare(
              "INSERT INTO brief_runs(day, status, turnId, activity, createdAt) VALUES (?, 'claimed', NULL, ?, ?) ON CONFLICT(day) DO NOTHING",
            )
            .run(day, activity, Date.now())
        ).changes,
      ) === 1
    );
  }
  async setBriefRun(
    day: string,
    status: string,
    turnId: string | null,
    activity: number,
  ): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO brief_runs(day, status, turnId, activity, createdAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET status = excluded.status, turnId = excluded.turnId, activity = excluded.activity",
      )
      .run(day, status, turnId, activity, Date.now());
  }
  async briefRun(day: string): Promise<{
    day: string;
    status: string;
    turnId: string | null;
    turnStatus: string | null;
  } | null> {
    const row = await this.db
      .prepare(
        `SELECT brief_runs.day, brief_runs.status, brief_runs.turnId, turns.status AS "turnStatus"
        FROM brief_runs LEFT JOIN turns ON turns.id = brief_runs.turnId WHERE brief_runs.day = ?`,
      )
      .get(day);
    return row
      ? {
          day: String(row.day),
          status: String(row.status),
          turnId: row.turnId === null ? null : String(row.turnId),
          turnStatus: row.turnStatus === null ? null : String(row.turnStatus),
        }
      : null;
  }
  async publishBrief(
    input: BriefInput,
    turnId: string | null,
  ): Promise<BriefSummary> {
    if (input.workspaceId === BRIEFS_WORKSPACE)
      throw new HarnessError("Write briefs for the other workspaces.");
    await this.getWorkspace(input.workspaceId);
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO briefs(id, day, workspaceId, title, highlights, html, sources, turnId, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(day, workspaceId) DO UPDATE SET
        title = excluded.title, highlights = excluded.highlights, html = excluded.html,
        sources = excluded.sources, turnId = excluded.turnId, updatedAt = excluded.updatedAt`,
      )
      .run(
        crypto.randomUUID(),
        input.day,
        input.workspaceId,
        input.title,
        JSON.stringify(input.highlights),
        input.html,
        JSON.stringify(input.sources),
        turnId,
        now,
        now,
      );
    const [brief] = await this.listBriefs({
      day: input.day,
      workspaceId: input.workspaceId,
    });
    return brief;
  }
  private briefRow(row: Record<string, unknown>): BriefSummary {
    return {
      id: String(row.id),
      day: String(row.day),
      workspaceId: String(row.workspaceId),
      title: String(row.title),
      highlights: JSON.parse(String(row.highlights)) as string[],
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    };
  }
  /** Summaries for a day, a workspace, or (neither) each workspace's latest. */
  async listBriefs(
    filter: { day?: string; workspaceId?: string; limit?: number } = {},
  ): Promise<BriefSummary[]> {
    const where: string[] = [];
    const values: (string | number)[] = [];
    if (filter.day) {
      where.push("day = ?");
      values.push(filter.day);
    }
    if (filter.workspaceId) {
      where.push("workspaceId = ?");
      values.push(filter.workspaceId);
    }
    if (!filter.day && !filter.workspaceId)
      where.push(
        "day = (SELECT MAX(latest.day) FROM briefs AS latest WHERE latest.workspaceId = briefs.workspaceId)",
      );
    values.push(Math.min(Math.max(filter.limit ?? 100, 1), 500));
    return (
      await this.db
        .prepare(
          `SELECT id, day, workspaceId, title, highlights, createdAt, updatedAt FROM briefs
          WHERE ${where.join(" AND ")} ORDER BY day DESC, workspaceId LIMIT ?`,
        )
        .all(...values)
    ).map((row) => this.briefRow(row));
  }
  async briefDays(limit = 90): Promise<{ day: string; count: number }[]> {
    return (
      await this.db
        .prepare(
          "SELECT day, COUNT(*) AS count FROM briefs GROUP BY day ORDER BY day DESC LIMIT ?",
        )
        .all(limit)
    ).map((row) => ({ day: String(row.day), count: Number(row.count) }));
  }
  async getBrief(id: string): Promise<Brief> {
    const row = await this.db
      .prepare("SELECT * FROM briefs WHERE id = ?")
      .get(id);
    if (!row) throw new HarnessError("Brief not found.", 404);
    return {
      ...this.briefRow(row),
      html: String(row.html),
      sources: JSON.parse(String(row.sources)),
      turnId: row.turnId === null ? null : String(row.turnId),
    };
  }
  async sendNote(input: {
    turnId: string;
    callerTurnId: string;
    toSessionId: string;
    message: string;
  }): Promise<Turn> {
    const message = requiredText(input.message, "Message", 20000);
    return this.transaction(async () => {
      const existing = await this.noteForTurn(input.turnId);
      if (existing) return await this.getTurn(input.turnId);
      const caller = await this.getTurn(input.callerTurnId);
      const target = await this.getSession(
        requiredText(input.toSessionId, "Session ID", 100),
      );
      if (target.id === caller.sessionId)
        throw new HarnessError("A session cannot send itself a note.");
      const now = Date.now();
      const recent = Number(
        (
          await this.db
            .prepare(
              "SELECT COUNT(*) AS count FROM session_notes WHERE ((fromSessionId = ? AND toSessionId = ?) OR (fromSessionId = ? AND toSessionId = ?)) AND createdAt > ?",
            )
            .get(
              caller.sessionId,
              target.id,
              target.id,
              caller.sessionId,
              now - 3600000,
            )
        )?.count,
      );
      if (recent >= MAX_NOTES_PER_HOUR)
        throw new HarnessError(
          `These two sessions exchanged ${recent} notes in the last hour. Settle it in fewer, fuller notes, or ask the planning session or the owner.`,
          429,
        );
      const turn = await this.createTurn(input.turnId, target.id, message);
      await this.db
        .prepare(
          "INSERT INTO session_notes(turnId, fromSessionId, toSessionId, createdAt) VALUES (?, ?, ?, ?)",
        )
        .run(turn.id, caller.sessionId, target.id, now);
      return turn;
    });
  }
  async noteForTurn(turnId: string): Promise<SessionNote | null> {
    const row = await this.db
      .prepare("SELECT * FROM session_notes WHERE turnId = ?")
      .get(turnId);
    return row
      ? {
          turnId: String(row.turnId),
          fromSessionId: String(row.fromSessionId),
          toSessionId: String(row.toSessionId),
          createdAt: Number(row.createdAt),
        }
      : null;
  }
  /** Recent notes sent or received by these sessions, newest first. */
  async notesAmong(sessionIds: string[], limit = 30) {
    if (!sessionIds.length) return [];
    const marks = sessionIds.map(() => "?").join(", ");
    return (await this.db
      .prepare(
        `SELECT session_notes.*, turns.status, substr(turns.prompt, 1, 300) AS preview FROM session_notes JOIN turns ON turns.id = session_notes.turnId WHERE fromSessionId IN (${marks}) OR toSessionId IN (${marks}) ORDER BY session_notes.createdAt DESC LIMIT ?`,
      )
      .all(...sessionIds, ...sessionIds, limit)) as unknown as (SessionNote & {
      status: string;
      preview: string;
    })[];
  }
  /**
   * The agent continues this conversation in a new turn that only machines
   * with these labels run (none: any machine), for example to verify on the
   * machine with the chip tools after coding elsewhere. A task's report waits
   * for the continuation to finish.
   */
  async continueOn(input: {
    turnId: string;
    callerTurnId: string;
    labels: unknown;
    message: string;
    reason: string;
  }): Promise<Turn> {
    const labels = parseLabels(input.labels);
    const message = requiredText(input.message, "Message", 20000);
    const reason = requiredText(input.reason, "Reason", 500);
    return this.transaction(async () => {
      const existing = (await this.db
        .prepare("SELECT * FROM turns WHERE id = ?")
        .get(input.turnId)) as unknown as Turn | undefined;
      if (existing) return existing;
      const caller = await this.getTurn(input.callerTurnId);
      // Count the agent's own continuations since the last outside message.
      const recent = (await this.db
        .prepare(
          "SELECT id FROM turns WHERE sessionId = ? AND rowid <= (SELECT rowid FROM turns WHERE id = ?) ORDER BY rowid DESC LIMIT ?",
        )
        .all(caller.sessionId, caller.id, MAX_CONTINUATIONS + 1)) as {
        id: string;
      }[];
      let chain = 0;
      while (chain < recent.length && recent[chain].id.startsWith("continue:"))
        chain++;
      if (chain >= MAX_CONTINUATIONS)
        throw new HarnessError(
          `This conversation already continued itself ${chain} times in a row. Finish here and report what is left, or ask the owner with request_input.`,
          409,
        );
      const turn = await this.createTurn(
        input.turnId,
        caller.sessionId,
        message,
      );
      await this.db
        .prepare(
          "UPDATE turns SET requiredLabels = ?, placementReason = ? WHERE id = ?",
        )
        .run(labels.join(",") || null, reason, turn.id);
      const link = await this.delegationForTurn(caller.id);
      if (link && link.role !== "report") {
        // The task's report comes from the continuation, when the work ends.
        await this.db
          .prepare(
            "UPDATE delegation_turns SET reportedAt = ? WHERE turnId = ?",
          )
          .run(Date.now(), caller.id);
        await this.db
          .prepare(
            "INSERT INTO delegation_turns(turnId, delegationId, role, round, createdAt) VALUES (?, ?, 'continue', ?, ?)",
          )
          .run(turn.id, link.delegationId, link.round, Date.now());
      }
      return await this.getTurn(turn.id);
    });
  }
  /**
   * The worker reports on its task. Progress is recorded for the owner and the
   * sender to look at; any other status is delivered to the sender when the
   * worker's turn ends.
   */
  async reportDelegation(
    turnId: string,
    status: string,
    summary: string,
  ): Promise<Delegation> {
    let link = await this.delegationForTurn(turnId);
    if (!link && (await this.noteForTurn(turnId))) {
      // A note can unblock this session's task; its report then comes from
      // this turn.
      const turn = await this.getTurn(turnId);
      const open = await this.db
        .prepare(
          "SELECT id, rounds FROM delegations WHERE toSessionId = ? AND status = 'open' ORDER BY updatedAt DESC LIMIT 1",
        )
        .get(turn.sessionId);
      if (open) {
        await this.db
          .prepare(
            "INSERT INTO delegation_turns(turnId, delegationId, role, round, createdAt) VALUES (?, ?, 'continue', ?, ?)",
          )
          .run(turnId, String(open.id), Number(open.rounds), Date.now());
        link = await this.delegationForTurn(turnId);
      }
    }
    if (!link || link.role === "report")
      throw new HarnessError(
        "This turn is not working on a task from another session.",
        409,
      );
    if (!DELEGATION_REPORTS.includes(status as DelegationReportStatus))
      throw new HarnessError(
        `Status must be one of ${DELEGATION_REPORTS.join(", ")}.`,
      );
    const text = requiredText(summary, "Report", 20000);
    const now = Date.now();
    if (status === "progress")
      await this.db
        .prepare(
          "UPDATE delegations SET progress = ?, progressAt = ?, updatedAt = ? WHERE id = ?",
        )
        .run(text, now, now, link.delegationId);
    else
      await this.db
        .prepare(
          "UPDATE delegation_turns SET reportStatus = ?, report = ? WHERE turnId = ?",
        )
        .run(status, text, turnId);
    return this.getDelegation(link.delegationId);
  }
  async closeDelegation(
    id: string,
    sessionId: string | null,
    status: "accepted" | "cancelled",
    note?: string,
  ): Promise<Delegation> {
    const delegation = await this.getDelegation(id);
    if (sessionId && delegation.fromSessionId !== sessionId)
      throw new HarnessError("That task belongs to another session.", 403);
    await this.db
      .prepare(
        "UPDATE delegations SET status = ?, closedNote = ?, updatedAt = ? WHERE id = ?",
      )
      .run(status, note?.slice(0, 2000) ?? null, Date.now(), id);
    return this.getDelegation(id);
  }
  /** Tasks this session gave or received, each with where it stands now. */
  async delegationsForSession(sessionId: string): Promise<DelegationView[]> {
    const rows = await this.db
      .prepare(
        "SELECT * FROM delegations WHERE fromSessionId = ? OR toSessionId = ? ORDER BY updatedAt DESC LIMIT 50",
      )
      .all(sessionId, sessionId);
    const views: DelegationView[] = [];
    for (const row of rows) {
      const delegation = delegationRow(row);
      const titles = await this.db
        .prepare(
          "SELECT id, title, workspaceId FROM sessions WHERE id IN (?, ?)",
        )
        .all(delegation.fromSessionId, delegation.toSessionId);
      const session = (id: string) => {
        const found = titles.find((item) => item.id === id);
        return found
          ? {
              id,
              title: String(found.title),
              workspaceId: String(found.workspaceId),
            }
          : { id, title: "Deleted session", workspaceId: "" };
      };
      const latest = await this.db
        .prepare(
          "SELECT turns.id, turns.status FROM delegation_turns JOIN turns ON turns.id = delegation_turns.turnId WHERE delegation_turns.delegationId = ? AND delegation_turns.role != 'report' ORDER BY delegation_turns.createdAt DESC LIMIT 1",
        )
        .get(delegation.id);
      const waiting =
        latest &&
        (await this.db
          .prepare(
            "SELECT 1 AS present FROM input_requests WHERE turnId = ? AND status = 'pending' LIMIT 1",
          )
          .get(latest.id));
      const state =
        delegation.status !== "open"
          ? delegation.status
          : waiting
            ? "waiting-on-owner"
            : latest && !isTerminal(latest.status as Turn["status"])
              ? latest.status === "running"
                ? "working"
                : "queued"
              : (delegation.reportStatus ?? "queued");
      views.push({
        ...delegation,
        state,
        from: session(delegation.fromSessionId),
        to: session(delegation.toSessionId),
      });
    }
    return views;
  }
  /** Finished task turns whose result has not gone back to the sender yet. */
  async pendingDelegationReports(): Promise<string[]> {
    return (
      await this.db
        .prepare(
          "SELECT delegation_turns.turnId FROM delegation_turns JOIN turns ON turns.id = delegation_turns.turnId WHERE delegation_turns.role != 'report' AND delegation_turns.reportedAt IS NULL AND turns.status IN ('completed', 'failed', 'interrupted', 'cancelled') ORDER BY delegation_turns.createdAt LIMIT 20",
        )
        .all()
    ).map((row) => String(row.turnId));
  }
  /**
   * Post the result of a finished task turn into the sender as a new turn, so
   * the sender's agent wakes up, reviews it and decides what comes next.
   */
  async deliverDelegationReport(turnId: string): Promise<Turn | null> {
    return this.transaction(async () => {
      const link = await this.delegationForTurn(turnId);
      if (!link || link.role === "report" || link.reportedAt) return null;
      const turn = await this.getTurn(turnId);
      if (!isTerminal(turn.status)) return null;
      const now = Date.now();
      await this.db
        .prepare("UPDATE delegation_turns SET reportedAt = ? WHERE turnId = ?")
        .run(now, turnId);
      const delegation = await this.getDelegation(link.delegationId);
      if (delegation.status !== "open") return null;
      const question = await this.db
        .prepare(
          "SELECT message FROM input_requests WHERE turnId = ? AND status = 'pending' AND kind = 'question' ORDER BY createdAt DESC LIMIT 1",
        )
        .get(turnId);
      let status: string;
      let report: string;
      if (question) {
        status = "waiting-on-owner";
        report = `The worker asked the owner and is waiting for an answer:\n\n> ${String(question.message).replaceAll("\n", "\n> ")}${link.report ? `\n\nIts report so far:\n\n${link.report}` : ""}`;
      } else if (link.reportStatus && link.report) {
        status = link.reportStatus;
        report = link.report;
      } else if (turn.status === "completed") {
        status = "finished";
        report = `The worker ended its turn without a report. Its final message:\n\n${turn.output.slice(-6000) || "(no output)"}`;
      } else {
        status = turn.status;
        report = `The worker's turn ${turn.status}${turn.error ? `: ${turn.error}` : "."}${turn.output ? `\n\nLast output:\n\n${turn.output.slice(-3000)}` : ""}`;
      }
      await this.db
        .prepare(
          "UPDATE delegations SET reportStatus = ?, report = ?, reportAt = ?, updatedAt = ? WHERE id = ?",
        )
        .run(status, report, now, now, delegation.id);
      const worker = await this.getSession(delegation.toSessionId);
      const reportTurn = await this.createTurn(
        `report:${turnId}`,
        delegation.fromSessionId,
        `Report from "${worker.title}" on task ${delegation.id} (${delegation.title}): ${status}\n\n${report}`,
      );
      await this.db
        .prepare(
          "INSERT OR IGNORE INTO delegation_turns(turnId, delegationId, role, round, reportStatus, report, createdAt) VALUES (?, ?, 'report', ?, ?, ?, ?)",
        )
        .run(reportTurn.id, delegation.id, link.round, status, report, now);
      return reportTurn;
    });
  }
}

export async function openHarnessStore(path?: string): Promise<HarnessStore> {
  const store = new HarnessStore(
    path ??
      (process.env.DATABASE_URL
        ? await connectPostgres(process.env.DATABASE_URL)
        : undefined),
  );
  try {
    await store.ready;
    return store;
  } catch (error) {
    await store.close().catch(() => {});
    throw error;
  }
}
