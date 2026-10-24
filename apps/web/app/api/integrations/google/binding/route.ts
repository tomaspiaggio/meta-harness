import { randomUUID } from "node:crypto";
import { HarnessError } from "@harness/core";
import { jsonObject } from "@harness/core/integrations";
import { googleConstraints, parseA1 } from "@harness/integrations";
import { failure, jsonBody } from "../../../../../server/http";
import { getStore } from "../../../../../server/store";
export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    const store = await getStore();
    const connection = (await store.listIntegrationConnections()).find(
      (value) => value.id === body.connectionId,
    );
    if (
      connection?.adapter !== "native" ||
      connection.config.adapterId !== "google"
    )
      throw new HarnessError("Google connection not found.", 404);
    const binding = (await store.listIntegrationBindings()).find(
      (value) =>
        value.connectionId === connection.id &&
        value.workspaceId === body.workspaceId,
    );
    if (!binding || binding.revision !== body.expectedRevision)
      throw new HarnessError("Workspace grant changed. Refresh Settings.", 409);
    const constraints = googleConstraints(jsonObject(body.constraints));
    for (const ranges of Object.values(constraints.sheetRanges ?? {}))
      for (const range of ranges) parseA1(range);
    const result = await store.putIntegrationBinding(
      {
        ...binding,
        constraints: jsonObject(constraints),
        revision: randomUUID(),
      },
      binding.revision,
    );
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}
