import { HarnessError } from "@harness/core";
import type { HarnessStore } from "@harness/storage/application";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { getStore } from "./store";

type OwnerLedger = Pick<
  HarnessStore,
  "createOwnerSession" | "ownerSession" | "revokeOwnerSession"
>;
/** The owner stays signed in on each device for 30 days, until Sign out. */
const SESSION_SECONDS = 30 * 24 * 3600;
export const googleAuthEnabled = () => process.env.HARNESS_AUTH === "google";
export interface GoogleOwnerConfig {
  origin: string;
  secret: string;
  clientId: string;
  clientSecret: string;
  emails: string[];
}
export function googleOwnerConfig(): GoogleOwnerConfig {
  let url: URL;
  try {
    url = new URL(process.env.HARNESS_PUBLIC_URL ?? "");
  } catch {
    throw new HarnessError(
      "Configure HARNESS_PUBLIC_URL for Google sign-in.",
      503,
    );
  }
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new HarnessError(
      "Google sign-in needs a bare HTTPS HARNESS_PUBLIC_URL (HTTP is allowed only on localhost).",
      503,
    );
  const secret = process.env.BETTER_AUTH_SECRET ?? "";
  const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  const emails = (process.env.HARNESS_OWNER_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (secret.length < 32 || !clientId || !clientSecret || !emails.length)
    throw new HarnessError(
      "Google sign-in is disabled until BETTER_AUTH_SECRET (32+ characters), GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and HARNESS_OWNER_EMAILS are configured.",
      503,
    );
  return { origin: url.origin, secret, clientId, clientSecret, emails };
}
/** Public readiness metadata contains no client IDs, secrets or account data. */
export function googleLoginReadiness(): {
  configured: boolean;
  message?: string;
} {
  try {
    googleOwnerConfig();
    return { configured: true };
  } catch (error) {
    if (!(error instanceof HarnessError) || error.status !== 503) throw error;
    return {
      configured: false,
      message:
        "Google sign-in setup is pending. Configure the Google OAuth credentials on this control server to enable login.",
    };
  }
}
export function allowedGoogleOwner(
  user: { email?: unknown; emailVerified?: unknown },
  emails: string[],
) {
  return (
    user.emailVerified === true &&
    typeof user.email === "string" &&
    emails.includes(user.email.toLowerCase())
  );
}
export function createGoogleOwnerAuth(
  config: GoogleOwnerConfig,
  ledger: () => Promise<OwnerLedger>,
) {
  return betterAuth({
    appName: "Meta Harness",
    baseURL: config.origin,
    basePath: "/api/auth",
    secret: config.secret,
    trustedOrigins: [config.origin],
    onAPIError: { errorURL: `${config.origin}/login` },
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        prompt: "select_account",
        mapProfileToUser(profile) {
          if (
            !allowedGoogleOwner(
              { email: profile.email, emailVerified: profile.email_verified },
              config.emails,
            )
          )
            throw new APIError("FORBIDDEN", {
              message: "This Google account is not an allowed owner.",
            });
          return {};
        },
      },
    },
    // One owner needs no extra database/pool/service. The existing application
    // ledger adds immediate revocation to Better Auth's encrypted cookie session.
    // Stateless refresh never extends a session, so its lifetime is the limit.
    session: {
      expiresIn: SESSION_SECONDS,
      cookieCache: {
        enabled: true,
        maxAge: SESSION_SECONDS,
        strategy: "jwe",
        refreshCache: false,
      },
    },
    account: {
      storeStateStrategy: "cookie",
      storeAccountCookie: false,
      accountLinking: { enabled: false },
    },
    advanced: {
      cookiePrefix: "harness_google",
      useSecureCookies: config.origin.startsWith("https:"),
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },
    rateLimit: { enabled: true },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (
          ctx.path === "/sign-in/social" &&
          (ctx.body?.provider !== "google" || ctx.body?.idToken)
        )
          throw new APIError("FORBIDDEN", {
            message: "Use Google browser sign-in.",
          });
      }),
      after: createAuthMiddleware(async (ctx) => {
        const signed = ctx.context.newSession;
        if (!ctx.path.startsWith("/callback/") || !signed) return;
        if (!allowedGoogleOwner(signed.user, config.emails))
          throw new APIError("FORBIDDEN", {
            message: "This Google account is not an allowed owner.",
          });
        await (await ledger()).createOwnerSession(
          signed.session.token,
          `google:${signed.user.id}`,
          signed.session.expiresAt.getTime(),
        );
      }),
    },
  });
}
let instance: ReturnType<typeof createGoogleOwnerAuth> | undefined;
export function googleOwnerAuth() {
  const config = googleOwnerConfig();
  instance ??= createGoogleOwnerAuth(config, getStore);
  return instance;
}
export async function authorizeGoogleOwner(request: Request) {
  await requireGoogleOwner(
    googleOwnerAuth(),
    googleOwnerConfig(),
    getStore,
    request.headers,
  );
}
export async function requireGoogleOwner(
  auth: ReturnType<typeof createGoogleOwnerAuth>,
  config: Pick<GoogleOwnerConfig, "emails">,
  ledger: () => Promise<OwnerLedger>,
  headers: Headers,
) {
  const session = await auth.api.getSession({ headers });
  if (
    !session ||
    !allowedGoogleOwner(session.user, config.emails) ||
    !(await (await ledger()).ownerSession(session.session.token))
  )
    throw new HarnessError("Sign in with your allowed Google account.", 401);
  return session;
}
export async function handleGoogleAuth(request: Request) {
  const config = googleOwnerConfig();
  const path = new URL(request.url).pathname.slice("/api/auth".length);
  const method = request.method;
  if (
    !(
      (method === "POST" && ["/sign-in/social", "/sign-out"].includes(path)) ||
      (method === "GET" && ["/callback/google", "/get-session"].includes(path))
    )
  )
    return new Response("Not found", { status: 404 });
  const auth = googleOwnerAuth();
  if (path === "/get-session")
    await requireGoogleOwner(auth, config, getStore, request.headers);
  if (path === "/sign-out") {
    const session = await auth.api.getSession({ headers: request.headers });
    if (session)
      await (await getStore()).revokeOwnerSession(session.session.token);
  }
  const current = new URL(request.url);
  const canonical = new URL(current.pathname + current.search, config.origin);
  const response = await auth.handler(new Request(canonical, request));
  response.headers.set("Cache-Control", "no-store");
  return response;
}
