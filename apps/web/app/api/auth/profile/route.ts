import { HarnessError } from "@harness/core";
import {
  googleAuthEnabled,
  googleOwnerAuth,
} from "../../../../server/google-auth";
import { failure, localRequest } from "../../../../server/http";

export async function GET(request: Request) {
  try {
    await localRequest(request);
    if (!googleAuthEnabled())
      return Response.json(
        { user: null },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    // localRequest enforces the verified-email allowlist and revocation ledger.
    const session = await googleOwnerAuth().api.getSession({
      headers: request.headers,
    });
    if (!session)
      throw new HarnessError("Sign in with your allowed Google account.", 401);
    const { name, email, image } = session.user;
    let photo: string | null = null;
    try {
      const url = new URL(image ?? "");
      if (url.protocol === "https:" && !url.username && !url.password)
        photo = url.toString();
    } catch {}
    return Response.json(
      { user: { name, email, image: photo } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
