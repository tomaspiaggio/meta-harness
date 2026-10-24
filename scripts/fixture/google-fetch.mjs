// Loaded only by the disposable native integration smoke process, never normal startup.
if (process.env.HARNESS_GOOGLE_RESOURCE_CLIENT_ID !== "fixture-resource-client")
  throw new Error("Google HTTP fixture preload requires fixture credentials.");
const original = globalThis.fetch;
const origin = process.env.HARNESS_GOOGLE_FIXTURE_ORIGIN;
if (!origin || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))
  throw new Error("Invalid fixture origin.");
const hosts = new Set([
  "oauth2.googleapis.com",
  "www.googleapis.com",
  "gmail.googleapis.com",
  "docs.googleapis.com",
  "sheets.googleapis.com",
]);
globalThis.fetch = async (input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (!hosts.has(target.hostname)) return original(input, init);
  const headers = new Headers(init?.headers);
  headers.set("x-fixture-target", target.href);
  return original(`${origin}/provider`, { ...init, headers });
};
