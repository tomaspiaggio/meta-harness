import { createHmac, timingSafeEqual } from "node:crypto";
import { HarnessError } from "@harness/core";
import type {
  IntegrationAdapter,
  JsonObject,
  JsonValue,
} from "@harness/core/integrations";
import { IntegrationNotStartedError } from "@harness/core/integrations";
import { GmailEmailProvider } from "./gmail";
import {
  assertFileAllowed,
  assertRangeAllowed,
  GOOGLE_SCOPES,
  type GoogleGroup,
  googleConstraints,
  googleDefinition,
  parseGoogleArguments,
} from "./google-tools";
import {
  array,
  boundedResponse,
  googleJson,
  type HttpFetch,
  object,
  string,
} from "./http";

export interface GoogleAccess {
  /** Broker checks live connection/scopes and holds credentials only within the control process. */
  withAccess<T>(
    connectionId: string,
    scopes: string[],
    signal: AbortSignal,
    action: (accessToken: string, account?: { email: string }) => Promise<T>,
    expectedRevision?: string,
  ): Promise<T>;
}
const MAX_TEXT = 24_000;
const fileFields =
  "id,name,mimeType,size,modifiedTime,version,webViewLink,capabilities(canDownload),shortcutDetails";
const pick = (value: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(
    keys.filter((k) => value[k] !== undefined).map((k) => [k, value[k]]),
  );
const cleanText = (value: string) => value.replaceAll("\u0000", "");
function docsContent(value: Record<string, unknown>) {
  let remaining = MAX_TEXT;
  let truncated = false;
  let visited = 0;
  const walk = (input: unknown, depth = 0): string => {
    if (depth > 30 || visited++ > 10_000) {
      truncated = true;
      return "";
    }
    if (remaining <= 0) {
      truncated = true;
      return "";
    }
    if (Array.isArray(input))
      return input.map((item) => walk(item, depth + 1)).join("");
    const obj = object(input);
    if (obj.textRun) {
      const text = cleanText(string(object(obj.textRun).content));
      const result = text.slice(0, remaining);
      remaining -= result.length;
      if (result.length < text.length) truncated = true;
      return result;
    }
    return Object.entries(obj)
      .filter(
        ([key]) =>
          ![
            "suggestedInsertionIds",
            "suggestedDeletionIds",
            "suggestedTextStyleChanges",
            "inlineObjects",
            "positionedObjects",
          ].includes(key),
      )
      .map(([, item]) =>
        item && typeof item === "object" ? walk(item, depth + 1) : "",
      )
      .join("");
  };
  const tabs = array(value.tabs);
  const result: JsonObject[] = [];
  const visitTab = (input: unknown, depth = 0) => {
    if (depth > 20 || result.length >= 100) {
      truncated = true;
      return;
    }
    const tab = object(input);
    const props = object(tab.tabProperties);
    result.push({
      id: string(props.tabId),
      title: string(props.title).slice(0, 200),
      text: walk(tab.documentTab),
    });
    for (const child of array(tab.childTabs)) visitTab(child, depth + 1);
  };
  if (tabs.length) for (const tab of tabs) visitTab(tab);
  else
    result.push({
      id: "",
      title: string(value.title),
      text: walk({
        body: value.body,
        headers: value.headers,
        footers: value.footers,
        footnotes: value.footnotes,
      }),
    });
  return {
    tabs: result,
    truncated,
    omitted: ["embedded objects", "suggestion resolution"],
  };
}
/** Bound the combined UTF-8 result, including headers, cell strings and metadata. */
function boundData(input: Record<string, unknown>): JsonObject {
  let remaining = 44_000;
  let truncated = false;
  const visit = (value: unknown, depth = 0): JsonValue => {
    if (depth > 40 || remaining < 32) {
      truncated = true;
      return null;
    }
    if (typeof value === "string") {
      const encoded = JSON.stringify(value);
      if (Buffer.byteLength(encoded) <= remaining - 2) {
        remaining -= Buffer.byteLength(encoded);
        return value;
      }
      let low = 0;
      let high = Math.min(value.length, remaining);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (
          Buffer.byteLength(JSON.stringify(value.slice(0, middle))) <=
          remaining - 2
        )
          low = middle;
        else high = middle - 1;
      }
      const result = value.slice(0, low);
      remaining -= Buffer.byteLength(JSON.stringify(result));
      truncated = true;
      return result;
    }
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number"
    ) {
      remaining -= 24;
      return value as JsonValue;
    }
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      remaining -= 2;
      for (const item of value) {
        if (remaining < 64) {
          truncated = true;
          break;
        }
        result.push(visit(item, depth + 1));
        remaining--;
      }
      return result;
    }
    const result: JsonObject = {};
    remaining -= 2;
    for (const [key, item] of Object.entries(object(value))) {
      if (item === undefined) continue;
      if (remaining < Buffer.byteLength(key) + 64) {
        truncated = true;
        break;
      }
      remaining -= Buffer.byteLength(JSON.stringify(key)) + 2;
      result[key] = visit(item, depth + 1);
    }
    return result;
  };
  const result = visit(input) as JsonObject;
  if (truncated) {
    result.truncated = true;
    result.resultLimitApplied = true;
  }
  return result;
}
export function createGoogleAdapter(options: {
  access: GoogleAccess;
  pageKey: Uint8Array;
  fetch?: HttpFetch;
  now?: () => number;
}): IntegrationAdapter {
  const http = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sign = (value: string) =>
    createHmac("sha256", options.pageKey).update(value).digest("base64url");
  const cursor = (binding: string, page: string) => {
    const body = Buffer.from(
      JSON.stringify({ binding, page, expires: now() + 900_000 }),
    ).toString("base64url");
    return `${body}.${sign(body)}`;
  };
  const uncursor = (binding: string, token: string) => {
    try {
      const [body, mac, extra] = token.split(".");
      if (!body || !mac || extra) throw new Error();
      const expected = Buffer.from(sign(body));
      const actual = Buffer.from(mac);
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw new Error();
      const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      if (
        value.binding !== binding ||
        value.expires < now() ||
        typeof value.page !== "string" ||
        value.page.length > 2048
      )
        throw new Error();
      return value.page as string;
    } catch {
      throw new HarnessError(
        "This page token expired or belongs to a different account, query or grant.",
      );
    }
  };
  return {
    id: "google",
    async discover() {
      return structuredClone(googleDefinition);
    },
    async execute(input) {
      let started = false;
      try {
        const args = parseGoogleArguments(input.tool.id, input.arguments);
        const constraints = googleConstraints(input.constraints);
        const group = input.tool.id.split(".")[0] as GoogleGroup;
        const scope = GOOGLE_SCOPES[group];
        if (!scope) throw new HarnessError("Unknown Google tool.", 404);
        const identifier = string(
          args.fileId ?? args.documentId ?? args.spreadsheetId,
        );
        if (identifier) assertFileAllowed(identifier, constraints);
        if (input.tool.id === "sheets.read_range")
          assertRangeAllowed(identifier, string(args.range), constraints);
        // A restricted sheet cannot expose global tab names/grid metadata outside the allowed ranges.
        if (
          input.tool.id === "sheets.metadata" &&
          constraints.sheetRanges &&
          !constraints.sheetRanges[identifier]
        )
          throw new HarnessError(
            "This spreadsheet is outside the workspace range grant.",
            403,
          );
        if (
          input.tool.id === "calendar.list_events" &&
          constraints.calendarIds &&
          !constraints.calendarIds.includes(string(args.calendarId))
        )
          throw new HarnessError(
            "This calendar is outside the workspace grant.",
            403,
          );
        const signal = AbortSignal.any([
          input.signal,
          AbortSignal.timeout(15_000),
        ]);
        const binding = sign(
          JSON.stringify([
            input.connection.id,
            input.connection.revision,
            input.workspaceId,
            input.tool.id,
            { ...args, pageToken: undefined },
            input.constraints,
          ]),
        );
        const page = args.pageToken
          ? uncursor(binding, string(args.pageToken))
          : undefined;
        return await options.access.withAccess(
          input.connection.id,
          [scope],
          signal,
          async (token, account) => {
            const get = async (url: URL | string) => {
              try {
                started = true;
                return await http(url, {
                  headers: { Authorization: `Bearer ${token}` },
                  signal,
                  redirect: "error",
                });
              } catch {
                throw new HarnessError(
                  signal.aborted
                    ? "Google read cancelled or timed out."
                    : "Google read transport failed.",
                  502,
                );
              }
            };
            const json = async (
              base: string,
              params: Record<string, string | undefined> = {},
            ) => {
              const url = new URL(base);
              for (const [key, value] of Object.entries(params))
                if (value !== undefined) url.searchParams.set(key, value);
              return googleJson(await get(url));
            };
            let data: Record<string, unknown>;
            let sourceUrl = "";
            let representation = "metadata";
            const gmail = new GmailEmailProvider(
              async (url) => googleJson(await get(url)),
              constraints.gmailLabelIds,
            );
            if (input.tool.id === "calendar.list_events") {
              const calendarId = string(args.calendarId);
              if (
                constraints.calendarIds &&
                !constraints.calendarIds.includes(calendarId)
              )
                throw new HarnessError(
                  "This calendar is outside the workspace grant.",
                  403,
                );
              const value = await json(
                `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
                {
                  timeMin: string(args.timeMin),
                  timeMax: string(args.timeMax),
                  timeZone: string(args.timeZone),
                  maxResults: String(args.limit),
                  pageToken: page,
                  singleEvents: "true",
                  showDeleted: "false",
                  orderBy: "startTime",
                  fields:
                    "timeZone,updated,nextPageToken,items(id,status,summary,description,location,htmlLink,start,end,organizer,attendees,recurringEventId,originalStartTime,updated)",
                },
              );
              data = {
                calendarId,
                requestedInterval: {
                  timeMin: args.timeMin,
                  timeMax: args.timeMax,
                },
                timeZone: string(value.timeZone) || args.timeZone,
                events: array(value.items)
                  .slice(0, Number(args.limit))
                  .map((item) =>
                    pick(object(item), [
                      "id",
                      "status",
                      "summary",
                      "description",
                      "location",
                      "htmlLink",
                      "start",
                      "end",
                      "organizer",
                      "attendees",
                      "recurringEventId",
                      "originalStartTime",
                      "updated",
                    ]),
                  ),
                partial: true,
                nextPageToken: value.nextPageToken
                  ? cursor(binding, string(value.nextPageToken))
                  : null,
              };
              representation = "calendar_events";
              sourceUrl = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(calendarId)}${account?.email ? `&authuser=${encodeURIComponent(account.email)}` : ""}`;
            } else if (input.tool.id === "gmail.search") {
              const value = await gmail.search(
                string(args.query),
                Number(args.limit),
                signal,
                page,
              );
              data = {
                threads: value.threads,
                partial: value.partial,
                nextPageToken: value.nextPageToken
                  ? cursor(binding, value.nextPageToken)
                  : null,
              };
              sourceUrl = `https://mail.google.com/mail/${account?.email ? `?authuser=${encodeURIComponent(account.email)}` : ""}#search`;
            } else if (input.tool.id === "gmail.read_thread") {
              data = (await gmail.readThread(
                string(args.threadId),
                signal,
              )) as unknown as Record<string, unknown>;
              representation = "plain_text";
              sourceUrl = `https://mail.google.com/mail/${account?.email ? `?authuser=${encodeURIComponent(account.email)}` : ""}#all/${args.threadId}`;
            } else if (input.tool.id === "drive.search") {
              const escaped = string(args.query)
                .replaceAll("\\", "\\\\")
                .replaceAll("'", "\\'");
              const value = await json(
                "https://www.googleapis.com/drive/v3/files",
                {
                  q: `trashed = false and name contains '${escaped}'`,
                  pageSize: String(args.limit),
                  pageToken: page,
                  supportsAllDrives: "true",
                  includeItemsFromAllDrives: "true",
                  fields: `nextPageToken,incompleteSearch,files(${fileFields})`,
                },
              );
              data = {
                files: array(value.files)
                  .slice(0, Number(args.limit))
                  .map(object)
                  .filter(
                    (file) =>
                      !constraints.fileIds ||
                      constraints.fileIds.includes(string(file.id)),
                  ),
                partial: true,
                incompleteSearch: value.incompleteSearch === true,
                nextPageToken: value.nextPageToken
                  ? cursor(binding, string(value.nextPageToken))
                  : null,
              };
              sourceUrl = "https://drive.google.com/drive/my-drive";
            } else if (input.tool.id === "drive.get_file") {
              data = await json(
                `https://www.googleapis.com/drive/v3/files/${identifier}`,
                { supportsAllDrives: "true", fields: fileFields },
              );
              sourceUrl = `https://drive.google.com/file/d/${identifier}/view`;
              if (args.representation === "text") {
                const mime = string(data.mimeType);
                let url: string;
                if (mime === "application/vnd.google-apps.document")
                  url = `https://www.googleapis.com/drive/v3/files/${identifier}/export?mimeType=text%2Fplain`;
                else if (
                  mime.startsWith("text/") ||
                  ["application/json", "application/xml"].includes(mime)
                )
                  url = `https://www.googleapis.com/drive/v3/files/${identifier}?alt=media&supportsAllDrives=true`;
                else
                  throw new HarnessError(
                    "This MIME type needs its dedicated read tool; binary and other editor exports are unavailable.",
                  );
                const response = await get(url);
                if (!response.ok) await googleJson(response);
                const text = cleanText(
                  await boundedResponse(response, 1_048_576),
                );
                data = {
                  ...data,
                  text: text.slice(0, MAX_TEXT),
                  truncated: text.length > MAX_TEXT,
                };
                representation = "plain_text";
              }
            } else if (input.tool.id === "docs.read") {
              const value = await json(
                `https://docs.googleapis.com/v1/documents/${identifier}`,
                { includeTabsContent: "true" },
              );
              data = {
                documentId: string(value.documentId),
                title: string(value.title).slice(0, 500),
                revisionId: string(value.revisionId),
                ...docsContent(value),
              };
              representation = "structured_text";
              sourceUrl = `https://docs.google.com/document/d/${identifier}/edit`;
            } else if (input.tool.id === "sheets.metadata") {
              const value = await json(
                `https://sheets.googleapis.com/v4/spreadsheets/${identifier}`,
                {
                  includeGridData: "false",
                  fields:
                    "spreadsheetId,spreadsheetUrl,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,sheetType,gridProperties))",
                },
              );
              const all = array(value.sheets).map(object);
              const allowedTabs = constraints.sheetRanges?.[identifier]?.map(
                (range) => range.slice(0, range.lastIndexOf("!")),
              );
              const sheets = all.filter(
                (sheet) =>
                  !allowedTabs ||
                  allowedTabs.some(
                    (tab) =>
                      tab === string(object(sheet.properties).title) ||
                      tab ===
                        `'${string(object(sheet.properties).title).replaceAll("'", "''")}'`,
                  ),
              );
              data = {
                spreadsheetId: identifier,
                properties: value.properties,
                sheets: sheets.slice(0, 100),
                truncated: sheets.length > 100,
                rangeRestricted: !!allowedTabs,
              };
              sourceUrl = `https://docs.google.com/spreadsheets/d/${identifier}/edit`;
            } else {
              const render = {
                formatted: "FORMATTED_VALUE",
                raw: "UNFORMATTED_VALUE",
                formula: "FORMULA",
              }[string(args.representation)];
              const value = await json(
                `https://sheets.googleapis.com/v4/spreadsheets/${identifier}/values/${encodeURIComponent(string(args.range))}`,
                {
                  valueRenderOption: render,
                  dateTimeRenderOption: "SERIAL_NUMBER",
                  majorDimension: "ROWS",
                },
              );
              let budget = MAX_TEXT;
              let truncated = false;
              const rows = array(value.values);
              const values = rows.slice(0, 200).map((row) =>
                array(row)
                  .slice(0, 50)
                  .map((cell) => {
                    if (typeof cell === "number" || typeof cell === "boolean") {
                      budget -= String(cell).length;
                      if (budget < 0) {
                        truncated = true;
                        return null;
                      }
                      return cell;
                    }
                    const text = string(cell);
                    const result = text.slice(0, Math.max(0, budget));
                    budget -= result.length;
                    if (result.length < text.length) truncated = true;
                    return result;
                  }),
              );
              data = {
                spreadsheetId: identifier,
                requestedRange: args.range,
                range: string(value.range),
                majorDimension: "ROWS",
                values,
                truncated: truncated || rows.length > 200,
                dateTimeRepresentation: "serial_number",
              };
              representation = string(args.representation);
              sourceUrl = `https://docs.google.com/spreadsheets/d/${identifier}/edit`;
            }
            const serialized = JSON.stringify({
              source: {
                integrationId: "google-workspace",
                connectionId: input.connection.id,
                accountLabel: input.connection.label,
                accountEmail: account?.email ?? null,
                toolId: input.tool.id,
                url: sourceUrl,
                fetchedAt: new Date(now()).toISOString(),
                representation,
                untrustedContent: true,
              },
              data: boundData(data),
            });
            const escapedToken = JSON.stringify(token).slice(1, -1);
            return JSON.parse(
              serialized.replaceAll(escapedToken, "[REDACTED]"),
            ) as JsonValue;
          },
          input.connection.revision,
        );
      } catch (error) {
        if (!started)
          throw new IntegrationNotStartedError(
            error instanceof HarnessError
              ? error.message
              : "Google read is not configured.",
          );
        throw error;
      }
    },
  };
}
