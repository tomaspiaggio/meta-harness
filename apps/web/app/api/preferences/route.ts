import { failure, jsonBody, localRequest } from "../../../server/http";
import { getStore } from "../../../server/store";
export async function GET(request: Request) {
  try {
    await localRequest(request);
    return Response.json(await (await getStore()).agentDefaults(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return failure(error);
  }
}
export async function PATCH(request: Request) {
  try {
    return Response.json(
      await (await getStore()).setAgentDefaults(await jsonBody(request)),
    );
  } catch (error) {
    return failure(error);
  }
}
