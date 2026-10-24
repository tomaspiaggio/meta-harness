import { HarnessError } from "@harness/core";
import type { EmailMessage, EmailProvider, EmailThread } from "./email";
import { array, object, string } from "./http";

const MAX_TEXT = 24_000;
const cleanText = (value: string) => value.replaceAll("\u0000", "");
function decodePart(part: Record<string, unknown>): string {
  if (part.filename || part.mimeType !== "text/plain") return "";
  const data = string(object(part.body).data);
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(data)) return "";
  return cleanText(Buffer.from(data, "base64url").toString("utf8"));
}
function messageContent(
  payload: Record<string, unknown>,
  budget = 1000,
): { text: string; attachments: boolean; partial: boolean } {
  let text = "";
  let attachments = false;
  let count = 0;
  const walk = (part: Record<string, unknown>, depth: number) => {
    if (count++ >= budget || depth > 20) return;
    if (part.filename || object(part.body).attachmentId) attachments = true;
    text += decodePart(part);
    for (const child of array(part.parts)) walk(object(child), depth + 1);
  };
  walk(payload, 0);
  return {
    text: text.slice(0, MAX_TEXT),
    attachments,
    partial: text.length > MAX_TEXT || count >= budget,
  };
}
export function gmailThread(
  value: Record<string, unknown>,
  labels?: string[],
): EmailThread {
  const all = array(value.messages);
  if (
    labels &&
    all.some(
      (item) =>
        !array(object(item).labelIds).some((label) =>
          labels.includes(string(label)),
        ),
    )
  )
    throw new HarnessError(
      "This thread includes messages outside the workspace label grant.",
      403,
    );
  let remaining = MAX_TEXT;
  const messages: EmailMessage[] = all.slice(0, 20).map((item) => {
    const message = object(item);
    const payload = object(message.payload);
    const content = messageContent(payload);
    const text = content.text.slice(0, remaining);
    remaining -= text.length;
    return {
      id: string(message.id),
      threadId: string(message.threadId),
      headers: array(payload.headers)
        .map(object)
        .filter((header) =>
          [
            "from",
            "to",
            "cc",
            "subject",
            "date",
            "message-id",
            "in-reply-to",
          ].includes(string(header.name).toLowerCase()),
        )
        .slice(0, 20)
        .map((header) => ({
          name: string(header.name).slice(0, 100),
          value: string(header.value).slice(0, 1000),
        })),
      snippet: string(message.snippet).slice(0, 500),
      text,
      truncated: content.partial || text.length < content.text.length,
      attachmentsOmitted: content.attachments,
    };
  });
  return {
    id: string(value.id),
    messages,
    truncated: all.length > 20 || messages.some((m) => m.truncated),
  };
}

/** Gmail implements the provider-neutral email read port. */
export class GmailEmailProvider implements EmailProvider {
  constructor(
    private request: (url: URL) => Promise<Record<string, unknown>>,
    private labels?: string[],
  ) {}
  async search(
    query: string,
    limit: number,
    signal: AbortSignal,
    pageToken?: string,
  ) {
    signal.throwIfAborted();
    const url = new URL(
      "https://gmail.googleapis.com/gmail/v1/users/me/threads",
    );
    url.searchParams.set("q", query);
    url.searchParams.set("maxResults", String(limit));
    for (const label of this.labels ?? [])
      url.searchParams.append("labelIds", label);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const value = await this.request(url);
    return {
      threads: array(value.threads)
        .slice(0, limit)
        .map((item) => ({
          id: string(object(item).id),
          snippet: string(object(item).snippet).slice(0, 500),
        })),
      partial: true,
      ...(value.nextPageToken
        ? { nextPageToken: string(value.nextPageToken) }
        : {}),
    };
  }
  async readThread(id: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const url = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${id}`,
    );
    url.searchParams.set("format", "full");
    return gmailThread(await this.request(url), this.labels);
  }
}
