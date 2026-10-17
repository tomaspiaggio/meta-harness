import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ClaimedTurn,
  HarnessError,
  type Provider,
  type Session,
  type Turn,
  type TurnStore,
  type Workspace,
} from "@harness/core";

export function dataDirectory(): string {
  // pnpm supplies the repository root to every child via scripts/dev.mjs.
  return resolve(
    /* turbopackIgnore: true */ process.env.HARNESS_DATA_DIR ?? "../../.data",
  );
}

export class SqliteStore implements TurnStore {
  private db: DatabaseSync;

  constructor(path = resolve(dataDirectory(), "harness.sqlite")) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
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
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_turn_per_session
      ON turns(sessionId) WHERE status IN ('pending', 'queued', 'running');
      CREATE INDEX IF NOT EXISTS turns_queue ON turns(status, createdAt);
      CREATE INDEX IF NOT EXISTS turns_session ON turns(sessionId, createdAt);
    `);
    const seed = this.db.prepare(
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

  close() {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listWorkspaces(): Workspace[] {
    return this.db
      .prepare("SELECT * FROM workspaces ORDER BY name")
      .all() as unknown as Workspace[];
  }

  createWorkspace(name: string, instructions: string): Workspace {
    const workspace = { id: crypto.randomUUID(), name, instructions };
    this.db
      .prepare("INSERT INTO workspaces VALUES (?, ?, ?)")
      .run(workspace.id, name, instructions);
    return workspace;
  }

  getWorkspace(id: string): Workspace {
    const row = this.db
      .prepare("SELECT * FROM workspaces WHERE id = ?")
      .get(id);
    if (!row) throw new HarnessError("Workspace not found.", 404);
    return row as unknown as Workspace;
  }

  listSessions(workspaceId: string): Session[] {
    return this.db
      .prepare(
        "SELECT * FROM sessions WHERE workspaceId = ? ORDER BY createdAt DESC LIMIT 100",
      )
      .all(workspaceId) as unknown as Session[];
  }

  getSession(id: string): Session {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    if (!row) throw new HarnessError("Session not found.", 404);
    return row as unknown as Session;
  }

  createSession(
    workspaceId: string,
    title: string,
    provider: Provider,
  ): Session {
    this.getWorkspace(workspaceId);
    const session: Session = {
      id: crypto.randomUUID(),
      workspaceId,
      title,
      provider,
      nativeId: null,
      createdAt: Date.now(),
    };
    this.db
      .prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)")
      .run(session.id, workspaceId, title, provider, null, session.createdAt);
    return session;
  }

  createTurn(id: string, sessionId: string, prompt: string): Turn {
    return this.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM turns WHERE id = ?")
        .get(id) as unknown as Turn | undefined;
      if (existing) {
        if (existing.sessionId !== sessionId || existing.prompt !== prompt) {
          throw new HarnessError(
            "Idempotency key was already used for different input.",
            409,
          );
        }
        return existing;
      }
      this.getSession(sessionId);
      const active = this.db
        .prepare(
          "SELECT id FROM turns WHERE sessionId = ? AND status IN ('pending', 'queued', 'running')",
        )
        .get(sessionId);
      if (active)
        throw new HarnessError("This session already has an active turn.", 409);
      this.db
        .prepare(
          "INSERT INTO turns(id, sessionId, prompt, createdAt) VALUES (?, ?, ?, ?)",
        )
        .run(id, sessionId, prompt, Date.now());
      return this.getTurn(id);
    });
  }

  getTurn(id: string): Turn {
    const row = this.db.prepare("SELECT * FROM turns WHERE id = ?").get(id);
    if (!row) throw new HarnessError("Turn not found.", 404);
    return row as unknown as Turn;
  }

  listTurns(sessionId: string): Turn[] {
    // Bound responses and browser memory. The full history remains on disk.
    return this.db
      .prepare(
        "SELECT * FROM (SELECT * FROM turns WHERE sessionId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 50) ORDER BY createdAt",
      )
      .all(sessionId) as unknown as Turn[];
  }

  pendingDispatch(): string[] {
    return this.db
      .prepare(
        "SELECT id FROM turns WHERE status = 'pending' ORDER BY createdAt LIMIT 10",
      )
      .all()
      .map((row) => String(row.id));
  }

  attachRun(id: string, runId: string): void {
    this.db
      .prepare("UPDATE turns SET runId = ? WHERE id = ? AND runId IS NULL")
      .run(runId, id);
  }

  enqueue(id: string): void {
    this.getTurn(id);
    this.db
      .prepare(
        "UPDATE turns SET status = 'queued' WHERE id = ? AND status = 'pending'",
      )
      .run(id);
  }

  recoverExpired(now: number): number {
    // Never rerun an interrupted agent automatically: its effects are uncertain.
    return Number(
      this.db
        .prepare(`UPDATE turns SET status = 'interrupted', leaseUntil = NULL,
      generation = generation + 1, error = 'Worker lease expired. Inspect partial work before continuing.'
      WHERE status = 'running' AND leaseUntil <= ?`)
        .run(now).changes,
    );
  }

  claim(workerId: string, now: number, leaseMs: number): ClaimedTurn | null {
    return this.transaction(() => {
      this.recoverExpired(now);
      const candidate = this.db
        .prepare(
          "SELECT id FROM turns WHERE status = 'queued' ORDER BY createdAt, rowid LIMIT 1",
        )
        .get();
      if (!candidate) return null;
      const id = String(candidate.id);
      this.db
        .prepare(
          "UPDATE turns SET status = 'running', workerId = ?, generation = generation + 1, leaseUntil = ? WHERE id = ?",
        )
        .run(workerId, now + leaseMs, id);
      const turn = this.getTurn(id);
      const session = this.getSession(turn.sessionId);
      return {
        turn,
        session,
        workspace: this.getWorkspace(session.workspaceId),
      };
    });
  }

  heartbeat(
    id: string,
    generation: number,
    now: number,
    leaseMs: number,
  ): boolean {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE turns SET leaseUntil = ? WHERE id = ? AND generation = ? AND status = 'running' AND leaseUntil > ?",
          )
          .run(now + leaseMs, id, generation, now).changes,
      ) === 1
    );
  }

  private requireOwnership(id: string, generation: number): void {
    const turn = this.getTurn(id);
    if (
      turn.status !== "running" ||
      turn.generation !== generation ||
      (turn.leaseUntil ?? 0) <= Date.now()
    ) {
      throw new HarnessError("Turn ownership expired.", 409);
    }
  }

  appendOutput(id: string, generation: number, text: string): void {
    this.transaction(() => {
      this.requireOwnership(id, generation);
      const result = this.db
        .prepare(
          "UPDATE turns SET output = output || ? WHERE id = ? AND length(CAST(output AS BLOB)) + length(CAST(? AS BLOB)) <= 262144",
        )
        .run(text, id, text);
      if (!result.changes)
        throw new HarnessError("Turn output exceeded 256 KiB.");
    });
  }

  saveNativeId(id: string, generation: number, nativeId: string): void {
    this.transaction(() => {
      this.requireOwnership(id, generation);
      this.db
        .prepare(
          "UPDATE sessions SET nativeId = ? WHERE id = (SELECT sessionId FROM turns WHERE id = ?)",
        )
        .run(nativeId, id);
    });
  }

  finish(
    id: string,
    generation: number,
    status: "completed" | "failed" | "interrupted",
    error?: string,
  ): void {
    this.transaction(() => {
      this.requireOwnership(id, generation);
      this.db
        .prepare(
          "UPDATE turns SET status = ?, error = ?, leaseUntil = NULL WHERE id = ?",
        )
        .run(status, error ?? null, id);
    });
  }
}
