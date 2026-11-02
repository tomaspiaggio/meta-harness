import { createHash, randomBytes } from "node:crypto";
import { HarnessError, requiredText } from "@harness/core";
import { nextOccurrence } from "@harness/core/automations";
import {
  type ExtensionManifest,
  type ExtensionRunResult,
  eventMessage,
  MAX_EXTENSION_STATE,
  missingSettings,
  parseExtensionCode,
  parseExtensionManifest,
} from "@harness/core/extensions";
import type { JsonValue } from "@harness/core/integrations";
import {
  labelList,
  parseLabels,
  type WorkerRecord,
  workerLabels,
} from "@harness/core/scheduling";
import type { SqlDatabase } from "./database";

/** The label a worker reports when it can run extension scripts. */
export const EXTENSION_RUNTIME_LABEL = "deno";
/** A worker that stops reporting loses its run this long after the timeout. */
const RUN_GRACE_MS = 30000;
/** Queued runs no worker took in this long are dropped; the next tick retries. */
const QUEUED_EXPIRY_MS = 60 * 60000;
const MAX_QUEUED_RUNS = 50;
const KEEP_RUNS = 200;
const KEEP_EVENTS = 2000;

export interface ExtensionRevision {
  extensionId: string;
  revision: number;
  manifest: ExtensionManifest;
  hash: string;
  status: "proposed" | "approved" | "rejected" | "superseded";
  proposedBy: string;
  note: string | null;
  createdAt: number;
  decidedAt: number | null;
}
export interface Extension {
  id: string;
  activeRevision: number | null;
  enabled: boolean;
  config: Record<string, string | number | boolean>;
  /** Names of secret settings that have a stored value. */
  secretNames: string[];
  requiredLabels: string[];
  webhookToken: string;
  createdAt: number;
  updatedAt: number;
  /** The approved manifest that runs, if any. */
  manifest: ExtensionManifest | null;
  /** The newest revision waiting for the owner, if any. */
  proposal: ExtensionRevision | null;
  /** Required settings that still have no value. */
  missing: string[];
  lastRun: ExtensionRun | null;
}
export interface ExtensionRun {
  id: string;
  extensionId: string;
  revision: number;
  trigger: string;
  status: "queued" | "running" | "completed" | "failed" | "skipped";
  workerId: string | null;
  leaseUntil: number | null;
  events: number;
  logs: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}
export interface ExtensionEventRecord {
  id: string;
  extensionId: string;
  key: string;
  runId: string;
  type: string;
  title: string;
  text: string;
  url: string | null;
  data: JsonValue;
  createdAt: number;
}
export interface ExtensionSubscription {
  id: string;
  extensionId: string;
  sessionId: string;
  /** Event types this session wants; empty means all. */
  types: string[];
  createdBy: string;
  createdAt: number;
}
/** What a worker needs to run one script; secrets are still sealed. */
export interface ExtensionAssignment {
  run: ExtensionRun;
  manifest: ExtensionManifest;
  code: string;
  config: Record<string, string | number | boolean>;
  secrets: string | null;
  state: Record<string, JsonValue>;
  request: JsonValue;
}

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const text = (value: unknown) => (value == null ? null : String(value));
const number = (value: unknown) => (value == null ? null : Number(value));
const revisionRow = (row: Record<string, unknown>): ExtensionRevision => ({
  extensionId: String(row.extensionId),
  revision: Number(row.revision),
  manifest: JSON.parse(String(row.manifest)),
  hash: String(row.hash),
  status: String(row.status) as ExtensionRevision["status"],
  proposedBy: String(row.proposedBy),
  note: text(row.note),
  createdAt: Number(row.createdAt),
  decidedAt: number(row.decidedAt),
});
const runRow = (row: Record<string, unknown>): ExtensionRun => ({
  id: String(row.id),
  extensionId: String(row.extensionId),
  revision: Number(row.revision),
  trigger: String(row.trigger),
  status: String(row.status) as ExtensionRun["status"],
  workerId: text(row.workerId),
  leaseUntil: number(row.leaseUntil),
  events: Number(row.events),
  logs: text(row.logs),
  error: text(row.error),
  createdAt: Number(row.createdAt),
  startedAt: number(row.startedAt),
  finishedAt: number(row.finishedAt),
});
const eventRow = (row: Record<string, unknown>): ExtensionEventRecord => ({
  id: String(row.id),
  extensionId: String(row.extensionId),
  key: String(row.key),
  runId: String(row.runId),
  type: String(row.type),
  title: String(row.title),
  text: String(row.text),
  url: text(row.url),
  data: row.data == null ? null : JSON.parse(String(row.data)),
  createdAt: Number(row.createdAt),
});
const subscriptionRow = (
  row: Record<string, unknown>,
): ExtensionSubscription => ({
  id: String(row.id),
  extensionId: String(row.extensionId),
  sessionId: String(row.sessionId),
  types: labelList(text(row.types)),
  createdBy: String(row.createdBy),
  createdAt: Number(row.createdAt),
});

