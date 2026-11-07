import { HarnessError } from "@harness/core";
import {
  type Goal,
  type GoalChange,
  type GoalEvent,
  type GoalEventKind,
  type GoalStatus,
  type GoalStep,
  type GoalTarget,
  goalProgress,
} from "@harness/core/goals";
import type { SqlDatabase } from "./database";

export const goalSchema = `
CREATE TABLE IF NOT EXISTS goals (
 id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL, sessionId TEXT NOT NULL, title TEXT NOT NULL,
 summary TEXT NOT NULL, why TEXT NOT NULL, status TEXT NOT NULL, currently TEXT NOT NULL, etaAt INTEGER,
 startsWhen TEXT NOT NULL, steps TEXT NOT NULL, targets TEXT NOT NULL, targetNote TEXT NOT NULL,
 createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, finishedAt INTEGER
);
CREATE INDEX IF NOT EXISTS goals_workspace ON goals(workspaceId, status);
CREATE TABLE IF NOT EXISTS goal_events (
 id TEXT PRIMARY KEY, goalId TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, author TEXT NOT NULL,
 done INTEGER NOT NULL, total INTEGER NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS goal_events_goal ON goal_events(goalId, at);
CREATE INDEX IF NOT EXISTS goal_events_at ON goal_events(at);
CREATE TABLE IF NOT EXISTS goal_links (
 kind TEXT NOT NULL, refId TEXT NOT NULL, goalId TEXT NOT NULL, PRIMARY KEY(kind, refId)
);
`;

/** Something the owner must do: a question to answer or a sign-in. */
export interface OwnerNeed {
  id: string;
  kind: string;
  message: string;
  sessionId: string;
  sessionTitle: string;
  workspaceId: string;
  goalId: string | null;
  createdAt: number;
}
/** A session working toward a goal: its planner, or one given a task for it. */
export interface GoalPerson {
  sessionId: string;
  title: string;
  planner: boolean;
  working: boolean;
}
/** A goal's events on one day, for the home page's history. */
export interface GoalEventWithGoal extends GoalEvent {
  goalTitle: string;
  workspaceId: string;
}

