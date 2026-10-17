import { failure, localRequest } from "../../../server/http";
import { getStore } from "../../../server/store";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  try {
    localRequest(request);
    const store = getStore();
    const query = new URL(request.url).searchParams;
    const workspaceId = query.get("workspace") ?? "business";
    store.getWorkspace(workspaceId);
    const sessionId = query.get("session");
    if (sessionId && store.getSession(sessionId).workspaceId !== workspaceId) {
      return Response.json(
        { error: "Session is outside this workspace." },
        { status: 404 },
      );
    }
    return Response.json(
      {
        workspaces: store.listWorkspaces(),
        sessions: store.listSessions(workspaceId),
        turns: sessionId ? store.listTurns(sessionId) : [],
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
