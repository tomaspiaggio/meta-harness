import { HarnessError } from "@harness/core";
import type { SqlDatabase } from "./database";

export type DeletedKind = "workspace" | "session" | "browser";
/** Database deletion and the durable cleanup outbox commit together. No network I/O. */
export async function deleteResource(
  db: SqlDatabase,
  kind: "workspace" | "session",
  id: string,
) {
  return db.transaction(async () => {
    if (
      await db
        .prepare("SELECT 1 FROM deleted_resources WHERE kind = ? AND id = ?")
        .get(kind, id)
    )
      return;
    const row = await db
      .prepare(
        kind === "workspace"
          ? "SELECT id FROM workspaces WHERE id = ?"
          : "SELECT id FROM sessions WHERE id = ?",
      )
      .get(id);
    if (!row)
      throw new HarnessError(
        `${kind === "workspace" ? "Workspace" : "Session"} not found.`,
        404,
      );
    const tombstone = async (type: DeletedKind, resourceId: string) => {
      await db
        .prepare("INSERT OR IGNORE INTO deleted_resources VALUES (?, ?, ?)")
        .run(type, resourceId, Date.now());
    };
    const cleanup = async (type: string, value: string) => {
      await db
        .prepare(
          "INSERT OR IGNORE INTO cleanup_jobs(id, kind, payload, nextAt) VALUES (?, ?, ?, ?)",
        )
        .run(`${type}:${value}`, type, value, Date.now());
    };
    const sessions =
      kind === "session"
        ? [{ id }]
        : await db
            .prepare("SELECT id FROM sessions WHERE workspaceId = ?")
            .all(id);
    for (const session of sessions) {
      const sessionId = String(session.id);
      const turns = await db
        .prepare("SELECT id, runId FROM turns WHERE sessionId = ?")
        .all(sessionId);
      for (const schedule of await db
        .prepare("SELECT id FROM schedules WHERE sessionId = ?")
        .all(sessionId)) {
        for (const wake of await db
          .prepare(
            "SELECT runId FROM schedule_wakes WHERE scheduleId = ? AND runId IS NOT NULL",
          )
          .all(schedule.id))
          await cleanup("run", String(wake.runId));
        await db
          .prepare("DELETE FROM schedule_wakes WHERE scheduleId = ?")
          .run(schedule.id);
        await db
          .prepare("DELETE FROM schedule_occurrences WHERE scheduleId = ?")
          .run(schedule.id);
      }
      await db
        .prepare("DELETE FROM schedules WHERE sessionId = ?")
        .run(sessionId);
      // Accepted shared knowledge is independent of a conversation; detach source links.
      await db
        .prepare(
          "UPDATE decision_history SET sessionId = NULL, turnId = NULL WHERE sessionId = ?",
        )
        .run(sessionId);
      for (const turn of turns) {
        const turnId = String(turn.id);
        if (turn.runId) await cleanup("run", String(turn.runId));
        for (const waiter of await db
          .prepare("SELECT runId FROM workflow_waiters WHERE turnId = ?")
          .all(turnId))
          await cleanup("run", String(waiter.runId));
        for (const sandbox of await db
          .prepare(
            "SELECT sandboxId FROM sandbox_jobs WHERE turnId = ? AND sandboxId IS NOT NULL",
          )
          .all(turnId))
          await cleanup("sandbox", String(sandbox.sandboxId));
        for (const grant of await db
          .prepare("SELECT workerId FROM worker_grants WHERE turnId = ?")
          .all(turnId))
          await db
            .prepare(
              "UPDATE workers SET tokenHash = ?, draining = 1 WHERE id = ?",
            )
            .run(crypto.randomUUID(), grant.workerId);
        await db
          .prepare("UPDATE decision_history SET turnId = NULL WHERE turnId = ?")
          .run(turnId);
        await db
          .prepare(
            "UPDATE worker_claims SET turnId = NULL, generation = NULL WHERE turnId = ?",
          )
          .run(turnId);
        // Fixed application-authored table names. Keep foreign-key constraints enabled.
        for (const table of [
          "schedule_occurrences",
          "turn_attachments",
          "browser_commands",
          "input_requests",
          "sandbox_jobs",
          "operation_ledger",
          "worker_grants",
          "workflow_waiters",
          "workflow_wakeups",
          "session_attention",
          "worker_events",
          "turn_knowledge",
          "checkpoints",
        ])
          await db.prepare(`DELETE FROM ${table} WHERE turnId = ?`).run(turnId);
      }
      for (const attachment of await db
        .prepare("SELECT objectKey FROM attachments WHERE sessionId = ?")
        .all(sessionId))
        await cleanup("object", String(attachment.objectKey));
      for (const table of [
        "notification_outbox",
        "channel_bindings",
        "input_requests",
        "title_jobs",
        "telegram_updates",
        "native_entries",
        "native_writes",
        "checkpoints",
        "session_attention",
        "attachments",
        "tasks",
        "turns",
      ])
        await db
          .prepare(`DELETE FROM ${table} WHERE sessionId = ?`)
          .run(sessionId);
      await tombstone("session", sessionId);
      await db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    }
    if (kind === "workspace") {
      for (const browser of await db
        .prepare("SELECT id FROM browser_identities WHERE workspaceId = ?")
        .all(id)) {
        await db
          .prepare("DELETE FROM browser_commands WHERE browserId = ?")
          .run(browser.id);
        await tombstone("browser", String(browser.id));
      }
      await db
        .prepare("DELETE FROM browser_identities WHERE workspaceId = ?")
        .run(id);
      await db
        .prepare("DELETE FROM workspace_resources WHERE workspaceId = ?")
        .run(id);
      await db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
      await tombstone("workspace", id);
    }
  });
}
