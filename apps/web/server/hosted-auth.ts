import { randomBytes } from "node:crypto";
import { HarnessError } from "@harness/core";
import * as oidc from "openid-client";
import { googleAuthEnabled, googleOwnerConfig } from "./google-auth";
import { getStore } from "./store";

export const hosted = () =>
  !!process.env.VERCEL || process.env.HARNESS_HOSTED === "1";
export function publicOrigin(): string {
  const raw = process.env.HARNESS_PUBLIC_URL;
  if (!raw)
    throw new HarnessError("Configure HARNESS_PUBLIC_URL before hosting.", 503);
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new HarnessError(
      "HARNESS_PUBLIC_URL must be a bare HTTPS origin.",
      503,
    );
  return url.origin;
}
export function hostedConfiguration(): void {
  publicOrigin();
  if (googleAuthEnabled()) googleOwnerConfig();
  if (
    process.env.VERCEL &&
    (!process.env.VERCEL_DEPLOYMENT_ID ||
      process.env.WORKFLOW_TARGET_WORLD === "local")
  )
    throw new HarnessError(
      "Enable Vercel system environment variables and the managed Workflow world before deployment.",
      503,
    );
  if (
    !process.env.DATABASE_URL ||
    (!googleAuthEnabled() &&
      (!process.env.HARNESS_OIDC_ISSUER ||
        !process.env.HARNESS_OIDC_CLIENT_ID ||
        !(
          process.env.HARNESS_OWNER_SUBJECTS || process.env.HARNESS_OWNER_EMAILS
        ))) ||
    Buffer.from(process.env.HARNESS_GRANT_KEY ?? "", "base64url").length < 32
  )
    throw new HarnessError(
      "Hosted access is disabled until PostgreSQL, owner authentication, an owner allowlist and a grant signing key are configured.",
      503,
    );
  if (
    !googleAuthEnabled() &&
    new URL(process.env.HARNESS_OIDC_ISSUER ?? "").protocol !== "https:"
  )
    throw new HarnessError("OIDC requires HTTPS.", 503);
}
export function cookie(request: Request, name: string): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
export function ownerAllowed(claims: {
  sub: string;
  email?: unknown;
  email_verified?: unknown;
}): boolean {
  const subjects = (process.env.HARNESS_OWNER_SUBJECTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const emails = (process.env.HARNESS_OWNER_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return (
    subjects.includes(claims.sub) ||
    (claims.email_verified === true &&
      typeof claims.email === "string" &&
      emails.includes(claims.email.toLowerCase()))
  );
}
let configuration: Promise<oidc.Configuration> | undefined;
function provider() {
  hostedConfiguration();
  configuration ??= oidc
    .discovery(
      new URL(process.env.HARNESS_OIDC_ISSUER ?? ""),
      process.env.HARNESS_OIDC_CLIENT_ID ?? "",
      process.env.HARNESS_OIDC_CLIENT_SECRET,
    )
    .catch((error) => {
      configuration = undefined;
      throw error;
    });
  return configuration;
}
export async function startOwnerLogin(): Promise<Response> {
  const config = await provider();
  const state = oidc.randomState();
  const verifier = oidc.randomPKCECodeVerifier();
  const nonce = oidc.randomNonce();
  await (await getStore()).saveOidcState(state, verifier, nonce);
  const target = oidc.buildAuthorizationUrl(config, {
    redirect_uri: `${publicOrigin()}/api/auth/callback`,
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: target.toString(),
      "Set-Cookie": `harness_oidc_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=600`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
export async function completeOwnerLogin(request: Request): Promise<Response> {
  const config = await provider();
  const current = new URL(
    `${publicOrigin()}/api/auth/callback${new URL(request.url).search}`,
  );
  const state = current.searchParams.get("state");
  if (!state || cookie(request, "harness_oidc_state") !== state)
    throw new HarnessError(
      "Login state did not match. Start sign-in again.",
      401,
    );
  const saved = await (await getStore()).consumeOidcState(state);
  if (!saved) throw new HarnessError("Login expired or was already used.", 401);
  const tokens = await oidc.authorizationCodeGrant(config, current, {
    pkceCodeVerifier: saved.verifier,
    expectedState: state,
    expectedNonce: saved.nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims || !ownerAllowed(claims))
    throw new HarnessError("This identity is not an allowed owner.", 403);
  const session = randomBytes(32).toString("base64url");
  await (await getStore()).createOwnerSession(
    session,
    claims.sub,
    Date.now() + 8 * 3600000,
  );
  const headers = new Headers({
    Location: `${publicOrigin()}/`,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  headers.append(
    "Set-Cookie",
    `harness_owner=${session}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800`,
  );
  headers.append(
    "Set-Cookie",
    "harness_oidc_state=; HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=0",
  );
  return new Response(null, { status: 302, headers });
}
export async function authorizeOwner(request: Request): Promise<void> {
  hostedConfiguration();
  const token = cookie(request, "harness_owner");
  if (
    !token ||
    !/^[a-zA-Z0-9_-]{43}$/.test(token) ||
    !(await (await getStore()).ownerSession(token))
  )
    throw new HarnessError("Sign in to this control plane.", 401);
}
