import {
  completeOwnerLogin,
  cookie,
  hosted,
  startOwnerLogin,
} from "../../../../server/hosted-auth";
import { failure } from "../../../../server/http";
import { sameOrigin } from "../../../../server/security";
import { getStore } from "../../../../server/store";
export async function GET(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  try {
    const { action } = await context.params;
    if (action === "status")
      return Response.json(
        { hosted: hosted() },
        { headers: { "Cache-Control": "no-store" } },
      );
    if (action === "login") return await startOwnerLogin();
    if (action === "callback") return await completeOwnerLogin(request);
    return new Response("Not found", { status: 404 });
  } catch (error) {
    return failure(error);
  }
}
export async function POST(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  try {
    sameOrigin(request);
    if ((await context.params).action !== "logout")
      return new Response("Not found", { status: 404 });
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
