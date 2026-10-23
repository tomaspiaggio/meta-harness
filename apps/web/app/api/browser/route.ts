export const maxDuration = 60;

import { HarnessError, requiredText } from "@harness/core";
import type { BrowserIdentity } from "@harness/core/browser";
import { BrowserBroker } from "../../../server/browser";
import { flushDispatch } from "../../../server/dispatcher";
import { failure, jsonBody, localRequest } from "../../../server/http";
import { getStore } from "../../../server/store";

function visible(browser: BrowserIdentity | null) {
  if (!browser) return null;
  const { stateCipher: _state, userPublicKey: _public, ...result } = browser;
  return result;
}
export async function GET(request: Request) {
  try {
    await localRequest(request);
    const workspaceId = requiredText(
      new URL(request.url).searchParams.get("workspace"),
      "Workspace ID",
      100,
    );
    const store = await getStore();
    await store.getWorkspace(workspaceId);
    const broker = new BrowserBroker(store);
    await broker.expire();
    const browser = await broker.forWorkspace(workspaceId);
    const host = (await store.listWorkers()).find(
      (worker) => worker.id === browser?.workerId,
    );
    const sessionId = new URL(request.url).searchParams.get("session");
    if (
      sessionId &&
      (await store.getSession(sessionId)).workspaceId !== workspaceId
    )
      throw new HarnessError("Session is outside this workspace.", 403);
    const rows =
      browser && sessionId
        ? await store
            .databaseConnection()
            .prepare(
              "SELECT browser_commands.id, action, arguments, browser_commands.status, result FROM browser_commands JOIN turns ON turns.id = browser_commands.turnId WHERE browserId = ? AND turns.sessionId = ? AND action != 'manual' ORDER BY browser_commands.createdAt DESC LIMIT 12",
            )
            .all(browser.id, sessionId)
        : [];
    const steps = rows.reverse().map((row) => {
      let args: Record<string, unknown> = {},
        result: Record<string, unknown> = {};
      try {
        args = JSON.parse(String(row.arguments));
        result = JSON.parse(String(row.result ?? "{}")) ?? {};
      } catch {}
      let label = String(row.action);
      if (row.action === "navigate") {
        try {
          const url = new URL(String(args.url));
          label = `Opened ${url.origin}${url.pathname}`;
        } catch {
          label = "Opened page";
        }
      }
      if (row.action === "click")
        label = `Clicked ${String(args.selector ?? "element").slice(0, 100)}`;
      if (row.action === "fill")
        label = `Typed into ${String(args.selector ?? "field").slice(0, 100)}`;
      if (row.action === "read") label = "Read page";
      return {
        id: row.id,
        status: row.status,
        label,
        ...(typeof result.image === "string" ? { image: result.image } : {}),
      };
    });
    const stepCursor = rows.map((row) => `${row.id}:${row.status}`).join(";");
    const unchanged =
      new URL(request.url).searchParams.get("stepCursor") === stepCursor;
    return Response.json(
      {
        ...(unchanged ? {} : { steps }),
        stepCursor,
        policy: await store.resourcePolicy(workspaceId),
        backend: host?.report?.browserBackend ?? "managed",
        host: host
          ? { id: host.id, name: host.name, hostname: host.report?.hostname }
          : null,
        browser: visible(browser),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    const store = await getStore();
    const broker = new BrowserBroker(store);
    const workspaceId = requiredText(body.workspaceId, "Workspace ID", 100);
    await store.getWorkspace(workspaceId);
    if (body.action === "enable") {
      // Compatibility for older tabs; there is no longer a workspace opt-in.
      return Response.json({
        browser: visible(await broker.ensure(workspaceId)),
      });
    }
    const identity = await broker.ensure(workspaceId);
    if (body.action === "takeover")
      return Response.json({
        browser: visible(
          await broker.takeover(
            identity.id,
            requiredText(body.publicKey, "Browser public key", 100),
            body.force === true,
          ),
        ),
      });
    if (body.action === "return") {
      if (typeof body.generation !== "number")
        throw new HarnessError("Invalid browser generation.");
      const browser = await broker.returnControl(
        identity.id,
        body.generation,
        requiredText(body.sessionId, "Session ID", 100),
        body.resume === true,
      );
      await flushDispatch();
      return Response.json({ browser: visible(browser) });
    }
    if (body.action === "manual") {
      const id = requiredText(body.id, "Browser input ID", 100);
      await broker.command(
        id,
        identity.id,
        "manual",
        body.input ? { input: body.input } : {},
      );
      const command = await broker.wait(id);
      if (command.status !== "completed")
        throw new HarnessError(
          command.error ?? "Browser input has no confirmed outcome.",
          409,
        );
      return Response.json(JSON.parse(command.result ?? "{}"), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (body.action === "screenshot") {
      const id = crypto.randomUUID();
      await broker.command(id, identity.id, "screenshot", {});
      const command = await broker.wait(id);
      if (command.status !== "completed")
        throw new HarnessError(
          command.error ?? "Browser preview is not available.",
          409,
        );
      return Response.json(JSON.parse(command.result ?? "{}"), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    throw new HarnessError("Invalid browser action.");
  } catch (error) {
    return failure(error);
  }
}
