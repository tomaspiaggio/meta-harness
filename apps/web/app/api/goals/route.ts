import { failure, localRequest } from "../../../server/http";
import { getStore } from "../../../server/store";
export const dynamic = "force-dynamic";

const WEEK = 7 * 86_400_000;
/**
 * ?id= one goal with its history and the sessions working on it; otherwise
 * what the home page shows: goals in play, what needs the owner, and the
 * last week of goal history.
 */
export async function GET(request: Request) {
  try {
    await localRequest(request);
    const store = await getStore();
    const id = new URL(request.url).searchParams.get("id");
    const workspaces = (await store.listWorkspaces()).map(({ id, name }) => ({
      id,
      name,
    }));
    const needs = await store.goals.needs();
    const headers = { "Cache-Control": "no-store" };
    if (id) {
      const goal = await store.goals.get(id);
      return Response.json(
        {
          goal,
          events: await store.goals.events(goal.id),
          people: await store.goals.people(goal),
          needs: needs.filter((need) => need.goalId === goal.id),
          workspaces,
          timeZone: store.ownerTimeZone(),
        },
        { headers },
      );
    }
    const now = Date.now();
    return Response.json(
      {
        goals: await store.goals.list({ endedSince: now - WEEK }),
        needs,
        history: await store.goals.eventsSince(now - WEEK),
        workspaces,
        timeZone: store.ownerTimeZone(),
      },
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
