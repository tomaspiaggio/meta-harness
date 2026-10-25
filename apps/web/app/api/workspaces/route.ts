import { HarnessError, requiredText } from "@harness/core";
import { failure, jsonBody, localRequest } from "../../../server/http";
import { getStore } from "../../../server/store";
export const dynamic = "force-dynamic";
/** Workspaces with their recent sessions, for the navigation tree. */
export async function GET(request: Request) {
  try {
    await localRequest(request);
    const store = await getStore();
    const workspaces = await store.listWorkspaces();
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
        ).flat(),
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
/** Where the workspace's agents work, on machines that have the folder. */
export async function PATCH(request: Request) {
  try {
    const body = await jsonBody(request);
    return Response.json(
      await (await getStore()).setWorkspaceFolder(
        requiredText(body.id, "Workspace ID", 100),
        body.folder,
      ),
    );
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
