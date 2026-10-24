import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { HarnessError, requiredText } from "@harness/core";
import type {
  BrowserAssignment,
  BrowserCommand,
  BrowserIdentity,
} from "@harness/core/browser";
import { browserCommandNotStarted } from "@harness/core/browser";
import type { HarnessStore } from "@harness/storage/application";
import type { AttemptGrant } from "./grants";
import { encryptionKey } from "./keys";
import { getStore } from "./store";

export class BrowserBroker {
  constructor(private store: HarnessStore) {}
  private get db() {
    return this.store.databaseConnection();
  }
  async get(id: string): Promise<BrowserIdentity> {
    const row = await this.db
      .prepare("SELECT * FROM browser_identities WHERE id = ?")
      .get(id);
    if (!row) throw new HarnessError("Browser identity not found.", 404);
    return row as unknown as BrowserIdentity;
  }
  async forWorkspace(workspaceId: string): Promise<BrowserIdentity | null> {
    return (await this.db
      .prepare("SELECT * FROM browser_identities WHERE workspaceId = ?")
      .get(workspaceId)) as unknown as BrowserIdentity | null;
  }
  async ensure(
    workspaceId: string,
    preferredWorkerId?: string,
  ): Promise<BrowserIdentity> {
    const workspace = await this.store.getWorkspace(workspaceId);
    return this.db.transaction(async () => {
      const id = `browser-${createHash("sha256").update(workspaceId).digest("hex").slice(0, 24)}`;
      await this.db
        .prepare(
          "INSERT OR IGNORE INTO browser_identities(id, workspaceId, name, updatedAt) VALUES (?, ?, ?, ?)",
        )
        .run(id, workspaceId, `${workspace.name} browser`, Date.now());
      let browser = await this.get(id);
      const now = Date.now();
      const workers = await this.store.listWorkers();
      const online = (worker: (typeof workers)[number]) =>
        !!worker.report?.browserHost &&
        worker.report.browserBackend !== "extension" &&
        worker.report.browserBackend !== "personal-chrome" &&
        (worker.seenAt ?? 0) >= now - 30000;
      const owner = workers.find((worker) => worker.id === browser.workerId);
      const preferred = workers.find(
        (worker) => worker.id === preferredWorkerId,
      );
      const preferredReport = preferred?.report;
      const preferredReady =
        preferred &&
        preferredReport &&
        online(preferred) &&
        !preferred.draining &&
        !preferredReport.draining &&
        preferredReport.memoryPressure !== "critical" &&
        preferredReport.availableMemoryMiB - preferredReport.reserveMemoryMiB >=
          384 &&
        preferredReport.maxBrowsers > 0;
      // Do not move an in-use browser, including gaps between a running turn's
      // commands. An idle browser can follow a new turn to its executing host.
      if (owner && online(owner) && (browser.leaseUntil ?? 0) > now) {
        const inUse = await this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM browser_commands LEFT JOIN turns ON turns.id = browser_commands.turnId WHERE browserId = ? AND (browser_commands.status IN ('pending', 'running') OR turns.status = 'running')",
          )
          .get(id);
        if (
          browser.mode !== "agent" ||
          !preferredReady ||
          owner.id === preferredWorkerId ||
          Number(inUse?.count) > 0
        )
          return browser;
      }
      if (
        owner &&
        online(owner) &&
        (browser.leaseUntil ?? 0) > now &&
        preferredReady
      ) {
        const used = await this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM browser_identities WHERE workerId = ? AND leaseUntil > ? AND id != ?",
          )
          .get(preferred.id, now, id);
        if (Number(used?.count) >= preferredReport.maxBrowsers) return browser;
      }
      let candidate: string | null = null;
      // Prefer the executing worker's own persistent browser, with no global
      // personal-Chrome preference. Other healthy hosts can supply capacity.
      const ordered = [...workers].sort(
        (left, right) =>
          Number(right.id === preferredWorkerId) -
          Number(left.id === preferredWorkerId),
      );
      for (const worker of ordered) {
        const report = worker.report;
        if (
          !report ||
          !online(worker) ||
          worker.draining ||
          report.draining ||
          report.memoryPressure === "critical" ||
          report.availableMemoryMiB - report.reserveMemoryMiB < 384
        )
          continue;
        const used = await this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM browser_identities WHERE workerId = ? AND leaseUntil > ? AND id != ?",
          )
          .get(worker.id, now, id);
        if (Number(used?.count) < report.maxBrowsers) {
          candidate = worker.id;
          break;
        }
      }
      if (!candidate)
        throw new HarnessError(
          "Waiting for an online browser host with a free browser slot and memory headroom. Disconnected extensions are unavailable; a managed browser can be installed with pnpm browser:install. Sign in through browser takeover when the selected host needs login.",
          409,
        );
      await this.db
        .prepare(
          "UPDATE browser_commands SET status = 'unknown_outcome', error = 'Browser host disappeared; reconcile before repeating a mutation.' WHERE browserId = ? AND status = 'running'",
        )
        .run(id);
      await this.db
        .prepare(
          "UPDATE browser_commands SET status = 'failed', result = ?, error = 'Browser host changed before execution.' WHERE browserId = ? AND status = 'pending'",
        )
        .run(JSON.stringify({ execution: "not_started" }), id);
      await this.db
        .prepare(
          "UPDATE browser_identities SET stateCipher = CASE WHEN workerId = ? THEN stateCipher ELSE NULL END, lastUrl = CASE WHEN workerId = ? THEN lastUrl ELSE NULL END, workerId = ?, generation = generation + 1, leaseUntil = ?, status = 'starting', mode = 'agent', userPublicKey = NULL, expiresAt = NULL, frame = NULL, frameAt = NULL, error = NULL, updatedAt = ? WHERE id = ?",
        )
        .run(candidate, candidate, candidate, now + 30000, now, id);
      browser = await this.get(id);
      return browser;
    });
  }
  async command(
    id: string,
    browserId: string,
    action: string,
    args: Record<string, unknown>,
    turnId: string | null = null,
    turnGeneration: number | null = null,
  ): Promise<BrowserCommand> {
    return this.db.transaction(async () => {
      const browser = await this.get(browserId);
      const existing = await this.db
        .prepare("SELECT * FROM browser_commands WHERE id = ?")
        .get(id);
      const encoded = JSON.stringify(args);
      if (encoded.length > 32768)
        throw new HarnessError("Browser input exceeds its size limit.");
      if (existing) {
        if (
          existing.browserId !== browserId ||
          existing.action !== action ||
          existing.arguments !== encoded ||
          existing.turnId !== turnId
        )
          throw new HarnessError("Browser operation ID was reused.", 409);
        return existing as unknown as BrowserCommand;
      }
      if (
        action === "manual"
          ? browser.mode !== "human" || (browser.expiresAt ?? 0) <= Date.now()
          : browser.mode !== "agent"
      )
        throw new HarnessError(
          "Browser input/capture is paused until its current controller returns control.",
          409,
        );
      const pending = await this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM browser_commands WHERE browserId = ? AND status IN ('pending', 'running')",
        )
        .get(browserId);
      if (Number(pending?.count) >= 10)
        throw new HarnessError("Browser command queue is full.", 409);
      await this.db
        .prepare(
          "INSERT INTO browser_commands(id, browserId, turnId, turnGeneration, browserGeneration, action, arguments, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          browserId,
          turnId,
          turnGeneration,
          browser.generation,
          action,
          encoded,
          Date.now(),
        );
      return (await this.db
        .prepare("SELECT * FROM browser_commands WHERE id = ?")
        .get(id)) as unknown as BrowserCommand;
    });
  }
  async wait(
    id: string,
    deadline = Date.now() + 45000,
  ): Promise<BrowserCommand> {
    while (Date.now() < deadline) {
      const row = await this.db
        .prepare("SELECT * FROM browser_commands WHERE id = ?")
        .get(id);
      if (!row) throw new HarnessError("Browser operation not found.", 404);
      if (row.status !== "pending" && row.status !== "running")
        return row as unknown as BrowserCommand;
      await delay(250);
    }
    throw new HarnessError(
      "Browser operation is still pending. Check its status before retrying a mutation.",
      409,
    );
  }
  async poll(
    workerId: string,
    requestId: string = crypto.randomUUID(),
  ): Promise<{
    assignments: BrowserAssignment[];
    identities: BrowserIdentity[];
  }> {
    return this.db.transaction(async () => {
      const worker = (await this.store.listWorkers()).find(
        (item) => item.id === workerId,
      );
      if (!worker?.report?.browserHost)
        return { assignments: [], identities: [] };
      const now = Date.now();
      await this.expire(now);
      const identities = (await this.db
        .prepare(
          "SELECT * FROM browser_identities WHERE workerId = ? AND leaseUntil > ?",
        )
        .all(workerId, now)) as unknown as BrowserIdentity[];
      for (const browser of identities)
        await this.db
          .prepare(
            "UPDATE browser_identities SET leaseUntil = ? WHERE id = ? AND workerId = ? AND generation = ?",
          )
          .run(now + 30000, browser.id, workerId, browser.generation);
      const receiptId = createHash("sha256")
        .update(`${workerId}:${requestId}`)
        .digest("hex");
      const receipt = await this.db
        .prepare(
          "SELECT commands FROM browser_polls WHERE id = ? AND workerId = ?",
        )
        .get(receiptId, workerId);
      if (receipt) {
        const assignments: BrowserAssignment[] = [];
        for (const commandId of JSON.parse(
          String(receipt.commands),
        ) as string[]) {
          const command = (await this.db
            .prepare(
              "SELECT * FROM browser_commands WHERE id = ? AND status = 'running'",
            )
            .get(commandId)) as unknown as BrowserCommand | undefined;
          const identity = identities.find(
            (item) =>
              item.id === command?.browserId &&
              item.generation === command.browserGeneration,
          );
          if (command && identity)
            assignments.push({
              command,
              identity,
              stateKey: encryptionKey(`browser:${identity.id}`),
            });
        }
        return { assignments, identities };
      }
      const assignments: BrowserAssignment[] = [];
      for (const browser of identities) {
        if (!(await this.store.resourcePolicy(browser.workspaceId)).browser) {
          await this.db
            .prepare(
              "UPDATE browser_identities SET workerId = NULL, leaseUntil = NULL, mode = 'paused', generation = generation + 1, frame = NULL WHERE id = ?",
            )
            .run(browser.id);
          await this.db
            .prepare(
              "UPDATE browser_commands SET status = 'failed', error = 'Workspace browser access was revoked.' WHERE browserId = ? AND status = 'pending'",
            )
            .run(browser.id);
          continue;
        }
        const row = (await this.db
          .prepare(
            "SELECT * FROM browser_commands WHERE browserId = ? AND status = 'pending' AND NOT EXISTS (SELECT 1 FROM browser_commands AS executing WHERE executing.browserId = browser_commands.browserId AND executing.status = 'running') ORDER BY createdAt LIMIT 1",
          )
          .get(browser.id)) as unknown as BrowserCommand | undefined;
        if (!row) continue;
        if (
          row.browserGeneration !== browser.generation ||
          (row.action === "manual"
            ? browser.mode !== "human"
            : browser.mode !== "agent")
        ) {
          await this.db
            .prepare(
              "UPDATE browser_commands SET status = 'failed', error = 'Browser control changed before execution.' WHERE id = ?",
            )
            .run(row.id);
          continue;
        }
        if (row.turnId) {
          try {
            const turn = await this.store.getTurn(row.turnId);
            await this.store.assertAssignment(
              turn.workerId ?? "",
              row.turnId,
              row.turnGeneration ?? 0,
            );
          } catch {
            await this.db
              .prepare(
                "UPDATE browser_commands SET status = 'failed', error = 'Agent ownership expired before browser execution.' WHERE id = ?",
              )
              .run(row.id);
            continue;
          }
        }
        await this.db
          .prepare(
            "UPDATE browser_commands SET status = 'running' WHERE id = ?",
          )
          .run(row.id);
        assignments.push({
          command: row,
          identity: browser,
          stateKey: encryptionKey(`browser:${browser.id}`),
        });
      }
      await this.db
        .prepare(
          "INSERT INTO browser_polls(id,workerId,commands,createdAt) VALUES (?,?,?,?)",
        )
        .run(
          receiptId,
          workerId,
          JSON.stringify(assignments.map((item) => item.command.id)),
          now,
        );
      await this.db
        .prepare(
          "DELETE FROM browser_polls WHERE workerId = ? AND id NOT IN (SELECT id FROM browser_polls WHERE workerId = ? ORDER BY createdAt DESC LIMIT 100)",
        )
        .run(workerId, workerId);
      return { assignments, identities };
    });
  }
  async complete(
    workerId: string,
    id: string,
    generation: number,
    result: Record<string, unknown> | null,
    stateCipher?: string,
    error?: string,
  ): Promise<void> {
    await this.db.transaction(async () => {
      const command = (await this.db
        .prepare("SELECT * FROM browser_commands WHERE id = ?")
        .get(id)) as unknown as BrowserCommand | undefined;
      if (!command) throw new HarnessError("Browser command not found.", 404);
      const browser = await this.get(command.browserId);
      if (
        browser.workerId !== workerId ||
        browser.generation !== generation ||
        (browser.leaseUntil ?? 0) <= Date.now()
      )
        throw new HarnessError("Browser ownership expired.", 409);
      if (command.status === "completed" || command.status === "failed") return;
      if (command.status !== "running")
        throw new HarnessError(
          "Browser command no longer owns execution.",
          409,
        );
      const encoded = JSON.stringify(result);
      if (
        encoded.length > 2 * 1024 * 1024 ||
        (stateCipher?.length ?? 0) > 2 * 1024 * 1024
      )
        throw new HarnessError("Browser result exceeds its size limit.");
      if (
        command.action === "manual" &&
        (browser.mode !== "human" || (!error && !result?.frame) || stateCipher)
      )
        throw new HarnessError(
          "Manual browser frames must stay encrypted and out of model capture.",
          409,
        );
      if (command.action === "manual" && result) {
        const frame = result.frame as Record<string, unknown> | undefined;
        if (
          !frame ||
          typeof frame.iv !== "string" ||
          Buffer.from(frame.iv, "base64").length !== 12 ||
          typeof frame.publicKey !== "string" ||
          Buffer.from(frame.publicKey, "base64").length !== 65 ||
          typeof frame.ciphertext !== "string" ||
          Object.keys(result).some(
            (key) => !["frame", "width", "height"].includes(key),
          ) ||
          Object.keys(frame).some(
            (key) => !["iv", "ciphertext", "publicKey"].includes(key),
          )
        )
          throw new HarnessError("Invalid encrypted manual frame.");
      }
      await this.db
        .prepare(
          "UPDATE browser_commands SET status = ?, result = ?, error = ?, completedAt = ?, arguments = ? WHERE id = ?",
        )
        .run(
          error ? "failed" : "completed",
          encoded,
          error?.slice(0, 500) ?? null,
          Date.now(),
          command.action === "manual" ? "{}" : command.arguments,
          id,
        );
      await this.db
        .prepare(
          "UPDATE browser_identities SET status = ?, lastUrl = ?, frame = ?, frameAt = ?, stateCipher = COALESCE(?, stateCipher), error = ?, updatedAt = ? WHERE id = ?",
        )
        .run(
          error ? "error" : "ready",
          typeof result?.url === "string"
            ? result.url.slice(0, 4000)
            : browser.lastUrl,
          result?.frame
            ? JSON.stringify(result.frame)
            : typeof result?.image === "string"
              ? JSON.stringify({ image: result.image })
              : browser.frame,
          Date.now(),
          browser.mode === "agent" ? (stateCipher ?? null) : null,
          error?.slice(0, 500) ?? null,
          Date.now(),
          browser.id,
        );
      await this.db
        .prepare(
          "DELETE FROM browser_commands WHERE browserId = ? AND action = 'manual' AND completedAt < ?",
        )
        .run(browser.id, Date.now() - 15000);
    });
  }
  async takeover(
    id: string,
    publicKey: string,
    force = false,
  ): Promise<BrowserIdentity> {
    if (
      !/^[a-zA-Z0-9+/=]{80,100}$/.test(publicKey) ||
      Buffer.from(publicKey, "base64").length !== 65
    )
      throw new HarnessError("Invalid browser encryption public key.");
    return this.db.transaction(async () => {
      const browser = await this.get(id);
      if ((browser.leaseUntil ?? 0) <= Date.now())
        throw new HarnessError("Browser host is unavailable.", 409);
      if (
        !force &&
        browser.mode === "human" &&
        browser.userPublicKey !== publicKey &&
        (browser.expiresAt ?? 0) > Date.now()
      )
        throw new HarnessError(
          "This browser is already controlled in another tab.",
          409,
        );
      if (
        browser.mode === "human" &&
        browser.userPublicKey === publicKey &&
        (browser.expiresAt ?? 0) > Date.now()
      )
        return browser;
      await this.db
        .prepare(
          "UPDATE browser_commands SET status = 'unknown_outcome', error = 'Manual takeover interrupted result delivery; reconcile before repeating.' WHERE browserId = ? AND status = 'running'",
        )
        .run(id);
      await this.db
        .prepare(
          "UPDATE browser_commands SET status = 'failed', error = 'Manual takeover paused agent actions.' WHERE browserId = ? AND status = 'pending'",
        )
        .run(id);
      await this.db
        .prepare(
          "UPDATE browser_identities SET mode = 'human', userPublicKey = ?, expiresAt = ?, generation = generation + 1, frame = NULL, updatedAt = ? WHERE id = ?",
        )
        .run(publicKey, Date.now() + 600000, Date.now(), id);
      return this.get(id);
    });
  }
  async returnControl(
    id: string,
    generation: number,
    sessionId: string,
    resume = false,
  ): Promise<BrowserIdentity> {
    return this.db.transaction(async () => {
      const browser = await this.get(id);
      if (
        (await this.store.getSession(sessionId)).workspaceId !==
        browser.workspaceId
      )
        throw new HarnessError("Browser is outside this workspace.", 403);
      const continuationId = `browser-return:${id}:${generation}`;
      const existing = await this.db
        .prepare("SELECT id FROM turns WHERE id = ?")
        .get(continuationId);
      if (existing) return browser;
      if (
        !resume &&
        browser.mode === "agent" &&
        browser.generation === generation + 1
      )
        return browser;
      if (browser.generation !== generation)
        throw new HarnessError(
          "Browser control changed. Refresh before returning it.",
          409,
        );
      await this.db
        .prepare(
          "UPDATE browser_commands SET status = 'unknown_outcome', error = 'Control returned during an in-flight input; inspect the browser before repeating.' WHERE browserId = ? AND status = 'running'",
        )
        .run(id);
      await this.db
        .prepare(
          "UPDATE browser_commands SET status = 'failed', error = 'Browser controller changed before input execution.' WHERE browserId = ? AND status = 'pending'",
        )
        .run(id);
      await this.db
        .prepare(
          "UPDATE browser_identities SET mode = 'agent', generation = generation + 1, userPublicKey = NULL, expiresAt = NULL, frame = NULL, updatedAt = ? WHERE id = ?",
        )
        .run(Date.now(), id);
      if (resume)
        await this.db
          .prepare(
            "UPDATE input_requests SET status = 'answered', response = 'Browser control returned', resolvedAt = ? WHERE id LIKE ? AND kind = 'browser-login' AND status = 'pending'",
          )
          .run(Date.now(), `${id}:%`);
      if (resume)
        await this.store.submitMessage(
          continuationId,
          sessionId,
          "I returned browser control. Refresh the page/account state and continue the browser task. Reconcile any unfinished external operation before repeating it.",
        );
      return this.get(id);
    });
  }
  async release(workerId: string, id: string, generation: number) {
    await this.db
      .prepare(
        "UPDATE browser_identities SET workerId = NULL, leaseUntil = NULL, status = 'idle' WHERE id = ? AND workerId = ? AND generation = ? AND mode = 'agent' AND NOT EXISTS (SELECT 1 FROM browser_commands WHERE browserId = ? AND status IN ('pending','running'))",
      )
      .run(id, workerId, generation, id);
  }
  async expire(now = Date.now()): Promise<void> {
    await this.db
      .prepare(
        "UPDATE browser_commands SET result = NULL WHERE action != 'manual' AND result IS NOT NULL AND completedAt < ?",
      )
      .run(now - 24 * 60 * 60000);
    await this.db
      .prepare(
        "DELETE FROM browser_commands WHERE action = 'manual' AND completedAt < ?",
      )
      .run(now - 15000);
    await this.db
      .prepare(
        "UPDATE browser_commands SET status = 'unknown_outcome', error = 'Browser execution deadline expired; reconcile before repeating.' WHERE status = 'running' AND createdAt < ?",
      )
      .run(now - 90000);
    await this.db
      .prepare(
        "UPDATE browser_identities SET mode = 'paused', generation = generation + 1, userPublicKey = NULL, expiresAt = NULL, frame = NULL WHERE mode = 'human' AND expiresAt <= ?",
      )
      .run(now);
    await this.db
      .prepare(
        "UPDATE browser_commands SET status = 'unknown_outcome', error = 'Browser execution lease expired.' WHERE status = 'running' AND browserId IN (SELECT id FROM browser_identities WHERE leaseUntil <= ?)",
      )
      .run(now);
  }
}

