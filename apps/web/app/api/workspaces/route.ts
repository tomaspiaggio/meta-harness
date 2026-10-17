import { requiredText } from "@harness/core";
import { failure, jsonBody } from "../../../server/http";
import { getStore } from "../../../server/store";

export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    return Response.json(
      getStore().createWorkspace(
        requiredText(body.name, "Name", 100),
        requiredText(body.instructions, "Instructions", 10_000),
      ),
      { status: 201 },
    );
  } catch (error) {
    return failure(error);
  }
}
