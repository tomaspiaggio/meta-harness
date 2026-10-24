import { setTimeout as delay } from "node:timers/promises";
import type { BrowserAssignment } from "@harness/core/browser";
import WebSocket from "ws";
import { browserPeer, decryptBytes, encryptBytes } from "./crypto";
import type { BrowserHost } from "./index";
import { safeBrowserUrl } from "./index";

/** Ephemeral CDP stream: no frame/input enters the operation ledger or model. */
export async function liveBrowser(
  host: BrowserHost,
  assignment: BrowserAssignment,
  publicKey: string,
  send: (message: Record<string, unknown>) => void,
) {
  const { page, touch, downloads } = await host.livePage(assignment);
  const peer = browserPeer(publicKey);
  const cdp = await page.context().newCDPSession(page);
  let closed = false;
  let lastFrame = 0;
  let sequence = 0;
  const emit = (data: string) => {
    if (closed) return;
    touch();
    send({
      type: "frame",
      sequence: ++sequence,
      time: Date.now(),
      width: 1280,
      height: 800,
      url: safeBrowserUrl(page.url()),
      frame: {
        ...encryptBytes(peer.key, Buffer.from(data, "base64")),
        publicKey: peer.publicKey,
      },
    });
  };
  cdp.on("Page.screencastFrame", (frame) => {
    void cdp
      .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
      .catch(() => {});
    if (Date.now() - lastFrame < 70) return;
    lastFrame = Date.now();
    emit(frame.data);
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 65,
    maxWidth: 1280,
    maxHeight: 800,
    everyNthFrame: 1,
  });
  // CDP does not promise a new frame for an unchanged page.
  emit(
    (await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 65 }))
      .data,
  );
  let catalog = "";
  const heartbeat = setInterval(() => {
    touch();
    if (downloads && assignment.identity.mode === "human")
      void downloads
        .list()
        .then((items) => {
          const value = JSON.stringify(items);
          if (!closed && value !== catalog) {
            catalog = value;
            send({
              type: "downloads",
              data: encryptBytes(peer.key, Buffer.from(value)),
            });
          }
        })
        .catch(() => {});
  }, 1000);
  heartbeat.unref();
  return {
    async input(value: { iv: string; ciphertext: string }) {
      if (closed || assignment.identity.mode !== "human")
        throw new Error("Read-only browser view.");
      const input = JSON.parse(
        Buffer.from(decryptBytes(peer.key, value)).toString("utf8"),
      );
      touch();
      if (input.type === "download" && downloads) {
        const chunk = await downloads.chunk(input.id, input.offset);
        send({
          type: "download",
          data: encryptBytes(peer.key, Buffer.from(JSON.stringify(chunk))),
        });
      } else if (input.type === "pointer") {
        if (
          ![
            "mousePressed",
            "mouseReleased",
            "mouseMoved",
            "mouseWheel",
          ].includes(input.event) ||
          !Number.isFinite(input.x) ||
          !Number.isFinite(input.y) ||
          input.x < 0 ||
          input.x >= 1280 ||
          input.y < 0 ||
          input.y >= 800
        )
          throw new Error("Invalid browser pointer input.");
        await cdp.send("Input.dispatchMouseEvent", {
          type: input.event,
          buttons: Number.isInteger(input.buttons) ? input.buttons & 7 : 0,
          x: input.x,
          y: input.y,
          button: ["left", "right", "middle"].includes(input.button)
            ? input.button
            : "none",
          clickCount:
            input.event === "mouseMoved" || input.event === "mouseWheel"
              ? 0
              : 1,
          ...(input.event === "mouseWheel"
            ? {
                deltaX: Math.max(-2000, Math.min(2000, Number(input.dx) || 0)),
                deltaY: Math.max(-2000, Math.min(2000, Number(input.dy) || 0)),
              }
            : {}),
        });
      } else if (
        input.type === "text" &&
        typeof input.text === "string" &&
        input.text.length <= 4000
      ) {
        await page.keyboard.insertText(input.text);
      } else if (
        input.type === "key" &&
        typeof input.key === "string" &&
        input.key.length <= 40 &&
        ["down", "up"].includes(input.event)
      ) {
        if (input.event === "down") await page.keyboard.down(input.key);
        else await page.keyboard.up(input.key);
      } else if (input.type === "navigate" && typeof input.url === "string") {
        await host.liveNavigate(page, input.url);
      } else throw new Error("Unsupported live browser input.");
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      await cdp.send("Page.stopScreencast").catch(() => {});
      await cdp.detach().catch(() => {});
    },
  };
}

export async function browserStreamWorker(
  identity: { id: string; token: string; serverUrl: string },
  host: BrowserHost,
  signal: AbortSignal,
) {
  if (host.backend !== "managed") return;
  const url = new URL(
    "/api/browser-stream?role=worker",
    process.env.HARNESS_BROWSER_STREAM_URL ?? identity.serverUrl,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  while (!signal.aborted) {
    const sessions = new Map<
      string,
      { live: Awaited<ReturnType<typeof liveBrowser>>; queue: Promise<void> }
    >();
    const opening = new Set<string>();
    const socket = new WebSocket(url, {
      headers: {
        "x-worker-id": identity.id,
        authorization: `Bearer ${identity.token}`,
      },
      perMessageDeflate: false,
      handshakeTimeout: 5000,
    });
    const send = (message: Record<string, unknown>) => {
      if (
        socket.readyState === WebSocket.OPEN &&
        socket.bufferedAmount < 1024 * 1024
      )
        socket.send(JSON.stringify(message));
    };
    const abort = () => socket.close();
    signal.addEventListener("abort", abort, { once: true });
    socket.on("error", () => {});
    socket.on("message", async (raw) => {
      let viewId: string | undefined;
      try {
        const message: {
          type: string;
          viewId: string;
          assignment: BrowserAssignment;
          publicKey: string;
          input: { iv: string; ciphertext: string };
          id: string;
        } = JSON.parse(raw.toString());
        viewId = message.viewId;
        if (message.type === "open") {
          opening.add(message.viewId);
          const live = await liveBrowser(
            host,
            message.assignment,
            message.publicKey,
            (value) => send({ ...value, viewId: message.viewId }),
          );
          if (
            !opening.delete(message.viewId) ||
            signal.aborted ||
            socket.readyState !== WebSocket.OPEN
          ) {
            await live.close();
            return;
          }
          sessions.set(message.viewId, { live, queue: Promise.resolve() });
        } else if (message.type === "close") {
          opening.delete(message.viewId);
          const session = sessions.get(message.viewId);
          sessions.delete(message.viewId);
          await session?.live.close();
        } else if (message.type === "input") {
          const session = sessions.get(message.viewId);
          if (!session) throw new Error("Browser view is not connected.");
          session.queue = session.queue
            .then(async () => {
              await session.live.input(message.input);
              send({
                type: "ack",
                viewId: message.viewId,
                id: message.id,
                time: Date.now(),
              });
            })
            .catch(() =>
              send({
                type: "error",
                viewId: message.viewId,
                error:
                  "Browser input failed; inspect the current page before retrying.",
              }),
            );
        }
      } catch (error) {
        send({
          type: "error",
          viewId,
          error:
            error instanceof Error ? error.message : "Browser stream failed.",
        });
      }
    });
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    signal.removeEventListener("abort", abort);
    opening.clear();
    for (const session of sessions.values()) await session.live.close();
    if (!signal.aborted)
      await delay(1500, undefined, { signal }).catch(() => {});
  }
}
