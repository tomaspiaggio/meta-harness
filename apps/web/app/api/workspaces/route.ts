import { HarnessError, requiredText } from "@harness/core";
import { failure, jsonBody, localRequest } from "../../../server/http";
import { getStore } from "../../../server/store";
export const dynamic = "force-dynamic";
/** Workspaces with their recent sessions, for the navigation tree. */
export async function GET(request: Request) {
  try {
    await localRequest(request);
    const store = await getStore();
    await store.ensurePlanners();
    const workspaces = await store.listWorkspaces();
    const activity = await store.sessionActivity();
    const workers = new Set(activity.workers);
    const busy = new Set(activity.busy);
    return Response.json(
      {
        workspaces,
        defaults: await store.agentDefaults(),
        sessions: (
          await Promise.all(
            workspaces.map(
              async (workspace) => await store.listSessions(workspace.id),
            ),
          )
        )
          .flat()
          .map((session) => ({
            ...session,
            worker: workers.has(session.id),
            busy: busy.has(session.id),
          })),
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
    return Response.json(
      await (await getStore()).createWorkspace(
        requiredText(body.name, "Name", 100),
        requiredText(body.instructions, "Instructions", 10000),
      ),
      { status: 201 },
    );
  } catch (error) {
    return failure(error);
  }
}
/**
 * The sidebar order (`order`: every workspace ID, top first), a workspace's
 * name, or where its agents work on machines that have the folder.
 */
export async function PATCH(request: Request) {
  try {
    const body = await jsonBody(request);
    const store = await getStore();
    if (body.order !== undefined) {
      if (
        !Array.isArray(body.order) ||
        body.order.length > 500 ||
        body.order.some((id) => typeof id !== "string")
      )
        throw new HarnessError("Order must list workspace IDs.");
      return Response.json(await store.orderWorkspaces(body.order as string[]));
    }
    const id = requiredText(body.id, "Workspace ID", 100);
    if (body.name !== undefined)
      return Response.json(
        await store.renameWorkspace(id, requiredText(body.name, "Name", 100)),
      );
    return Response.json(await store.setWorkspaceFolder(id, body.folder));
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await jsonBody(request);
    if (body.confirm !== true)
      throw new HarnessError("Deletion requires confirmation.");
    await (await getStore()).deleteWorkspace(requiredText(body.id, "ID", 100));
    const { after } = await import("next/server");
    after(async () => {
      const { cleanupDeleted } = await import("../../../server/deletion");
      await cleanupDeleted();
    });
    return Response.json({ deleted: true });
  } catch (error) {
    return failure(error);
  }
}
