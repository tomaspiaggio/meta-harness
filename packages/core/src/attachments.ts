import { HarnessError } from "./index";
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TURN_ATTACHMENTS = 8;
export interface Attachment {
  id: string;
  sessionId: string;
  name: string;
  mediaType: string;
  size: number;
  hash: string;
  objectKey: string;
  createdAt: number;
  status?: string;
}
export interface RuntimeAttachment extends Attachment {
  path: string;
}
export const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
export function attachmentName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 200 ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127 ||
        character === "/" ||
        character === "\\",
    ) ||
    value === "." ||
    value === ".."
  )
    throw new HarnessError(
      "Use a filename without path separators or control characters.",
    );
  return value.trim();
}
