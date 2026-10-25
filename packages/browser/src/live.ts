import { setTimeout as delay } from "node:timers/promises";
import type { BrowserAssignment } from "@harness/core/browser";
import type { Page } from "patchright";
import WebSocket from "ws";
import { browserPeer, decryptBytes, encryptBytes } from "./crypto";
import type { BrowserHost } from "./index";
import { safeBrowserUrl } from "./index";
import { chooseAt, selectAt } from "./native";

/** A failure whose message is safe and useful to show the person. */
export class LiveInputError extends Error {}

export type PageField = {
  ref: string;
  label: string;
  kind: "text" | "email" | "password" | "code" | "tel" | "number" | "select";
  value?: string;
  filled: boolean;
  options?: { value: string; label: string }[];
};

/**
 * The fields the page is asking for right now, read from its accessibility
 * tree. The owner fills only what the agent could not; values already in the
 * page are shown so they can be changed. Password values are never read back.
 */
export async function pageFields(page: Page): Promise<PageField[]> {
  const snapshot = await page
    .ariaSnapshot({ mode: "ai", timeout: 5000 })
    .catch(() => "");
  const fields: PageField[] = [];
  for (const line of snapshot.split("\n")) {
    const match = line.match(
      /^\s*- (textbox|searchbox|spinbutton|combobox)(?: "([^"]{0,120})")?[^\n]*?\[ref=((?:f\d+)?e\d+)\]/,
    );
    if (!match) continue;
    const details = await page
      .locator(`aria-ref=${match[3]}`)
      .evaluate((element) => {
        const input = element as HTMLInputElement & HTMLSelectElement;
        const tag = element.tagName.toLowerCase();
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        if (
          !["input", "textarea", "select"].includes(tag) ||
          input.disabled ||
          input.readOnly ||
          style.visibility === "hidden" ||
          style.display === "none" ||
          box.width < 2 ||
          box.height < 2
        )
          return null;
        const type = (input.type || "text").toLowerCase();
        if (
          [
            "hidden",
            "submit",
            "button",
            "reset",
            "checkbox",
            "radio",
            "file",
            "range",
            "color",
            "image",
          ].includes(type)
        )
          return null;
        const hint = `${input.autocomplete} ${input.name} ${input.id}`;
        return {
          tag,
          type,
          code:
            /one-time-code/.test(input.autocomplete) ||
            /\b(otp|code|pin|totp)\b|otp|pin$/i.test(hint),
          label:
            element.getAttribute("aria-label") ||
            input.labels?.[0]?.textContent?.trim() ||
            input.placeholder ||
            input.name ||
            "",
          value: type === "password" ? "" : String(input.value ?? ""),
          filled: Boolean(input.value),
          options:
            tag === "select"
              ? Array.from(input.options)
                  .slice(0, 200)
                  .map((option) => ({
                    value: option.value,
                    label: (option.label || option.textContent || "")
                      .trim()
                      .slice(0, 120),
                  }))
              : undefined,
        };
      })
      .catch(() => null);
    if (!details) continue;
    const kind: PageField["kind"] =
      details.tag === "select"
        ? "select"
        : details.type === "password"
          ? "password"
          : details.code
            ? "code"
            : details.type === "email"
              ? "email"
              : details.type === "tel"
                ? "tel"
                : details.type === "number"
                  ? "number"
                  : "text";
    fields.push({
      ref: match[3],
      label: (match[2] || details.label || "Field").slice(0, 120),
      kind,
      filled: details.filled,
      ...(details.value ? { value: details.value.slice(0, 500) } : {}),
      ...(details.options ? { options: details.options } : {}),
    });
    if (fields.length >= 20) break;
  }
  return fields;
}

/**
 * Sealed fill: the value arrives encrypted from the owner's browser and is
 * typed into that field. It is never stored, logged or returned.
 */
async function fillField(
  page: Page,
  ref: string,
  value: string,
  submit: boolean,
) {
  const target = page.locator(`aria-ref=${ref}`);
  if (!(await target.count()))
    throw new LiveInputError(
      "That field is no longer on the page. The list was refreshed.",
    );
  if ((await target.evaluate((element) => element.tagName)) === "SELECT")
    await target.selectOption(value, { timeout: 5000 });
  else await target.fill(value, { timeout: 5000 });
  if (submit) await target.press("Enter");
}

/**
 * Phone-sized tap targets: the page's clickable elements from the accessibility
 * tree, so a person can press "Try another way" without hitting a tiny link.
 */
async function pageTargets(page: Page) {
  const snapshot = await page
    .ariaSnapshot({ mode: "ai", timeout: 5000 })
    .catch(() => "");
  const targets: { ref: string; role: string; name: string }[] = [];
  for (const line of snapshot.split("\n")) {
    const match = line.match(
      /^\s*- (button|link|checkbox|radio|menuitem|tab|option|switch)\s+"([^"]{1,120})"[^\n]*?\[ref=((?:f\d+)?e\d+)\]/,
    );
    if (match && !targets.some((item) => item.name === match[2]))
      targets.push({ role: match[1], name: match[2], ref: match[3] });
    if (targets.length >= 60) break;
  }
  return targets;
}

