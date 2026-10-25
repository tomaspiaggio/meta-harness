import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type ClaimedTurn,
  HarnessError,
  type Provider,
  type RuntimeEvent,
  type Session,
  type Turn,
} from "@harness/core";
import type { FileSnapshot, SessionCheckpoint } from "@harness/core/checkpoint";
import {
  type Decision,
  type DecisionSnapshot,
  type DecisionUpdate,
  MAX_DECISION_BYTES,
  parseDecisionUpdates,
} from "@harness/core/knowledge";
import type {
  NativeSessionEntry,
  NativeSessionKey,
} from "@harness/core/native-store";
import {
  type Allocation,
  admissionReason,
  labelList,
  missingLabels,
  parseLabels,
  type ResourceProfile,
  type Task,
  type WorkerRecord,
  type WorkerReport,
} from "@harness/core/scheduling";
import { connectPostgres, LocalDatabase, type SqlDatabase } from "./database";
import { SqliteStore } from "./index";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const LEASE_MS = 30000;
// A busy home machine keeps a conversation this long before another takes it.
const AFFINITY_MS = 2 * 60000;
const capacityReason = (reason: string) =>
  /^(All .* occupied|Harness .* full|Host |Preserving host memory)/.test(
    reason,
  );
export interface WorkerAssignment {
  claim: ClaimedTurn;
  task: Task | null;
  checkpoint: SessionCheckpoint | null;
}
/** Central persistence; workers access it only through their authenticated API. */
export class ControlStore extends SqliteStore {
  constructor(path?: string | SqlDatabase) {
    super(path);
    if (!(this.db instanceof LocalDatabase)) {
      this.ready = this.ready.then(() => this.ensureChatTasks());
      return;
    }
    const raw = this.db.raw;
    raw.exec(`
      CREATE TABLE IF NOT EXISTS workers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, tokenHash TEXT NOT NULL,
        report TEXT, seenAt INTEGER, draining INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id),
        sessionId TEXT NOT NULL UNIQUE REFERENCES sessions(id), title TEXT NOT NULL,
        objective TEXT NOT NULL, profile TEXT NOT NULL, priority INTEGER NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0, targetWorkerId TEXT, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worker_events (
        turnId TEXT NOT NULL REFERENCES turns(id), generation INTEGER NOT NULL,
        sequence INTEGER NOT NULL, hash TEXT NOT NULL,
        PRIMARY KEY(turnId, generation, sequence)
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id),
        turnId TEXT NOT NULL REFERENCES turns(id), nativeId TEXT, snapshot TEXT NOT NULL,
        output TEXT NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS checkpoints_session ON checkpoints(sessionId, createdAt);
      CREATE TABLE IF NOT EXISTS worker_claims (
        workerId TEXT NOT NULL REFERENCES workers(id), requestId TEXT NOT NULL,
        turnId TEXT, generation INTEGER, createdAt INTEGER NOT NULL,
        PRIMARY KEY(workerId, requestId)
      );
      CREATE TABLE IF NOT EXISTS native_entries (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT NOT NULL REFERENCES sessions(id),
        subpath TEXT NOT NULL, uuid TEXT, data TEXT NOT NULL, UNIQUE(sessionId, subpath, uuid)
      );
      CREATE TABLE IF NOT EXISTS native_writes (
        sessionId TEXT NOT NULL REFERENCES sessions(id), id TEXT NOT NULL, hash TEXT NOT NULL,
        PRIMARY KEY(sessionId, id)
      );
      CREATE TABLE IF NOT EXISTS provider_cooldowns (
        workerId TEXT NOT NULL REFERENCES workers(id), provider TEXT NOT NULL,
        retryAt INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(workerId, provider)
      );
      CREATE TABLE IF NOT EXISTS decision_history (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL,
        content TEXT, revision INTEGER NOT NULL, workspaceId TEXT NOT NULL REFERENCES workspaces(id),
        sessionId TEXT REFERENCES sessions(id), turnId TEXT REFERENCES turns(id), updatedAt INTEGER NOT NULL,
        UNIQUE(key, revision)
      );
      CREATE TABLE IF NOT EXISTS turn_knowledge (
        turnId TEXT NOT NULL REFERENCES turns(id), generation INTEGER NOT NULL,
        snapshot TEXT NOT NULL, PRIMARY KEY(turnId, generation)
      );
    `);
    // Published decisions outlive their source workspace. Keep its ID as provenance.
    if (
      raw
        .prepare("PRAGMA foreign_key_list(decision_history)")
        .all()
        .some((row) => row.table === "workspaces")
    ) {
      raw.exec(`BEGIN IMMEDIATE;
        ALTER TABLE decision_history RENAME TO decision_history_before_deletion;
        CREATE TABLE decision_history (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL,
          content TEXT, revision INTEGER NOT NULL, workspaceId TEXT NOT NULL,
          sessionId TEXT REFERENCES sessions(id), turnId TEXT REFERENCES turns(id), updatedAt INTEGER NOT NULL,
          UNIQUE(key, revision));
        INSERT INTO decision_history SELECT * FROM decision_history_before_deletion;
        DROP TABLE decision_history_before_deletion;
        COMMIT;`);
    }
    (() => {
      const columns = raw
        .prepare("PRAGMA table_info(sessions)")
        .all()
        .map((column) => column.name);
      // Idempotent additive schema changes preserve the existing local conversations.
      if (!columns.includes("ownerWorkerId"))
        raw.exec("ALTER TABLE sessions ADD COLUMN ownerWorkerId TEXT");
      if (!columns.includes("checkpointId"))
        raw.exec("ALTER TABLE sessions ADD COLUMN checkpointId TEXT");
      if (!columns.includes("requiredLabels"))
        raw.exec("ALTER TABLE sessions ADD COLUMN requiredLabels TEXT");
      if (
        !raw
          .prepare("PRAGMA table_info(workers)")
          .all()
          .some((column) => column.name === "labels")
      )
        raw.exec("ALTER TABLE workers ADD COLUMN labels TEXT");
      if (!columns.includes("nativeRevision"))
        raw.exec(
          "ALTER TABLE sessions ADD COLUMN nativeRevision INTEGER NOT NULL DEFAULT 0",
        );
      const checkpointColumns = raw
        .prepare("PRAGMA table_info(checkpoints)")
        .all()
        .map((column) => column.name);
      if (!checkpointColumns.includes("nativeRevision"))
        raw.exec(
          "ALTER TABLE checkpoints ADD COLUMN nativeRevision INTEGER NOT NULL DEFAULT 0",
        );
    })();
    this.ready = this.ensureChatTasks();
  }
  /** Project pre-existing and new chat sessions into the shared task board. */
  private async ensureChatTasks(sessionId?: string): Promise<void> {
    await this.db
      .prepare(`INSERT INTO tasks(id, workspaceId, sessionId, title, objective, profile, priority, createdAt)
      SELECT 'session:' || sessions.id, sessions.workspaceId, sessions.id, sessions.title,
        (SELECT prompt FROM turns WHERE sessionId = sessions.id ORDER BY createdAt, rowid LIMIT 1),
        'standard', 0, sessions.createdAt
      FROM sessions
      WHERE ${sessionId ? "sessions.id = ? AND" : ""}
        EXISTS (SELECT 1 FROM turns WHERE sessionId = sessions.id)
        AND NOT EXISTS (SELECT 1 FROM tasks WHERE sessionId = sessions.id)`)
      .run(...(sessionId ? [sessionId] : []));
  }
  override async createTurn(
    id: string,
    sessionId: string,
    prompt: string,
    interruptsTurnId?: string,
  ): Promise<Turn> {
    const turn = await super.createTurn(
      id,
      sessionId,
      prompt,
      interruptsTurnId,
    );
    await this.ensureChatTasks(sessionId);
    return turn;
  }
  override async renameSession(id: string, title: string) {
    return await this.transaction(async () => {
      const session = await super.renameSession(id, title);
      await this.db
        .prepare("UPDATE tasks SET title = ? WHERE sessionId = ?")
        .run(session.title, id);
      return session;
    });
  }
  async createWorker(name: string): Promise<{
    id: string;
    token: string;
  }> {
    const id = crypto.randomUUID();
    const token = randomBytes(32).toString("base64url");
    await this.db
      .prepare("INSERT INTO workers(id, name, tokenHash) VALUES (?, ?, ?)")
      .run(id, name, digest(token));
    return { id, token };
  }
  async authenticateWorker(id: string, token: string): Promise<void> {
    const row = await this.db
      .prepare("SELECT tokenHash FROM workers WHERE id = ?")
      .get(id);
    const actual = Buffer.from(digest(token));
    const stored = String(row?.tokenHash ?? "");
    const expected = Buffer.from(
      stored.length === 64 ? stored : "0".repeat(64),
    );
    if (!row || stored.length !== 64 || !timingSafeEqual(actual, expected))
      throw new HarnessError("Invalid worker credential.", 401);
  }
  async revokeWorker(id: string): Promise<void> {
    await this.db
      .prepare("UPDATE workers SET tokenHash = '', draining = 1 WHERE id = ?")
      .run(id);
  }
  async reportWorker(
    id: string,
    report: WorkerReport,
    now = Date.now(),
  ): Promise<void> {
    await this.db
      .prepare("UPDATE workers SET report = ?, seenAt = ? WHERE id = ?")
      .run(JSON.stringify(report), now, id);
  }
  async listWorkers(): Promise<WorkerRecord[]> {
    return (
      await this.db
        .prepare(
          "SELECT id, name, report, seenAt, draining, labels FROM workers ORDER BY name",
        )
        .all()
    ).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      report: row.report
        ? (JSON.parse(String(row.report)) as WorkerReport)
        : null,
      seenAt: row.seenAt === null ? null : Number(row.seenAt),
      draining: Number(row.draining),
      labels: labelList(row.labels as string | null),
    }));
  }
  async setWorkerLabels(id: string, labels: unknown): Promise<WorkerRecord> {
    const result = await this.db
      .prepare("UPDATE workers SET labels = ? WHERE id = ?")
      .run(parseLabels(labels).join(",") || null, id);
    if (!result.changes) throw new HarnessError("Worker not found.", 404);
    return (await this.listWorkers()).find(
      (worker) => worker.id === id,
    ) as WorkerRecord;
  }
  /** Only machines with every one of these labels run the session. */
  async setSessionLabels(id: string, labels: unknown): Promise<Session> {
    await this.getSession(id);
    await this.db
      .prepare("UPDATE sessions SET requiredLabels = ? WHERE id = ?")
      .run(parseLabels(labels).join(",") || null, id);
    return await this.getSession(id);
  }
  async drainWorker(id: string, draining: boolean): Promise<void> {
    const result = await this.db
      .prepare("UPDATE workers SET draining = ? WHERE id = ?")
      .run(draining ? 1 : 0, id);
    if (!result.changes) throw new HarnessError("Worker not found.", 404);
  }
  async createTask(input: {
    id: string;
    workspaceId: string;
    title: string;
    objective: string;
    provider: Provider;
    profile: ResourceProfile;
    priority: number;
  }): Promise<Task> {
    return await this.transaction(async () => {
      const existing = (await this.db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(input.id)) as unknown as Task | undefined;
      if (existing) {
        if (
          existing.workspaceId !== input.workspaceId ||
          existing.objective !== input.objective ||
          existing.title !== input.title ||
          existing.profile !== input.profile ||
          existing.priority !== input.priority ||
          (await this.getSession(existing.sessionId)).provider !==
            input.provider
        ) {
          throw new HarnessError(
            "Task ID already belongs to different input.",
            409,
          );
        }
        return existing;
      }
      const session = await this.createSession(
        input.workspaceId,
        input.title,
        input.provider,
      );
      await this.db
        .prepare(
          "INSERT INTO tasks(id, workspaceId, sessionId, title, objective, profile, priority, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.id,
          input.workspaceId,
          session.id,
          input.title,
          input.objective,
          input.profile,
          input.priority,
          Date.now(),
        );
      await this.db
        .prepare(
          "INSERT INTO turns(id, sessionId, prompt, createdAt) VALUES (?, ?, ?, ?)",
        )
        .run(crypto.randomUUID(), session.id, input.objective, Date.now());
      return await this.getTask(input.id);
    });
  }
  async getTask(id: string): Promise<Task> {
    const row = await this.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(id);
    if (!row) throw new HarnessError("Task not found.", 404);
    return row as unknown as Task;
  }
  async taskForSession(sessionId: string): Promise<Task | null> {
    return (
      ((await this.db
        .prepare("SELECT * FROM tasks WHERE sessionId = ?")
        .get(sessionId)) as unknown as Task | undefined) ?? null
    );
  }
  async updateTask(
    id: string,
    changes: {
      paused?: boolean;
      priority?: number;
      targetWorkerId?: string | null;
    },
  ): Promise<void> {
    const task = await this.getTask(id);
    if (
      changes.targetWorkerId &&
      !(await this.listWorkers()).some(
        (worker) => worker.id === changes.targetWorkerId,
      )
    )
      throw new HarnessError("Target worker not found.", 404);
    await this.db
      .prepare(
        "UPDATE tasks SET paused = ?, priority = ?, targetWorkerId = ? WHERE id = ?",
      )
      .run(
        changes.paused === undefined ? task.paused : Number(changes.paused),
        changes.priority ?? task.priority,
        changes.targetWorkerId === undefined
          ? task.targetWorkerId
          : changes.targetWorkerId,
        id,
      );
  }
  private async allocations(workerId: string): Promise<Allocation[]> {
    return (await this.db
      .prepare(`SELECT COALESCE(tasks.profile, 'standard') AS profile, sessions.provider
      FROM turns JOIN sessions ON sessions.id = turns.sessionId LEFT JOIN tasks ON tasks.sessionId = turns.sessionId
      WHERE turns.workerId = ? AND turns.status = 'running'`)
      .all(workerId)) as unknown as Allocation[];
  }
  /**
   * Whether running on this machine starts a new native agent that gets the
   * conversation from the harness instead of its own memory. Claude sessions
   * with a complete portable checkpoint move with their memory.
   */
  protected async leavesHome(
    session: Session,
    worker: WorkerRecord,
  ): Promise<boolean> {
    if (
      session.provider === "demo" ||
      !session.nativeId ||
      session.ownerWorkerId === worker.id
    )
      return false;
    const checkpoint = await this.getCheckpoint(session.id);
    const revision = Number(
      (
        await this.db
          .prepare("SELECT nativeRevision FROM sessions WHERE id = ?")
          .get(session.id)
      )?.nativeRevision,
    );
    return !(
      session.provider === "claude" &&
      worker.report?.portableProviders?.includes("claude") &&
      checkpoint &&
      checkpoint.nativeRevision === revision &&
      (await this.getTurn(checkpoint.turnId)).status === "completed"
    );
  }
  protected async reason(
    turn: Turn,
    worker: WorkerRecord,
    now: number,
  ): Promise<string | null> {
    if (
      !worker.report ||
      worker.seenAt === null ||
      now - worker.seenAt >= LEASE_MS
    )
      return "Worker is offline";
    const task = await this.taskForSession(turn.sessionId);
    const preceding = await this.db
      .prepare(`SELECT 1 FROM turns AS prior JOIN turns AS current ON current.id = ?
      WHERE prior.sessionId = current.sessionId AND prior.id != current.id AND
      (prior.status = 'running' OR (prior.status IN ('pending', 'queued') AND prior.rowid < current.rowid)) LIMIT 1`)
      .get(turn.id);
    if (preceding) return "Waiting for the preceding message in this session";
    if (task?.paused) return "Task is paused";
    if (task?.targetWorkerId && task.targetWorkerId !== worker.id)
      return "Task is assigned to another worker";
    const session = await this.getSession(turn.sessionId);
    const cooldown = await this.db
      .prepare(
        "SELECT * FROM provider_cooldowns WHERE workerId = ? AND provider = ? AND retryAt > ?",
      )
      .get(worker.id, session.provider, now);
    if (cooldown)
      return `${session.provider} is waiting for its provider reset (${new Date(Number(cooldown.retryAt)).toISOString()})`;
    const missing = missingLabels(labelList(session.requiredLabels), worker);
    if (missing.length) return `Needs a machine labelled ${missing.join(", ")}`;
    if (await this.leavesHome(session, worker)) {
      // The agent's memory of this conversation lives on the machine that ran
      // it last. Prefer it, but never wait for a machine that is off.
      const owner = (await this.listWorkers()).find(
        (candidate) => candidate.id === session.ownerWorkerId,
      );
      const ownerReason = owner ? await this.reason(turn, owner, now) : "";
      if (ownerReason === null)
        return `Waiting for ${owner?.name}, which has this conversation's agent memory`;
      if (
        ownerReason &&
        capacityReason(ownerReason) &&
        now - turn.createdAt < AFFINITY_MS
      )
        return `Waiting up to 2 minutes for ${owner?.name} (busy), which has this conversation's agent memory`;
    }
    return admissionReason(
      {
        ...worker.report,
        draining: !!worker.draining || worker.report.draining,
      },
      await this.allocations(worker.id),
      task?.profile ?? "standard",
      session.provider,
    );
  }
  async waitingReason(
    turnId: string,
    now = Date.now(),
  ): Promise<string | null> {
    const turn = await this.getTurn(turnId);
    if (turn.status !== "pending" && turn.status !== "queued") return null;
    if ((await this.taskForSession(turn.sessionId))?.paused)
      return "Task is paused";
    if (turn.status === "pending") return "Waiting for workflow dispatch";
    const workers = await this.listWorkers();
    if (!workers.length) return "No workers enrolled";
    const reasons = await Promise.all(
      workers.map(async (worker) => await this.reason(turn, worker, now)),
    );
    return reasons.some((reason) => reason === null)
      ? "Waiting for an eligible worker to claim"
      : [...new Set(reasons)].join("; ");
  }
  async listTasks(workspaceId?: string) {
    const tasks = (await this.db
      .prepare(
        `SELECT * FROM tasks ${workspaceId ? "WHERE workspaceId = ?" : ""} ORDER BY createdAt DESC, rowid DESC LIMIT 100`,
      )
      .all(...(workspaceId ? [workspaceId] : []))) as unknown as Task[];
    const workers = await this.listWorkers();
    return await Promise.all(
      tasks.map(async (task) => {
        const turn = (await this.db
          .prepare(
            "SELECT * FROM turns WHERE sessionId = ? ORDER BY CASE WHEN status = 'running' THEN 0 WHEN status IN ('pending', 'queued') THEN 1 ELSE 2 END, CASE WHEN status IN ('pending', 'queued') THEN rowid END ASC, createdAt DESC, rowid DESC LIMIT 1",
          )
          .get(task.sessionId)) as unknown as Turn;
        const reasons = await Promise.all(
          workers.map(async (worker) => ({
            workerId: worker.id,
            name: worker.name,
            reason: await this.reason(turn, worker, Date.now()),
          })),
        );
        const waitingReason = await this.waitingReason(turn.id);
        return {
          ...task,
          status:
            task.paused &&
            (turn.status === "queued" || turn.status === "pending")
              ? "paused"
              : turn.status === "running" && turn.stopRequestedAt
                ? "stopping"
                : turn.status,
          turnId: turn.id,
          workerId: turn.workerId,
          provider: (await this.getSession(task.sessionId)).provider,
          waitingReason,
          workers: reasons,
        };
      }),
    );
  }
  override async recoverExpired(now: number): Promise<number> {
    return this.transaction(async () => {
      const expired = (await this.db
        .prepare(`SELECT turns.* FROM turns JOIN sessions ON sessions.id = turns.sessionId
        WHERE turns.status = 'running' AND turns.leaseUntil <= ? AND sessions.provider = 'demo' AND turns.stopRequestedAt IS NULL`)
        .all(now)) as unknown as Turn[];
      for (const turn of expired) {
        const checkpoint = await this.db
          .prepare(
            "SELECT checkpoints.output FROM checkpoints JOIN sessions ON sessions.checkpointId = checkpoints.id WHERE sessions.id = ? AND checkpoints.turnId = ?",
          )
          .get(turn.sessionId, turn.id);
        await this.db
          .prepare(`UPDATE turns SET status = 'queued', workerId = NULL, leaseUntil = NULL, generation = generation + 1,
          output = ?, error = 'Demo attempt lost; recovering the last durable checkpoint.' WHERE id = ?`)
          .run(checkpoint?.output ?? "", turn.id);
      }
      return expired.length + (await super.recoverExpired(now));
    });
  }
  async claimForWorker(
    id: string,
    now = Date.now(),
    requestId: string = crypto.randomUUID(),
  ): Promise<WorkerAssignment | null> {
    return await this.transaction(async () => {
      await this.recoverExpired(now);
      const previous = await this.db
        .prepare(
          "SELECT * FROM worker_claims WHERE workerId = ? AND requestId = ?",
        )
        .get(id, requestId);
      if (previous) {
        if (!previous.turnId) return null;
        const turn = await this.getTurn(String(previous.turnId));
        if (
          turn.status !== "running" ||
          turn.workerId !== id ||
          turn.generation !== previous.generation
        )
          return null;
        const session = await this.getSession(turn.sessionId);
        return {
          claim: {
            turn,
            session,
            workspace: await this.getWorkspace(session.workspaceId),
          },
          task: await this.taskForSession(session.id),
          checkpoint: await this.getCheckpoint(session.id),
        };
      }
      const worker = (await this.listWorkers()).find(
        (candidate) => candidate.id === id,
      );
      if (!worker) throw new HarnessError("Worker not found.", 404);
      const candidates = (await this.db
        .prepare(`SELECT turns.* FROM turns LEFT JOIN tasks ON tasks.sessionId = turns.sessionId
        WHERE turns.status = 'queued' AND NOT EXISTS (
          SELECT 1 FROM turns AS prior WHERE prior.sessionId = turns.sessionId
          AND (prior.status = 'running' OR (prior.status IN ('pending', 'queued') AND prior.rowid < turns.rowid))
        ) ORDER BY COALESCE(tasks.priority, 0) DESC, turns.createdAt, turns.rowid LIMIT 100`)
        .all()) as unknown as Turn[];
      let candidate: Turn | undefined;
      for (const turn of candidates) {
        if (!(await this.reason(turn, worker, now))) {
          candidate = turn;
          break;
        }
      }
      if (!candidate) {
        await this.db
          .prepare("INSERT INTO worker_claims VALUES (?, ?, NULL, NULL, ?)")
          .run(id, requestId, now);
        await this.pruneClaimHistory(id);
        return null;
      }
      if (
        await this.leavesHome(
          await this.getSession(candidate.sessionId),
          worker,
        )
      )
        // The new machine starts a fresh agent; the claim route gives it the
        // conversation so far. Its old memory and checkpoint no longer apply.
        await this.db
          .prepare(
            "UPDATE sessions SET nativeId = NULL, ownerWorkerId = NULL, checkpointId = NULL, nativeRevision = nativeRevision + 1 WHERE id = ?",
          )
          .run(candidate.sessionId);
      await this.db
        .prepare(
          "UPDATE turns SET status = 'running', workerId = ?, generation = generation + 1, leaseUntil = ?, error = NULL WHERE id = ?",
        )
        .run(id, now + LEASE_MS, candidate.id);
      const turn = await this.getTurn(candidate.id);
      await this.db
        .prepare("INSERT INTO worker_claims VALUES (?, ?, ?, ?, ?)")
        .run(id, requestId, turn.id, turn.generation, now);
      await this.pruneClaimHistory(id);
      const session = await this.getSession(turn.sessionId);
      return {
        claim: {
          turn,
          session,
          workspace: await this.getWorkspace(session.workspaceId),
        },
        task: await this.taskForSession(session.id),
        checkpoint: await this.getCheckpoint(session.id),
      };
    });
  }
  private async pruneClaimHistory(id: string): Promise<void> {
    await this.db
      .prepare(
        "DELETE FROM worker_claims WHERE workerId = ? AND requestId NOT IN (SELECT requestId FROM worker_claims WHERE workerId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 200)",
      )
      .run(id, id);
  }
  protected async requireWorkerOwnership(
    workerId: string,
    turnId: string,
    generation: number,
  ): Promise<void> {
    await this.requireOwnership(turnId, generation);
    if ((await this.getTurn(turnId)).workerId !== workerId)
      throw new HarnessError("This turn belongs to another worker.", 403);
  }
  async heartbeatWorkerTurn(
    workerId: string,
    turnId: string,
    generation: number,
  ): Promise<{
    stopRequested: boolean;
  }> {
    return await this.transaction(async () => {
      await this.requireWorkerOwnership(workerId, turnId, generation);
      if (!(await this.heartbeat(turnId, generation, Date.now(), LEASE_MS)))
        throw new HarnessError("Turn ownership expired.", 409);
      return { stopRequested: !!(await this.getTurn(turnId)).stopRequestedAt };
    });
  }
  async applyWorkerEvent(
    workerId: string,
    turnId: string,
    generation: number,
    sequence: number,
    event: RuntimeEvent,
  ): Promise<void> {
    await this.transaction(async () => {
      await this.requireWorkerOwnership(workerId, turnId, generation);
      const hash = digest(JSON.stringify(event));
      const existing = await this.db
        .prepare(
          "SELECT hash FROM worker_events WHERE turnId = ? AND generation = ? AND sequence = ?",
        )
        .get(turnId, generation, sequence);
      if (existing) {
        if (existing.hash !== hash)
          throw new HarnessError(
            "Event sequence reused for different content.",
            409,
          );
        return;
      }
      const last = await this.db
        .prepare(
          "SELECT MAX(sequence) AS sequence FROM worker_events WHERE turnId = ? AND generation = ?",
        )
        .get(turnId, generation);
      if (sequence !== Number(last?.sequence ?? 0) + 1)
        throw new HarnessError("Worker event is out of order.", 409);
      if (event.type === "text") {
        const result = await this.db
          .prepare(
            "UPDATE turns SET output = output || ? WHERE id = ? AND length(CAST(output AS BLOB)) + length(CAST(? AS BLOB)) <= 262144",
          )
          .run(event.text, turnId, event.text);
        if (!result.changes)
          throw new HarnessError("Turn output exceeded 256 KiB.");
      } else if (event.type === "native-session") {
        const nativeId = (
          await this.getSession((await this.getTurn(turnId)).sessionId)
        ).nativeId;
        if (nativeId && nativeId !== event.id)
          throw new HarnessError(
            "Native session identity changed unexpectedly.",
            409,
          );
        await this.db
          .prepare(
            "UPDATE sessions SET nativeId = ?, ownerWorkerId = ? WHERE id = (SELECT sessionId FROM turns WHERE id = ?)",
          )
          .run(event.id, workerId, turnId);
      } else throw new HarnessError("Checkpoints use the checkpoint endpoint.");
      await this.db
        .prepare("INSERT INTO worker_events VALUES (?, ?, ?, ?)")
        .run(turnId, generation, sequence, hash);
    });
  }
  async saveCheckpoint(
    workerId: string,
    turnId: string,
    generation: number,
    id: string,
    snapshot: FileSnapshot,
  ): Promise<void> {
    await this.transaction(async () => {
      await this.requireWorkerOwnership(workerId, turnId, generation);
      const turn = await this.getTurn(turnId);
      const session = await this.getSession(turn.sessionId);
      if (session.provider !== "demo" && session.provider !== "claude")
        throw new HarnessError(
          "Portable native provider checkpoints are not enabled yet.",
          409,
        );
      const existing = await this.db
        .prepare("SELECT * FROM checkpoints WHERE id = ?")
        .get(id);
      if (existing) {
        if (
          existing.turnId !== turnId ||
          existing.snapshot !== JSON.stringify(snapshot)
        )
          throw new HarnessError("Checkpoint ID reused.", 409);
        return;
      }
      const nativeRevision = Number(
        (
          await this.db
            .prepare("SELECT nativeRevision FROM sessions WHERE id = ?")
            .get(session.id)
        )?.nativeRevision ?? 0,
      );
      if (
        session.provider === "claude" &&
        !(await this.db
          .prepare(
            "SELECT 1 FROM native_entries WHERE sessionId = ? AND subpath = '' LIMIT 1",
          )
          .get(session.id))
      )
        throw new HarnessError(
          "Native transcript must be persisted before checkpoint publication.",
          409,
        );
      await this.db
        .prepare(
          "INSERT INTO checkpoints(id, sessionId, turnId, nativeId, snapshot, output, createdAt, nativeRevision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          session.id,
          turnId,
          session.nativeId,
          JSON.stringify(snapshot),
          turn.output,
          Date.now(),
          nativeRevision,
        );
      await this.db
        .prepare("UPDATE sessions SET checkpointId = ? WHERE id = ?")
        .run(id, session.id);
      // Bound retained checkpoint history for the local test bench.
      await this.db
        .prepare(
          "DELETE FROM checkpoints WHERE sessionId = ? AND id NOT IN (SELECT id FROM checkpoints WHERE sessionId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 3)",
        )
        .run(session.id, session.id);
    });
  }
  async getCheckpoint(sessionId: string): Promise<SessionCheckpoint | null> {
    const row = await this.db
      .prepare(
        "SELECT checkpoints.* FROM checkpoints JOIN sessions ON sessions.checkpointId = checkpoints.id WHERE sessions.id = ?",
      )
      .get(sessionId);
    if (!row) return null;
    return {
      id: String(row.id),
      sessionId,
      turnId: String(row.turnId),
      nativeId: row.nativeId === null ? null : String(row.nativeId),
      nativeRevision: Number(row.nativeRevision),
      snapshot: JSON.parse(String(row.snapshot)) as FileSnapshot,
      createdAt: Number(row.createdAt),
    };
  }
  async completeWorkerTurn(
    workerId: string,
    turnId: string,
    generation: number,
    status: "completed" | "failed" | "interrupted",
    error?: string,
    decisionUpdates: DecisionUpdate[] = [],
  ): Promise<void> {
    await this.transaction(async () => {
      const turn = await this.getTurn(turnId);
      if (turn.stopRequestedAt) {
        status = "interrupted";
        error =
          "Stopped by you. Partial work has been preserved; external actions may already have occurred.";
        decisionUpdates = [];
      }
      // A lost completion acknowledgement returns the already committed outcome.
      if (
        turn.status === status &&
        turn.workerId === workerId &&
        turn.generation === generation
      )
        return;
      await this.requireWorkerOwnership(workerId, turnId, generation);
      const session = await this.getSession(turn.sessionId);
      const checkpoint = await this.getCheckpoint(session.id);
      if (
        status === "completed" &&
        session.provider === "claude" &&
        (await this.hasNativeTranscript(session.id)) &&
        checkpoint?.nativeRevision !==
          Number(
            (
              await this.db
                .prepare("SELECT nativeRevision FROM sessions WHERE id = ?")
                .get(session.id)
            )?.nativeRevision,
          )
      ) {
        throw new HarnessError(
          "Native transcript advanced after the file checkpoint; publish a new checkpoint.",
          409,
        );
      }
      if (
        status === "completed" &&
        ((await this.getSession(turn.sessionId)).provider === "demo" ||
          ((await this.getSession(turn.sessionId)).provider === "claude" &&
            (await this.hasNativeTranscript(turn.sessionId)))) &&
        (await this.getCheckpoint(turn.sessionId))?.turnId !== turn.id
      ) {
        throw new HarnessError(
          "A final checkpoint is required before portable completion.",
          409,
        );
      }
      if (status === "completed" && decisionUpdates.length) {
        const snapshot = await this.db
          .prepare(
            "SELECT snapshot FROM turn_knowledge WHERE turnId = ? AND generation = ?",
          )
          .get(turnId, generation);
        if (!snapshot)
          throw new HarnessError(
            "Read shared decisions before publishing.",
            409,
          );
        const consumed = JSON.parse(
          String(snapshot.snapshot),
        ) as DecisionSnapshot;
        for (const update of parseDecisionUpdates(decisionUpdates)) {
          if (
            (consumed.decisions.find((d) => d.key === update.key)?.revision ??
              0) !== update.expectedRevision
          )
            throw new HarnessError(
              "Decision update does not match this turn's consumed revision.",
              409,
            );
          await this.writeDecision(
            update,
            session.workspaceId,
            session.id,
            turnId,
          );
        }
        await this.getSharedDecisions(); // Enforce the bounded context before committing.
      }
      await this.db
        .prepare(
          "UPDATE turns SET status = ?, error = ?, leaseUntil = NULL WHERE id = ?",
        )
        .run(status, error ?? null, turnId);
    });
  }
  async getSharedDecisions(): Promise<DecisionSnapshot> {
    const decisions = (await this.db
      .prepare(`SELECT * FROM decision_history WHERE sequence IN
      (SELECT MAX(sequence) FROM decision_history GROUP BY key) ORDER BY key`)
      .all()) as unknown as Decision[];
    const revision = Number(
      (
        await this.db
          .prepare(
            "SELECT COALESCE(MAX(sequence), 0) AS revision FROM decision_history",
          )
          .get()
      )?.revision,
    );
    const snapshot = { revision, decisions };
    if (
      decisions.length > 100 ||
      Buffer.byteLength(JSON.stringify(snapshot)) > MAX_DECISION_BYTES
    )
      throw new HarnessError(
        "Shared decisions exceed this prototype's 100-record/32 KiB context limit. Consolidate decisions before publishing more.",
        413,
      );
    return snapshot;
  }
  async readWorkerDecisions(
    workerId: string,
    turnId: string,
    generation: number,
  ): Promise<DecisionSnapshot> {
    return await this.transaction(async () => {
      await this.requireWorkerOwnership(workerId, turnId, generation);
      const previous = await this.db
        .prepare(
          "SELECT snapshot FROM turn_knowledge WHERE turnId = ? AND generation = ?",
        )
        .get(turnId, generation);
      if (previous)
        return JSON.parse(String(previous.snapshot)) as DecisionSnapshot;
      const snapshot = await this.getSharedDecisions();
      await this.db
        .prepare("INSERT INTO turn_knowledge VALUES (?, ?, ?)")
        .run(turnId, generation, JSON.stringify(snapshot));
      return snapshot;
    });
  }
  async decisionsForTurn(turnId: string): Promise<Decision[]> {
    return (await this.db
      .prepare(
        "SELECT * FROM decision_history WHERE turnId = ? ORDER BY sequence",
      )
      .all(turnId)) as unknown as Decision[];
  }
  /** Explicit administrator import; ordinary workers publish only through fenced completion. */
  async importSharedDecision(
    update: DecisionUpdate,
    workspaceId: string,
    sessionId: string | null = null,
    turnId: string | null = null,
  ): Promise<void> {
    await this.transaction(async () => {
      await this.getWorkspace(workspaceId);
      if (
        sessionId &&
        (await this.getSession(sessionId)).workspaceId !== workspaceId
      )
        throw new HarnessError("Decision source is outside this workspace.");
      if (turnId && (await this.getTurn(turnId)).sessionId !== sessionId)
        throw new HarnessError(
          "Decision turn does not match its source session.",
        );
      await this.writeDecision(
        parseDecisionUpdates([update])[0],
        workspaceId,
        sessionId,
        turnId,
      );
      await this.getSharedDecisions();
    });
  }
  /** Owner edits append a revision; withdrawing never erases accepted history. */
  async editSharedDecision(update: DecisionUpdate): Promise<DecisionSnapshot> {
    return this.transaction(async () => {
      const parsed = parseDecisionUpdates([update])[0];
      const current = await this.db
        .prepare(
          "SELECT workspaceId FROM decision_history WHERE key = ? ORDER BY sequence DESC LIMIT 1",
        )
        .get(parsed.key);
      if (!current) throw new HarnessError("Decision not found.", 404);
      await this.writeDecision(parsed, String(current.workspaceId), null, null);
      return this.getSharedDecisions();
    });
  }
  private async writeDecision(
    update: DecisionUpdate,
    workspaceId: string,
    sessionId: string | null,
    turnId: string | null,
  ): Promise<void> {
    const revision = Number(
      (
        await this.db
          .prepare(
            "SELECT COALESCE(MAX(revision), 0) AS revision FROM decision_history WHERE key = ?",
          )
          .get(update.key)
      )?.revision,
    );
    if (revision !== update.expectedRevision)
      throw new HarnessError(
        `Decision ${update.key} changed to revision ${revision}; review the latest decision before updating it.`,
        409,
      );
    await this.db
      .prepare(
        "INSERT INTO decision_history(key, content, revision, workspaceId, sessionId, turnId, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        update.key,
        update.content,
        revision + 1,
        workspaceId,
        sessionId,
        turnId,
        Date.now(),
      );
  }
  private async hasNativeTranscript(sessionId: string): Promise<boolean> {
    return !!(await this.db
      .prepare("SELECT 1 FROM native_entries WHERE sessionId = ? LIMIT 1")
      .get(sessionId));
  }
  private async nativeKey(
    workerId: string,
    turnId: string,
    generation: number,
    key: NativeSessionKey,
  ): Promise<string> {
    await this.requireWorkerOwnership(workerId, turnId, generation);
    const turn = await this.getTurn(turnId);
    const session = await this.getSession(turn.sessionId);
    if (
      session.provider !== "claude" ||
      key.projectKey !== `meta-harness-${session.id}` ||
      !key.sessionId ||
      key.sessionId.length > 200 ||
      (session.nativeId && key.sessionId !== session.nativeId) ||
      (key.subpath !== undefined &&
        (typeof key.subpath !== "string" ||
          key.subpath.length > 512 ||
          key.subpath.includes("\0")))
    ) {
      throw new HarnessError(
        "Native transcript key is outside this assignment.",
        403,
      );
    }
    return session.id;
  }
  async appendNative(
    workerId: string,
    turnId: string,
    generation: number,
    id: string,
    key: NativeSessionKey,
    entries: NativeSessionEntry[],
  ): Promise<void> {
    await this.transaction(async () => {
      const sessionId = await this.nativeKey(workerId, turnId, generation, key);
      const writeHash = digest(JSON.stringify({ key, entries }));
      const written = await this.db
        .prepare(
          "SELECT hash FROM native_writes WHERE sessionId = ? AND id = ?",
        )
        .get(sessionId, id);
      if (written) {
        if (written.hash !== writeHash)
          throw new HarnessError(
            "Native write ID reused for different entries.",
            409,
          );
        return;
      }
      let size = Number(
        (
          await this.db
            .prepare(
              "SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) AS size FROM native_entries WHERE sessionId = ?",
            )
            .get(sessionId)
        )?.size,
      );
      let added = 0;
      for (const entry of entries) {
        const encoded = JSON.stringify(entry);
        const existing = entry.uuid
          ? await this.db
              .prepare(
                "SELECT data FROM native_entries WHERE sessionId = ? AND subpath = ? AND uuid = ?",
              )
              .get(sessionId, key.subpath ?? "", entry.uuid)
          : null;
        if (existing) {
          if (existing.data !== encoded)
            throw new HarnessError(
              "Native entry UUID reused for different content.",
              409,
            );
          continue;
        }
        size += Buffer.byteLength(encoded);
        if (size > 16 * 1024 * 1024)
          throw new HarnessError(
            "Native transcript exceeds this prototype's 16 MiB limit.",
            413,
          );
        await this.db
          .prepare(
            "INSERT INTO native_entries(sessionId, subpath, uuid, data) VALUES (?, ?, ?, ?)",
          )
          .run(sessionId, key.subpath ?? "", entry.uuid ?? null, encoded);
        added++;
      }
      await this.db
        .prepare("INSERT INTO native_writes VALUES (?, ?, ?)")
        .run(sessionId, id, writeHash);
      await this.db
        .prepare(
          "UPDATE sessions SET nativeId = ?, ownerWorkerId = ?, nativeRevision = nativeRevision + ? WHERE id = ?",
        )
        .run(key.sessionId, workerId, added ? 1 : 0, sessionId);
    });
  }
  async loadNative(
    workerId: string,
    turnId: string,
    generation: number,
    key: NativeSessionKey,
  ): Promise<NativeSessionEntry[] | null> {
    const sessionId = await this.nativeKey(workerId, turnId, generation, key);
    const rows = await this.db
      .prepare(
        "SELECT data FROM native_entries WHERE sessionId = ? AND subpath = ? ORDER BY sequence",
      )
      .all(sessionId, key.subpath ?? "");
    return rows.length
      ? rows.map((row) => JSON.parse(String(row.data)) as NativeSessionEntry)
      : null;
  }
  async nativeSubkeys(
    workerId: string,
    turnId: string,
    generation: number,
    key: NativeSessionKey,
  ): Promise<string[]> {
    const sessionId = await this.nativeKey(workerId, turnId, generation, key);
    return (
      await this.db
        .prepare(
          "SELECT DISTINCT subpath FROM native_entries WHERE sessionId = ? AND subpath <> '' ORDER BY subpath",
        )
        .all(sessionId)
    ).map((row) => String(row.subpath));
  }
  async coolDownProvider(
    workerId: string,
    turnId: string,
    generation: number,
    retryAt: number,
    reason: string,
  ): Promise<void> {
    await this.transaction(async () => {
      await this.requireWorkerOwnership(workerId, turnId, generation);
      const provider = (
        await this.getSession((await this.getTurn(turnId)).sessionId)
      ).provider;
      await this.db
        .prepare(`INSERT INTO provider_cooldowns VALUES (?, ?, ?, ?) ON CONFLICT(workerId, provider)
        DO UPDATE SET retryAt = MAX(provider_cooldowns.retryAt, excluded.retryAt), reason = excluded.reason`)
        .run(workerId, provider, retryAt, reason);
    });
  }
}
export async function openControlStore(path?: string): Promise<ControlStore> {
  const store = new ControlStore(
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
