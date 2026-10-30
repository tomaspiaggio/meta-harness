import { requiredText, type Turn } from "@harness/core";
import {
  labelList,
  type WorkerRecord,
  workerLabels,
} from "@harness/core/scheduling";
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
/** Which machines can run a session, for its Advanced settings. */
function placement(workers: WorkerRecord[], required: string[]) {
  const live = workers.filter((worker) => !worker.draining && worker.report);
  return {
    labels: required,
    available: [...new Set(live.flatMap(workerLabels))].sort(),
    machines: live.map((worker) => ({
      name: worker.name,
      online: !!worker.seenAt && worker.seenAt > Date.now() - 30000,
      labels: workerLabels(worker),
    })),
  };
}
/** The session a note turn came from. */
async function noteTag(
  store: Awaited<ReturnType<typeof getStore>>,
  turnId: string,
) {
  const note = await store.noteForTurn(turnId);
  if (!note) return null;
  const from = await store.getSession(note.fromSessionId).catch(() => null);
  return {
    from: from
      ? { id: from.id, title: from.title, workspaceId: from.workspaceId }
      : null,
  };
}
/** Turns as the conversation shows them, with who ran them and what they made. */
async function turnViews(
  store: Awaited<ReturnType<typeof getStore>>,
  turns: Turn[],
  workers: WorkerRecord[],
) {
  const workerNames = new Map(
    workers.map((worker) => [
      worker.id,
      {
        name: worker.name,
        hostname: worker.report?.hostname ?? null,
      },
    ]),
  );
  return await Promise.all(
    turns.map(async (turn) => ({
      ...turn,
      worker: turn.workerId ? (workerNames.get(turn.workerId) ?? null) : null,
      waitingReason: await store.waitingReason(turn.id),
      publications: await store.decisionsForTurn(turn.id),
      attachments: await store.attachmentsForTurn(turn.id),
      delegation: await delegationTag(store, turn.id),
      note: await noteTag(store, turn.id),
    })),
  );
}
/** A switch shows the latest turns first; earlier ones load as the reader scrolls up. */
const LATEST_TURNS = 12;
const OLDER_TURNS = 20;
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
    const workers = await store.listWorkers();
    if (
      sessionId &&
      (await store.getSession(sessionId)).workspaceId !== workspaceId
    ) {
      return Response.json(
        { error: "Session is outside this workspace." },
        { status: 404 },
      );
    }
    const before = query.get("before");
    if (sessionId && before) {
      const page = await store.turnPage(
        sessionId,
        OLDER_TURNS,
        requiredText(before, "Turn ID", 100),
      );
      return Response.json(
        {
          turns: await turnViews(store, page.turns, workers),
          older: page.older,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const page = sessionId
      ? await store.turnPage(sessionId, LATEST_TURNS)
      : { turns: [], older: false };
    return Response.json(
      {
        workspaces,
        sessions: await store.listSessions(workspaceId),
        turns: await turnViews(store, page.turns, workers),
        older: page.older,
        schedules: sessionId ? await store.listSchedules(sessionId) : [],
        delegations: sessionId
          ? await store.delegationsForSession(sessionId)
          : [],
        inputRequests: sessionId ? await store.inputsForSession(sessionId) : [],
        placement: placement(
          workers,
          sessionId
            ? labelList((await store.getSession(sessionId)).requiredLabels)
            : [],
        ),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
