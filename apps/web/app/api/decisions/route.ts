import { HarnessError } from "@harness/core";
import { parseDecisionUpdates } from "@harness/core/knowledge";
import { failure, jsonBody, localRequest } from "../../../server/http";
import { getStore } from "../../../server/store";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await localRequest(request);
    return Response.json(await (await getStore()).getSharedDecisions(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return failure(error);
  }
}
export async function PATCH(request: Request) {
  return edit(request, false);
}
export async function DELETE(request: Request) {
  return edit(request, true);
}
async function edit(request: Request, withdraw: boolean) {
  try {
    const body = await jsonBody(request);
    if (withdraw && body.confirm !== true)
      throw new HarnessError("Withdrawal requires confirmation.");
    const update = parseDecisionUpdates([
      {
        key: body.key,
        content: withdraw ? null : body.content,
        expectedRevision: body.expectedRevision,
      },
    ])[0];
    return Response.json(await (await getStore()).editSharedDecision(update));
  } catch (error) {
    return failure(error);
  }
}
