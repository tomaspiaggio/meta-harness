import { HarnessError, requiredText } from "@harness/core";
import { failure, jsonBody } from "../../../server/http";
import { getStore } from "../../../server/store";

/** The owner cancels a task one session gave another. */
export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    if (body.action !== "cancel")
      throw new HarnessError("Unsupported task action.");
    const store = await getStore();
    return Response.json(
      await store.closeDelegation(
        requiredText(body.id, "Task ID", 100),
        null,
        "cancelled",
        "Cancelled by the owner.",
      ),
    );
  } catch (error) {
    return failure(error);
  }
}
