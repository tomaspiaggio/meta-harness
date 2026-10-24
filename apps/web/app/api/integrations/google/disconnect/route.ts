import { HarnessError } from "@harness/core";
import { GoogleAuthorizationStore } from "@harness/storage/google";
import {
  googleBroker,
  invalidateGoogleBindings,
} from "../../../../../server/google-integrations";
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
      connection?.config.adapterId !== "google" ||
      connection.revision !== body.expectedRevision
    )
      throw new HarnessError(
        "Google connection changed. Refresh Settings.",
        409,
      );
    const credentials = new GoogleAuthorizationStore(
      store.databaseConnection(),
    );
    const credential = await credentials.getCredential(connection.id);
    await invalidateGoogleBindings(connection.id, connection.revision);
    if (credential) {
      if (body.action === "rotate_key")
        await (await googleBroker()).rotateKey(connection.id);
      else
        await (await googleBroker()).disconnect(
          connection.id,
          credential.revision,
        );
    }
    return Response.json(
      { disconnected: body.action !== "rotate_key" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
