import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import {
  type Attachment,
  MAX_ATTACHMENT_BYTES,
  type RuntimeAttachment,
} from "@harness/core/attachments";
import { boundedBytes, type WorkerClient } from "./client";

export async function materializeAttachments(
  client: WorkerClient,
  directory: string,
  turnId: string,
  generation: number,
  references?: { id: string; hash: string }[],
): Promise<RuntimeAttachment[]> {
  const attachments = await client.post<
    (Attachment & { url?: string; current?: boolean })[]
  >("attachments", { turnId, generation });
  const root = join(directory, ".harness-attachments");
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink())
    throw new Error("Attachment directory cannot be a symlink.");
  const result: RuntimeAttachment[] = [];
  for (const attachment of attachments) {
    if (
      !/^[a-zA-Z0-9_-]{1,100}$/.test(attachment.id) ||
      !/^[a-f0-9]{64}$/.test(attachment.hash) ||
      attachment.size > MAX_ATTACHMENT_BYTES
    )
      throw new Error("Invalid assigned attachment.");
    const path = join(
      root,
      `${attachment.id}-${attachment.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120)}`,
    );
    let bytes: Uint8Array | undefined;
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (stat.isFile() && stat.size === attachment.size)
          bytes = new Uint8Array(await file.readFile());
      } finally {
        await file.close();
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
    const digest = (value: Uint8Array) =>
      createHash("sha256").update(value).digest("hex");
    if (!bytes || digest(bytes) !== attachment.hash) {
      bytes = attachment.url
        ? await boundedBytes(
            await fetch(attachment.url, { signal: AbortSignal.timeout(30000) }),
            MAX_ATTACHMENT_BYTES,
          )
        : await client.bytes(
            "attachment-read",
            { turnId, generation, id: attachment.id },
            MAX_ATTACHMENT_BYTES,
          );
      if (bytes.length !== attachment.size || digest(bytes) !== attachment.hash)
        throw new Error("Attachment checksum mismatch.");
      const file = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_TRUNC |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(bytes);
      } finally {
        await file.close();
      }
    }
    references?.push({ id: attachment.id, hash: attachment.hash });
    if (attachment.current !== false) result.push({ ...attachment, path });
  }
  return result;
}
