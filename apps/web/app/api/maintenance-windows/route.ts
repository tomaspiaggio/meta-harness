import { requiredText } from "@harness/core";
import { failure, jsonBody, localRequest } from "../../../server/http";
import { getStore } from "../../../server/store";
export const dynamic = "force-dynamic";
/** The owner's planned downtime: list, schedule, and cancel or end early. */
export async function GET(request: Request) {
  try {
    await localRequest(request);
    return Response.json(await (await getStore()).listMaintenance(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    const window = await (await getStore()).scheduleMaintenance({
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      workers: body.workers,
      note: body.note || undefined,
    });
    return Response.json(window, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}
export async function DELETE(request: Request) {
  try {
    const body = await jsonBody(request);
    await (await getStore()).endMaintenance(requiredText(body.id, "ID", 100));
    return Response.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
