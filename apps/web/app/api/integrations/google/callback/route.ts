import { HarnessError } from "@harness/core";
import {
  googleBroker,
  googleOwnerBinding,
  googleResourceConfig,
  invalidateGoogleBindings,
} from "../../../../../server/google-integrations";
import { cookie } from "../../../../../server/hosted-auth";
import { authorizeAdmin } from "../../../../../server/security";
import { getStore } from "../../../../../server/store";
export async function GET(request: Request) {
  let target = "/settings?google=failed";
  try {
    // Google redirects are intentionally cross-site. Authenticate the owner and verify flow state instead of same-origin fetch checks.
    await authorizeAdmin(request);
    const config = googleResourceConfig();
    const url = new URL(request.url);
    const flow = cookie(request, "harness_google_resource");
    if (
      !flow ||
      !/^[A-Za-z0-9_-]{43}$/.test(flow) ||
      request.headers.get("host")?.toLowerCase() !==
        new URL(config.redirectUri).host ||
      url.pathname !== new URL(config.redirectUri).pathname ||
      url.searchParams.has("error")
    )
      throw new HarnessError(
        "Google consent was cancelled or did not match this control plane.",
        403,
      );
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const broker = await googleBroker();
    const result = await broker.complete({
      state,
      code,
      ownerBinding: await googleOwnerBinding(request, flow),
      callbackUri: config.redirectUri,
      signal: AbortSignal.timeout(15_000),
    });
    const store = await getStore();
    const connection = (await store.listIntegrationConnections()).find(
      (value) => value.id === result.connectionId,
    );
    if (!connection)
      throw new HarnessError("Google connection no longer exists.", 409);
    await invalidateGoogleBindings(connection.id, connection.revision);
    target = "/settings?google=connected";
  } catch {
    // Neither provider response bodies, authorization codes nor token errors enter logs/URLs.
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: target,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Set-Cookie":
        "harness_google_resource=; HttpOnly; SameSite=Lax; Path=/api/integrations/google; Max-Age=0",
    },
  });
}
