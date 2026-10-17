import { HarnessError, parseProvider, requiredText } from "@harness/core";
import { parseProfile } from "@harness/core/scheduling";
import { flushDispatch } from "../../../server/dispatcher";
import { failure, jsonBody, localRequest } from "../../../server/http";
import { getStore } from "../../../server/store";

export const dynamic = "force-dynamic";
export function GET(request: Request) {
  try {
    localRequest(request);
    const store = getStore();
    store.recoverExpired(Date.now());
    return Response.json(
      {
        tasks: store.listTasks(),
        workers: store.listWorkers(),
        workspaces: store.listWorkspaces(),
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
    const priority = body.priority ?? 0;
    if (
      typeof priority !== "number" ||
      !Number.isInteger(priority) ||
      priority < -100 ||
      priority > 100
    )
      throw new HarnessError("Priority must be an integer from -100 to 100.");
    const task = getStore().createTask({
      id: requiredText(body.id, "Task ID", 100),
      workspaceId: requiredText(body.workspaceId, "Workspace ID", 100),
      title: requiredText(body.title, "Title", 100),
      objective: requiredText(body.objective, "Objective"),
      provider: parseProvider(body.provider),
      profile: parseProfile(body.profile),
      priority,
    });
    void flushDispatch().catch((error) =>
      console.error("Task dispatch will retry:", error),
    );
    return Response.json(task, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await jsonBody(request);
    const id = requiredText(body.id, "ID", 100);
    const store = getStore();
    if (body.kind === "worker") {
      if (typeof body.draining !== "boolean")
        throw new HarnessError("Expected a draining flag.");
      store.drainWorker(id, body.draining);
    } else {
      if (body.paused !== undefined && typeof body.paused !== "boolean")
        throw new HarnessError("Expected a paused flag.");
      if (
        body.priority !== undefined &&
        (typeof body.priority !== "number" ||
          !Number.isInteger(body.priority) ||
          Math.abs(body.priority) > 100)
      )
        throw new HarnessError("Invalid priority.");
      store.updateTask(id, {
        paused: body.paused as boolean | undefined,
        priority: body.priority as number | undefined,
        targetWorkerId:
          body.targetWorkerId === undefined || body.targetWorkerId === null
            ? body.targetWorkerId
            : requiredText(body.targetWorkerId, "Target worker", 100),
      });
    }
    return Response.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