/** Store methods for extensions; the caller supplies transactions and turns. */
export class ExtensionStore {
  constructor(
    private db: SqlDatabase,
    private createTurn: (
      id: string,
      sessionId: string,
      prompt: string,
    ) => Promise<unknown>,
    private session: (id: string) => Promise<{ id: string }>,
  ) {}
  private transaction<T>(action: () => Promise<T>): Promise<T> {
    return this.db.transaction(action);
  }
  private async row(id: string) {
    const row = await this.db
      .prepare("SELECT * FROM extensions WHERE id = ?")
      .get(id);
    if (!row) throw new HarnessError("Extension not found.", 404);
    return row;
  }
  private async view(row: Record<string, unknown>): Promise<Extension> {
    const id = String(row.id);
    const activeRevision = number(row.activeRevision);
    const active =
      activeRevision === null ? null : await this.revision(id, activeRevision);
    const pending = await this.db
      .prepare(
        "SELECT * FROM extension_revisions WHERE extensionId = ? AND status = 'proposed' ORDER BY revision DESC LIMIT 1",
      )
      .get(id);
    const last = await this.db
      .prepare(
        "SELECT * FROM extension_runs WHERE extensionId = ? ORDER BY createdAt DESC LIMIT 1",
      )
      .get(id);
    const config = JSON.parse(String(row.config));
    const secretNames = labelList(
      text(row.secrets) ? String(JSON.parse(String(row.secrets)).names) : null,
    );
    return {
      id,
      activeRevision,
      enabled: Number(row.enabled) === 1,
      config,
      secretNames,
      requiredLabels: labelList(text(row.requiredLabels)),
      webhookToken: String(row.webhookToken),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      manifest: active?.manifest ?? null,
      proposal: pending ? revisionRow(pending) : null,
      missing: active
        ? missingSettings(active.manifest, [
            ...Object.keys(config),
            ...secretNames,
          ])
        : [],
      lastRun: last ? runRow(last) : null,
    };
  }
  async list(): Promise<Extension[]> {
    const rows = await this.db
      .prepare("SELECT * FROM extensions ORDER BY id")
      .all();
    return Promise.all(rows.map((row) => this.view(row)));
  }
  async get(id: string): Promise<Extension> {
    return this.view(await this.row(id));
  }
  async revision(id: string, revision: number): Promise<ExtensionRevision> {
    const row = await this.db
      .prepare(
        "SELECT * FROM extension_revisions WHERE extensionId = ? AND revision = ?",
      )
      .get(id, revision);
    if (!row) throw new HarnessError("Extension revision not found.", 404);
    return revisionRow(row);
  }
  async revisionCode(id: string, revision: number): Promise<string> {
    const row = await this.db
      .prepare(
        "SELECT code FROM extension_revisions WHERE extensionId = ? AND revision = ?",
      )
      .get(id, revision);
    if (!row) throw new HarnessError("Extension revision not found.", 404);
    return String(row.code);
  }
  async revisions(id: string): Promise<ExtensionRevision[]> {
    return (
      await this.db
        .prepare(
          "SELECT * FROM extension_revisions WHERE extensionId = ? ORDER BY revision DESC LIMIT 50",
        )
        .all(id)
    ).map(revisionRow);
  }
  /**
   * A new manifest and script wait for the owner. Nothing runs until they
   * approve it; proposing the same code again returns the existing revision.
   */
  async propose(input: {
    manifest: unknown;
    code: unknown;
    proposedBy: string;
    note?: string | null;
  }): Promise<ExtensionRevision> {
    const manifest = parseExtensionManifest(input.manifest);
    const code = parseExtensionCode(input.code);
    const digest = hash(`${JSON.stringify(manifest)}\n${code}`);
    const proposedBy = requiredText(input.proposedBy, "Proposer", 200);
    const note =
      input.note == null ? null : requiredText(input.note, "Note", 4000);
    const now = Date.now();
    return this.transaction(async () => {
      const existing = await this.db
        .prepare("SELECT * FROM extensions WHERE id = ?")
        .get(manifest.id);
      if (!existing)
        await this.db
          .prepare(
            "INSERT INTO extensions(id, webhookToken, createdAt, updatedAt) VALUES (?, ?, ?, ?)",
          )
          .run(manifest.id, randomBytes(24).toString("base64url"), now, now);
      const same = await this.db
        .prepare(
          "SELECT * FROM extension_revisions WHERE extensionId = ? AND hash = ? AND status IN ('proposed', 'approved') ORDER BY revision DESC LIMIT 1",
        )
        .get(manifest.id, digest);
      if (same) return revisionRow(same);
      const latest = await this.db
        .prepare(
          "SELECT MAX(revision) AS revision FROM extension_revisions WHERE extensionId = ?",
        )
        .get(manifest.id);
      const revision = Number(latest?.revision ?? 0) + 1;
      await this.db
        .prepare(
          "UPDATE extension_revisions SET status = 'superseded', decidedAt = ? WHERE extensionId = ? AND status = 'proposed'",
        )
        .run(now, manifest.id);
      await this.db
        .prepare(
          "INSERT INTO extension_revisions(extensionId, revision, manifest, code, hash, status, proposedBy, note, createdAt) VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?)",
        )
        .run(
          manifest.id,
          revision,
          JSON.stringify(manifest),
          code,
          digest,
          proposedBy,
          note,
          now,
        );
      await this.db
        .prepare("UPDATE extensions SET updatedAt = ? WHERE id = ?")
        .run(now, manifest.id);
      return this.revision(manifest.id, revision);
    });
  }
  /**
   * Approving makes a revision the one that runs; approving an older approved
   * one rolls back. Rejecting only closes a proposal.
   */
  async decide(
    id: string,
    revision: number,
    decision: "approve" | "reject",
  ): Promise<Extension> {
    const now = Date.now();
    return this.transaction(async () => {
      const row = await this.row(id);
      const target = await this.revision(id, revision);
      if (decision === "reject") {
        if (target.status !== "proposed")
          throw new HarnessError("Only a proposal can be rejected.", 409);
        await this.db
          .prepare(
            "UPDATE extension_revisions SET status = 'rejected', decidedAt = ? WHERE extensionId = ? AND revision = ?",
          )
          .run(now, id, revision);
      } else {
        if (target.status !== "proposed" && target.status !== "approved")
          throw new HarnessError(
            "Only a proposal or an earlier approved revision can run.",
            409,
          );
        await this.db
          .prepare(
            "UPDATE extension_revisions SET status = 'approved', decidedAt = COALESCE(decidedAt, ?) WHERE extensionId = ? AND revision = ?",
          )
          .run(now, id, revision);
        // A rollback leaves newer proposals for the owner to decide later.
        await this.db
          .prepare(
            "UPDATE extensions SET activeRevision = ?, enabled = ?, updatedAt = ? WHERE id = ?",
          )
          .run(
            revision,
            number(row.activeRevision) === null ? 1 : Number(row.enabled),
            now,
            id,
          );
        await this.db
          .prepare("DELETE FROM extension_timers WHERE extensionId = ?")
          .run(id);
        await this.cancelQueued(id, "A different revision was approved.");
      }
      return this.get(id);
    });
  }
  private async cancelQueued(id: string, reason: string) {
    await this.db
      .prepare(
        "UPDATE extension_runs SET status = 'skipped', error = ?, finishedAt = ? WHERE extensionId = ? AND status = 'queued'",
      )
      .run(reason, Date.now(), id);
  }
  async configure(
    id: string,
    input: {
      enabled?: boolean;
      config?: Record<string, string | number | boolean>;
      /** Sealed secrets and the names they hold, or undefined to keep them. */
      secrets?: { sealed: string; names: string[] } | null;
      requiredLabels?: unknown;
      rotateWebhook?: boolean;
    },
  ): Promise<Extension> {
    const now = Date.now();
    return this.transaction(async () => {
      const row = await this.row(id);
      if (input.enabled === true && number(row.activeRevision) === null)
        throw new HarnessError(
          "Approve a revision before turning the extension on.",
          409,
        );
      await this.db
        .prepare(
          "UPDATE extensions SET enabled = ?, config = ?, secrets = ?, requiredLabels = ?, webhookToken = ?, updatedAt = ? WHERE id = ?",
        )
        .run(
          input.enabled === undefined
            ? Number(row.enabled)
            : input.enabled
              ? 1
              : 0,
          input.config === undefined
            ? String(row.config)
            : JSON.stringify(input.config),
          input.secrets === undefined
            ? text(row.secrets)
            : input.secrets === null
              ? null
              : JSON.stringify({
                  sealed: input.secrets.sealed,
                  names: input.secrets.names.join(","),
                }),
          input.requiredLabels === undefined
            ? text(row.requiredLabels)
            : parseLabels(input.requiredLabels).join(",") || null,
          input.rotateWebhook
            ? randomBytes(24).toString("base64url")
            : String(row.webhookToken),
          now,
          id,
        );
      if (input.enabled === false)
        await this.cancelQueued(id, "The extension was turned off.");
      return this.get(id);
    });
  }
  /** The sealed secrets blob, for the control process to open. */
  async sealedSecrets(id: string): Promise<string | null> {
    const row = await this.row(id);
    return text(row.secrets) ? JSON.parse(String(row.secrets)).sealed : null;
  }
  async remove(id: string): Promise<void> {
    await this.transaction(async () => {
      await this.row(id);
      if (
        await this.db
          .prepare(
            "SELECT 1 AS present FROM extension_runs WHERE extensionId = ? AND status = 'running' LIMIT 1",
          )
          .get(id)
      )
        throw new HarnessError(
          "A run is in progress. Turn the extension off and try again in a minute.",
          409,
        );
      for (const table of [
        "extension_subscriptions",
        "extension_events",
        "extension_state",
        "extension_runs",
        "extension_timers",
        "extension_revisions",
      ])
        await this.db
          .prepare(`DELETE FROM ${table} WHERE extensionId = ?`)
          .run(id);
      await this.db.prepare("DELETE FROM extensions WHERE id = ?").run(id);
    });
  }
  async subscribe(input: {
    extensionId: string;
    sessionId: string;
    types?: unknown;
    createdBy: string;
  }): Promise<ExtensionSubscription> {
    const types = input.types === undefined ? [] : parseEventTypes(input.types);
    return this.transaction(async () => {
      await this.row(input.extensionId);
      await this.session(input.sessionId);
      const id = `${input.extensionId}:${input.sessionId}`;
      await this.db
        .prepare(
          "INSERT INTO extension_subscriptions(id, extensionId, sessionId, types, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET types = excluded.types",
        )
        .run(
          id,
          input.extensionId,
          input.sessionId,
          types.join(",") || null,
          input.createdBy,
          Date.now(),
        );
      return subscriptionRow(
        (await this.db
          .prepare("SELECT * FROM extension_subscriptions WHERE id = ?")
          .get(id)) as Record<string, unknown>,
      );
    });
  }
  async unsubscribe(extensionId: string, sessionId: string): Promise<void> {
    await this.db
      .prepare(
        "DELETE FROM extension_subscriptions WHERE extensionId = ? AND sessionId = ?",
      )
      .run(extensionId, sessionId);
  }
  async subscriptions(filter: {
    extensionId?: string;
    sessionId?: string;
  }): Promise<ExtensionSubscription[]> {
    const where = [
      ...(filter.extensionId ? ["extensionId = ?"] : []),
      ...(filter.sessionId ? ["sessionId = ?"] : []),
    ];
    return (
      await this.db
        .prepare(
          `SELECT * FROM extension_subscriptions${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY createdAt`,
        )
        .all(
          ...[filter.extensionId, filter.sessionId].filter(
            (value): value is string => !!value,
          ),
        )
    ).map(subscriptionRow);
  }
  /**
   * Queues a run. Timer runs coalesce with one already waiting or running;
   * webhook runs queue up to a bound so a noisy sender cannot fill the table.
   */
  async enqueue(
    id: string,
    trigger: string,
    request: JsonValue = null,
    now = Date.now(),
  ): Promise<ExtensionRun | null> {
    return this.transaction(async () => {
      const extension = await this.get(id);
      if (!extension.manifest || extension.activeRevision === null)
        throw new HarnessError("This extension has no approved revision.", 409);
      if (!extension.enabled)
        throw new HarnessError("This extension is turned off.", 409);
      const declared = extension.manifest.triggers.find(
        (item) => item.name === trigger,
      );
      if (!declared)
        throw new HarnessError(`This extension has no trigger ${trigger}.`);
      if (extension.missing.length)
        throw new HarnessError(
          `Fill in the extension's settings first: ${extension.missing.join(", ")}.`,
          409,
        );
      if (declared.type === "cron" && request === null) {
        const busy = await this.db
          .prepare(
            "SELECT 1 AS present FROM extension_runs WHERE extensionId = ? AND trigger = ? AND status IN ('queued', 'running') LIMIT 1",
          )
          .get(id, trigger);
        if (busy) return null;
      }
      const queued = Number(
        (
          await this.db
            .prepare(
              "SELECT COUNT(*) AS count FROM extension_runs WHERE extensionId = ? AND status = 'queued'",
            )
            .get(id)
        )?.count,
      );
      if (queued >= MAX_QUEUED_RUNS)
        throw new HarnessError(
          "This extension already has 50 runs waiting.",
          429,
        );
      const runId = crypto.randomUUID();
      await this.db
        .prepare(
          "INSERT INTO extension_runs(id, extensionId, revision, trigger, input, status, createdAt) VALUES (?, ?, ?, ?, ?, 'queued', ?)",
        )
        .run(
          runId,
          id,
          extension.activeRevision,
          trigger,
          request === null ? null : JSON.stringify(request),
          now,
        );
      return runRow(
        (await this.db
          .prepare("SELECT * FROM extension_runs WHERE id = ?")
          .get(runId)) as Record<string, unknown>,
      );
    });
  }
  /**
   * Fires due timers, fails runs whose worker went quiet, and prunes history.
   * Idempotent, so any control instance may run it.
   */
  async tick(now = Date.now()): Promise<void> {
    for (const extension of await this.list()) {
      if (!extension.enabled || !extension.manifest) continue;
      for (const trigger of extension.manifest.triggers) {
        if (trigger.type !== "cron") continue;
        const cron = {
          type: "cron" as const,
          expression: trigger.cron,
          timezone: trigger.timezone,
        };
        const timer = await this.db
          .prepare(
            "SELECT * FROM extension_timers WHERE extensionId = ? AND trigger = ?",
          )
          .get(extension.id, trigger.name);
        if (!timer || Number(timer.revision) !== extension.activeRevision) {
          await this.db
            .prepare(
              "INSERT INTO extension_timers(extensionId, trigger, revision, nextAt) VALUES (?, ?, ?, ?) ON CONFLICT(extensionId, trigger) DO UPDATE SET revision = excluded.revision, nextAt = excluded.nextAt",
            )
            .run(
              extension.id,
              trigger.name,
              extension.activeRevision,
              nextOccurrence(cron, now) ?? now,
            );
          continue;
        }
        if (Number(timer.nextAt) > now) continue;
        const advanced = await this.db
          .prepare(
            "UPDATE extension_timers SET nextAt = ? WHERE extensionId = ? AND trigger = ? AND nextAt = ?",
          )
          .run(
            nextOccurrence(cron, now) ?? now + 60000,
            extension.id,
            trigger.name,
            timer.nextAt,
          );
        // Another control instance fired it first.
        if (!advanced.changes || extension.missing.length) continue;
        await this.enqueue(extension.id, trigger.name, null, now).catch(
          () => null,
        );
      }
    }
    await this.db
      .prepare(
        "UPDATE extension_runs SET status = 'failed', error = 'The worker running it stopped responding.', finishedAt = ? WHERE status = 'running' AND leaseUntil < ?",
      )
      .run(now, now);
    await this.db
      .prepare(
        "UPDATE extension_runs SET status = 'skipped', error = 'No worker with the extension runtime took it within an hour.', finishedAt = ? WHERE status = 'queued' AND createdAt < ?",
      )
      .run(now, now - QUEUED_EXPIRY_MS);
    for (const { id } of await this.db
      .prepare("SELECT id FROM extensions")
      .all()) {
      await this.db
        .prepare(
          "DELETE FROM extension_runs WHERE extensionId = ? AND status NOT IN ('queued', 'running') AND createdAt < (SELECT createdAt FROM extension_runs WHERE extensionId = ? ORDER BY createdAt DESC LIMIT 1 OFFSET ?)",
        )
        .run(id, id, KEEP_RUNS);
      await this.db
        .prepare(
          "DELETE FROM extension_events WHERE extensionId = ? AND createdAt < (SELECT createdAt FROM extension_events WHERE extensionId = ? ORDER BY createdAt DESC LIMIT 1 OFFSET ?)",
        )
        .run(id, id, KEEP_EVENTS);
    }
  }
  /**
   * Hands the oldest runnable script to a worker that has the runtime and the
   * extension's labels. One run per extension at a time keeps its state simple.
   */
  async claim(
    worker: WorkerRecord,
    now = Date.now(),
  ): Promise<ExtensionAssignment | null> {
    const labels = new Set(workerLabels(worker));
    if (
      !labels.has(EXTENSION_RUNTIME_LABEL) ||
      worker.draining ||
      worker.report?.draining
    )
      return null;
    return this.transaction(async () => {
      const candidates = await this.db
        .prepare(
          `SELECT extension_runs.* FROM extension_runs JOIN extensions ON extensions.id = extension_runs.extensionId
          WHERE extension_runs.status = 'queued' AND extensions.enabled = 1
          AND NOT EXISTS (SELECT 1 FROM extension_runs AS other WHERE other.extensionId = extension_runs.extensionId AND other.status = 'running')
          ORDER BY extension_runs.createdAt LIMIT 20`,
        )
        .all();
      for (const candidate of candidates) {
        const run = runRow(candidate);
        const row = await this.row(run.extensionId);
        if (!labelList(text(row.requiredLabels)).every((l) => labels.has(l)))
          continue;
        const revision = await this.revision(run.extensionId, run.revision);
        const claimed = await this.db
          .prepare(
            "UPDATE extension_runs SET status = 'running', workerId = ?, startedAt = ?, leaseUntil = ? WHERE id = ? AND status = 'queued'",
          )
          .run(
            worker.id,
            now,
            now + revision.manifest.timeoutSeconds * 1000 + RUN_GRACE_MS,
            run.id,
          );
        if (!claimed.changes) continue;
        const state: Record<string, JsonValue> = {};
        for (const item of await this.db
          .prepare(
            "SELECT key, value FROM extension_state WHERE extensionId = ?",
          )
          .all(run.extensionId))
          state[String(item.key)] = JSON.parse(String(item.value));
        return {
          run: { ...run, status: "running", workerId: worker.id },
          manifest: revision.manifest,
          code: await this.revisionCode(run.extensionId, run.revision),
          config: JSON.parse(String(row.config)),
          secrets: text(row.secrets)
            ? JSON.parse(String(row.secrets)).sealed
            : null,
          state,
          request:
            candidate.input == null
              ? null
              : JSON.parse(String(candidate.input)),
        };
      }
      return null;
    });
  }
  /**
   * Records what a run did. A failed run changes nothing: its state changes
   * and events are dropped, so the next run sees the same starting point.
   * New events reach each subscribed session as one message.
   */
  async complete(
    workerId: string,
    runId: string,
    result: ExtensionRunResult,
    now = Date.now(),
  ): Promise<{ events: number; turns: string[] }> {
    return this.transaction(async () => {
      const row = await this.db
        .prepare("SELECT * FROM extension_runs WHERE id = ?")
        .get(runId);
      if (!row) throw new HarnessError("Run not found.", 404);
      const run = runRow(row);
      if (run.status !== "running" || run.workerId !== workerId)
        throw new HarnessError("This run is no longer assigned here.", 409);
      const finish = (status: string, events: number, error: string | null) =>
        this.db
          .prepare(
            "UPDATE extension_runs SET status = ?, events = ?, logs = ?, error = ?, finishedAt = ?, leaseUntil = NULL WHERE id = ?",
          )
          .run(status, events, result.logs || null, error, now, runId);
      if (result.error) {
        await finish("failed", 0, result.error);
        return { events: 0, turns: [] };
      }
      const current: Record<string, unknown> = {};
      for (const item of await this.db
        .prepare("SELECT key, value FROM extension_state WHERE extensionId = ?")
        .all(run.extensionId))
        current[String(item.key)] = item.value;
      for (const key of result.state.delete) delete current[key];
      for (const [key, value] of Object.entries(result.state.set))
        current[key] = JSON.stringify(value);
      const size = Object.entries(current).reduce(
        (total, [key, value]) => total + key.length + String(value).length,
        0,
      );
      if (size > MAX_EXTENSION_STATE) {
        await finish(
          "failed",
          0,
          `Saved state would exceed ${MAX_EXTENSION_STATE / 1024} KB; nothing was saved.`,
        );
        return { events: 0, turns: [] };
      }
      for (const key of result.state.delete)
        await this.db
          .prepare(
            "DELETE FROM extension_state WHERE extensionId = ? AND key = ?",
          )
          .run(run.extensionId, key);
      for (const [key, value] of Object.entries(result.state.set))
        await this.db
          .prepare(
            "INSERT INTO extension_state(extensionId, key, value) VALUES (?, ?, ?) ON CONFLICT(extensionId, key) DO UPDATE SET value = excluded.value",
          )
          .run(run.extensionId, key, JSON.stringify(value));
      const fresh: ExtensionRunResult["events"] = [];
      const seen = new Set<string>();
      for (const event of result.events) {
        if (seen.has(event.key)) continue;
        seen.add(event.key);
        const inserted = await this.db
          .prepare(
            "INSERT OR IGNORE INTO extension_events(id, extensionId, key, runId, type, title, text, url, data, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            crypto.randomUUID(),
            run.extensionId,
            event.key,
            runId,
            event.type,
            event.title,
            event.text,
            event.url,
            event.data === null ? null : JSON.stringify(event.data),
            now,
          );
        if (inserted.changes) fresh.push(event);
      }
      const turns: string[] = [];
      if (fresh.length) {
        const manifest = (await this.revision(run.extensionId, run.revision))
          .manifest;
        for (const subscription of await this.subscriptions({
          extensionId: run.extensionId,
        })) {
          const wanted = subscription.types.length
            ? fresh.filter((event) => subscription.types.includes(event.type))
            : fresh;
          if (!wanted.length) continue;
          const turnId = `extension:${runId}:${subscription.sessionId}`;
          try {
            await this.createTurn(
              turnId,
              subscription.sessionId,
              eventMessage(manifest, run.trigger, wanted),
            );
          } catch (error) {
            // A full queue in one session must not lose the run for others.
            if (error instanceof HarnessError && error.status === 409) continue;
            throw error;
          }
          await this.db
            .prepare(
              "INSERT OR IGNORE INTO extension_deliveries(turnId, extensionId, runId, events, createdAt) VALUES (?, ?, ?, ?, ?)",
            )
            .run(turnId, run.extensionId, runId, wanted.length, now);
          turns.push(turnId);
        }
      }
      await finish("completed", fresh.length, null);
      return { events: fresh.length, turns };
    });
  }
  async runs(id: string, limit = 50): Promise<ExtensionRun[]> {
    return (
      await this.db
        .prepare(
          "SELECT * FROM extension_runs WHERE extensionId = ? ORDER BY createdAt DESC LIMIT ?",
        )
        .all(id, Math.min(limit, 200))
    ).map(runRow);
  }
  async events(id: string, limit = 50): Promise<ExtensionEventRecord[]> {
    return (
      await this.db
        .prepare(
          "SELECT * FROM extension_events WHERE extensionId = ? ORDER BY createdAt DESC LIMIT ?",
        )
        .all(id, Math.min(limit, 200))
    ).map(eventRow);
  }
  async state(id: string): Promise<Record<string, JsonValue>> {
    const state: Record<string, JsonValue> = {};
    for (const item of await this.db
      .prepare("SELECT key, value FROM extension_state WHERE extensionId = ?")
      .all(id))
      state[String(item.key)] = JSON.parse(String(item.value));
    return state;
  }
  async deliveryForTurn(
    turnId: string,
  ): Promise<{ extensionId: string; runId: string; events: number } | null> {
    const row = await this.db
      .prepare("SELECT * FROM extension_deliveries WHERE turnId = ?")
      .get(turnId);
    return row
      ? {
          extensionId: String(row.extensionId),
          runId: String(row.runId),
          events: Number(row.events),
        }
      : null;
  }
}
function parseEventTypes(value: unknown): string[] {
  const items =
    typeof value === "string"
      ? value.split(/[\s,]+/).filter(Boolean)
      : Array.isArray(value)
        ? value
        : null;
  if (
    !items ||
    items.length > 20 ||
    !items.every(
      (item) => typeof item === "string" && /^[a-zA-Z0-9._-]{1,60}$/.test(item),
    )
  )
    throw new HarnessError("Event types must be up to 20 short words.");
  return [...new Set(items as string[])];
}
