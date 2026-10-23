import { getRun } from "workflow/api";
import { getObjects } from "./objects";
import { sandboxCredentials } from "./sandbox";
import { getStore } from "./store";

/** External cleanup retries independently; deleted resources are already inaccessible. */
export async function cleanupDeleted() {
  const db = (await getStore()).databaseConnection();
  for (const job of await db
    .prepare(
      "SELECT * FROM cleanup_jobs WHERE nextAt <= ? AND (leaseUntil IS NULL OR leaseUntil < ?) LIMIT 20",
    )
    .all(Date.now(), Date.now())) {
    const claimed = await db
      .prepare(
        "UPDATE cleanup_jobs SET leaseUntil = ? WHERE id = ? AND (leaseUntil IS NULL OR leaseUntil < ?)",
      )
      .run(Date.now() + 60000, job.id, Date.now());
    if (!claimed.changes) continue;
    try {
      const payload = String(job.payload);
      if (job.kind === "object") await (await getObjects()).delete(payload);
      else if (job.kind === "run") {
        const run = getRun(payload);
        if (!["completed", "failed", "cancelled"].includes(await run.status))
          await run.cancel();
      } else if (job.kind === "sandbox") {
        const { Sandbox } = await import("@vercel/sandbox");
        await (
          await Sandbox.get({ name: payload, ...sandboxCredentials() })
        ).stop();
      } else throw new Error("Unknown cleanup kind");
      await db.prepare("DELETE FROM cleanup_jobs WHERE id = ?").run(job.id);
    } catch {
      await db
        .prepare(
          "UPDATE cleanup_jobs SET leaseUntil = NULL, nextAt = ?, error = 'Cleanup will retry' WHERE id = ?",
        )
        .run(Date.now() + 60000, job.id);
    }
  }
}
