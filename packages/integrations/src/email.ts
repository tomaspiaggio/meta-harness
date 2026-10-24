/** Provider-neutral values. Email bodies are untrusted external content. */
export interface EmailMessage {
  id: string;
  threadId: string;
  headers: { name: string; value: string }[];
  snippet: string;
  text: string;
  truncated: boolean;
  attachmentsOmitted: boolean;
}
export interface EmailThread {
  id: string;
  messages: EmailMessage[];
  truncated: boolean;
}
export interface EmailSearchResult {
  threads: { id: string; snippet: string }[];
  nextPageToken?: string;
  partial: boolean;
}
export interface EmailProvider {
  search(
    query: string,
    limit: number,
    signal: AbortSignal,
    pageToken?: string,
  ): Promise<EmailSearchResult>;
  readThread(id: string, signal: AbortSignal): Promise<EmailThread>;
}