export class GoalStore {
  constructor(private db: SqlDatabase) {}
  private goal(row: Record<string, unknown>): Goal {
    return {
      id: String(row.id),
      workspaceId: String(row.workspaceId),
      sessionId: String(row.sessionId),
      title: String(row.title),
      summary: String(row.summary),
      why: String(row.why),
      status: String(row.status) as GoalStatus,
      now: String(row.currently),
      etaAt: row.etaAt === null ? null : Number(row.etaAt),
      startsWhen: String(row.startsWhen),
      steps: JSON.parse(String(row.steps)) as GoalStep[],
      targets: JSON.parse(String(row.targets)) as GoalTarget[],
      targetNote: String(row.targetNote),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      finishedAt: row.finishedAt === null ? null : Number(row.finishedAt),
    };
  }
  private event(row: Record<string, unknown>): GoalEvent {
    return {
      id: String(row.id),
      goalId: String(row.goalId),
      kind: String(row.kind) as GoalEventKind,
      text: String(row.text),
      by: String(row.author),
      done: Number(row.done),
      total: Number(row.total),
      at: Number(row.at),
    };
  }
  async get(id: string): Promise<Goal> {
    const row = await this.db
      .prepare("SELECT * FROM goals WHERE id = ?")
      .get(id);
    if (!row) throw new HarnessError("Goal not found.", 404);
    return this.goal(row);
  }
  /**
   * Goals in play: active and planned ones, plus those finished or dropped
   * since `endedSince`.
   */
  async list(
    filter: { workspaceId?: string; endedSince?: number } = {},
  ): Promise<Goal[]> {
    const values: (string | number)[] = [filter.endedSince ?? 0];
    let where =
      "(goals.status IN ('active', 'next') OR goals.updatedAt >= ?) AND EXISTS (SELECT 1 FROM workspaces WHERE workspaces.id = goals.workspaceId)";
    if (filter.workspaceId) {
      where += " AND goals.workspaceId = ?";
      values.push(filter.workspaceId);
    }
    return (
      await this.db
        .prepare(
          `SELECT * FROM goals WHERE ${where} ORDER BY goals.createdAt LIMIT 200`,
        )
        .all(...values)
    ).map((row) => this.goal(row));
  }
  private async record(
    goal: Goal,
    kind: GoalEventKind,
    text: string,
    by: string,
    at: number,
    order: number,
  ) {
    const progress = goalProgress(goal);
    await this.db
      .prepare(
        "INSERT INTO goal_events(id, goalId, kind, text, author, done, total, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        // Events of one update share a time; the ID keeps them in order.
        `${String(order).padStart(2, "0")}-${crypto.randomUUID()}`,
        goal.id,
        kind,
        text,
        by,
        progress.done,
        progress.total,
        at,
      );
  }
  /** Creates a goal; a repeated call with the same ID returns the first. */
  async create(
    id: string,
    workspaceId: string,
    sessionId: string,
    change: GoalChange,
    now = Date.now(),
  ): Promise<Goal> {
    return this.db.transaction(async () => {
      const existing = await this.db
        .prepare("SELECT * FROM goals WHERE id = ?")
        .get(id);
      if (existing) return this.goal(existing);
      const input = change.goal;
      const ended = input.status === "done" || input.status === "dropped";
      await this.db
        .prepare(
          `INSERT INTO goals(id, workspaceId, sessionId, title, summary, why, status, currently, etaAt, startsWhen, steps, targets, targetNote, createdAt, updatedAt, finishedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          workspaceId,
          sessionId,
          input.title,
          input.summary,
          input.why,
          input.status,
          input.now,
          input.etaAt,
          input.startsWhen,
          JSON.stringify(input.steps),
          JSON.stringify(input.targets),
          input.targetNote,
          now,
          now,
          ended ? now : null,
        );
      const goal = await this.get(id);
      await this.record(goal, "started", change.change, "", now, 0);
      for (const [index, decision] of change.decisions.entries())
        await this.record(
          goal,
          "decision",
          decision.text,
          decision.by,
          now,
          index + 1,
        );
      return goal;
    });
  }
  async update(
    id: string,
    workspaceId: string,
    change: GoalChange,
    now = Date.now(),
  ): Promise<Goal> {
    return this.db.transaction(async () => {
      const before = await this.get(id);
      if (before.workspaceId !== workspaceId)
        throw new HarnessError("That goal belongs to another workspace.", 403);
      const input = change.goal;
      const ended = input.status === "done" || input.status === "dropped";
      const wasEnded = before.status === "done" || before.status === "dropped";
      await this.db
        .prepare(
          `UPDATE goals SET title = ?, summary = ?, why = ?, status = ?, currently = ?, etaAt = ?, startsWhen = ?,
          steps = ?, targets = ?, targetNote = ?, updatedAt = ?, finishedAt = ? WHERE id = ?`,
        )
        .run(
          input.title,
          input.summary,
          input.why,
          input.status,
          input.now,
          input.etaAt,
          input.startsWhen,
          JSON.stringify(input.steps),
          JSON.stringify(input.targets),
          input.targetNote,
          now,
          ended ? (wasEnded ? before.finishedAt : now) : null,
          id,
        );
      const goal = await this.get(id);
      await this.record(
        goal,
        ended && !wasEnded ? "finished" : "progress",
        change.change,
        "",
        now,
        0,
      );
      for (const [index, decision] of change.decisions.entries())
        await this.record(
          goal,
          "decision",
          decision.text,
          decision.by,
          now,
          index + 1,
        );
      return goal;
    });
  }
  async events(goalId: string): Promise<GoalEvent[]> {
    return (
      await this.db
        .prepare(
          "SELECT * FROM goal_events WHERE goalId = ? ORDER BY at, id LIMIT 500",
        )
        .all(goalId)
    ).map((row) => this.event(row));
  }
  /** Every goal's events since a time, oldest first, for the daily history. */
  async eventsSince(since: number): Promise<GoalEventWithGoal[]> {
    return (
      await this.db
        .prepare(
          `SELECT goal_events.*, goals.title AS "goalTitle", goals.workspaceId AS "workspaceId"
          FROM goal_events JOIN goals ON goals.id = goal_events.goalId
          WHERE goal_events.at >= ? ORDER BY goal_events.at, goal_events.id LIMIT 1000`,
        )
        .all(since)
    ).map((row) => ({
      ...this.event(row),
      goalTitle: String(row.goalTitle),
      workspaceId: String(row.workspaceId),
    }));
  }
  /** Ties a task or an owner question to the goal it serves. */
  async link(kind: "task" | "input", refId: string, goalId: string) {
    await this.db
      .prepare(
        "INSERT INTO goal_links(kind, refId, goalId) VALUES (?, ?, ?) ON CONFLICT(kind, refId) DO NOTHING",
      )
      .run(kind, refId, goalId);
  }
  /** The planner, then each session given a task for this goal. */
  async people(goal: Goal): Promise<GoalPerson[]> {
    const planner = await this.db
      .prepare("SELECT id, title FROM sessions WHERE id = ?")
      .get(goal.sessionId);
    const workers = await this.db
      .prepare(
        `SELECT sessions.id, sessions.title, MAX(CASE WHEN delegations.status = 'open' THEN 1 ELSE 0 END) AS "working"
        FROM goal_links JOIN delegations ON delegations.id = goal_links.refId
        JOIN sessions ON sessions.id = delegations.toSessionId
        WHERE goal_links.kind = 'task' AND goal_links.goalId = ?
        GROUP BY sessions.id, sessions.title ORDER BY MAX(delegations.updatedAt) DESC`,
      )
      .all(goal.id);
    return [
      ...(planner
        ? [
            {
              sessionId: String(planner.id),
              title: String(planner.title),
              planner: true,
              working: false,
            },
          ]
        : []),
      ...workers.map((row) => ({
        sessionId: String(row.id),
        title: String(row.title),
        planner: false,
        working: Number(row.working) === 1,
      })),
    ];
  }
  /**
   * Open questions and sign-ins for the owner, each with the goal it serves:
   * the one its question was asked for, or the goal of the task its session
   * is working on.
   */
  async needs(): Promise<OwnerNeed[]> {
    return (
      await this.db
        .prepare(
          `SELECT input_requests.id, input_requests.kind, input_requests.message, input_requests.createdAt,
          sessions.id AS "sessionId", sessions.title AS "sessionTitle", sessions.workspaceId AS "workspaceId",
          COALESCE(
            (SELECT goalId FROM goal_links WHERE kind = 'input' AND refId = input_requests.id),
            (SELECT goal_links.goalId FROM goal_links JOIN delegations ON delegations.id = goal_links.refId
              WHERE goal_links.kind = 'task' AND delegations.toSessionId = sessions.id AND delegations.status = 'open'
              ORDER BY delegations.updatedAt DESC LIMIT 1)
          ) AS "goalId"
          FROM input_requests JOIN sessions ON sessions.id = input_requests.sessionId
          WHERE input_requests.status = 'pending' ORDER BY input_requests.createdAt LIMIT 50`,
        )
        .all()
    ).map((row) => ({
      id: String(row.id),
      kind: String(row.kind),
      message: String(row.message),
      sessionId: String(row.sessionId),
      sessionTitle: String(row.sessionTitle),
      workspaceId: String(row.workspaceId),
      goalId: row.goalId === null ? null : String(row.goalId),
      createdAt: Number(row.createdAt),
    }));
  }
}
