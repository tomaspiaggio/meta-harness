import { validateSnapshot } from "@harness/checkpoints";
import { HarnessError, type RuntimeEvent, requiredText } from "@harness/core";
import { parseWorkerReport } from "@harness/core/scheduling";
import { failure, readJson } from "../../../../server/http";
import { sameOrigin } from "../../../../server/security";
import { getStore } from "../../../../server/store";

export async function POST(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  try {
    sameOrigin(request);
    const workerId = request.headers.get("x-worker-id") ?? "";
    const store = getStore();
    store.authenticateWorker(
      workerId,
      request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
    );
    const { action } = await context.params;
    const body = await readJson(
      request,
      action === "checkpoint" ? 6 * 1024 * 1024 : 64 * 1024,
    );
    if (action === "report") {
      store.reportWorker(workerId, parseWorkerReport(body.report));
      return Response.json({ ok: true });
    }
    if (action === "claim")
      return Response.json(
        store.claimForWorker(
          workerId,
          Date.now(),
          requiredText(body.requestId, "Claim request ID", 100),
        ),
      );
    const turnId = requiredText(body.turnId, "Turn ID", 100);
    const generation = body.generation;
    if (
      typeof generation !== "number" ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    )
      throw new HarnessError("Invalid ownership generation.");
    if (action === "heartbeat")
      store.heartbeatWorkerTurn(workerId, turnId, generation);
    else if (action === "event") {
      if (
        typeof body.sequence !== "number" ||
        !Number.isSafeInteger(body.sequence) ||
        body.sequence < 1
      )
        throw new HarnessError("Invalid event sequence.");
      const event = body.event as Partial<RuntimeEvent> | undefined;
      if (
        event?.type === "text" &&
        typeof event.text === "string" &&
        event.text.length <= 32_768
      ) {
        store.applyWorkerEvent(workerId, turnId, generation, body.sequence, {
          type: "text",
          text: event.text,
        });
      } else if (
        event?.type === "native-session" &&
        typeof event.id === "string" &&
        event.id.length > 0 &&
        event.id.length < 200
      ) {
        store.applyWorkerEvent(workerId, turnId, generation, body.sequence, {
          type: "native-session",
          id: event.id,
        });
      } else throw new HarnessError("Invalid worker event.");
    } else if (action === "checkpoint") {
      let snapshot: ReturnType<typeof validateSnapshot>;
      try {
        snapshot = validateSnapshot(body.snapshot);
      } catch (error) {
        throw new HarnessError(
          error instanceof Error ? error.message : "Invalid checkpoint.",
        );
      }
      store.saveCheckpoint(
        workerId,
        turnId,
        generation,
        requiredText(body.id, "Checkpoint ID", 100),
        snapshot,
      );
    } else if (action === "complete") {
      if (
        body.status !== "completed" &&
        body.status !== "failed" &&
        body.status !== "interrupted"
      )
        throw new HarnessError("Invalid completion status.");
      store.completeWorkerTurn(
        workerId,
        turnId,
        generation,
        body.status,
        body.error === undefined
          ? undefined
          : requiredText(body.error, "Error", 4000),
      );
    } else throw new HarnessError("Unknown worker action.", 404);
    return Response.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
