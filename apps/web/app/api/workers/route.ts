import { HarnessError, requiredText } from "@harness/core";
import { hosted, publicOrigin } from "../../../server/hosted-auth";
import { failure, jsonBody, localRequest } from "../../../server/http";
import { getStore } from "../../../server/store";
export async function GET(request: Request) {
  try {
    await localRequest(request);
    return Response.json(await (await getStore()).listWorkers(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    let server: URL;
    try {
      server = new URL(
        body.serverUrl === undefined
          ? hosted()
            ? publicOrigin()
            : new URL(request.url).origin
          : requiredText(body.serverUrl, "Control URL", 2000),
      );
    } catch {
      throw new HarnessError(
        "Use a valid HTTP(S) control URL reachable from the worker.",
      );
    }
    if (
      !["https:", "http:"].includes(server.protocol) ||
      server.username ||
      server.password ||
      server.pathname !== "/" ||
      server.search ||
      server.hash
    )
      throw new HarnessError(
        "Use a bare HTTP(S) control URL, without credentials or a path.",
      );
    const worker = await (await getStore()).createWorker(
      requiredText(body.name, "Worker name", 100),
    );
    return Response.json(
      {
        ...worker,
        serverUrl: server.origin,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function DELETE(request: Request) {
  try {
    const body = await jsonBody(request);
    await (await getStore()).revokeWorker(
      requiredText(body.id, "Worker ID", 100),
    );
    return Response.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
