import { HarnessError, requiredText } from "@harness/core";
import {
  attachmentName,
  MAX_ATTACHMENT_BYTES,
} from "@harness/core/attachments";
import { sha256 } from "@harness/storage/objects";
import { failure, jsonBody, localRequest } from "../../../server/http";
import { getObjects } from "../../../server/objects";
import { getStore } from "../../../server/store";

export async function POST(request: Request) {
  try {
    const body = await jsonBody(request);
    const id = requiredText(body.id, "Attachment ID", 100);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id))
      throw new HarnessError("Invalid attachment ID.");
    const hash = requiredText(body.hash, "SHA-256", 64);
    if (!/^[a-f0-9]{64}$/.test(hash))
      throw new HarnessError("Invalid SHA-256.");
    const size = body.size;
    if (
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > MAX_ATTACHMENT_BYTES
    )
      throw new HarnessError("Files must be between 1 byte and 10 MiB.", 413);
    const mediaType =
      typeof body.mediaType === "string" &&
      /^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(body.mediaType)
        ? body.mediaType
        : "application/octet-stream";
    if (mediaType.startsWith("image/") && size > 5 * 1024 * 1024)
      throw new HarnessError("Images must be at most 5 MiB.", 413);
    const store = await getStore();
    const session = await store.getSession(
      requiredText(body.sessionId, "Session ID", 100),
    );
    const attachment = await store.addAttachment({
      id,
      sessionId: session.id,
      name: attachmentName(body.name),
      mediaType,
      hash,
      size,
      objectKey: `attachments/${session.id}/${id}/${hash}`,
      createdAt: Date.now(),
    });
    if (attachment.status === "ready")
      return Response.json({ attachment, ready: true });
    const objects = await getObjects();
    const target = objects.signedPut
      ? await objects.signedPut(
          attachment.objectKey,
          attachment.mediaType,
          attachment.hash,
        )
      : {
          url: `/api/attachments?id=${encodeURIComponent(id)}`,
          headers: { "Content-Type": "application/octet-stream" },
        };
    return Response.json({ attachment, upload: target });
  } catch (error) {
    return failure(error);
  }
}
export async function PUT(request: Request) {
  try {
    await localRequest(request);
    const attachment = await (await getStore()).getAttachment(
      requiredText(
        new URL(request.url).searchParams.get("id"),
        "Attachment ID",
        100,
      ),
    );
    if (attachment.status === "ready")
      throw new HarnessError("This attachment is already immutable.", 409);
    const objects = await getObjects();
    if (objects.signedPut)
      throw new HarnessError("Use the signed upload URL.", 409);
    if (
      Number(request.headers.get("content-length") ?? 0) > MAX_ATTACHMENT_BYTES
    )
      throw new HarnessError("File exceeds 10 MiB.", 413);
    const reader = request.body?.getReader();
    if (!reader) throw new HarnessError("Expected a file.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > MAX_ATTACHMENT_BYTES) {
        await reader.cancel();
        throw new HarnessError("File exceeds 10 MiB.", 413);
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(Buffer.concat(chunks));
    if (size !== attachment.size || sha256(bytes) !== attachment.hash)
      throw new HarnessError("Upload content did not match its size/checksum.");
    await objects.put(attachment.objectKey, bytes, attachment.mediaType);
    return Response.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
export async function PATCH(request: Request) {
  try {
    const body = await jsonBody(request);
    const store = await getStore();
    const attachment = await store.getAttachment(
      requiredText(body.id, "Attachment ID", 100),
    );
    const objects = await getObjects();
    const head = await objects.head(attachment.objectKey);
    const hash =
      head.hash ??
      sha256(await objects.get(attachment.objectKey, MAX_ATTACHMENT_BYTES));
    if (head.size !== attachment.size || hash !== attachment.hash)
      throw new HarnessError("Uploaded file failed integrity verification.");
    return Response.json(await store.confirmAttachment(attachment.id));
  } catch (error) {
    return failure(error);
  }
}
export async function GET(request: Request) {
  try {
    await localRequest(request);
    const attachment = await (await getStore()).getAttachment(
      requiredText(
        new URL(request.url).searchParams.get("id"),
        "Attachment ID",
        100,
      ),
    );
    if (attachment.status !== "ready")
      throw new HarnessError("Upload is not ready.", 409);
    const objects = await getObjects();
    if (objects.signedGet)
      return new Response(null, {
        status: 302,
        headers: {
          Location: await objects.signedGet(attachment.objectKey),
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    const bytes = await objects.get(attachment.objectKey, MAX_ATTACHMENT_BYTES);
    if (sha256(bytes) !== attachment.hash)
      throw new HarnessError("File integrity check failed.", 409);
    return new Response(Buffer.from(bytes), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return failure(error);
  }
}
