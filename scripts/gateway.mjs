import { createServer, request as forward } from "node:http";
import { browserStreamRelay } from "./browser-stream-relay.mjs";
/** Public surface is explicit; local Workflow control routes never pass through. */
export function publicPath(raw) {
  try {
    if (!raw.startsWith("/") || raw.startsWith("//")) return false;
    const path = decodeURIComponent(new URL(raw, "http://gateway").pathname);
    if (
      path.includes("\\") ||
      path.includes("%") ||
      path.includes("\0") ||
      path.split("/").some((part) => part === "." || part === "..")
    )
      return false;
    return (
      [
        "/",
        "/tasks",
        "/login",
        "/knowledge",
        "/schedules",
        "/settings",
      ].includes(path) ||
      path.startsWith("/_next/") ||
      /^\/api\/auth\/(status|login|callback|logout|sign-in\/social|callback\/google|get-session|sign-out)$/.test(
        path,
      ) ||
      /^\/api\/(state|tasks|turns|sessions|workspaces|login|decisions|schedules|attachments|inputs|browser|resources|notifications|maintenance|tools|telegram|workers|diagnostics|preferences|worker|browser-stream)$/.test(
        path,
      ) ||
      /^\/api\/worker\/[a-z-]+$/.test(path)
    );
  } catch {
    return false;
  }
}
/** Streaming reverse proxy in the launcher process; no extra resident daemon. */
export function createGateway(privatePort) {
  const server = createServer((request, response) => {
    if (!publicPath(request.url ?? "/")) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    const headers = { ...request.headers };
    for (const name of [
      "x-forwarded-host",
      "x-forwarded-for",
      "x-forwarded-proto",
      "forwarded",
      "connection",
      "upgrade",
      "proxy-authorization",
      "proxy-connection",
    ])
      delete headers[name];
    for (const name of Object.keys(headers))
      if (
        name.startsWith("x-invoke-") ||
        name.startsWith("x-middleware-") ||
        name === "x-matched-path" ||
        name === "x-now-route-matches"
      )
        delete headers[name];
    headers["x-forwarded-for"] = request.socket.remoteAddress ?? "";
    headers["x-forwarded-proto"] = "http";
    const upstream = forward(
      {
        hostname: "127.0.0.1",
        port: privatePort,
        path: request.url,
        method: request.method,
        headers,
      },
      (result) => {
        response.writeHead(result.statusCode ?? 502, result.headers);
        result.pipe(response);
      },
    );
    upstream.setTimeout(60000, () =>
      upstream.destroy(new Error("Control request timed out.")),
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end("Control plane unavailable");
    });
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  const streams = browserStreamRelay(server, privatePort);
  const close = server.close.bind(server);
  server.close = (...args) => {
    for (const client of streams.clients) client.terminate();
    return close(...args);
  };
  return server;
}
