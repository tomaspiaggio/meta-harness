import {
  googleResourceSetup,
  saveGoogleResourceClient,
} from "../../../../../server/google-integrations";
import { failure, jsonBody } from "../../../../../server/http";

/** Save the Google data-access OAuth client from Settings (no restart needed). */
export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    saveGoogleResourceClient(
      request,
      typeof body.clientId === "string" ? body.clientId : "",
      typeof body.clientSecret === "string" ? body.clientSecret : "",
    );
    return Response.json({ setup: googleResourceSetup(request) });
  } catch (error) {
    return failure(error);
  }
}
