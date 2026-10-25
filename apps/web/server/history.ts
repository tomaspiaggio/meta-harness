import { HarnessError, requiredText } from "@harness/core";
import type { HarnessStore } from "@harness/storage/application";

/**
 * Read-only conversation history for agents. This is a single-owner harness,
 * so an agent may read any of the owner's sessions on demand — for example the
 * conversation behind a shared decision. Results are bounded and paginated
 * instead of injected; credentials and browser frames never live in turns.
 */
const TURN_CHARS = 6000;
type Row = Record<string, unknown>;

function clip(value: unknown, limit = TURN_CHARS) {
  const text = String(value ?? "");
  return text.length > limit
    ? `${text.slice(0, limit)}\n[…${text.length - limit} more characters; read with a narrower window]`
    : text;
}
function limitArg(value: unknown, fallback: number, maximum: number) {
  const number = Number(value ?? fallback);
  return Number.isInteger(number) && number >= 1
    ? Math.min(number, maximum)
    : fallback;
}

async function sessionInfo(store: HarnessStore, sessionId: string) {
  const row = (await store
    .databaseConnection()
    .prepare(
      "SELECT sessions.id, sessions.title, sessions.provider, sessions.workspaceId, workspaces.name AS workspace FROM sessions LEFT JOIN workspaces ON workspaces.id = sessions.workspaceId WHERE sessions.id = ?",
    )
    .get(sessionId)) as Row | undefined;
  if (!row)
    throw new HarnessError(
      "That session no longer exists (it may have been deleted).",
      404,
    );
  return row;
}

function turnView(row: Row) {
  return {
    turnId: row.id,
    at: new Date(Number(row.createdAt)).toISOString(),
    status: row.status,
    owner: clip(row.prompt),
    agent: clip(row.output),
  };
}

/** Turns of a session, newest page first unless anchored on a turn. */
export async function readSession(
  store: HarnessStore,
  args: Record<string, unknown>,
) {
  const sessionId = requiredText(args.session_id, "session_id", 100);
  const info = await sessionInfo(store, sessionId);
  const limit = limitArg(args.limit, 6, 12);
  const db = store.databaseConnection();
  let rows: Row[];
  if (typeof args.around_turn_id === "string") {
    const anchor = (await db
      .prepare("SELECT createdAt FROM turns WHERE id = ? AND sessionId = ?")
      .get(String(args.around_turn_id), sessionId)) as Row | undefined;
    if (!anchor) throw new HarnessError("Turn not found in that session.", 404);
    const before = (await db
      .prepare(
        "SELECT * FROM turns WHERE sessionId = ? AND createdAt < ? ORDER BY createdAt DESC LIMIT ?",
      )
      .all(sessionId, Number(anchor.createdAt), Math.ceil(limit / 2))) as Row[];
    const after = (await db
      .prepare(
        "SELECT * FROM turns WHERE sessionId = ? AND createdAt >= ? ORDER BY createdAt ASC LIMIT ?",
      )
      .all(
        sessionId,
        Number(anchor.createdAt),
        limit - before.length,
      )) as Row[];
    rows = [...before.reverse(), ...after];
  } else {
    const before = Number(args.before ?? Number.MAX_SAFE_INTEGER);
    rows = (
      (await db
        .prepare(
          "SELECT * FROM turns WHERE sessionId = ? AND createdAt < ? ORDER BY createdAt DESC LIMIT ?",
        )
        .all(sessionId, before, limit)) as Row[]
    ).reverse();
  }
  const total = Number(
    (
      (await db
        .prepare("SELECT COUNT(*) AS count FROM turns WHERE sessionId = ?")
        .get(sessionId)) as Row
    ).count,
  );
  return {
    session: info,
    totalTurns: total,
    turns: rows.map(turnView),
    ...(rows.length && rows.length < total
      ? {
          olderPage: { session_id: sessionId, before: rows[0].createdAt },
        }
      : {}),
  };
}

/** Find past conversation turns mentioning the given words. */
export async function searchHistory(
  store: HarnessStore,
  args: Record<string, unknown>,
) {
  const query = requiredText(args.query, "query", 200).toLowerCase();
  const limit = limitArg(args.limit, 8, 20);
  const rows = (await store
    .databaseConnection()
    .prepare(
      "SELECT turns.id, turns.sessionId, turns.createdAt, turns.prompt, turns.output, sessions.title, workspaces.name AS workspace FROM turns JOIN sessions ON sessions.id = turns.sessionId LEFT JOIN workspaces ON workspaces.id = sessions.workspaceId WHERE LOWER(turns.prompt) LIKE ? OR LOWER(turns.output) LIKE ? ORDER BY turns.createdAt DESC LIMIT ?",
    )
    .all(`%${query}%`, `%${query}%`, limit)) as Row[];
  const snippet = (text: unknown) => {
    const value = String(text ?? "");
    const index = value.toLowerCase().indexOf(query);
    if (index < 0) return "";
    return value
      .slice(Math.max(0, index - 160), index + query.length + 240)
      .replace(/\s+/g, " ");
  };
  return {
    matches: rows.map((row) => ({
      session_id: row.sessionId,
      session: row.title,
      workspace: row.workspace,
      turnId: row.id,
      at: new Date(Number(row.createdAt)).toISOString(),
      excerpt: snippet(row.prompt) || snippet(row.output),
    })),
    hint: "Use session_read with session_id and around_turn_id to read a match in context.",
  };
}

/** The conversation that wrote a shared decision, around the writing turn. */
export async function decisionSource(
  store: HarnessStore,
  args: Record<string, unknown>,
) {
  const key = requiredText(args.key, "key", 100);
  const db = store.databaseConnection();
  const decision = (await db
    .prepare(
      typeof args.revision === "number"
        ? "SELECT * FROM decision_history WHERE key = ? AND revision = ?"
        : "SELECT * FROM decision_history WHERE key = ? ORDER BY revision DESC LIMIT 1",
    )
    .get(
      ...(typeof args.revision === "number" ? [key, args.revision] : [key]),
    )) as Row | undefined;
  if (!decision) throw new HarnessError("No decision with that key.", 404);
  const revisions = (await db
    .prepare(
      "SELECT revision, sessionId, turnId, updatedAt FROM decision_history WHERE key = ? ORDER BY revision",
    )
    .all(key)) as Row[];
  if (!decision.sessionId)
    return {
      decision,
      revisions,
      source: "unavailable: this revision was recorded without a session",
    };
  try {
    return {
      decision,
      revisions,
      conversation: await readSession(store, {
        session_id: decision.sessionId,
        ...(decision.turnId ? { around_turn_id: decision.turnId } : {}),
        limit: args.limit ?? 6,
      }),
    };
  } catch (error) {
    return {
      decision,
      revisions,
      source: `unavailable: ${error instanceof Error ? error.message : "source conversation missing"}`,
    };
  }
}

export async function listWorkspacesWithSessions(store: HarnessStore) {
  const workspaces = await store.listWorkspaces();
  return Promise.all(
    workspaces.map(async (workspace) => ({
      id: workspace.id,
      name: workspace.name,
      sessions: (await store.listSessions(workspace.id))
        .slice(0, 30)
        .map((session) => ({ session_id: session.id, title: session.title })),
    })),
  );
}
