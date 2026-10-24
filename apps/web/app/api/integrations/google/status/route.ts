import { GOOGLE_SCOPES, type GoogleGroup } from "@harness/integrations";
import { GoogleAuthorizationStore } from "@harness/storage/google";
import { googleResourceConfig } from "../../../../../server/google-integrations";
import { failure, localRequest } from "../../../../../server/http";
import { getStore } from "../../../../../server/store";
export async function GET(request: Request) {
  try {
    await localRequest(request);
    const store = await getStore();
    const credentials = new GoogleAuthorizationStore(
      store.databaseConnection(),
    );
    let configured = true;
    try {
      googleResourceConfig();
    } catch {
      configured = false;
    }
    const connections = await Promise.all(
      (await store.listIntegrationConnections())
        .filter(
          (value) =>
            value.adapter === "native" && value.config.adapterId === "google",
        )
        .map(async (connection) => {
          const credential = await credentials.getCredential(connection.id);
          return {
            id: connection.id,
            label: connection.label,
            revision: connection.revision,
            enabled: connection.enabled,
            accountEmail: credential?.email ?? "",
            status: credential?.status ?? "disconnected",
            grantedGroups: (Object.keys(GOOGLE_SCOPES) as GoogleGroup[]).filter(
              (group) => credential?.scopes.includes(GOOGLE_SCOPES[group]),
            ),
          };
        }),
    );
    return Response.json(
      { configured, connections },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
