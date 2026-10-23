import { createHmac, timingSafeEqual } from "node:crypto";
import { HarnessError } from "@harness/core";
import { hosted } from "./hosted-auth";
import { adminToken } from "./security";

export interface AttemptGrant {
  workerId: string;
  turnId: string;
  generation: number;
  expiresAt: number;
  purpose: "tools";
}
export function grantSigningKey(): Buffer {
  const configured = process.env.HARNESS_GRANT_KEY;
  if (configured) {
    const decoded = Buffer.from(configured, "base64url");
    if (decoded.length >= 32) return decoded;
  }
  if (hosted()) throw new HarnessError("Configure a grant signing key.", 503);
  return Buffer.from(adminToken(), "base64url");
}
const signature = (payload: string) =>
  createHmac("sha256", grantSigningKey()).update(payload).digest("base64url");
export function mintAttemptGrant(
  workerId: string,
  turnId: string,
  generation: number,
): string {
  const duration = Math.min(
    86400000,
    Math.max(60000, Number(process.env.HARNESS_TURN_TIMEOUT_MS ?? 1800000)),
  );
  const payload = Buffer.from(
    JSON.stringify({
      workerId,
      turnId,
      generation,
      expiresAt: Date.now() + duration,
      purpose: "tools",
    }),
  ).toString("base64url");
  return `${payload}.${signature(payload)}`;
}
export function verifyAttemptGrant(value: string): AttemptGrant {
  const [payload, mac, extra] = value.split(".");
  if (!payload || !mac || extra || value.length > 2000)
    throw new HarnessError("Invalid tool grant.", 401);
  const expected = Buffer.from(signature(payload));
  const actual = Buffer.from(mac);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new HarnessError("Invalid tool grant.", 401);
  let grant: AttemptGrant;
  try {
    grant = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new HarnessError("Invalid tool grant.", 401);
  }
  if (
    grant.purpose !== "tools" ||
    typeof grant.workerId !== "string" ||
    typeof grant.turnId !== "string" ||
    !Number.isSafeInteger(grant.generation) ||
    grant.generation < 1 ||
    !Number.isSafeInteger(grant.expiresAt) ||
    grant.expiresAt <= Date.now()
  )
    throw new HarnessError("Tool grant expired or was invalid.", 401);
  return grant;
}
