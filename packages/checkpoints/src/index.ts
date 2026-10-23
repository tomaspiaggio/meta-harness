import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FileSnapshot } from "@harness/core/checkpoint";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 512;
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export function validateSnapshot(value: unknown): FileSnapshot {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("files" in value) ||
    !Array.isArray(value.files) ||
    value.files.length > MAX_FILES
  )
    throw new Error("Invalid checkpoint manifest.");
  let size = 0;
  const seen = new Set<string>();
  const files = value.files.map((file: unknown) => {
    if (
      !file ||
      typeof file !== "object" ||
      !("path" in file) ||
      typeof file.path !== "string" ||
      !("data" in file) ||
      typeof file.data !== "string" ||
      !("sha256" in file) ||
      typeof file.sha256 !== "string" ||
      !("executable" in file) ||
      typeof file.executable !== "boolean"
    )
      throw new Error("Invalid checkpoint file.");
    if (
      !file.path ||
      file.path.length > 1024 ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path.includes("\0") ||
      file.path.includes(":")
    )
      throw new Error("Unsafe checkpoint path.");
    const parts = file.path.split("/");
    if (
      parts.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part === ".git" ||
          part === "node_modules",
      ) ||
      seen.has(file.path)
    )
      throw new Error("Unsafe or duplicate checkpoint path.");
    seen.add(file.path);
    const bytes = Buffer.from(file.data, "base64");
    if (bytes.toString("base64") !== file.data || hash(bytes) !== file.sha256)
      throw new Error("Checkpoint checksum mismatch.");
    size += bytes.length;
    if (size > MAX_BYTES) throw new Error("Checkpoint exceeds 4 MiB.");
    return {
      path: file.path,
      data: file.data,
      sha256: file.sha256,
      executable: file.executable,
    };
  });
  // Reject file/directory collisions independently of entry order.
  for (const file of files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++)
      if (seen.has(parts.slice(0, i).join("/")))
        throw new Error("Checkpoint file/directory collision.");
  }
  let attachments: FileSnapshot["attachments"];
  if ("attachments" in value && value.attachments !== undefined) {
    if (!Array.isArray(value.attachments) || value.attachments.length > 1000)
      throw new Error("Invalid checkpoint attachment references.");
    attachments = value.attachments.map((entry: unknown) => {
      const item = entry as { id?: unknown; hash?: unknown };
      if (
        !item ||
        typeof item.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id) ||
        typeof item.hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.hash)
      )
        throw new Error("Invalid checkpoint attachment reference.");
      return { id: item.id, hash: item.hash };
    });
  }
  return { version: 1, files, ...(attachments ? { attachments } : {}) };
}
/** Capture only a session execution directory, never the provider's auth home. */
export async function captureSnapshot(
  directory: string,
): Promise<FileSnapshot> {
  const files: FileSnapshot["files"] = [];
  let bytes = 0;
  async function walk(relative: string) {
    const path = join(directory, relative);
    const stat = await lstat(path);
    if (stat.isSymbolicLink())
      throw new Error("Checkpoint capture does not follow symlinks.");
    if (stat.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) {
        if (
          entry !== ".git" &&
          entry !== "node_modules" &&
          entry !== ".harness-attachments" &&
          entry !== ".harness-home"
        )
          await walk(relative ? `${relative}/${entry}` : entry);
      }
    } else if (stat.isFile()) {
      if (files.length >= MAX_FILES || bytes + stat.size > MAX_BYTES)
        throw new Error("Checkpoint exceeds local file or size limit.");
      const data = await readFile(path);
      bytes += data.length;
      if (bytes > MAX_BYTES) throw new Error("Checkpoint exceeds 4 MiB.");
      files.push({
        path: relative,
        data: data.toString("base64"),
        sha256: hash(data),
        executable: !!(stat.mode & 0o111),
      });
    } else
      throw new Error("Checkpoint contains an unsupported filesystem entry.");
  }
  await walk("");
  return validateSnapshot({ version: 1, files });
}
/** Restore into a fresh sibling directory so partial extraction never becomes live. */
export async function restoreSnapshot(
  directory: string,
  value: unknown,
): Promise<void> {
  const snapshot = validateSnapshot(value);
  const stage = `${directory}.restore-${crypto.randomUUID()}`;
  await mkdir(stage, { recursive: true, mode: 0o700 });
  try {
    for (const file of snapshot.files) {
      const path = join(stage, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, Buffer.from(file.data, "base64"), {
        mode: file.executable ? 0o700 : 0o600,
      });
    }
    await rm(directory, { recursive: true, force: true });
    await rename(stage, directory);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
