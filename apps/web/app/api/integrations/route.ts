import "../../../server/integration-adapters";
import { randomUUID } from "node:crypto";
import { HarnessError } from "@harness/core";
import { failure, localRequest, readJson } from "../../../server/http";
import { getIntegrationAdapter } from "../../../server/integrations";
import { getStore } from "../../../server/store";
export async function GET(request: Request) {
  try {
    await localRequest(request);
    const store = await getStore();
    return Response.json(
      {
        definitions: await store.listIntegrationDefinitions(),
        connections: await store.listIntegrationConnections(),
        bindings: await store.listIntegrationBindings(),
        workspaces: await store.listWorkspaces(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    await localRequest(request);
    const body = await readJson(request, 262144);
    const store = await getStore();
    const expected =
      typeof body.expectedRevision === "string"
        ? body.expectedRevision
        : undefined;
    if (body.action === "delete") {
      if (typeof body.connectionId !== "string" || !expected)
        throw new HarnessError("Expected connection identity and revision.");
      await store.deleteIntegrationConnection(body.connectionId, expected);
      return Response.json({ deleted: true });
    }
    if (body.action === "connection")
      return Response.json(
        await store.putIntegrationConnection(body.connection, expected),
      );
    if (body.action === "binding")
      return Response.json(
        await store.putIntegrationBinding(body.binding, expected),
      );
    if (body.action === "discover") {
      const connection = (await store.listIntegrationConnections()).find(
        (c) => c.id === body.connectionId,
      );
      if (!connection || connection.revision !== expected)
        throw new HarnessError("Connection revision conflict.", 409);
      const definition = await getIntegrationAdapter(connection).discover(
        connection,
        AbortSignal.timeout(15000),
      );
      const latestConnection = (await store.listIntegrationConnections()).find(
        (c) => c.id === connection.id,
      );
      if (latestConnection?.revision !== connection.revision)
        throw new HarnessError(
          "Connection changed during discovery. Test its current revision.",
          409,
        );
      if (definition.id !== connection.integrationId)
        throw new HarnessError("Adapter returned an unrelated definition.");
      const old = (await store.listIntegrationDefinitions()).find(
        (d) => d.id === definition.id,
      );
      if (old?.revision !== definition.revision)
        await store.putIntegrationDefinition(definition, old?.revision);
      return Response.json(definition);
    }
    if (body.action === "disable") {
      const connection = (await store.listIntegrationConnections()).find(
        (c) => c.id === body.connectionId,
      );
      if (!connection) throw new HarnessError("Connection not found.", 404);
      return Response.json(
        await store.putIntegrationConnection(
          { ...connection, enabled: false, revision: randomUUID() },
          expected,
        ),
      );
    }
    throw new HarnessError("Unknown integration action.");
  } catch (error) {
    return failure(error);
  }
}
