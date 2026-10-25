import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../packages/browser/package.json", import.meta.url),
);
const { WebSocketServer } = require("ws");

/** One ephemeral multiplexed relay in the existing gateway. Frames never touch SQL. */
export function browserStreamRelay(server, privatePort, otherUpgrade) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
    perMessageDeflate: false,
  });
  const workers = new Map();
  const viewers = new Map();
  const send = (socket, value) => {
    if (socket?.readyState === 1 && socket.bufferedAmount < 1024 * 1024)
      socket.send(JSON.stringify(value));
  };
  async function authorize(request) {
    const headers = { ...request.headers };
    for (const name of Object.keys(headers))
      if (
        name.startsWith("sec-websocket-") ||
        name.startsWith("x-invoke-") ||
        name.startsWith("x-middleware-") ||
        name === "x-matched-path" ||
        name === "x-now-route-matches" ||
        [
          "connection",
          "upgrade",
          "x-forwarded-for",
          "x-forwarded-host",
          "x-forwarded-proto",
          "forwarded",
        ].includes(name)
      )
        delete headers[name];
    headers["x-forwarded-for"] = request.socket.remoteAddress ?? "";
    const auth = await new Promise((resolve, reject) => {
      const upstream = httpRequest(
        {
          hostname: "127.0.0.1",
          port: privatePort,
          path: request.url,
          method: "GET",
          headers,
        },
        (response) => {
          const chunks = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > 3 * 1024 * 1024)
              upstream.destroy(new Error("Auth response too large"));
            else chunks.push(chunk);
          });
          response.on("end", () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString());
              if (response.statusCode !== 200)
                reject(
                  new Error(value.error ?? "Browser authorization failed"),
                );
              else resolve(value);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      upstream.setTimeout(5000, () =>
        upstream.destroy(new Error("Authorization timed out")),
      );
      upstream.on("error", reject);
      upstream.end();
    });
    return auth;
  }
  server.on("upgrade", async (request, socket, head) => {
    if (
      new URL(request.url ?? "/", "http://gateway").pathname !==
      "/api/browser-stream"
    ) {
      if (otherUpgrade?.(request, socket, head)) return;
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    try {
      if (
        request.headers.origin &&
        new URL(request.headers.origin).host !== request.headers.host
      )
        throw new Error("Cross-origin stream rejected.");
      const auth = await authorize(request);
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.on("error", () => {});
        if (auth.role === "worker") {
          workers.get(auth.workerId)?.close(1012, "Worker reconnected");
          workers.set(auth.workerId, ws);
          ws.upgradeRequest = request;
          const verifyWorker = setInterval(() => {
            void authorize(request).catch(() => ws.close(1008));
          }, 5000);
          verifyWorker.unref();
          ws.on("close", () => clearInterval(verifyWorker));
          send(ws, { type: "ready" });
          ws.on("message", (raw) => {
            let message;
            try {
              message = JSON.parse(raw.toString());
            } catch {
              return ws.close(1008);
            }
            const view = viewers.get(message.viewId);
            if (!view || view.auth.workerId !== auth.workerId) return;
            if (
              [
                "frame",
                "error",
                "ack",
                "downloads",
                "download",
                "notice",
                "select",
                "targets",
                "fields",
              ].includes(message.type)
            )
              send(view.ws, message);
          });
          ws.on("close", () => {
            if (workers.get(auth.workerId) !== ws) return;
            workers.delete(auth.workerId);
            for (const view of viewers.values())
              if (view.auth.workerId === auth.workerId)
                view.ws.close(1012, "Browser worker disconnected");
          });
          return;
        }
        const worker = workers.get(auth.workerId);
        if (!worker) {
          send(ws, {
            type: "error",
            error:
              "Browser worker stream is offline. Upgrade/reconnect its managed browser service.",
          });
          return ws.close(1013);
        }
        const viewId = randomUUID();
        viewers.set(viewId, { ws, auth });
        send(worker, { type: "open", viewId, ...auth });
        let pending = Promise.resolve();
        let rate = 0;
        let window = Date.now();
        ws.on("message", (raw) => {
          if (Date.now() - window > 1000) {
            window = Date.now();
            rate = 0;
          }
          if (++rate > 150 || raw.length > 16000)
            return ws.close(1008, "Input limit");
          pending = pending
            .then(async () => {
              const message = JSON.parse(raw.toString());
              if (message.type !== "input") return;
              // Check generation, revocation and host for EVERY input. The
              // owner and the agent share the browser; there is no control lease.
              await authorize(worker.upgradeRequest);
              const current = await authorize(request);
              if (
                current.generation !== auth.generation ||
                current.workerId !== auth.workerId
              )
                throw new Error("Browser control changed.");
              send(worker, {
                type: "input",
                viewId,
                id: message.id,
                input: message.input,
              });
            })
            .catch((error) => {
              send(ws, { type: "error", error: error.message });
              ws.close(1008);
            });
        });
        const timer = setInterval(async () => {
          try {
            const current = await authorize(request);
            if (
              current.generation !== auth.generation ||
              current.workerId !== auth.workerId
            )
              ws.close(1008, "Browser control changed");
          } catch {
            ws.close(1008, "Browser view expired");
          }
        }, 2000);
        timer.unref();
        ws.on("close", () => {
          clearInterval(timer);
          viewers.delete(viewId);
          send(worker, { type: "close", viewId });
        });
      });
    } catch (error) {
      console.warn(
        "[browser-stream] Authorization failed:",
        error instanceof Error ? error.message : "Unknown error",
      );
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    }
  });
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 15000);
  heartbeat.unref();
  wss.on("connection", () => {});
  // handleUpgrade's callback does not emit connection automatically.
  const original = wss.handleUpgrade.bind(wss);
  wss.handleUpgrade = (request, socket, head, callback) =>
    original(request, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on("pong", () => {
        ws.isAlive = true;
      });
      callback(ws);
    });
  server.on("close", () => {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  });
  return wss;
}
