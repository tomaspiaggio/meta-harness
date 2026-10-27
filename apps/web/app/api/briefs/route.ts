import {
  BRIEF_HOUR,
  localTime,
  parseDay,
  previousDay,
} from "@harness/core/briefs";
import { startBrief } from "../../../server/briefs";
import { failure, jsonBody, localRequest } from "../../../server/http";
import { getStore } from "../../../server/store";
export const dynamic = "force-dynamic";
/** ?id= one brief with its HTML; ?day= that day's briefs; otherwise each workspace's latest. */
export async function GET(request: Request) {
  try {
    await localRequest(request);
    const store = await getStore();
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (id)
      return Response.json(await store.getBrief(id), {
        headers: { "Cache-Control": "no-store" },
      });
    const day = url.searchParams.get("day");
    const now = localTime(Date.now(), store.ownerTimeZone());
    const yesterday = previousDay(now.day);
    return Response.json(
      {
        days: await store.briefDays(),
        briefs: await store.listBriefs(day ? { day: parseDay(day) } : {}),
        workspaces: (await store.listWorkspaces()).map(({ id, name }) => ({
          id,
          name,
        })),
        yesterday,
        nextRunHour: BRIEF_HOUR,
        run: await store.briefRun(day ? parseDay(day) : yesterday),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
/** Writes (or with rewrite: true, rewrites) the brief for a day now. */
export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    const store = await getStore();
    const day =
      body.day === undefined
        ? previousDay(localTime(Date.now(), store.ownerTimeZone()).day)
        : parseDay(body.day);
    return Response.json(await startBrief(day, body.rewrite === true));
  } catch (error) {
    return failure(error);
  }
}
