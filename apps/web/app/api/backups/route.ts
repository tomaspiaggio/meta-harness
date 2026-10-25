import { backupStatus } from "../../../server/backup";
import { failure, localRequest } from "../../../server/http";

/** When the last encrypted off-site backup ran; null when none are set up. */
export async function GET(request: Request) {
  try {
    await localRequest(request);
    return Response.json(
      { status: backupStatus() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
