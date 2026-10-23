import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessError } from "@harness/core";
import { dataDirectory } from "@harness/storage";
import { hosted } from "./hosted-auth";

export function encryptionKey(purpose: string): string {
  let key = process.env.HARNESS_ENCRYPTION_KEY;
  if (!key && !hosted()) {
    const root = dataDirectory();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = join(root, "encryption-key");
    try {
      writeFileSync(path, randomBytes(32).toString("base64"), {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
    }
    key = readFileSync(path, "utf8").trim();
  }
  const bytes = Buffer.from(key ?? "", "base64");
  if (bytes.length !== 32)
    throw new HarnessError(
      "Configure a separate 32-byte HARNESS_ENCRYPTION_KEY before storing browser identities or secrets.",
      503,
    );
  return createHmac("sha256", bytes).update(purpose).digest("base64");
}
