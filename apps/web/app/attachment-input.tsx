"use client";
import type { Attachment } from "@harness/core/attachments";
import {
  imageTypes,
  MAX_ATTACHMENT_BYTES,
  MAX_TURN_ATTACHMENTS,
} from "@harness/core/attachments";
import { Paperclip, X } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

export interface PendingFile {
  id: string;
  file: File;
  preview?: string;
  progress: number;
  uploaded?: Attachment;
}
export function acceptFiles(
  current: PendingFile[],
  incoming: FileList | File[],
  error: (message: string) => void,
): PendingFile[] {
  const result = [...current];
  for (const file of Array.from(incoming)) {
    if (result.length >= MAX_TURN_ATTACHMENTS) {
      error("Attach at most eight files.");
      break;
    }
    if (
      !file.size ||
      file.size > MAX_ATTACHMENT_BYTES ||
      (imageTypes.has(file.type) && file.size > 5 * 1024 * 1024)
    ) {
      error("Files can be up to 10 MiB; images up to 5 MiB.");
      continue;
    }
    result.push({
      id: crypto.randomUUID(),
      file,
      progress: 0,
      preview: imageTypes.has(file.type)
        ? URL.createObjectURL(file)
        : undefined,
    });
  }
  return result;
}
export function FilePicker({
  files,
  disabled,
  onFiles,
}: {
  files: PendingFile[];
  disabled: boolean;
  onFiles: (files: File[]) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={picker}
        type="file"
        multiple
        className="hidden"
        aria-label="Attach files"
        onChange={(event) => {
          if (event.target.files) onFiles(Array.from(event.target.files));
          event.target.value = "";
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={disabled || files.length >= MAX_TURN_ATTACHMENTS}
        onClick={() => picker.current?.click()}
        aria-label="Attach images or files"
      >
        <Paperclip />
      </Button>
    </>
  );
}
export function PendingAttachments({
  files,
  disabled,
  remove,
}: {
  files: PendingFile[];
  disabled: boolean;
  remove: (id: string) => void;
}) {
  const previews = useRef(new Set<string>());
  useEffect(() => {
    const next = new Set(
      files.flatMap((file) => (file.preview ? [file.preview] : [])),
    );
    for (const previous of previews.current)
      if (!next.has(previous)) URL.revokeObjectURL(previous);
    previews.current = next;
  }, [files]);
  useEffect(
    () => () => {
      for (const preview of previews.current) URL.revokeObjectURL(preview);
    },
    [],
  );
  return files.length ? (
    <div className="mb-3 flex flex-wrap gap-2">
      {files.map((file) => (
        <div
          key={file.id}
          className="relative flex max-w-56 items-center gap-2 rounded-lg border bg-muted p-2 pr-7 text-xs"
        >
          {file.preview && (
            <Image
              width={40}
              height={40}
              unoptimized
              src={file.preview}
              alt="Attachment preview"
              className="size-10 rounded object-cover"
            />
          )}
          <span className="min-w-0 truncate">
            {file.file.name}
            <span className="block text-muted-foreground">
              {file.uploaded
                ? "Ready"
                : file.progress
                  ? `${file.progress}% uploaded`
                  : `${Math.ceil(file.file.size / 1024)} KiB`}
            </span>
          </span>
          <button
            type="button"
            className="absolute top-1 right-1 rounded p-1"
            aria-label={`Remove ${file.file.name}`}
            disabled={disabled}
            onClick={() => remove(file.id)}
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  ) : null;
}
export async function uploadAttachment(
  sessionId: string,
  pending: PendingFile,
  progress: (percentage: number) => void,
): Promise<Attachment> {
  if (pending.uploaded?.sessionId === sessionId) return pending.uploaded;
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", await pending.file.arrayBuffer()),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const registered = await fetch("/api/attachments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: pending.id,
      sessionId,
      name: pending.file.name,
      mediaType: pending.file.type || "application/octet-stream",
      size: pending.file.size,
      hash,
    }),
  });
  const result = await registered.json();
  if (!registered.ok)
    throw new Error(result.error ?? "Cannot prepare attachment.");
  if (!result.ready)
    await new Promise<void>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("PUT", result.upload.url);
      request.timeout = 120000;
      for (const [key, value] of Object.entries(
        result.upload.headers as Record<string, string>,
      ))
        request.setRequestHeader(key, value);
      request.upload.onprogress = (event) => {
        if (event.lengthComputable)
          progress(Math.round((event.loaded / event.total) * 100));
      };
      request.onload = () =>
        request.status >= 200 && request.status < 300
          ? resolve()
          : reject(new Error(`File upload failed (${request.status}).`));
      request.onerror = () =>
        reject(new Error("File upload lost its connection."));
      request.ontimeout = () => reject(new Error("File upload timed out."));
      request.send(pending.file);
    });
  const confirmation = await fetch("/api/attachments", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: pending.id }),
  });
  const attachment = await confirmation.json();
  if (!confirmation.ok)
    throw new Error(attachment.error ?? "File upload failed verification.");
  progress(100);
  return attachment;
}
