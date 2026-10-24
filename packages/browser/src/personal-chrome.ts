import { chromeConnectionInstructions } from "@harness/core/browser";

export { chromeConnectionInstructions } from "@harness/core/browser";

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type BrowserBackend = "managed" | "personal-chrome" | "extension";

export function browserBackend(): BrowserBackend {
  const configured = process.env.HARNESS_BROWSER_BACKEND;
  if (
    configured &&
    configured !== "managed" &&
    configured !== "personal-chrome" &&
    configured !== "extension"
  )
    throw new Error(
      "HARNESS_BROWSER_BACKEND must be managed, extension or personal-chrome.",
    );
  if (
    configured === "managed" ||
    configured === "personal-chrome" ||
    configured === "extension"
  )
    return configured;
  return "managed";
}

export function personalChromeDirectory(): string {
  if (process.env.HARNESS_CHROME_USER_DATA_DIR)
    return process.env.HARNESS_CHROME_USER_DATA_DIR;
  if (process.platform === "darwin")
    return join(homedir(), "Library/Application Support/Google/Chrome");
  if (process.platform === "win32")
    return join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/User Data");
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "google-chrome",
  );
}

/** Chrome's permission-based discovery file, also used by Chrome DevTools MCP.
 * Read only this endpoint file, never copy cookies, keys or profile databases.
 */
export async function personalChromeEndpoint(
  directory = personalChromeDirectory(),
): Promise<string> {
  try {
    const lines = (
      await readFile(join(directory, "DevToolsActivePort"), "utf8")
    )
      .trim()
      .split(/\r?\n/);
    if (
      lines.length !== 2 ||
      !/^\d{1,5}$/.test(lines[0]) ||
      Number(lines[0]) < 1 ||
      Number(lines[0]) > 65535 ||
      !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(lines[1])
    )
      throw new Error("Invalid Chrome discovery file.");
    return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
  } catch {
    throw new Error(chromeConnectionInstructions);
  }
}
