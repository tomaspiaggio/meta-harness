import { failure, localRequest } from "../../../server/http";
import { getStore } from "../../../server/store";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await localRequest(request);
    const store = await getStore();
    await store.recoverExpired(Date.now());
    const query = new URL(request.url).searchParams;
    const workspaces = await store.listWorkspaces();
    // Without an explicit workspace, use the first real one; the seeded
    // "business" ID may have been deleted.
    const workspaceId = query.get("workspace") ?? workspaces[0]?.id;
    if (!workspaceId)
      return Response.json(
        {
          workspaces,
          sessions: [],
          turns: [],
          schedules: [],
          inputRequests: [],
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    await store.getWorkspace(workspaceId);
    const sessionId = query.get("session");
    if (
      sessionId &&
      (await store.getSession(sessionId)).workspaceId !== workspaceId
    ) {
      return Response.json(
        { error: "Session is outside this workspace." },
        { status: 404 },
      );
    }
    return Response.json(
      {
        workspaces,
        sessions: await store.listSessions(workspaceId),
        turns: sessionId
          ? await Promise.all(
              (await store.listTurns(sessionId)).map(async (turn) => ({
                ...turn,
                waitingReason: await store.waitingReason(turn.id),
                publications: await store.decisionsForTurn(turn.id),
                attachments: await store.attachmentsForTurn(turn.id),
              })),
            )
          : [],
        schedules: sessionId ? await store.listSchedules(sessionId) : [],
        inputRequests: sessionId ? await store.inputsForSession(sessionId) : [],
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
