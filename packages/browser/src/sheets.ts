/// <reference lib="dom" />

import { type DefaultTreeAdapterMap, parse } from "parse5";
import type { Page } from "patchright";

export function sheetReadTarget(
  currentUrl: string,
  args: Record<string, unknown>,
  allowTestLoopback = false,
) {
  const current = new URL(currentUrl);
  if (
    !(
      current.protocol === "https:" && current.hostname === "docs.google.com"
    ) &&
    !(allowTestLoopback && current.hostname === "127.0.0.1")
  )
    throw new Error(
      "Open the Google Sheet in the browser before reading its rows.",
    );
  const match = current.pathname.match(
    /^(\/spreadsheets(?:\/u\/\d+)?)\/d\/([a-zA-Z0-9_-]+)\/(?:edit|htmlview)\/?$/,
  );
  if (!match) throw new Error("The current page is not a Google Sheet.");
  const integer = (name: string, fallback: number, maximum: number) => {
    const value = args[name] ?? fallback;
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > maximum
    )
      throw new Error(`Invalid ${name}. Use an integer from 1 to ${maximum}.`);
    return value;
  };
  const startRow = integer("start_row", 1, 100000);
  const maxRows = integer("max_rows", 20, 50);
  const maxColumns = integer("max_columns", 12, 26);
  const gid = String(
    args.gid ??
      new URLSearchParams(current.hash.slice(1)).get("gid") ??
      current.searchParams.get("gid") ??
      "0",
  );
  if (!/^\d{1,20}$/.test(gid)) throw new Error("Invalid sheet gid.");
  const target = new URL(
    `${match[1]}/d/${match[2]}/htmlview/sheet`,
    current.origin,
  );
  target.search = new URLSearchParams({
    gid,
    single: "true",
    headers: "true",
    range: `A${startRow}:${String.fromCharCode(64 + maxColumns)}${startRow + maxRows - 1}`,
  }).toString();
  if (current.searchParams.has("authuser"))
    target.searchParams.set(
      "authuser",
      current.searchParams.get("authuser") ?? "",
    );
  return { url: target.toString(), gid, startRow, maxRows, maxColumns };
}

/** Read the signed-in document's HTML view inside Chrome. Cookies never leave it.
 * This is a bounded, read-only view, not an API-key or public-sharing fallback.
 */
export async function readGoogleSheet(
  page: Page,
  args: Record<string, unknown>,
  allowTestLoopback = false,
) {
  const target = sheetReadTarget(page.url(), args, allowTestLoopback);
  const html = await page.evaluate(async (options) => {
    const response = await fetch(options.url, {
      credentials: "include",
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
      throw new Error(
        `Google Sheets read failed (${response.status}). Verify that this browser account can access the sheet.`,
      );
    if (new URL(response.url).origin !== new URL(options.url).origin)
      throw new Error(
        "Google Sheets requires account verification in the browser.",
      );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Google Sheets returned no document.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 4 * 1024 * 1024)
          throw new Error(
            "Sheet HTML exceeds the 4 MiB read limit. Use a smaller range or the browser's accessible view.",
          );
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }, target);
  return parseSheetHtml(html, target);
}

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];
function elements(node: HtmlNode, tag: string): HtmlElement[] {
  const found: HtmlElement[] = [];
  if ("tagName" in node && node.tagName === tag) found.push(node);
  if ("childNodes" in node)
    for (const child of node.childNodes) found.push(...elements(child, tag));
  return found;
}
function text(node: HtmlNode): string {
  if ("tagName" in node && ["script", "style"].includes(node.tagName))
    return "";
  if ("value" in node) return node.value;
  return "childNodes" in node ? node.childNodes.map(text).join("") : "";
}
/** Parse inert HTML on the worker, outside the site's Trusted Types policy.
 * Scripts never execute and the signed-in page's security policy is unchanged.
 */
export function parseSheetHtml(
  html: string,
  options: ReturnType<typeof sheetReadTarget>,
) {
  const tables = elements(parse(html), "table");
  const table =
    tables.find((table) =>
      table.attrs.some(
        (attr) =>
          attr.name === "class" && attr.value.split(/\s+/).includes("waffle"),
      ),
    ) ??
    tables.sort(
      (a, b) => elements(b, "td").length - elements(a, "td").length,
    )[0];
  if (!table)
    throw new Error(
      "Google Sheets did not expose a readable HTML table. Use the browser screenshot or accessibility view; do not claim the cells were read.",
    );
  const rows = elements(table, "tr").filter(
    (row) => elements(row, "td").length,
  );
  const rowNumber = (row: HtmlNode) => {
    const header = elements(row, "th")[0];
    const value = header ? text(header).trim() : "";
    return /^\d+$/.test(value) ? Number(value) : null;
  };
  const numbered = rows.some((row) => rowNumber(row) !== null);
  let characters = 0;
  let truncated = false;
  const values: { row: number; cells: string[] }[] = [];
  for (let index = 0; index < rows.length; index++) {
    const number = rowNumber(rows[index]);
    // The A/B/C column headings also use td cells; they are not row 1.
    if (numbered && number === null) continue;
    const row = number ?? index + options.startRow;
    if (row < options.startRow || row >= options.startRow + options.maxRows)
      continue;
    const cells = elements(rows[index], "td")
      .slice(0, options.maxColumns)
      .map((cell) => text(cell).trim().slice(0, 2000));
    const length = cells.reduce((sum, cell) => sum + cell.length, 0);
    if (characters + length > 20000) {
      truncated = true;
      break;
    }
    characters += length;
    values.push({ row, cells });
    if (values.length === options.maxRows) break;
  }
  if (!values.length)
    throw new Error(
      "No rows were exposed for the requested range. Use the browser screenshot to inspect the current sheet.",
    );
  return {
    source: "signed-in-google-sheets-html-view",
    gid: options.gid,
    startRow: options.startRow,
    maxRows: options.maxRows,
    maxColumns: options.maxColumns,
    rows: values,
    truncated,
  };
}
