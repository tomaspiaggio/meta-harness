import { failure, localRequest } from "../../../server/http";
import { getStore } from "../../../server/store";

/** Who a task, feedback or report turn came from, for the conversation view. */
async function delegationTag(
  store: Awaited<ReturnType<typeof getStore>>,
  turnId: string,
) {
  const link = await store.delegationForTurn(turnId);
  if (!link) return null;
  const peerId = link.role === "report" ? link.toSessionId : link.fromSessionId;
  const peer = await store.getSession(peerId).catch(() => null);
  return {
    role: link.role,
    taskId: link.delegationId,
    title: link.title,
    round: link.round,
    status: link.role === "report" ? link.reportStatus : null,
    peer: peer
      ? { id: peer.id, title: peer.title, workspaceId: peer.workspaceId }
      : null,
  };
}
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
    const workerNames = new Map(
      (sessionId ? await store.listWorkers() : []).map((worker) => [
        worker.id,
        {
          name: worker.name,
          hostname: worker.report?.hostname ?? null,
        },
      ]),
    );
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
                worker: turn.workerId
                  ? (workerNames.get(turn.workerId) ?? null)
                  : null,
                waitingReason: await store.waitingReason(turn.id),
                publications: await store.decisionsForTurn(turn.id),
                attachments: await store.attachmentsForTurn(turn.id),
                delegation: await delegationTag(store, turn.id),
              })),
            )
          : [],
        schedules: sessionId ? await store.listSchedules(sessionId) : [],
        delegations: sessionId
          ? await store.delegationsForSession(sessionId)
          : [],
        inputRequests: sessionId ? await store.inputsForSession(sessionId) : [],
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
