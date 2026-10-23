import { requiredText } from "@harness/core";
import { getRun } from "workflow/api";
import { failure, localRequest } from "../../../server/http";
import { getStore } from "../../../server/store";
/** Owner-only status inspection; never proxies Workflow's control endpoints. */
export async function GET(request: Request) {
  try {
    await localRequest(request);
    const turn = await (await getStore()).getTurn(
      requiredText(
        new URL(request.url).searchParams.get("turn"),
        "Turn ID",
        100,
      ),
    );
    return Response.json(
      {
        turnId: turn.id,
        status: turn.status,
        workflow: turn.runId
          ? { runId: turn.runId, status: await getRun(turn.runId).status }
          : null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