/** Ephemeral CDP stream: no frame/input enters the operation ledger or model. */
export async function liveBrowser(
  host: BrowserHost,
  assignment: BrowserAssignment,
  publicKey: string,
  send: (message: Record<string, unknown>) => void,
) {
  const { touch, downloads, current, onPage, onNotice } =
    await host.livePage(assignment);
  const peer = browserPeer(publicKey);
  let page = current();
  let cdp = await page.context().newCDPSession(page);
  let closed = false;
  let lastFrame = 0;
  let sequence = 0;
  const emit = (data: string, size?: { width: number; height: number }) => {
    if (closed) return;
    touch();
    send({
      type: "frame",
      sequence: ++sequence,
      time: Date.now(),
      width: size?.width ?? 1280,
      height: size?.height ?? 800,
      url: safeBrowserUrl(page.url()),
      frame: {
        ...encryptBytes(peer.key, Buffer.from(data, "base64")),
        publicKey: peer.publicKey,
      },
    });
  };
  const start = async () => {
    const session = cdp;
    session.on("Page.screencastFrame", (frame) => {
      void session
        .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
        .catch(() => {});
      if (session !== cdp || Date.now() - lastFrame < 70) return;
      lastFrame = Date.now();
      emit(frame.data, {
        width: Math.round(frame.metadata.deviceWidth ?? 1280),
        height: Math.round(frame.metadata.deviceHeight ?? 800),
      });
    });
    await session.send("Page.startScreencast", {
      format: "jpeg",
      quality: 65,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: 1,
    });
    // CDP does not promise a new frame for an unchanged page.
    emit(
      (
        await session.send("Page.captureScreenshot", {
          format: "jpeg",
          quality: 65,
        })
      ).data,
    );
  };
  await start();
  const sendSealed = (type: string, value: unknown) =>
    send({
      type,
      data: encryptBytes(peer.key, Buffer.from(JSON.stringify(value))),
    });
  const stopNotices = onNotice((value) => {
    if (!closed) sendSealed("notice", value);
  });
  // Follow popups and new tabs (for example OAuth sign-in windows), so the
  // viewer always sees the page the agent or person is working in.
  const unsubscribe = onPage((next) => {
    if (closed || next === page) return;
    const previous = cdp;
    page = next;
    void (async () => {
      await previous.send("Page.stopScreencast").catch(() => {});
      await previous.detach().catch(() => {});
      cdp = await page.context().newCDPSession(page);
      await start();
    })().catch(() => {});
  });
  // While the owner is viewing, keep the list of fields the page is asking for
  // current, so the form follows the site step by step.
  let fieldsSent = "";
  const sendFields = async (force = false) => {
    if (closed) return;
    const value = JSON.stringify(await pageFields(page));
    if (closed || (!force && value === fieldsSent)) return;
    fieldsSent = value;
    send({
      type: "fields",
      data: encryptBytes(peer.key, Buffer.from(value)),
    });
  };
  const fieldPoll = setInterval(() => void sendFields().catch(() => {}), 2500);
  fieldPoll.unref();
  void sendFields().catch(() => {});
  let catalog = "";
  const heartbeat = setInterval(() => {
    touch();
    if (downloads)
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
      if (closed) throw new Error("This browser view has closed.");
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
      } else if (input.type === "targets") {
        sendSealed("targets", await pageTargets(page));
      } else if (
        input.type === "press-target" &&
        typeof input.ref === "string" &&
        /^(?:f\d{1,4})?e\d{1,6}$/.test(input.ref)
      ) {
        const box = await page
          .locator(`aria-ref=${input.ref}`)
          .boundingBox({ timeout: 3000 })
          .catch(() => null);
        if (!box)
          throw new LiveInputError(
            "That button is gone. Open the list again for the current page.",
          );
        // Real input at the element's center, like a precise tap.
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      } else if (
        input.type === "choose" &&
        typeof input.value === "string" &&
        Number.isFinite(input.x) &&
        Number.isFinite(input.y)
      ) {
        await chooseAt(page, input.x, input.y, input.value);
      } else if (input.type === "pointer") {
        // Native select popups are invisible in the stream: offer the options
        // to the viewer instead of opening the page's dropdown.
        if (input.event === "mousePressed" && input.button === "left") {
          const select = await selectAt(page, input.x, input.y);
          if (select) {
            sendSealed("select", { ...select, x: input.x, y: input.y });
            return;
          }
        }
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
      } else if (input.type === "fields") {
        await sendFields(true);
      } else if (
        input.type === "fill" &&
        Array.isArray(input.fields) &&
        input.fields.length <= 20
      ) {
        const entries = input.fields.filter(
          (item: { ref?: unknown; value?: unknown }) =>
            typeof item?.ref === "string" &&
            /^(?:f\d{1,4})?e\d{1,6}$/.test(item.ref) &&
            typeof item.value === "string" &&
            item.value.length <= 2000,
        ) as { ref: string; value: string }[];
        try {
          for (const [index, item] of entries.entries())
            await fillField(
              page,
              item.ref,
              item.value,
              input.submit === true && index === entries.length - 1,
            );
        } finally {
          setTimeout(() => void sendFields(), 1200);
        }
      } else if (input.type === "navigate" && typeof input.url === "string") {
        await host.liveNavigate(page, input.url);
      } else throw new Error("Unsupported live browser input.");
    },
    async close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      stopNotices();
      clearInterval(heartbeat);
      clearInterval(fieldPoll);
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
            .catch((error) =>
              send({
                type: "error",
                viewId: message.viewId,
                id: message.id,
                error:
                  error instanceof LiveInputError
                    ? error.message
                    : "Browser input failed; inspect the current page before retrying.",
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
