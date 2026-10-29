import {
  controlUpdateStatus,
  startControlUpdate,
} from "../../../server/control-update";
import { failure, jsonBody, localRequest } from "../../../server/http";

export const dynamic = "force-dynamic";

/**
 * The deployed build, compared by open apps to reload after a deploy. With
 * ?update=1 the owner also gets the last server update's progress.
 */
export async function GET(request: Request) {
  try {
    const update = new URL(request.url).searchParams.get("update") === "1";
    if (update) await localRequest(request);
    return Response.json(
      {
        build: process.env.HARNESS_BUILD,
        ...(update ? { update: controlUpdateStatus() } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
/** The owner updates the server to a commit on main. */
export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    return Response.json(startControlUpdate(body.commit, "owner"), {
      status: 202,
    });
  } catch (error) {
    return failure(error);
  }
}
