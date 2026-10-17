import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type ClaimedTurn,
  HarnessError,
  type Provider,
  type RuntimeEvent,
  type Turn,
} from "@harness/core";
import type { FileSnapshot, SessionCheckpoint } from "@harness/core/checkpoint";
import {
  type Allocation,
  admissionReason,
  type ResourceProfile,
  type Task,
  type WorkerRecord,
  type WorkerReport,
} from "@harness/core/scheduling";
import { SqliteStore } from "./index";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const LEASE_MS = 30_000;

export interface WorkerAssignment {
  claim: ClaimedTurn;
  task: Task | null;
  checkpoint: SessionCheckpoint | null;
}

/** Central persistence; workers access it only through their authenticated API. */
export class ControlStore extends SqliteStore {
  constructor(path?: string) {
    super(path);
    this.db.exec(`
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
    `);
    const columns = this.db
      .prepare("PRAGMA table_info(sessions)")
      .all()
      .map((column) => column.name);
    // Idempotent additive schema changes preserve the existing local conversations.
    if (!columns.includes("ownerWorkerId"))
      this.db.exec("ALTER TABLE sessions ADD COLUMN ownerWorkerId TEXT");
    if (!columns.includes("checkpointId"))
      this.db.exec("ALTER TABLE sessions ADD COLUMN checkpointId TEXT");
  }

  createWorker(name: string): { id: string; token: string } {
    const id = crypto.randomUUID();
    const token = randomBytes(32).toString("base64url");
    this.db
      .prepare("INSERT INTO workers(id, name, tokenHash) VALUES (?, ?, ?)")
      .run(id, name, digest(token));
    return { id, token };
  }

