import { HarnessError, requiredText } from "@harness/core";
import { flushDispatch } from "../../../../server/dispatcher";
import { saveSettings } from "../../../../server/extensions";
import { failure, jsonBody, localRequest } from "../../../../server/http";
import { getStore } from "../../../../server/store";

type Context = { params: Promise<{ id: string }> };
export const dynamic = "force-dynamic";
/** Everything the owner reviews: revisions, runs, events and subscribers. */
export async function GET(request: Request, context: Context) {
  try {
    await localRequest(request);
    const { id } = await context.params;
    const store = (await getStore()).extensions;
    const revision = new URL(request.url).searchParams.get("revision");
    if (revision)
      return Response.json(
        {
          ...(await store.revision(id, Number(revision))),
          code: await store.revisionCode(id, Number(revision)),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    const sessions = await getStore();
    const subscriptions = await Promise.all(
      (await store.subscriptions({ extensionId: id })).map(
        async (subscription) => {
          const session = await sessions
            .getSession(subscription.sessionId)
            .catch(() => null);
          return {
            ...subscription,
            session: session
              ? {
                  id: session.id,
                  title: session.title,
                  workspaceId: session.workspaceId,
                }
              : null,
          };
        },
      ),
    );
    return Response.json(
      {
        extension: await store.get(id),
        revisions: await store.revisions(id),
        runs: await store.runs(id, 30),
        events: await store.events(id, 30),
        state: Object.keys(await store.state(id)),
        subscriptions,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
/** Settings, on/off, labels and the webhook address. */
export async function PATCH(request: Request, context: Context) {
  try {
    const body = await jsonBody(request);
    const { id } = await context.params;
    return Response.json(await saveSettings(await getStore(), id, body));
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    const body = await jsonBody(request);
    const { id } = await context.params;
    const store = (await getStore()).extensions;
    if (body.action === "approve" || body.action === "reject") {
      if (typeof body.revision !== "number")
        throw new HarnessError("Choose a revision.");
      return Response.json(await store.decide(id, body.revision, body.action));
    }
    if (body.action === "run") {
      const run = await store.enqueue(
        id,
        requiredText(body.trigger, "Trigger", 40),
        { manual: true },
      );
      return Response.json(run);
    }
    if (body.action === "subscribe") {
      const subscription = await store.subscribe({
        extensionId: id,
        sessionId: requiredText(body.sessionId, "Session ID", 100),
        types: body.types,
        createdBy: "owner",
      });
      await flushDispatch();
      return Response.json(subscription);
    }
    if (body.action === "unsubscribe") {
      await store.unsubscribe(
        id,
        requiredText(body.sessionId, "Session ID", 100),
      );
      return Response.json({ ok: true });
    }
    throw new HarnessError("Unknown extension action.");
  } catch (error) {
    return failure(error);
  }
}
export async function DELETE(request: Request, context: Context) {
  try {
    await localRequest(request);
    const { id } = await context.params;
    await (await getStore()).extensions.remove(id);
    return Response.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
