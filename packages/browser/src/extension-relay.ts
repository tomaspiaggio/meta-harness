import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { BrowserModel, type CDPMessage } from "./vendor/browser-model";

export interface ExtensionPairing {
  port: number;
  token: string;
  extensionId?: string;
}
export async function extensionPairing(
  path: string,
): Promise<ExtensionPairing> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (
      !Number.isInteger(value.port) ||
      value.port < 1024 ||
      value.port > 65535 ||
      !/^[\w-]{43}$/.test(value.token)
    )
      throw new Error("Invalid browser extension configuration.");
    return value;
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
    )
      throw error;
    const pairing = {
      port: Number(process.env.HARNESS_BROWSER_EXTENSION_PORT ?? 46121),
      token: randomBytes(32).toString("base64url"),
    };
    if (
      !Number.isInteger(pairing.port) ||
      pairing.port < 1024 ||
      pairing.port > 65535
    )
      throw new Error(
        "HARNESS_BROWSER_EXTENSION_PORT must be between 1024 and 65535.",
      );
    await writeFile(path, JSON.stringify(pairing), { mode: 0o600, flag: "wx" });
    return pairing;
  }
}
const equal = (a: string, b: string) =>
  /^[a-zA-Z0-9_-]{43}$/.test(a) &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class ExtensionRelay {
  private server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  private sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
  });
  private extension?: WebSocket;
  private client?: WebSocket;
  private model?: BrowserModel;
  private initialized = false;
  private sequence = 0;
  private inspectSequence = 0;
  private browserSessions = new Set<string>();
  private inspectSessions = new Map<string, string>();
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private keepalive?: ReturnType<typeof setInterval>;
  constructor(
    private config: ExtensionPairing,
    private path: string,
  ) {}
  connected() {
    return this.initialized && this.extension?.readyState === WebSocket.OPEN;
  }
  async start() {
    this.server.on("upgrade", (request, socket, head) => {
      const origin = request.headers.origin;
      const isExtension =
        request.url === "/extension" &&
        /^chrome-extension:\/\/[a-p]{32}$/.test(origin ?? "");
      const isClient =
        request.url === "/cdp" &&
        !origin &&
        equal(
          request.headers.authorization?.replace(/^Bearer /, "") ?? "",
          this.config.token,
        );
      if ((!isExtension && !isClient) || this.sockets.clients.size >= 8) {
        socket.destroy();
        return;
      }
      this.sockets.handleUpgrade(request, socket, head, (ws) => {
        if (isExtension)
          this.acceptExtension(
            ws,
            origin?.slice("chrome-extension://".length) ?? "",
          );
        else this.acceptClient(ws);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.port, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.keepalive = setInterval(() => {
      if (this.extension?.readyState === WebSocket.OPEN)
        this.extension.send(JSON.stringify({ type: "ping" }));
    }, 20000);
    this.keepalive.unref();
  }
  endpoint() {
    if (!this.connected() && this.config.extensionId)
      throw new Error(
        "Your paired browser is offline. Open the Chrome profile with Meta Harness Browser enabled and keep its worker running. It reconnects automatically; do not sign in or pair again and do not enable remote debugging.",
      );
    if (!this.connected())
      throw new Error(
        "Connect the Meta Harness Browser extension once: load apps/browser-extension/dist in chrome://extensions, run pnpm browser:pair on this worker, and paste the code into the extension. No remote-debugging approval is needed.",
      );
    return `ws://127.0.0.1:${this.config.port}/cdp`;
  }
  headers() {
    return { Authorization: `Bearer ${this.config.token}` };
  }
  private acceptExtension(ws: WebSocket, extensionId: string) {
    ws.on("error", () => ws.close());
    const timeout = setTimeout(() => ws.close(1008), 3000);
    timeout.unref();
    ws.once("message", async (data) => {
      clearTimeout(timeout);
      try {
        const hello = JSON.parse(data.toString());
        if (
          hello.type !== "hello" ||
          typeof hello.token !== "string" ||
          !equal(hello.token, this.config.token) ||
          (this.config.extensionId &&
            this.config.extensionId !== extensionId) ||
          this.extension?.readyState === WebSocket.OPEN
        ) {
          ws.close(1008);
          return;
        }
        this.extension = ws;
        this.config.extensionId = extensionId;
        await writeFile(this.path, JSON.stringify(this.config), {
          mode: 0o600,
        });
        this.model = new BrowserModel((method, params) =>
          this.command(method, params),
        );
        this.initialized = false;
        ws.on("message", (data) => this.extensionMessage(data.toString()));
        ws.on("close", () => {
          if (this.extension !== ws) return;
          this.initialized = false;
          this.extension = undefined;
          this.client?.close();
          for (const callback of this.pending.values()) {
            clearTimeout(callback.timer);
            callback.reject(
              new Error(
                "Browser extension disconnected; reconcile before repeating actions.",
              ),
            );
          }
          this.pending.clear();
        });
        ws.on("error", () => ws.close());
        ws.send(JSON.stringify({ type: "paired" }));
      } catch {
        ws.close(1008);
      }
    });
  }
  private command(method: string, params: unknown): Promise<unknown> {
    if (this.extension?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Browser extension is disconnected."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error("Browser command timed out; inspect before repeating."),
        );
      }, 25000);
      this.pending.set(id, { resolve, reject, timer });
      this.extension?.send(JSON.stringify({ id, method, params }));
    });
  }
  private extensionMessage(data: string) {
    try {
      const message = JSON.parse(data);
      if (message.id) {
        const callback = this.pending.get(message.id);
        if (!callback) return;
        this.pending.delete(message.id);
        clearTimeout(callback.timer);
        if (message.error) callback.reject(new Error(String(message.error)));
        else callback.resolve(message.result);
        return;
      }
      const params = message.params ?? [];
      if (message.method === "extension.initialized") this.initialized = true;
      if (message.method === "chrome.tabs.onCreated")
        this.model?.onTabCreated(params[0]);
      if (message.method === "chrome.tabs.onRemoved")
        this.model?.onTabRemoved(params[0]);
      if (message.method === "chrome.debugger.onEvent")
        this.model?.onDebuggerEvent(params[0], params[1], params[2]);
      if (message.method === "chrome.debugger.onDetach")
        this.model?.onDebuggerDetach(params[0]);
    } catch {
      this.extension?.close(1008);
    }
  }
  private acceptClient(ws: WebSocket) {
    if (!this.connected() || this.client?.readyState === WebSocket.OPEN) {
      ws.close(1008);
      return;
    }
    this.client = ws;
    const model = this.model;
    if (!model) {
      ws.close();
      return;
    }
    model.connectOverCDP((message) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    });
    ws.on("message", async (data) => {
      let message: CDPMessage | undefined;
      try {
        message = JSON.parse(data.toString());
        if (
          !message ||
          !Number.isSafeInteger(message.id) ||
          typeof message.method !== "string"
        ) {
          ws.close(1008);
          return;
        }
        const result = await this.dispatch(message);
        if (ws.readyState === WebSocket.OPEN)
          ws.send(
            JSON.stringify({
              id: message.id,
              sessionId: message.sessionId,
              result,
            }),
          );
      } catch (error) {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(
            JSON.stringify({
              id: message?.id,
              sessionId: message?.sessionId,
              error: {
                message:
                  error instanceof Error
                    ? error.message
                    : "Browser relay failed.",
              },
            }),
          );
      }
    });
    ws.on("error", () => ws.close());
    ws.on("close", () => {
      if (this.client === ws) this.client = undefined;
    });
  }
  private async dispatch(message: CDPMessage) {
    const { method, params } = message;
    const model = this.model;
    if (!model) throw new Error("Browser extension disconnected.");
    const sessionId = this.browserSessions.has(message.sessionId ?? "")
      ? undefined
      : (this.inspectSessions.get(message.sessionId ?? "") ??
        message.sessionId);
    if (method === "Browser.getVersion")
      return {
        protocolVersion: "1.3",
        product: "Chrome/Extension-Bridge",
        userAgent: "MetaHarness",
      };
    if (method === "Browser.close")
      throw new Error("Cannot close the user's browser.");
    if (
      method === "Browser.setDownloadBehavior" ||
      method === "Target.setDiscoverTargets"
    )
      return {};
    if (method === "Target.attachToBrowserTarget") {
      const sessionId = `harness-browser-${++this.inspectSequence}`;
      this.browserSessions.add(sessionId);
      return { sessionId };
    }
    if (method === "Target.detachFromTarget") {
      this.inspectSessions.delete(params?.sessionId);
      this.browserSessions.delete(params?.sessionId);
      return {};
    }
    if (method === "Target.attachToTarget") {
      const target = model.sessionIdForTarget(params?.targetId);
      if (!target) throw new Error("Target is outside the harness tabs.");
      const alias = `harness-inspect-${++this.inspectSequence}`;
      this.inspectSessions.set(alias, target);
      return { sessionId: alias };
    }
    if (method === "Target.getTargets")
      return { targetInfos: model.targetInfos() };
    if (method === "Target.setAutoAttach" && !sessionId) {
      await model.enableAutoAttach();
      return {};
    }
    if (method === "Target.createTarget")
      return model.createTarget(params?.url);
    if (method === "Target.closeTarget")
      return model.closeTarget(params?.targetId);
    if (method === "Target.getTargetInfo")
      return {
        targetInfo:
          model.getTargetInfo(sessionId) ??
          model.targetInfoForId(params?.targetId),
      };
    return sessionId
      ? model.sendCommand(sessionId, method ?? "", params)
      : model.sendBrowserCommand(method ?? "", params);
  }
  async close() {
    if (this.keepalive) clearInterval(this.keepalive);
    for (const socket of this.sockets.clients) socket.terminate();
    this.sockets.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
