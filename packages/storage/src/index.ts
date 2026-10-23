import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ClaimedTurn,
  HarnessError,
  isTerminal,
  type Provider,
  requiredText,
  type Session,
  type Turn,
  type TurnStore,
  type Workspace,
} from "@harness/core";
import { parseModel } from "@harness/core/models";
import { LocalDatabase, type SqlDatabase } from "./database";
export function dataDirectory(): string {
  // pnpm supplies the repository root to every child via scripts/dev.mjs.
  return resolve(
    // Read at runtime: bundlers must not trace mutable databases as source files.
    Reflect.get(process.env, "HARNESS_DATA_DIR") ?? "../../.data",
  );
}
export class SqliteStore implements TurnStore {
  protected db: SqlDatabase;
  ready: Promise<void> = Promise.resolve();
  constructor(
    path: string | SqlDatabase = resolve(dataDirectory(), "harness.sqlite"),
  ) {
    if (typeof path !== "string") {
      this.db = path;
      this.ready = this.seedDefaults();
      return;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const raw = new DatabaseSync(path);
    raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA cache_size = -2048;
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id),
        title TEXT NOT NULL, provider TEXT NOT NULL, nativeId TEXT,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id),
        prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', runId TEXT,
        workerId TEXT, generation INTEGER NOT NULL DEFAULT 0, leaseUntil INTEGER,
        output TEXT NOT NULL DEFAULT '', error TEXT, createdAt INTEGER NOT NULL
      );
      DROP INDEX IF EXISTS one_active_turn_per_session;
      CREATE UNIQUE INDEX IF NOT EXISTS one_running_turn_per_session
      ON turns(sessionId) WHERE status = 'running';
      CREATE INDEX IF NOT EXISTS turns_queue ON turns(status, createdAt);
      CREATE INDEX IF NOT EXISTS turns_session ON turns(sessionId, createdAt);
    `);
    (() => {
      const turnColumns = raw.prepare("PRAGMA table_info(turns)").all();
      for (const [name, type] of [
        ["stopRequestedAt", "INTEGER"],
        ["model", "TEXT"],
        ["interruptsTurnId", "TEXT"],
      ]) {
        if (!turnColumns.some((column) => column.name === name))
          raw.exec(`ALTER TABLE turns ADD COLUMN ${name} ${type}`);
      }
      if (
        !raw
          .prepare("PRAGMA table_info(sessions)")
          .all()
          .some((column) => column.name === "titleSource")
      )
        raw.exec(
          "ALTER TABLE sessions ADD COLUMN titleSource TEXT NOT NULL DEFAULT 'prompt'",
        );
      if (
        !raw
          .prepare("PRAGMA table_info(sessions)")
          .all()
          .some((column) => column.name === "readThroughSequence")
      )
        raw.exec(
          "ALTER TABLE sessions ADD COLUMN readThroughSequence INTEGER NOT NULL DEFAULT 0",
        );
      if (
        !raw
          .prepare("PRAGMA table_info(sessions)")
          .all()
          .some((column) => column.name === "model")
      )
        raw.exec("ALTER TABLE sessions ADD COLUMN model TEXT");
      raw.exec(`
        CREATE TABLE IF NOT EXISTS session_attention (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          sessionId TEXT NOT NULL REFERENCES sessions(id),
          turnId TEXT NOT NULL UNIQUE REFERENCES turns(id), createdAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS session_attention_session ON session_attention(sessionId, sequence);
        CREATE TRIGGER IF NOT EXISTS terminal_turn_attention AFTER UPDATE OF status ON turns
        WHEN NEW.status IN ('completed', 'failed', 'interrupted') AND OLD.status NOT IN ('completed', 'failed', 'interrupted')
        BEGIN
          INSERT OR IGNORE INTO session_attention(sessionId, turnId, createdAt)
          VALUES (NEW.sessionId, NEW.id, CAST(unixepoch('subsec') * 1000 AS INTEGER));
        END;
      `);
    })();
    raw.exec(
      "CREATE TABLE IF NOT EXISTS harness_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    const initialized = raw
      .prepare("SELECT 1 FROM harness_settings WHERE key = 'seeded'")
      .get();
    if (!initialized) {
      if (!raw.prepare("SELECT 1 FROM workspaces LIMIT 1").get()) {
        const seed = raw.prepare(
          "INSERT OR IGNORE INTO workspaces VALUES (?, ?, ?)",
        );
        for (const [id, name, instructions] of [
          ["business", "Business", "Find and develop customer opportunities."],
          [
            "tech",
            "Tech",
            "Build reliable software and record technical decisions.",
          ],
          [
            "fundraising",
            "Fundraising",
            "Develop the fundraising narrative and investor relationships.",
          ],
        ])
          seed.run(id, name, instructions);
      }
      raw
        .prepare(
          "INSERT OR IGNORE INTO harness_settings VALUES ('seeded', '1')",
        )
        .run();
    }
    this.db = new LocalDatabase(raw, path);
  }
  async close() {
    await this.db.close();
  }
  protected async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.db.transaction(async () => await fn());
  }
  private async seedDefaults() {
    await this.transaction(async () => {
      const inserted = await this.db
        .prepare(
          "INSERT OR IGNORE INTO harness_settings VALUES ('seeded', '1')",
        )
        .run();
      if (
        !inserted.changes ||
        (await this.db.prepare("SELECT 1 FROM workspaces LIMIT 1").get())
      )
        return;
      for (const [id, name, instructions] of [
        ["business", "Business", "Find and develop customer opportunities."],
        [
          "tech",
          "Tech",
          "Build reliable software and record technical decisions.",
        ],
        [
          "fundraising",
          "Fundraising",
          "Develop the fundraising narrative and investor relationships.",
        ],
      ])
        await this.db
          .prepare("INSERT OR IGNORE INTO workspaces VALUES (?, ?, ?)")
          .run(id, name, instructions);
    });
  }
  async listWorkspaces(): Promise<Workspace[]> {
    return (await this.db
      .prepare("SELECT * FROM workspaces ORDER BY name")
      .all()) as unknown as Workspace[];
  }
  async createWorkspace(
    name: string,
    instructions: string,
  ): Promise<Workspace> {
    const workspace = { id: crypto.randomUUID(), name, instructions };
    await this.db
      .prepare("INSERT INTO workspaces VALUES (?, ?, ?)")
      .run(workspace.id, name, instructions);
    return workspace;
  }
  async getWorkspace(id: string): Promise<Workspace> {
    const row = await this.db
      .prepare("SELECT * FROM workspaces WHERE id = ?")
      .get(id);
    if (!row) throw new HarnessError("Workspace not found.", 404);
    return row as unknown as Workspace;
  }
  async listSessions(workspaceId: string): Promise<Session[]> {
    return (await this.db
      .prepare(
        `SELECT * FROM (${this.sessionProjection()}) AS session_view WHERE workspaceId = ? ORDER BY (unreadCount > 0) DESC, lastActivityAt DESC, createdAt DESC LIMIT 100`,
      )
      .all(workspaceId)) as unknown as Session[];
  }
  async getSession(id: string): Promise<Session> {
    const row = await this.db
      .prepare(`${this.sessionProjection()} WHERE id = ?`)
      .get(id);
    if (!row) throw new HarnessError("Session not found.", 404);
    return row as unknown as Session;
  }
  private sessionProjection(): string {
    return `SELECT sessions.*,
      (SELECT COUNT(*) FROM session_attention WHERE sessionId = sessions.id AND sequence > sessions.readThroughSequence) AS unreadCount,
      COALESCE((SELECT MAX(sequence) FROM session_attention WHERE sessionId = sessions.id), 0) AS attentionSequence,
      MAX(createdAt,
        COALESCE((SELECT MAX(createdAt) FROM turns WHERE sessionId = sessions.id), 0),
        COALESCE((SELECT MAX(createdAt) FROM session_attention WHERE sessionId = sessions.id), 0)) AS lastActivityAt
      FROM sessions`;
  }
  async markSessionRead(id: string, throughSequence: number): Promise<Session> {
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 0)
      throw new HarnessError("Invalid read cursor.");
    const session = await this.getSession(id);
    await this.db
      .prepare(
        "UPDATE sessions SET readThroughSequence = MAX(readThroughSequence, ?) WHERE id = ?",
      )
      .run(Math.min(throughSequence, session.attentionSequence ?? 0), id);
    return await this.getSession(id);
  }
  async renameSession(id: string, title: string): Promise<Session> {
    await this.getSession(id);
    await this.db
      .prepare(
        "UPDATE sessions SET title = ?, titleSource = 'manual' WHERE id = ?",
      )
      .run(requiredText(title, "Title", 100), id);
    return await this.getSession(id);
  }
  async createSession(
    workspaceId: string,
    title: string,
    provider: Provider,
    model: string | null = null,
  ): Promise<Session> {
    await this.getWorkspace(workspaceId);
    const session: Session = {
      id: crypto.randomUUID(),
      workspaceId,
      title,
      provider,
      model: parseModel(provider, model),
      nativeId: null,
      createdAt: Date.now(),
    };
    await this.db
      .prepare(
        "INSERT INTO sessions(id, workspaceId, title, provider, nativeId, createdAt, model) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        session.id,
        workspaceId,
        title,
        provider,
        null,
        session.createdAt,
        session.model ?? null,
      );
    return session;
  }
  async createTurn(
    id: string,
    sessionId: string,
    prompt: string,
    interruptsTurnId?: string,
  ): Promise<Turn> {
    return await this.transaction(async () => {
      const existing = (await this.db
        .prepare("SELECT * FROM turns WHERE id = ?")
        .get(id)) as unknown as Turn | undefined;
      if (existing) {
        if (
          existing.sessionId !== sessionId ||
          existing.prompt !== prompt ||
          (existing.interruptsTurnId ?? null) !== (interruptsTurnId ?? null)
        ) {
          throw new HarnessError(
            "Idempotency key was already used for different input.",
            409,
          );
        }
        return existing;
      }
      const session = await this.getSession(sessionId);
      const waiting = await this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM turns WHERE sessionId = ? AND status IN ('pending', 'queued')",
        )
        .get(sessionId);
      if (Number(waiting?.count) >= 100)
        throw new HarnessError(
          "This session already has 100 waiting messages.",
          409,
        );
      if (interruptsTurnId) {
        if ((await this.getTurn(interruptsTurnId)).sessionId !== sessionId)
          throw new HarnessError(
            "Interrupted turn belongs to another session.",
            409,
          );
        await this.requestStopInternal(interruptsTurnId);
      }
      await this.db
        .prepare(
          "INSERT INTO turns(id, sessionId, prompt, createdAt, interruptsTurnId, model) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          sessionId,
          prompt,
          Date.now(),
          interruptsTurnId ?? null,
          session.model ?? null,
        );
      return await this.getTurn(id);
    });
  }
  async requestStop(id: string): Promise<Turn> {
    return await this.transaction(
      async () => await this.requestStopInternal(id),
    );
  }
  private async requestStopInternal(id: string): Promise<Turn> {
    const turn = await this.getTurn(id);
    if (isTerminal(turn.status)) return turn;
    await this.db
      .prepare(`UPDATE turns SET stopRequestedAt = COALESCE(stopRequestedAt, ?),
      status = CASE WHEN status = 'running' THEN status ELSE 'interrupted' END,
      error = CASE WHEN status = 'running' THEN error ELSE 'Stopped by you before execution.' END
      WHERE id = ?`)
      .run(Date.now(), id);
    return await this.getTurn(id);
  }
  async getTurn(id: string): Promise<Turn> {
    const row = await this.db
      .prepare("SELECT * FROM turns WHERE id = ?")
      .get(id);
    if (!row) throw new HarnessError("Turn not found.", 404);
    return row as unknown as Turn;
  }
  async listTurns(sessionId: string): Promise<Turn[]> {
    // Bound responses and browser memory. The full history remains on disk.
    return (await this.db
      .prepare(
        "SELECT * FROM (SELECT * FROM turns WHERE sessionId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 50) ORDER BY createdAt",
      )
      .all(sessionId)) as unknown as Turn[];
  }
  async pendingDispatch(): Promise<string[]> {
    return (
      await this.db
        .prepare(
          "SELECT id FROM turns WHERE status = 'pending' ORDER BY createdAt LIMIT 10",
        )
        .all()
    ).map((row) => String(row.id));
  }
  async attachRun(id: string, runId: string): Promise<void> {
    await this.db
      .prepare("UPDATE turns SET runId = ? WHERE id = ? AND runId IS NULL")
      .run(runId, id);
  }
  async enqueue(id: string): Promise<void> {
    await this.getTurn(id);
    await this.db
      .prepare(
        "UPDATE turns SET status = 'queued' WHERE id = ? AND status = 'pending'",
      )
      .run(id);
  }
  async recoverExpired(now: number): Promise<number> {
    // Never rerun an interrupted agent automatically: its effects are uncertain.
    return Number(
      (
        await this.db
          .prepare(`UPDATE turns SET status = 'interrupted', leaseUntil = NULL,
      generation = generation + 1, error = 'Worker lease expired. Inspect partial work before continuing.'
      WHERE status = 'running' AND leaseUntil <= ?`)
          .run(now)
      ).changes,
    );
  }
  async claim(
    workerId: string,
    now: number,
    leaseMs: number,
  ): Promise<ClaimedTurn | null> {
    return await this.transaction(async () => {
      await this.recoverExpired(now);
      const candidate = await this.db
        .prepare(`SELECT id FROM turns WHERE status = 'queued' AND NOT EXISTS (
            SELECT 1 FROM turns AS prior WHERE prior.sessionId = turns.sessionId
            AND (prior.status = 'running' OR (prior.status IN ('pending', 'queued') AND prior.rowid < turns.rowid))
          ) ORDER BY createdAt, rowid LIMIT 1`)
        .get();
      if (!candidate) return null;
      const id = String(candidate.id);
      await this.db
        .prepare(
          "UPDATE turns SET status = 'running', workerId = ?, generation = generation + 1, leaseUntil = ? WHERE id = ?",
        )
        .run(workerId, now + leaseMs, id);
      const turn = await this.getTurn(id);
      const session = await this.getSession(turn.sessionId);
      return {
        turn,
        session,
        workspace: await this.getWorkspace(session.workspaceId),
      };
    });
  }
  async heartbeat(
    id: string,
    generation: number,
    now: number,
    leaseMs: number,
  ): Promise<boolean> {
    return (
      Number(
        (
          await this.db
            .prepare(
              "UPDATE turns SET leaseUntil = ? WHERE id = ? AND generation = ? AND status = 'running' AND leaseUntil > ?",
            )
            .run(now + leaseMs, id, generation, now)
        ).changes,
      ) === 1
    );
  }
  protected async requireOwnership(
    id: string,
    generation: number,
  ): Promise<void> {
    const turn = await this.getTurn(id);
    if (
      turn.status !== "running" ||
      turn.generation !== generation ||
      (turn.leaseUntil ?? 0) <= Date.now()
    ) {
      throw new HarnessError("Turn ownership expired.", 409);
    }
  }
  async appendOutput(
    id: string,
    generation: number,
    text: string,
  ): Promise<void> {
    await this.transaction(async () => {
      await this.requireOwnership(id, generation);
      const result = await this.db
        .prepare(
          "UPDATE turns SET output = output || ? WHERE id = ? AND length(CAST(output AS BLOB)) + length(CAST(? AS BLOB)) <= 262144",
        )
        .run(text, id, text);
      if (!result.changes)
        throw new HarnessError("Turn output exceeded 256 KiB.");
    });
  }
  async saveNativeId(
    id: string,
    generation: number,
    nativeId: string,
  ): Promise<void> {
    await this.transaction(async () => {
      await this.requireOwnership(id, generation);
      await this.db
        .prepare(
          "UPDATE sessions SET nativeId = ? WHERE id = (SELECT sessionId FROM turns WHERE id = ?)",
        )
        .run(nativeId, id);
    });
  }
  async finish(
    id: string,
    generation: number,
    status: "completed" | "failed" | "interrupted",
    error?: string,
  ): Promise<void> {
    await this.transaction(async () => {
      await this.requireOwnership(id, generation);
      await this.db
        .prepare(
          "UPDATE turns SET status = ?, error = ?, leaseUntil = NULL WHERE id = ?",
        )
        .run(status, error ?? null, id);
    });
  }
}
