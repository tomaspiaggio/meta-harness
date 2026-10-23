import { HarnessError, parseProvider, requiredText } from "@harness/core";
import { parseProfile } from "@harness/core/scheduling";
import { after } from "next/server";
import { failure, jsonBody, localRequest } from "../../../server/http";
import { maintain } from "../../../server/maintenance";
import { getStore } from "../../../server/store";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await localRequest(request);
    const store = await getStore();
    await store.recoverExpired(Date.now());
    return Response.json(
      {
        tasks: await store.listTasks(),
        workers: await store.listWorkers(),
        workspaces: await store.listWorkspaces(),
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
    const task = await (await getStore()).createTask({
      id: requiredText(body.id, "Task ID", 100),
      workspaceId: requiredText(body.workspaceId, "Workspace ID", 100),
      title: requiredText(body.title, "Title", 100),
      objective: requiredText(body.objective, "Objective"),
      provider: parseProvider(body.provider),
      profile: parseProfile(body.profile),
      priority,
    });
    after(() => maintain());
    return Response.json(task, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}
export async function PATCH(request: Request) {
  try {
    const body = await jsonBody(request);
    const id = requiredText(body.id, "ID", 100);
    const store = await getStore();
    if (body.kind === "worker") {
      if (typeof body.draining !== "boolean")
        throw new HarnessError("Expected a draining flag.");
      await store.drainWorker(id, body.draining);
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
      await store.updateTask(id, {
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
