import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/** A private, on-demand display owned by this browser, never the user's desktop. */
export async function browserDisplay() {
  const directory = await mkdtemp(join(tmpdir(), "harness-display-"));
  const authority = join(directory, "authority");
  const cookie = randomBytes(16).toString("hex");
  const run = promisify(execFile);
  let child: ReturnType<typeof spawn> | undefined;
  const close = async () => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) =>
        child?.once("exit", () => resolve()),
      );
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child?.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(timeout);
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    // Xvfb loads this cookie; after display allocation add its matching client entry.
    await run("xauth", ["-f", authority, "add", ":99", ".", cookie]);
    child = spawn(
      "Xvfb",
      [
        "-displayfd",
        "3",
        "-screen",
        "0",
        "1280x800x24",
        "-nolisten",
        "tcp",
        "-auth",
        authority,
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe"] },
    );
    const process = child;
    const display = await new Promise<string>((resolve, reject) => {
      let value = "";
      const timer = setTimeout(
        () => reject(new Error("Private browser display did not start.")),
        5000,
      );
      process.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      process.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Private browser display exited."));
      });
      process.stdio[3]?.on("data", (bytes: Buffer) => {
        value += bytes.toString();
        if (/^\d+\n$/.test(value)) {
          clearTimeout(timer);
          resolve(`:${value.trim()}`);
        }
      });
    });
    await run("xauth", ["-f", authority, "add", display, ".", cookie]);
    return { env: { DISPLAY: display, XAUTHORITY: authority }, close };
  } catch (error) {
    await close();
    throw error;
  }
}
