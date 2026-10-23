import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeInput } from "@harness/core";
import { imageTypes } from "@harness/core/attachments";

export function inputPrompt(input: RuntimeInput): string {
  const files = input.attachments?.map((file) => ({
    name: file.name,
    path: relative(input.directory, file.path),
    mediaType: file.mediaType,
    sha256: file.hash,
  }));
  return `Workspace instructions:\n${input.instructions}\n\nUser instruction:\n${input.prompt}${files?.length ? `\n\nAttached files (read these paths when relevant; non-image files require tools):\n${JSON.stringify(files)}` : ""}`;
}
export async function claudeUserMessage(
  input: RuntimeInput,
): Promise<SDKUserMessage> {
  const content: SDKUserMessage["message"]["content"] = [
    { type: "text", text: inputPrompt(input) },
  ];
  for (const file of input.attachments ?? []) {
    if (!imageTypes.has(file.mediaType)) continue;
    const bytes = await readFile(file.path);
    if (
      bytes.length > 5 * 1024 * 1024 ||
      createHash("sha256").update(bytes).digest("hex") !== file.hash
    )
      throw new Error("Image attachment failed its size/integrity check.");
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: file.mediaType as
          | "image/png"
          | "image/jpeg"
          | "image/webp"
          | "image/gif",
        data: bytes.toString("base64"),
      },
    });
  }
  return {
    type: "user",
    session_id: input.session.nativeId ?? "",
    parent_tool_use_id: null,
    message: { role: "user", content },
  };
}
