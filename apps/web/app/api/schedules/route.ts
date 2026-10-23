import { HarnessError, requiredText } from "@harness/core";
import { upcomingOccurrences } from "@harness/core/automations";
import { flushDispatch } from "../../../server/dispatcher";
import { failure, jsonBody, localRequest } from "../../../server/http";
import { dispatchSchedules } from "../../../server/schedules";
import { getStore } from "../../../server/store";

export async function GET(request: Request) {
  try {
    await localRequest(request);
    const store = await getStore();
    const id = new URL(request.url).searchParams.get("id");
    if (id)
      return Response.json(
        {
          schedule: await store.getSchedule(id),
          history: await store.scheduleHistory(id),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    const sessionId =
      new URL(request.url).searchParams.get("session") ?? undefined;
    return Response.json(
      {
        schedules: (await store.listSchedules(sessionId)).map((schedule) => ({
          ...schedule,
          upcoming: upcomingOccurrences(schedule.trigger, Date.now()),
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    const schedule = await (await getStore()).draftSchedule(
      requiredText(body.id, "Schedule ID", 100),
      body.draft,
      body.revision === undefined ? undefined : revision(body.revision),
    );
    return Response.json(schedule, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}
export async function PATCH(request: Request) {
  try {
    const body = await jsonBody(request);
    const id = requiredText(body.id, "Schedule ID", 100);
    const expected = revision(body.revision);
    const store = await getStore();
    if (body.action === "run") {
      const occurrence = await store.scheduledOccurrence(
        id,
        expected,
        Date.now(),
        Date.now(),
        requiredText(body.occurrenceId, "Run ID", 100),
      );
      if (!occurrence)
        throw new HarnessError(
          "Only the current active schedule can run.",
          409,
        );
      await flushDispatch();
      return Response.json(occurrence);
    }
    if (
      body.action !== "activate" &&
      body.action !== "pause" &&
      body.action !== "delete"
    )
      throw new HarnessError("Invalid schedule action.");
    const schedule = await store.changeSchedule(id, expected, body.action);
    await dispatchSchedules();
    return Response.json(schedule);
  } catch (error) {
    return failure(error);
  }
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new HarnessError("Invalid schedule revision.");
  return value;
}
