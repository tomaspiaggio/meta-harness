import { googleAuthEnabled } from "../../../server/google-auth";
import { failure, readJson } from "../../../server/http";
import {
  loginCookie,
  sameOrigin,
  tokenMatches,
} from "../../../server/security";
export async function POST(request: Request) {
  try {
    if (googleAuthEnabled())
      return Response.json({ error: "Use Google sign-in." }, { status: 403 });
    sameOrigin(request);
    const body = await readJson(request);
    if (typeof body.token !== "string" || !tokenMatches(body.token))
      return Response.json({ error: "Invalid access token." }, { status: 401 });
    return Response.json(
      { ok: true },
      {
        headers: {
          "Set-Cookie": `harness_session=${loginCookie()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${new URL(request.url).protocol === "https:" || !["localhost", "127.0.0.1", "::1"].includes(process.env.HARNESS_BIND_HOST ?? "127.0.0.1") ? "; Secure" : ""}`,
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    return failure(error);
  }
}
