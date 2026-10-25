import { HarnessError, parseProvider, requiredText } from "@harness/core";
import { failure, jsonBody } from "../../../server/http";
import { getStore } from "../../../server/store";
export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    return Response.json(
      await (await getStore()).createSession(
        requiredText(body.workspaceId, "Workspace ID", 100),
        requiredText(body.title, "Title", 100),
        body.provider === undefined ? undefined : parseProvider(body.provider),
        body.model as string | null | undefined,
      ),
      { status: 201 },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function PATCH(request: Request) {
  try {
    const body = await jsonBody(request);
    if (body.action === "model")
      return Response.json(
        await (await getStore()).setSessionModel(
          requiredText(body.id, "Session ID", 100),
          body.model,
        ),
      );
    if (body.action === "labels")
      return Response.json(
        await (await getStore()).setSessionLabels(
          requiredText(body.id, "Session ID", 100),
          body.labels,
        ),
      );
    if (body.action === "read") {
      if (typeof body.throughSequence !== "number")
        throw new HarnessError("Invalid read cursor.");
      return Response.json(
        await (await getStore()).markSessionRead(
          requiredText(body.id, "Session ID", 100),
          body.throughSequence,
        ),
      );
    }
    return Response.json(
      await (await getStore()).renameSession(
        requiredText(body.id, "Session ID", 100),
        requiredText(body.title, "Title", 100),
      ),
    );
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await jsonBody(request);
    if (body.confirm !== true)
      throw new HarnessError("Deletion requires confirmation.");
    await (await getStore()).deleteSession(requiredText(body.id, "ID", 100));
    const { after } = await import("next/server");
    after(async () => {
      const { cleanupDeleted } = await import("../../../server/deletion");
      await cleanupDeleted();
    });
    return Response.json({ deleted: true });
  } catch (error) {
    return failure(error);
  }
}
