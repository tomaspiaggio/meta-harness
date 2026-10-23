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
    return Response.json(
      {
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
