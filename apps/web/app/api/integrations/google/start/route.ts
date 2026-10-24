import { randomUUID } from "node:crypto";
import { HarnessError } from "@harness/core";
import {
  GOOGLE_SCOPES,
  type GoogleGroup,
  googleDefinition,
} from "@harness/integrations";
import {
  ensureGoogleDefinition,
  googleBroker,
  googleFlowCookie,
  googleOwnerBinding,
  googleResourceConfig,
} from "../../../../../server/google-integrations";
import { failure, jsonBody } from "../../../../../server/http";
import { getStore } from "../../../../../server/store";
export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    const config = googleResourceConfig();
    if (new URL(request.url).origin !== new URL(config.redirectUri).origin)
      throw new HarnessError(
        "Open this control plane at its registered Google redirect origin.",
        403,
      );
    if (
      !Array.isArray(body.groups) ||
      !body.groups.length ||
      body.groups.some(
        (group) => typeof group !== "string" || !(group in GOOGLE_SCOPES),
      )
    )
      throw new HarnessError(
        "Select Gmail, Drive, Docs or Sheets read access.",
      );
    const groups = [...new Set(body.groups)] as GoogleGroup[];
    await ensureGoogleDefinition();
    const store = await getStore();
    let connection = (await store.listIntegrationConnections()).find(
      (value) => value.id === body.connectionId,
    );
    if (body.connectionId) {
      if (
        !connection ||
        connection.adapter !== "native" ||
        connection.integrationId !== googleDefinition.id ||
        connection.config.adapterId !== "google" ||
        connection.revision !== body.expectedRevision
      )
        throw new HarnessError(
          "Google connection changed. Refresh Settings.",
          409,
        );
      if (!connection.enabled)
        connection = await store.putIntegrationConnection(
          { ...connection, enabled: true, revision: randomUUID() },
          connection.revision,
        );
    } else {
      if (
        typeof body.label !== "string" ||
        !body.label.trim() ||
        body.label.length > 100
      )
        throw new HarnessError("Name this Google account connection.");
      connection = await store.putIntegrationConnection({
        id: randomUUID(),
        integrationId: googleDefinition.id,
        adapter: "native",
        label: body.label.trim(),
        revision: randomUUID(),
        enabled: true,
        config: { adapterId: "google" },
      });
    }
    if (!connection) throw new HarnessError("Connection unavailable.");
    const flow = googleFlowCookie(request);
    const broker = await googleBroker();
    const authorizationUrl = await broker.start({
      connectionId: connection.id,
      connectionRevision: connection.revision,
      ownerBinding: googleOwnerBinding(request, flow),
      groups,
    });
    return Response.json(
      { authorizationUrl },
      {
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "Set-Cookie": `harness_google_resource=${flow}; HttpOnly; SameSite=Lax; Path=/api/integrations/google; Max-Age=600${new URL(config.redirectUri).protocol === "https:" ? "; Secure" : ""}`,
        },
      },
    );
  } catch (error) {
    return failure(error);
  }
}