export async function browserTool(
  grant: AttemptGrant,
  args: Record<string, unknown>,
  suppliedStore?: HarnessStore,
): Promise<{ result: unknown; image?: string }> {
  const store = suppliedStore ?? (await getStore());
  await store.assertAssignment(grant.workerId, grant.turnId, grant.generation);
  const session = await store.getSession(
    (await store.getTurn(grant.turnId)).sessionId,
  );
  const broker = new BrowserBroker(store);
  const browser = await broker.ensure(session.workspaceId, grant.workerId);
  const action = requiredText(args.action, "Browser action", 30);
  if (action === "status")
    return {
      result: {
        status: browser.status,
        mode: browser.mode,
        url: browser.lastUrl,
        workerId: browser.workerId,
        instruction:
          "This host uses its own browser login state. If the required account is signed out, navigate to the login page and call needs_login for interactive takeover. Never request passwords in chat.",
      },
    };
  if (action === "needs_login") {
    await store.requestInput(
      `${browser.id}:${grant.turnId}`,
      session.id,
      grant.turnId,
      "browser-login",
      "Sign in to the workspace browser using the Sign in button, then return control to continue.",
    );
    return {
      result: {
        status: "needs_login",
        instruction:
          "Finish the turn and wait for the user to return browser control.",
      },
    };
  }
  if (
    !["navigate", "click", "fill", "read", "sheet_read", "screenshot"].includes(
      action,
    )
  )
    throw new HarnessError("Unsupported browser action.");
  const mutating = ["navigate", "click", "fill"].includes(action);
  const operationKey = mutating
    ? requiredText(args.operation_id, "Stable operation_id", 100)
    : crypto.randomUUID();
  const id = `browserop-${createHash("sha256").update(`${session.id}:${operationKey}`).digest("hex")}`;
  if (mutating) await store.reconcileUnstartedBrowserOperations(session.id);
  const operation = mutating
    ? await store.operation(
        grant.workerId,
        grant.turnId,
        grant.generation,
        id,
        args,
        { operationKey, action, browserId: browser.id, retryUnstarted: true },
      )
    : { state: "new", receipt: null };
  if (operation.state === "succeeded")
    return {
      result: operation.receipt
        ? JSON.parse(operation.receipt)
        : { status: "succeeded" },
    };
  if (operation.state !== "new")
    return {
      result: {
        status: "unknown_outcome",
        instruction:
          "Inspect current page and reconcile this operation; do not repeat the mutation with another ID.",
      },
    };
  const attempt = "attempt" in operation ? operation.attempt : 0;
  const commandId = attempt ? `${id}:attempt:${attempt}` : id;
  let outcomeSaved = false;
  try {
    const input = Object.fromEntries(
      Object.entries(args).filter(
        ([key]) => key !== "operation_id" && key !== "action",
      ),
    );
    await broker.command(
      commandId,
      browser.id,
      action,
      input,
      grant.turnId,
      grant.generation,
    );
    const command = await broker.wait(commandId);
    if (command.status !== "completed") {
      if (mutating)
        await store.operationOutcome(
          id,
          browserCommandNotStarted(command) ? "failed" : "unknown_outcome",
          browserCommandNotStarted(command)
            ? JSON.stringify({
                operationKey,
                action,
                browserId: browser.id,
                attempt,
                execution: "not_started",
              })
            : null,
          command.error ?? "Browser action failed.",
        );
      outcomeSaved = true;
      throw new HarnessError(command.error ?? "Browser action failed.", 409);
    }
    const result = JSON.parse(command.result ?? "{}");
    const image =
      !["read", "sheet_read"].includes(action) &&
      typeof result.image === "string"
        ? result.image
        : undefined;
    if (result.status === "needs_login")
      await store.requestInput(
        `${browser.id}:${grant.turnId}`,
        session.id,
        grant.turnId,
        "browser-login",
        result.login === "rejected"
          ? "Google rejected this browser. Sign-in has not completed; open the browser to resolve access before continuing."
          : "Sign in to the workspace browser, then choose Continue task.",
      );
    delete result.image;
    if (mutating)
      await store.operationOutcome(id, "succeeded", JSON.stringify(result));
    return { result, image };
  } catch (error) {
    if (mutating && !outcomeSaved)
      await store.operationOutcome(
        id,
        "unknown_outcome",
        null,
        error instanceof Error
          ? error.message
          : "Browser result was not acknowledged.",
      );
    throw error;
  }
}
