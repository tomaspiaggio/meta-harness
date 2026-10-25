import { HarnessError, requiredText } from "@harness/core";
import { hosted, publicOrigin } from "../../../server/hosted-auth";
import { failure, jsonBody, localRequest } from "../../../server/http";
import { getStore } from "../../../server/store";
import { workerOnboarding } from "../../../server/worker-onboarding";
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
    if (body.format !== undefined && body.format !== "markdown")
      throw new HarnessError("Unsupported worker enrollment format.");
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
    const name = requiredText(body.name, "Worker name", 100);
    const worker = await (await getStore()).createWorker(name);
    const credential = { ...worker, serverUrl: server.origin };
    if (body.format === "markdown") {
      const guide = workerOnboarding(name, credential);
      return new Response(guide.markdown, {
        status: 201,
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${guide.filename}"`,
          "Cache-Control": "no-store",
        },
      });
    }
    return Response.json(credential, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return failure(error);
  }
}
/** The owner renames or labels a machine, so sessions can require it. */
export async function PATCH(request: Request) {
  try {
    const body = await jsonBody(request);
    const store = await getStore();
    const id = requiredText(body.id, "Worker ID", 100);
    if (body.name !== undefined) {
      await store.renameWorker(
        id,
        requiredText(body.name, "Machine name", 100),
      );
      return Response.json({ ok: true });
    }
    return Response.json(
      await (await getStore()).setWorkerLabels(
        requiredText(body.id, "Worker ID", 100),
        body.labels,
      ),
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
