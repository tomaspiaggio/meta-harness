import { requiredText } from "@harness/core";
import { resourcePolicy } from "@harness/core/resources";
import { failure, jsonBody, localRequest } from "../../../server/http";
import { getStore } from "../../../server/store";
export async function GET(request: Request) {
  try {
    await localRequest(request);
    const id = requiredText(
      new URL(request.url).searchParams.get("workspace"),
      "Workspace ID",
      100,
    );
    return Response.json(await (await getStore()).resourcePolicy(id), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    const policy = resourcePolicy(body.policy);
    await (await getStore()).saveResourcePolicy(
      requiredText(body.workspaceId, "Workspace ID", 100),
      { ...policy },
    );
    return Response.json(policy);
  } catch (error) {
    return failure(error);
  }
}
