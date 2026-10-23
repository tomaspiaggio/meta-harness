import { createHash } from "node:crypto";
import {
  HarnessError,
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
  type BrowserCommand,
  browserCommandNotStarted,
} from "@harness/core/browser";
import { stableJson } from "@harness/core/idempotency";
import {
  type AgentDefaults,
  defaultAgentDefaults,
  parseAgentDefaults,
  parseModel,
} from "@harness/core/models";
import type { WorkerRecord, WorkerReport } from "@harness/core/scheduling";
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
  async inputsForSession(sessionId: string): Promise<InputRequest[]> {
    return (await this.db
      .prepare(
        "SELECT * FROM input_requests WHERE sessionId = ? AND status = 'pending' ORDER BY createdAt LIMIT 20",
      )
      .all(sessionId)) as unknown as InputRequest[];
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
  ): Promise<void> {
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
    await super.reportWorker(id, report, now);
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