  authenticateWorker(id: string, token: string): void {
    const row = this.db
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

  revokeWorker(id: string): void {
    this.db
      .prepare("UPDATE workers SET tokenHash = '', draining = 1 WHERE id = ?")
      .run(id);
  }

  reportWorker(id: string, report: WorkerReport, now = Date.now()): void {
    this.db
      .prepare("UPDATE workers SET report = ?, seenAt = ? WHERE id = ?")
      .run(JSON.stringify(report), now, id);
  }

  listWorkers(): WorkerRecord[] {
    return this.db
      .prepare(
        "SELECT id, name, report, seenAt, draining FROM workers ORDER BY name",
      )
      .all()
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        report: row.report
          ? (JSON.parse(String(row.report)) as WorkerReport)
          : null,
        seenAt: row.seenAt === null ? null : Number(row.seenAt),
        draining: Number(row.draining),
      }));
  }

  drainWorker(id: string, draining: boolean): void {
    const result = this.db
      .prepare("UPDATE workers SET draining = ? WHERE id = ?")
      .run(draining ? 1 : 0, id);
    if (!result.changes) throw new HarnessError("Worker not found.", 404);
  }

  createTask(input: {
    id: string;
    workspaceId: string;
    title: string;
    objective: string;
    provider: Provider;
    profile: ResourceProfile;
    priority: number;
  }): Task {
    return this.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(input.id) as unknown as Task | undefined;
      if (existing) {
        if (
          existing.workspaceId !== input.workspaceId ||
          existing.objective !== input.objective ||
          existing.title !== input.title ||
          existing.profile !== input.profile ||
          existing.priority !== input.priority ||
          this.getSession(existing.sessionId).provider !== input.provider
        ) {
          throw new HarnessError(
            "Task ID already belongs to different input.",
            409,
          );
        }
        return existing;
      }
      const session = this.createSession(
        input.workspaceId,
        input.title,
        input.provider,
      );
      this.db
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
      this.db
        .prepare(
          "INSERT INTO turns(id, sessionId, prompt, createdAt) VALUES (?, ?, ?, ?)",
        )
        .run(crypto.randomUUID(), session.id, input.objective, Date.now());
      return this.getTask(input.id);
    });
  }

  getTask(id: string): Task {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    if (!row) throw new HarnessError("Task not found.", 404);
    return row as unknown as Task;
  }

  taskForSession(sessionId: string): Task | null {
    return (
      (this.db
        .prepare("SELECT * FROM tasks WHERE sessionId = ?")
        .get(sessionId) as unknown as Task | undefined) ?? null
    );
  }

  updateTask(
    id: string,
    changes: {
      paused?: boolean;
      priority?: number;
      targetWorkerId?: string | null;
    },
  ): void {
    const task = this.getTask(id);
    if (
      changes.targetWorkerId &&
      !this.listWorkers().some((worker) => worker.id === changes.targetWorkerId)
    )
      throw new HarnessError("Target worker not found.", 404);
    this.db
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

  private allocations(workerId: string): Allocation[] {
    return this.db
      .prepare(`SELECT COALESCE(tasks.profile, 'standard') AS profile, sessions.provider
      FROM turns JOIN sessions ON sessions.id = turns.sessionId LEFT JOIN tasks ON tasks.sessionId = turns.sessionId
      WHERE turns.workerId = ? AND turns.status = 'running'`)
      .all(workerId) as unknown as Allocation[];
  }

  private reason(turn: Turn, worker: WorkerRecord, now: number): string | null {
    if (
      !worker.report ||
      worker.seenAt === null ||
      now - worker.seenAt >= LEASE_MS
    )
      return "Worker is offline";
    const task = this.taskForSession(turn.sessionId);
    if (task?.paused) return "Task is paused";
    if (task?.targetWorkerId && task.targetWorkerId !== worker.id)
      return "Task is assigned to another worker";
    const session = this.getSession(turn.sessionId);
    const owner = this.db
      .prepare("SELECT ownerWorkerId FROM sessions WHERE id = ?")
      .get(session.id)?.ownerWorkerId;
    if (session.provider !== "demo" && session.nativeId && owner !== worker.id)
      return "Native provider state is pinned to its original worker";
    return admissionReason(
      {
        ...worker.report,
        draining: !!worker.draining || worker.report.draining,
      },
      this.allocations(worker.id),
      task?.profile ?? "standard",
      session.provider,
    );
  }

  listTasks(workspaceId?: string) {
    const tasks = this.db
      .prepare(
        `SELECT * FROM tasks ${workspaceId ? "WHERE workspaceId = ?" : ""} ORDER BY priority DESC, createdAt LIMIT 100`,
      )
      .all(...(workspaceId ? [workspaceId] : [])) as unknown as Task[];
    const workers = this.listWorkers();
    return tasks.map((task) => {
      const turn = this.db
        .prepare(
          "SELECT * FROM turns WHERE sessionId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 1",
        )
        .get(task.sessionId) as unknown as Turn;
      const reasons = workers.map((worker) => ({
        workerId: worker.id,
        name: worker.name,
        reason: this.reason(turn, worker, Date.now()),
      }));
      const waitingReason = task.paused
        ? "Task is paused"
        : turn.status === "pending"
          ? "Waiting for workflow dispatch"
          : turn.status !== "queued"
            ? null
            : !workers.length
              ? "No workers enrolled"
              : reasons.some((item) => !item.reason)
                ? "Waiting for an eligible worker to claim"
                : [...new Set(reasons.map((item) => item.reason))].join("; ");
      return {
        ...task,
        status:
          task.paused && (turn.status === "queued" || turn.status === "pending")
            ? "paused"
            : turn.status,
        turnId: turn.id,
        workerId: turn.workerId,
        provider: this.getSession(task.sessionId).provider,
        waitingReason,
        workers: reasons,
      };
    });
  }

  override recoverExpired(now: number): number {
    const expired = this.db
      .prepare(`SELECT turns.* FROM turns JOIN sessions ON sessions.id = turns.sessionId
      WHERE turns.status = 'running' AND turns.leaseUntil <= ? AND sessions.provider = 'demo'`)
      .all(now) as unknown as Turn[];
    for (const turn of expired) {
      const checkpoint = this.db
        .prepare(
          "SELECT checkpoints.output FROM checkpoints JOIN sessions ON sessions.checkpointId = checkpoints.id WHERE sessions.id = ? AND checkpoints.turnId = ?",
        )
        .get(turn.sessionId, turn.id);
      this.db
        .prepare(`UPDATE turns SET status = 'queued', workerId = NULL, leaseUntil = NULL, generation = generation + 1,
        output = ?, error = 'Demo attempt lost; recovering the last durable checkpoint.' WHERE id = ?`)
        .run(checkpoint?.output ?? "", turn.id);
    }
    return expired.length + super.recoverExpired(now);
  }

  claimForWorker(
    id: string,
    now = Date.now(),
    requestId: string = crypto.randomUUID(),
  ): WorkerAssignment | null {
    return this.transaction(() => {
      this.recoverExpired(now);
      const previous = this.db
        .prepare(
          "SELECT * FROM worker_claims WHERE workerId = ? AND requestId = ?",
        )
        .get(id, requestId);
      if (previous) {
        if (!previous.turnId) return null;
        const turn = this.getTurn(String(previous.turnId));
        if (
          turn.status !== "running" ||
          turn.workerId !== id ||
          turn.generation !== previous.generation
        )
          return null;
        const session = this.getSession(turn.sessionId);
        return {
          claim: {
            turn,
            session,
            workspace: this.getWorkspace(session.workspaceId),
          },
          task: this.taskForSession(session.id),
          checkpoint: this.getCheckpoint(session.id),
        };
      }
      const worker = this.listWorkers().find(
        (candidate) => candidate.id === id,
      );
      if (!worker) throw new HarnessError("Worker not found.", 404);
      const candidates = this.db
        .prepare(`SELECT turns.* FROM turns LEFT JOIN tasks ON tasks.sessionId = turns.sessionId
        WHERE turns.status = 'queued' ORDER BY COALESCE(tasks.priority, 0) DESC, turns.createdAt, turns.rowid LIMIT 100`)
        .all() as unknown as Turn[];
      const candidate = candidates.find(
        (turn) => !this.reason(turn, worker, now),
      );
      if (!candidate) {
        this.db
          .prepare("INSERT INTO worker_claims VALUES (?, ?, NULL, NULL, ?)")
          .run(id, requestId, now);
        this.pruneClaimHistory(id);
        return null;
      }
      this.db
        .prepare(
          "UPDATE turns SET status = 'running', workerId = ?, generation = generation + 1, leaseUntil = ?, error = NULL WHERE id = ?",
        )
        .run(id, now + LEASE_MS, candidate.id);
      const turn = this.getTurn(candidate.id);
      this.db
        .prepare("INSERT INTO worker_claims VALUES (?, ?, ?, ?, ?)")
        .run(id, requestId, turn.id, turn.generation, now);
      this.pruneClaimHistory(id);
      const session = this.getSession(turn.sessionId);
      return {
        claim: {
          turn,
          session,
          workspace: this.getWorkspace(session.workspaceId),
        },
        task: this.taskForSession(session.id),
        checkpoint: this.getCheckpoint(session.id),
      };
    });
  }

  private pruneClaimHistory(id: string): void {
    this.db
      .prepare(
        "DELETE FROM worker_claims WHERE workerId = ? AND requestId NOT IN (SELECT requestId FROM worker_claims WHERE workerId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 200)",
      )
      .run(id, id);
  }

  private requireWorkerOwnership(
    workerId: string,
    turnId: string,
    generation: number,
  ): void {
    this.requireOwnership(turnId, generation);
    if (this.getTurn(turnId).workerId !== workerId)
      throw new HarnessError("This turn belongs to another worker.", 403);
  }

  heartbeatWorkerTurn(
    workerId: string,
    turnId: string,
    generation: number,
  ): void {
    this.transaction(() => {
      this.requireWorkerOwnership(workerId, turnId, generation);
      if (!this.heartbeat(turnId, generation, Date.now(), LEASE_MS))
        throw new HarnessError("Turn ownership expired.", 409);
    });
  }

  applyWorkerEvent(
    workerId: string,
    turnId: string,
    generation: number,
    sequence: number,
    event: RuntimeEvent,
  ): void {
    this.transaction(() => {
      this.requireWorkerOwnership(workerId, turnId, generation);
      const hash = digest(JSON.stringify(event));
      const existing = this.db
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
      const last = this.db
        .prepare(
          "SELECT MAX(sequence) AS sequence FROM worker_events WHERE turnId = ? AND generation = ?",
        )
        .get(turnId, generation);
      if (sequence !== Number(last?.sequence ?? 0) + 1)
        throw new HarnessError("Worker event is out of order.", 409);
      if (event.type === "text") {
        const result = this.db
          .prepare(
            "UPDATE turns SET output = output || ? WHERE id = ? AND length(CAST(output AS BLOB)) + length(CAST(? AS BLOB)) <= 262144",
          )
          .run(event.text, turnId, event.text);
        if (!result.changes)
          throw new HarnessError("Turn output exceeded 256 KiB.");
      } else if (event.type === "native-session") {
        this.db
          .prepare(
            "UPDATE sessions SET nativeId = ?, ownerWorkerId = ? WHERE id = (SELECT sessionId FROM turns WHERE id = ?)",
          )
          .run(event.id, workerId, turnId);
      } else throw new HarnessError("Checkpoints use the checkpoint endpoint.");
      this.db
        .prepare("INSERT INTO worker_events VALUES (?, ?, ?, ?)")
        .run(turnId, generation, sequence, hash);
    });
  }

  saveCheckpoint(
    workerId: string,
    turnId: string,
    generation: number,
    id: string,
    snapshot: FileSnapshot,
  ): void {
    this.transaction(() => {
      this.requireWorkerOwnership(workerId, turnId, generation);
      const turn = this.getTurn(turnId);
      const session = this.getSession(turn.sessionId);
      if (session.provider !== "demo")
        throw new HarnessError(
          "Portable native provider checkpoints are not enabled yet.",
          409,
        );
      const existing = this.db
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
      this.db
        .prepare("INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          id,
          session.id,
          turnId,
          session.nativeId,
          JSON.stringify(snapshot),
          turn.output,
          Date.now(),
        );
      this.db
        .prepare("UPDATE sessions SET checkpointId = ? WHERE id = ?")
        .run(id, session.id);
      // Bound retained checkpoint history for the local test bench.
      this.db
        .prepare(
          "DELETE FROM checkpoints WHERE sessionId = ? AND id NOT IN (SELECT id FROM checkpoints WHERE sessionId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 3)",
        )
        .run(session.id, session.id);
    });
  }

  getCheckpoint(sessionId: string): SessionCheckpoint | null {
    const row = this.db
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
      snapshot: JSON.parse(String(row.snapshot)) as FileSnapshot,
      createdAt: Number(row.createdAt),
    };
  }

  completeWorkerTurn(
    workerId: string,
    turnId: string,
    generation: number,
    status: "completed" | "failed" | "interrupted",
    error?: string,
  ): void {
    const turn = this.getTurn(turnId);
    // A lost completion acknowledgement returns the already committed outcome.
    if (
      turn.status === status &&
      turn.workerId === workerId &&
      turn.generation === generation
    )
      return;
    this.requireWorkerOwnership(workerId, turnId, generation);
    if (
      status === "completed" &&
      this.getSession(turn.sessionId).provider === "demo" &&
      this.getCheckpoint(turn.sessionId)?.turnId !== turn.id
    ) {
      throw new HarnessError(
        "A final checkpoint is required before Demo completion.",
        409,
      );
    }
    this.finish(turnId, generation, status, error);
  }
}
