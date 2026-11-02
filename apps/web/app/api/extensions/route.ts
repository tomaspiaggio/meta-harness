import { HarnessError, requiredText } from "@harness/core";
import { fetchExtensionPackage } from "../../../server/extensions";
import { failure, jsonBody, localRequest } from "../../../server/http";
import { getStore } from "../../../server/store";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await localRequest(request);
    return Response.json(await (await getStore()).extensions.list(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return failure(error);
  }
}
/** Adds a revision for the owner to review; nothing runs until approved. */
export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    const store = await getStore();
    const source =
      body.action === "install-url"
        ? await fetchExtensionPackage(requiredText(body.url, "URL", 2000))
        : body.action === "propose"
          ? { manifest: body.manifest, code: body.code }
          : (() => {
              throw new HarnessError("Choose install-url or propose.");
            })();
    const revision = await store.extensions.propose({
      ...source,
      proposedBy: "owner",
      note:
        body.action === "install-url"
          ? `Installed from ${String(body.url)}`
          : typeof body.note === "string"
            ? body.note
            : null,
    });
    return Response.json(revision);
  } catch (error) {
    return failure(error);
  }
}
