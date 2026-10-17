import { parseProvider, requiredText } from "@harness/core";
import { failure, jsonBody } from "../../../server/http";
import { getStore } from "../../../server/store";

export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    return Response.json(
      getStore().createSession(
        requiredText(body.workspaceId, "Workspace ID", 100),
        requiredText(body.title, "Title", 100),
        parseProvider(body.provider),
      ),
      { status: 201 },
    );
  } catch (error) {
    return failure(error);
  }
}
