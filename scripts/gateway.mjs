import { createServer, request as forward } from "node:http";
import { connect } from "node:net";
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
        "/manifest.webmanifest",
        "/sw.js",
        "/apple-touch-icon.png",
        "/icon-192.png",
        "/icon-512.png",
        "/icon-maskable-512.png",
      ].includes(path) ||
      path.startsWith("/_next/") ||
      /^\/api\/auth\/(status|profile|login|callback|logout|sign-in\/social|callback\/google|get-session|sign-out)$/.test(
        path,
      ) ||
      /^\/api\/(state|tasks|turns|sessions|workspaces|login|decisions|schedules|attachments|inputs|browser|resources|notifications|maintenance|tools|telegram|workers|diagnostics|preferences|worker|browser-stream|version|push|backups|delegations)$/.test(
        path,
      ) ||
      /^\/api\/integrations(?:\/mcp|\/google\/(?:status|start|callback|disconnect|binding|client))?$/.test(
        path,
      ) ||
      /^\/api\/worker\/[a-z-]+$/.test(path)
    );
  } catch {
    return false;
  }
}
function upstreamHeaders(request, upgrade = false) {
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
  if (upgrade) {
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";
  }
  return headers;
}

/** Streaming reverse proxy in the launcher process; no extra resident daemon. */
export function createGateway(privatePort, { development = false } = {}) {
  const developmentSockets = new Set();
  const server = createServer((request, response) => {
    if (!publicPath(request.url ?? "/")) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    const headers = upstreamHeaders(request);
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
  const streams = browserStreamRelay(
    server,
    privatePort,
    (request, socket, head) => {
      if (
        !development ||
        !["/_next/hmr", "/_next/webpack-hmr"].includes(
          new URL(request.url ?? "/", "http://gateway").pathname,
        )
      )
        return false;
      let sameOrigin = false;
      try {
        sameOrigin =
          !!request.headers.origin &&
          new URL(request.headers.origin).host === request.headers.host;
      } catch {}
      if (
        !sameOrigin ||
        request.method !== "GET" ||
        request.headers["sec-fetch-site"] === "cross-site"
      ) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return true;
      }
      const upstream = connect(privatePort, "127.0.0.1");
      developmentSockets.add(socket);
      developmentSockets.add(upstream);
      const close = () => {
        developmentSockets.delete(socket);
        developmentSockets.delete(upstream);
        socket.destroy();
        upstream.destroy();
      };
      socket.on("error", close);
      upstream.on("error", close);
      socket.on("close", close);
      upstream.on("close", close);
      upstream.setTimeout(10000, close);
      upstream.once("data", () => upstream.setTimeout(0));
      upstream.on("connect", () => {
        const headers = Object.entries(upstreamHeaders(request, true)).flatMap(
          ([name, values]) =>
            (Array.isArray(values) ? values : [values])
              .filter((value) => value !== undefined)
              .map((value) => `${name}: ${value}`),
        );
        upstream.write(
          `GET ${request.url} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`,
        );
        if (head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      return true;
    },
  );
  const close = server.close.bind(server);
  server.close = (...args) => {
    for (const client of streams.clients) client.terminate();
    for (const socket of developmentSockets) socket.destroy();
    return close(...args);
  };
  return server;
}
