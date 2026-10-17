import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessError } from "@harness/core";
import { dataDirectory } from "@harness/storage";

export function adminToken(): string {
  const directory = dataDirectory();
  const path = join(directory, "admin-token");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, randomBytes(32).toString("base64url"), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    )
      throw error;
  }
  return readFileSync(path, "utf8").trim();
}

export function sameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (
    (origin && new URL(origin).host !== request.headers.get("host")) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new HarnessError("Cross-origin request rejected.", 403);
}

export function tokenMatches(candidate: string): boolean {
  const actual = Buffer.from(candidate);
  const expected = Buffer.from(adminToken());
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const signature = (payload: string) =>
  createHmac("sha256", adminToken()).update(payload).digest("base64url");
export function loginCookie(): string {
  const expires = String(Date.now() + 24 * 60 * 60 * 1000);
  return `${expires}.${signature(expires)}`;
}

export function authorizeAdmin(request: Request): void {
  const host = process.env.HARNESS_BIND_HOST ?? "127.0.0.1";
  if (
    ["127.0.0.1", "localhost", "::1"].includes(host) &&
    process.env.HARNESS_REQUIRE_AUTH !== "1"
  )
    return;
  if (
    tokenMatches(
      request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
    )
  )
    return;
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("harness_session="))
    ?.slice("harness_session=".length);
  if (cookie) {
    const [expires, mac] = cookie.split(".");
    if (expires && mac && Number(expires) > Date.now()) {
      const expected = Buffer.from(signature(expires));
      const actual = Buffer.from(mac);
      if (
        expected.length === actual.length &&
        timingSafeEqual(expected, actual)
      )
        return;
    }
  }
  throw new HarnessError("Sign in to this control plane.", 401);
}
