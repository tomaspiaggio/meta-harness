import { getStore } from "./store";

type Job = {
  id: string;
  turnId: string;
  workerId: string | null;
  sandboxId: string | null;
  status: string;
  expiresAt: number;
};
function limit(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${name}.`);
  return value;
}
export function sandboxCredentials() {
  return process.env.VERCEL_TOKEN &&
    process.env.VERCEL_TEAM_ID &&
    process.env.VERCEL_PROJECT_ID
    ? {
        token: process.env.VERCEL_TOKEN,
        teamId: process.env.VERCEL_TEAM_ID,
        projectId: process.env.VERCEL_PROJECT_ID,
      }
    : {};
}
/** Optional cold capacity. No cloud calls occur without both deployment and workspace opt-in. */
export async function reconcileSandboxes() {
  if (process.env.HARNESS_SANDBOX_ENABLED !== "1") return;
  const origin = process.env.HARNESS_PUBLIC_URL;
  const snapshotId = process.env.HARNESS_SANDBOX_SNAPSHOT_ID;
  if (!origin || new URL(origin).protocol !== "https:" || !snapshotId)
    throw new Error(
      "Sandbox requires a reachable HTTPS control plane and a prepared immutable worker snapshot.",
    );
  const maximum = limit("HARNESS_SANDBOX_MAX_CONCURRENT", 1, 1, 4);
  const daily = limit("HARNESS_SANDBOX_MAX_STARTS_PER_DAY", 4, 1, 50);
  const duration = limit("HARNESS_SANDBOX_TIMEOUT_MS", 900000, 60000, 3600000);
  const vcpus = limit("HARNESS_SANDBOX_VCPUS", 1, 1, 4);
  const store = await getStore();
  const db = store.databaseConnection();
  const { Sandbox } = await import("@vercel/sandbox");
  const credentials = sandboxCredentials();
  for (const row of await db
    .prepare(
      "SELECT * FROM sandbox_jobs WHERE status IN ('starting','running','stopping')",
    )
    .all()) {
    const job = row as unknown as Job;
    const turn = await store.getTurn(job.turnId);
    if (
      !["completed", "interrupted", "failed"].includes(turn.status) &&
      job.expiresAt > Date.now() &&
      job.status !== "stopping"
    )
      continue;
    if (job.workerId) await store.revokeWorker(job.workerId);
    await db
      .prepare("UPDATE sandbox_jobs SET status = 'stopping' WHERE id = ?")
      .run(job.id);
    if (job.sandboxId) {
      try {
        await (
          await Sandbox.get({ name: job.sandboxId, ...credentials })
        ).stop();
      } catch {
        continue;
      }
    }
    await db
      .prepare("UPDATE sandbox_jobs SET status = 'stopped' WHERE id = ?")
      .run(job.id);
  }
  const turns = await db
    .prepare(
      "SELECT turns.* FROM turns WHERE status = 'queued' AND NOT EXISTS (SELECT 1 FROM sandbox_jobs WHERE sandbox_jobs.turnId = turns.id) ORDER BY createdAt LIMIT 10",
    )
    .all();
  for (const turn of turns) {
    const session = await store.getSession(String(turn.sessionId));
    const policy = await store.resourcePolicy(session.workspaceId);
    if (!["fallback", "sandbox"].includes(String(policy.capacity))) continue;
    const task = (await store.listTasks()).find(
      (task) => task.sessionId === session.id,
    );
    if (task?.paused || task?.targetWorkerId || task?.profile === "browser")
      continue;
    if (
      policy.capacity === "fallback" &&
      (await store.waitingReason(String(turn.id))) === null
    )
      continue;
    // A prepared snapshot must advertise only proven portable runtime state.
    if (
      session.nativeId &&
      session.provider !== "demo" &&
      session.provider !== "claude"
    )
      continue;
    const bindings = policy.secrets as { env: string }[];
    if (
      session.provider !== "demo" &&
      !bindings.some(
        (binding) =>
          binding.env ===
          (session.provider === "claude"
            ? "ANTHROPIC_API_KEY"
            : "OPENAI_API_KEY"),
      )
    )
      continue;
    const id = `sandbox:${turn.id}`;
    const reservation = await db.transaction(async () => {
      const active = await db
        .prepare(
          "SELECT COUNT(*) AS count FROM sandbox_jobs WHERE status IN ('starting','running','stopping')",
        )
        .get();
      const used = await db
        .prepare(
          "SELECT COUNT(*) AS count FROM sandbox_jobs WHERE createdAt >= ?",
        )
        .get(Date.now() - 86400000);
      if (
        Number(active?.count) >= maximum ||
        Number(used?.count) >= daily ||
        (await db.prepare("SELECT 1 FROM sandbox_jobs WHERE id = ?").get(id))
      )
        return null;
      const worker = await store.createEphemeralWorker(
        "Sandbox",
        String(turn.id),
        Date.now() + duration,
      );
      await db
        .prepare(
          "INSERT INTO sandbox_jobs(id,turnId,workerId,status,expiresAt,createdAt) VALUES (?,?,?,'starting',?,?)",
        )
        .run(id, turn.id, worker.id, Date.now() + duration, Date.now());
      return worker;
    });
    if (!reservation) continue;
    let sandbox: Awaited<ReturnType<typeof Sandbox.create>> | undefined;
    try {
      sandbox = await Sandbox.create({
        source: { type: "snapshot", snapshotId },
        resources: { vcpus },
        timeout: duration,
        ...credentials,
      });
      // Provisioning may outlive owner deletion; never launch a revoked job.
      await store.getTurn(String(turn.id));
      await db
        .prepare("UPDATE sandbox_jobs SET sandboxId = ? WHERE id = ?")
        .run(sandbox.name, id);
      const credential = "/tmp/harness-worker.json";
      await sandbox.writeFiles([
        {
          path: credential,
          content: Buffer.from(
            JSON.stringify({ ...reservation, serverUrl: origin }),
          ),
        },
      ]);
      const permissions = await sandbox.runCommand({
        cmd: "chmod",
        args: ["600", credential],
      });
      if (permissions.exitCode !== 0)
        throw new Error("Worker credential permissions failed.");
      const workerPath =
        process.env.HARNESS_SANDBOX_WORKER_PATH ??
        "/vercel/sandbox/meta-harness/apps/worker";
      await sandbox.runCommand({
        cmd: "node",
        args: ["--import", "tsx", "src/index.ts"],
        cwd: workerPath,
        sudo: true,
        detached: true,
        timeoutMs: duration,
        env: {
          HARNESS_WORKER_TOKEN_FILE: credential,
          HARNESS_CONTROL_URL: origin,
          HARNESS_PROVIDERS: session.provider,
          HARNESS_CLAUDE_RUNTIME: "sdk",
          HARNESS_BROWSER_ENABLED: "0",
          HARNESS_ISOLATE_AGENTS: "1",
          HARNESS_WORKER_LABELS: "sandbox",
          HARNESS_CONCURRENCY: "1",
          HARNESS_MEMORY_BUDGET_MIB: String(vcpus * 1536),
          HARNESS_WORKER_DATA_DIR: "/tmp/harness-work",
          HARNESS_TURN_TIMEOUT_MS: String(Math.max(1000, duration - 30000)),
        },
      });
      await db
        .prepare("UPDATE sandbox_jobs SET status = 'running' WHERE id = ?")
        .run(id);
    } catch {
      await store.revokeWorker(reservation.id);
      if (sandbox) await sandbox.stop().catch(() => {});
      await db
        .prepare(
          "UPDATE sandbox_jobs SET status = 'failed', error = 'Provisioning had no confirmed success; inspect Sandbox before retrying.' WHERE id = ?",
        )
        .run(id);
    }
  }
}
