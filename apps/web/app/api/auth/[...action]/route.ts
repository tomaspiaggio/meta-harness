import {
  googleAuthEnabled,
  googleLoginReadiness,
  handleGoogleAuth,
} from "../../../../server/google-auth";
import {
  completeOwnerLogin,
  cookie,
  hosted,
  startOwnerLogin,
} from "../../../../server/hosted-auth";
import { failure } from "../../../../server/http";
import { sameOrigin } from "../../../../server/security";
import { getStore } from "../../../../server/store";

type Context = { params: Promise<{ action: string[] }> };
export async function GET(request: Request, context: Context) {
  try {
    const action = (await context.params).action.join("/");
    if (action === "status") {
      return Response.json(
        {
          hosted: hosted(),
          mode: googleAuthEnabled() ? "google" : hosted() ? "oidc" : "setup",
          ...(googleAuthEnabled()
            ? googleLoginReadiness()
            : hosted()
              ? { configured: true }
              : {
                  configured: false,
                  message:
                    "Google sign-in setup is pending. Configure the Google OAuth credentials on this control server to enable login.",
                }),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (googleAuthEnabled()) return await handleGoogleAuth(request);
    if (action === "login") return await startOwnerLogin();
    if (action === "callback") return await completeOwnerLogin(request);
    return new Response("Not found", { status: 404 });
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    sameOrigin(request);
    const action = (await context.params).action.join("/");
    if (googleAuthEnabled()) {
      if (action === "logout") {
        const target = new URL(request.url);
        target.pathname = "/api/auth/sign-out";
        return await handleGoogleAuth(new Request(target, request));
      }
      return await handleGoogleAuth(request);
    }
    if (action !== "logout") return new Response("Not found", { status: 404 });
    const token = cookie(request, "harness_owner");
    if (token) await (await getStore()).revokeOwnerSession(token);
    const headers = new Headers({ "Cache-Control": "no-store" });
    for (const name of ["harness_owner", "harness_session"])
      headers.append(
        "Set-Cookie",
        `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${hosted() ? "; Secure" : ""}`,
      );
    return Response.json({ ok: true }, { headers });
  } catch (error) {
    return failure(error);
  }
}
