"use client";
import type { BrowserIdentity } from "@harness/core/browser";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BrowserSteps } from "./browser-steps";
import { ErrorNote } from "./shell";

type View = Omit<BrowserIdentity, "stateCipher" | "userPublicKey">;
export type BrowserStep = {
  id: string;
  label: string;
  status: string;
  image?: string;
  createdAt: number;
  turnId: string;
  target: string;
  error?: string;
  login?: string;
};
const decode = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const encode = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 16384)
    text += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(text);
};

export function BrowserPanel({
  workspaceId,
  sessionId,
  open,
  onOpenChange,
  needsLogin = false,
  onSteps,
}: {
  workspaceId: string;
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  needsLogin?: boolean;
  onSteps?: (steps: BrowserStep[]) => void;
}) {
  const [browser, setBrowser] = useState<View | null>(null);
  const [host, setHost] = useState("");
  const [downloads, setDownloads] = useState<
    { id: string; name: string; size: number }[]
  >([]);
  const downloading = useRef<{
    id: string;
    chunks: Uint8Array<ArrayBuffer>[];
    offset: number;
  } | null>(null);
  const [steps, setSteps] = useState<BrowserStep[]>([]);
  const stepCursor = useRef("");
  const [error, setError] = useState("");
  const [phase, setPhase] = useState("Connecting");
  const [hasFrame, setHasFrame] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [zoomed, setZoomed] = useState(false);
  const [tap, setTap] = useState<{ x: number; y: number; key: number } | null>(
    null,
  );
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!tap) return;
    const timer = setTimeout(() => setTap(null), 700);
    return () => clearTimeout(timer);
  }, [tap]);
  const [targets, setTargets] = useState<
    { ref: string; role: string; name: string }[] | null
  >(null);
  const [picker, setPicker] = useState<{
    label: string;
    x: number;
    y: number;
    options: {
      value: string;
      label: string;
      selected: boolean;
      disabled: boolean;
    }[];
  } | null>(null);
  const [fields, setFields] = useState<PageField[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const card = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // Phones only open a keyboard for a focused text field, never for a canvas.
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const key = useRef<CryptoKey | null>(null);
  const queue = useRef(Promise.resolve());
  const sequence = useRef(0);
  const pending = useRef(
    new Map<
      string,
      {
        at: number;
        resolve: () => void;
        done: Promise<void>;
        settled?: (error?: string) => void;
      }
    >(),
  );
  const mounted = useRef(true);
  const generation = useRef(0);
  const held = useRef(new Set<string>());
  const hoverAt = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleRef = useRef(false);
  const wheelHandler = useRef<(event: WheelEvent) => void>(() => {});
  // The browser is for when something needs a person; it never opens itself.
  const visible = open;
  const site = (() => {
    try {
      return new URL(url || browser?.lastUrl || "").hostname.replace(
        /^www\./,
        "",
      );
    } catch {
      return "";
    }
  })();
  visibleRef.current = visible;
  useEffect(() => {
    if (visible)
      card.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    else setExpanded(false);
  }, [visible]);

  async function request(body: Record<string, unknown>) {
    const response = await fetch("/api/browser", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, workspaceId, sessionId }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Browser request failed.");
    if (data.browser) {
      setBrowser(data.browser);
      generation.current = data.browser.generation;
    }
    return data;
  }
  async function load() {
    const response = await fetch(
      `/api/browser?workspace=${encodeURIComponent(workspaceId)}&session=${encodeURIComponent(sessionId)}&stepCursor=${encodeURIComponent(stepCursor.current)}`,
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (!mounted.current) return;
    setBrowser(data.browser);
    setHost(data.host?.name ?? "");
    if (data.steps) {
      setSteps(data.steps);
      onStepsRef.current?.(data.steps);
    }
    stepCursor.current = data.stepCursor ?? "";
  }
  const onStepsRef = useRef(onSteps);
  onStepsRef.current = onSteps;
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    mounted.current = true;
    void loadRef.current().catch(() => {});
    const timer = setInterval(
      () => {
        if (!document.hidden) void loadRef.current().catch(() => {});
      },
      visible ? 2000 : 5000,
    );
    return () => {
      mounted.current = false;
      clearInterval(timer);
      socket.current?.close();
    };
  }, [visible]);

  async function connect() {
    if (retry.current) clearTimeout(retry.current);
    setBusy(true);
    setError("");
    setPhase("Connecting");
    socket.current?.close();
    pending.current.clear();
    key.current = null;
    sequence.current = 0;
    downloading.current = null;
    setDownloads([]);
    setHasFrame(false);
    try {
      if (!crypto.subtle)
        throw new Error("Live browser access needs HTTPS or localhost.");
      const pair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        false,
        ["deriveKey"],
      );
      const publicKey = encode(
        new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
      );
      const data = await request({ action: "enable" });
      const target = new URL("/api/browser-stream", location.origin);
      target.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      target.searchParams.set("browser", data.browser.id);
      target.searchParams.set("key", publicKey);
      const ws = new WebSocket(target);
      socket.current = ws;
      setFields(null);
      held.current.clear();
      let streamKey: CryptoKey | null = null;
      ws.onmessage = async (event) => {
        if (socket.current !== ws) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === "error") {
            const receipt = message.id && pending.current.get(message.id);
            if (receipt) {
              receipt.resolve();
              receipt.settled?.(message.error);
              pending.current.delete(message.id);
            }
            if (!receipt?.settled) setError(message.error);
            return;
          }
          if (message.type === "ack") {
            const receipt = pending.current.get(message.id);
            if (receipt) {
              setLatency(Date.now() - receipt.at);
              receipt.resolve();
              receipt.settled?.();
              pending.current.delete(message.id);
            }
            return;
          }
          if (
            [
              "downloads",
              "download",
              "notice",
              "select",
              "targets",
              "fields",
            ].includes(message.type) &&
            streamKey
          ) {
            const decrypted = await crypto.subtle.decrypt(
              { name: "AES-GCM", iv: decode(message.data.iv) },
              streamKey,
              decode(message.data.ciphertext),
            );
            const value = JSON.parse(new TextDecoder().decode(decrypted));
            if (message.type === "notice")
              setNotice(
                `The page showed ${value.kind === "alert" ? "an alert" : `a ${value.kind}`} (${value.kind === "alert" ? "acknowledged" : "cancelled"} automatically): ${value.message}`,
              );
            else if (message.type === "select") setPicker(value);
            else if (message.type === "targets") setTargets(value);
            else if (message.type === "fields") setFields(value);
            else if (message.type === "downloads") setDownloads(value);
            else {
              const active = downloading.current;
              if (
                !active ||
                active.id !== value.id ||
                active.offset !== value.offset ||
                value.size > 8 * 1024 * 1024
              )
                return;
              const bytes = decode(value.bytes);
              active.chunks.push(bytes);
              active.offset += bytes.length;
              if (value.done) {
                const url = URL.createObjectURL(
                  new Blob(active.chunks, { type: "application/octet-stream" }),
                );
                const link = document.createElement("a");
                link.href = url;
                link.download = value.name;
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 10000);
                downloading.current = null;
              } else
                inputRef.current({
                  type: "download",
                  id: active.id,
                  offset: active.offset,
                });
            }
            return;
          }
          if (message.type !== "frame" || message.sequence <= sequence.current)
            return;
          const current = message.sequence;
          sequence.current = current;
          if (!streamKey) {
            const peer = await crypto.subtle.importKey(
              "raw",
              decode(message.frame.publicKey),
              { name: "ECDH", namedCurve: "P-256" },
              false,
              [],
            );
            streamKey = await crypto.subtle.deriveKey(
              { name: "ECDH", public: peer },
              pair.privateKey,
              { name: "AES-GCM", length: 256 },
              false,
              ["encrypt", "decrypt"],
            );
          }
          if (socket.current !== ws) return;
          key.current = streamKey;
          const bytes = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: decode(message.frame.iv) },
            streamKey,
            decode(message.frame.ciphertext),
          );
          const image = await createImageBitmap(
            new Blob([bytes], { type: "image/jpeg" }),
          );
          if (socket.current === ws && current === sequence.current) {
            if (canvas.current)
              canvas.current.dataset.frameSequence = String(current);
            canvas.current?.getContext("2d")?.drawImage(image, 0, 0, 1280, 800);
            setHasFrame(true);
            setPhase("Live");
            setError("");
            if (
              document.activeElement?.getAttribute("aria-label") !==
              "Browser address"
            )
              setUrl(message.url === "about:blank" ? "" : message.url);
          }
          image.close();
        } catch {
          setError(
            "Could not decode the live view. Reconnect to create a fresh encrypted stream.",
          );
        }
      };
      ws.onclose = () => {
        if (socket.current === ws) {
          setPhase("Disconnected");
          // Phones drop sockets when you switch apps (for example to approve
          // MFA); reconnect on its own instead of leaving a dead view.
          if (retry.current) clearTimeout(retry.current);
          retry.current = setTimeout(() => {
            if (
              mounted.current &&
              visibleRef.current &&
              !document.hidden &&
              socket.current === ws
            )
              void connectRef.current();
          }, 1500);
        }
      };
      ws.onerror = () => {
        if (socket.current === ws)
          setError(
            "Live stream could not connect. Check that the browser worker is online and updated.",
          );
      };
      onOpenChange(true);
    } catch (failure) {
      const reason =
        failure instanceof Error
          ? failure.message
          : "Browser connection failed.";
      setError(reason);
      if (reason.startsWith("Waiting for")) {
        setPhase("Waiting for capacity");
        retry.current = setTimeout(() => {
          if (visibleRef.current) void connectRef.current();
        }, 1500);
      } else setPhase("Disconnected");
    } finally {
      setBusy(false);
    }
  }
  const inputRef = useRef<
    (value: Record<string, unknown>, settled?: (error?: string) => void) => void
  >(() => {});
  const connectRef = useRef(connect);
  connectRef.current = connect;
  useEffect(() => {
    if (!visible) return;
    const back = () => {
      const ws = socket.current;
      if (
        !document.hidden &&
        (!ws ||
          ws.readyState === WebSocket.CLOSED ||
          ws.readyState === WebSocket.CLOSING)
      )
        void connectRef.current();
    };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, [visible]);
  useEffect(() => {
    if (visible) void connectRef.current();
    else socket.current?.close();
    return () => {
      if (retry.current) clearTimeout(retry.current);
      socket.current?.close();
    };
  }, [visible]);

  function input(
    value: Record<string, unknown>,
    settled?: (error?: string) => void,
  ) {
    const ws = socket.current;
    if (phase !== "Live" || !key.current || !ws) {
      settled?.("The browser is not connected. Reconnect and try again.");
      return;
    }
    const activeKey = key.current;
    queue.current = queue.current
      .then(async () => {
        if (socket.current !== ws || ws.readyState !== WebSocket.OPEN) return;
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const bytes = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          activeKey,
          new TextEncoder().encode(JSON.stringify(value)),
        );
        const id = crypto.randomUUID();
        let resolve = () => {};
        const done = new Promise<void>((r) => {
          resolve = r;
        });
        pending.current.set(id, { at: Date.now(), resolve, done, settled });
        ws.send(
          JSON.stringify({
            type: "input",
            id,
            input: {
              iv: encode(iv),
              ciphertext: encode(new Uint8Array(bytes)),
            },
          }),
        );
      })
      .catch(() =>
        setError("Input was not sent. Reconnect before trying again."),
      );
  }
  inputRef.current = input;

  function pointer(
    event:
      | React.PointerEvent<HTMLCanvasElement>
      | React.WheelEvent<HTMLCanvasElement>,
    type: string,
  ) {
    if (!live) return;
    event.preventDefault();
    if (type === "mousePressed") canvas.current?.focus({ preventScroll: true });
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = Math.min(rect.width / 1280, rect.height / 800);
    const offsetX = (rect.width - 1280 * scale) / 2;
    const offsetY = (rect.height - 800 * scale) / 2;
    input({
      type: "pointer",
      event: type,
      buttons: "buttons" in event ? event.buttons : 0,
      x: Math.min(
        1279,
        Math.max(0, (event.clientX - rect.left - offsetX) / scale),
      ),
      y: Math.min(
        799,
        Math.max(0, (event.clientY - rect.top - offsetY) / scale),
      ),
      button:
        "button" in event ? ["left", "middle", "right"][event.button] : "none",
      ...("deltaY" in event ? { dy: event.deltaY, dx: event.deltaX } : {}),
    });
  }
  wheelHandler.current = (event) => {
    if (!live || !canvas.current) return;
    event.preventDefault();
    const rect = canvas.current.getBoundingClientRect();
    const scale = Math.min(rect.width / 1280, rect.height / 800);
    input({
      type: "pointer",
      event: "mouseWheel",
      button: "none",
      x: Math.max(
        0,
        Math.min(
          1279,
          (event.clientX - rect.left - (rect.width - 1280 * scale) / 2) / scale,
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          799,
          (event.clientY - rect.top - (rect.height - 800 * scale) / 2) / scale,
        ),
      ),
      dx: event.deltaX,
      dy: event.deltaY,
    });
  };
  useEffect(() => {
    if (!visible) return;
    const target = canvas.current;
    const wheel = (event: WheelEvent) => wheelHandler.current(event);
    target?.addEventListener("wheel", wheel, { passive: false });
    return () => target?.removeEventListener("wheel", wheel);
  }, [visible]);
  const activity = !onSteps && steps.length > 0 && (
    <BrowserSteps steps={steps} />
  );
  if (!visible) return activity;
  // You and the agent share the browser: input works whenever it is live.
  const live = phase === "Live";
  const close = () => onOpenChange(false);
  return (
    <>
      <section
        ref={card}
        aria-label="Workspace browser"
        onKeyDownCapture={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (expanded) setExpanded(false);
            else close();
          }
        }}
        className={
          expanded
            ? "fixed inset-0 z-50 flex flex-col overflow-y-auto bg-card pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
            : "my-4 flex flex-col overflow-hidden rounded-lg border bg-card text-sm"
        }
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2">
          <strong className="text-sm" title={browser?.name}>
            Browser
          </strong>
          <span
            role="status"
            data-testid="browser-stream-status"
            className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
          >
            <span
              aria-hidden
              className={`size-2 shrink-0 rounded-full ${phase === "Live" ? "bg-success" : phase === "Disconnected" ? "bg-destructive" : "bg-warning"}`}
            />
            <span className="truncate">
              {phase}
              {latency !== null && live ? ` · ${latency} ms` : ""}
              {host ? ` · ${host}` : ""}
            </span>
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Shrink" : "Full screen"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Close browser view"
              onClick={close}
            >
              <X />
            </Button>
          </div>
        </div>
        {needsLogin && (
          <p
            role="note"
            className="border-b bg-warning/10 px-3 py-2 text-xs text-muted-foreground"
          >
            <strong className="font-medium text-foreground">
              The agent is waiting for you to sign in
              {site ? ` to ${site}` : ""}.
            </strong>{" "}
            Fill what the page asks for below or tap the page, then reply in the
            conversation. Your password goes only to the site; the agent never
            sees it.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          {phase === "Disconnected" && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void connect()}
            >
              Reconnect
            </Button>
          )}
          {live && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => input({ type: "targets" })}
              >
                Buttons on this page
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={zoomed}
                onClick={() => setZoomed(!zoomed)}
              >
                {zoomed ? "Fit page" : "Zoom in"}
              </Button>
            </>
          )}
        </div>
        {error && (
          <div className="px-3 pb-2">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}
        {live && <PageFields fields={fields} send={input} />}
        {live && downloads.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
            <span>Downloads on this worker:</span>
            {downloads.map((item) => (
              <Button
                key={item.id}
                size="sm"
                variant="outline"
                onClick={() => {
                  downloading.current = {
                    id: item.id,
                    chunks: [],
                    offset: 0,
                  };
                  input({ type: "download", id: item.id, offset: 0 });
                }}
              >
                Download {item.name}
              </Button>
            ))}
          </div>
        )}
        <form
          className="flex items-center gap-2 border-t px-3 py-1"
          onSubmit={(event) => {
            event.preventDefault();
            input({
              type: "navigate",
              url: /^https?:/.test(url) ? url : `https://${url}`,
            });
          }}
        >
          <Input
            aria-label="Browser address"
            placeholder="Address"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            disabled={!live}
            className="h-8 border-0 bg-transparent px-0 text-xs shadow-none"
          />
          {live && (
            <Button size="sm" variant="ghost" type="submit">
              Go
            </Button>
          )}
        </form>
        <div
          className={`relative flex bg-muted ${expanded ? "min-h-0 flex-1" : "aspect-[16/10] max-h-[60vh]"} ${zoomed ? "items-start justify-start overflow-auto" : "items-center justify-center"}`}
          aria-busy={!hasFrame}
        >
          <canvas
            ref={canvas}
            width={1280}
            height={800}
            tabIndex={0}
            aria-label="Remote browser"
            data-ready={hasFrame}
            className={
              zoomed
                ? "block h-auto w-[250%] max-w-none outline-none"
                : "block h-auto max-h-full w-auto max-w-full touch-none outline-none focus:ring-2 focus:ring-primary"
            }
            // Zoomed, one finger pans; a tap (no movement) still clicks.
            style={zoomed ? { touchAction: "pan-x pan-y" } : undefined}
            onPointerDown={(event) => {
              if (!live) return;
              if (event.pointerType === "touch") {
                touchStart.current = { x: event.clientX, y: event.clientY };
                return;
              }
              event.currentTarget.setPointerCapture(event.pointerId);
              pointer(event, "mousePressed");
            }}
            onPointerUp={(event) => {
              if (event.pointerType === "touch") {
                const start = touchStart.current;
                touchStart.current = null;
                if (
                  !live ||
                  !start ||
                  Math.hypot(event.clientX - start.x, event.clientY - start.y) >
                    10
                )
                  return;
                // Taps click on release, so a pan never leaves the remote
                // mouse pressed.
                pointer(event, "mousePressed");
                pointer(event, "mouseReleased");
                const box =
                  event.currentTarget.parentElement?.getBoundingClientRect();
                if (box)
                  setTap({
                    x:
                      event.clientX -
                      box.left +
                      (event.currentTarget.parentElement?.scrollLeft ?? 0),
                    y:
                      event.clientY -
                      box.top +
                      (event.currentTarget.parentElement?.scrollTop ?? 0),
                    key: Date.now(),
                  });
              } else pointer(event, "mouseReleased");
              // Focus inside the tap so iOS/Android show the keyboard; typed
              // characters are forwarded to whatever the tap focused remotely.
              if (live && event.pointerType !== "mouse")
                keyboard.current?.focus({ preventScroll: true });
            }}
            onPointerCancel={() => {
              touchStart.current = null;
            }}
            onPointerMove={(event) => {
              if (
                live &&
                event.pointerType !== "touch" &&
                Date.now() - hoverAt.current > 35
              ) {
                hoverAt.current = Date.now();
                pointer(event, "mouseMoved");
              }
            }}
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={(event) => {
              if (!live) return;
              event.preventDefault();
              event.stopPropagation();
              if (
                event.key.length === 1 &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.altKey
              )
                input({ type: "text", text: event.key });
              else {
                held.current.add(event.key);
                input({
                  type: "key",
                  event: "down",
                  key: event.key === " " ? "Space" : event.key,
                });
              }
            }}
            onKeyUp={(event) => {
              if (held.current.delete(event.key))
                input({ type: "key", event: "up", key: event.key });
            }}
            onBlur={() => {
              for (const key of held.current)
                input({ type: "key", event: "up", key });
              held.current.clear();
            }}
            onPaste={(event) => {
              if (live) {
                event.preventDefault();
                input({
                  type: "text",
                  text: event.clipboardData.getData("text/plain"),
                });
              }
            }}
          />
          {live && (
            <textarea
              ref={keyboard}
              aria-label="Phone keyboard for the remote page"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              rows={1}
              className="pointer-events-none absolute bottom-0 left-0 h-8 w-full resize-none opacity-0"
              style={{ fontSize: 16 }}
              onInput={(event) => {
                const value = event.currentTarget.value;
                event.currentTarget.value = "";
                if (value) input({ type: "text", text: value });
              }}
              onKeyDown={(event) => {
                // Keys that produce no text still need to reach the page.
                if (["Backspace", "Enter", "Tab"].includes(event.key)) {
                  event.preventDefault();
                  input({ type: "key", event: "down", key: event.key });
                  input({ type: "key", event: "up", key: event.key });
                }
              }}
            />
          )}
          {tap && (
            <span
              key={tap.key}
              aria-hidden
              className="pointer-events-none absolute size-10 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full border-4 border-primary"
              style={{ left: tap.x, top: tap.y }}
            />
          )}
          {notice && (
            <div
              role="status"
              className="absolute inset-x-2 top-2 flex items-start gap-2 rounded-md bg-background/95 p-2 text-xs shadow"
            >
              <span className="min-w-0 flex-1">{notice}</span>
              <button
                type="button"
                aria-label="Dismiss notice"
                onClick={() => setNotice("")}
              >
                <X className="size-4" />
              </button>
            </div>
          )}
          {!hasFrame && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-muted-foreground">
              {phase === "Disconnected"
                ? "Stream disconnected. Reconnect to view the browser."
                : "Connecting to the browser…"}
            </div>
          )}
        </div>
        <p className="px-3 py-2 text-xs text-muted-foreground">
          You and the agent share this browser. Tap or click the page; typing
          and paste go to the field you tapped. When you are done, just reply in
          the conversation.
        </p>
      </section>
      {targets && (
        <Sheet
          title="Buttons and links on this page"
          onClose={() => setTargets(null)}
        >
          {!targets.length && (
            <p className="text-muted-foreground">
              No buttons found. Tap the page directly or use Zoom.
            </p>
          )}
          <ul className="grid gap-1">
            {targets.map((target) => (
              <li key={target.ref}>
                <button
                  type="button"
                  className="w-full rounded-md px-3 py-2.5 text-left hover:bg-accent"
                  onClick={() => {
                    input({ type: "press-target", ref: target.ref });
                    setTargets(null);
                  }}
                >
                  {target.name}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {target.role}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      )}
      {picker && (
        <Sheet title={picker.label} onClose={() => setPicker(null)}>
          <ul className="grid gap-1">
            {picker.options.map((option) => (
              <li key={`${option.value}:${option.label}`}>
                <button
                  type="button"
                  disabled={option.disabled}
                  className={`w-full rounded-md px-3 py-2 text-left hover:bg-accent disabled:opacity-40 ${option.selected ? "bg-accent font-medium" : ""}`}
                  onClick={() => {
                    input({
                      type: "choose",
                      x: picker.x,
                      y: picker.y,
                      value: option.value,
                    });
                    setPicker(null);
                  }}
                >
                  {option.label || option.value || "(empty)"}
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      )}
      {activity}
    </>
  );
}

function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      role="dialog"
      aria-label={title}
      className="fixed inset-x-0 bottom-0 z-[60] mx-auto max-h-[70vh] w-full max-w-xl overflow-y-auto rounded-t-xl border bg-card p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-sm shadow-2xl"
    >
      <div className="mb-2 flex items-center justify-between">
        <strong>{title}</strong>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
      {children}
    </div>,
    document.body,
  );
}

type PageField = {
  ref: string;
  label: string;
  kind: "text" | "email" | "password" | "code" | "tel" | "number" | "select";
  value?: string;
  filled: boolean;
  options?: { value: string; label: string }[];
};

/**
 * The fields the remote page is asking for right now, mirrored as real inputs
 * so phones get the right keyboard and password managers can help. Only the
 * fields you change are sent, encrypted to the worker and typed into the page;
 * nothing is stored or shown to the agent.
 */
function PageFields({
  fields,
  send,
}: {
  fields: PageField[] | null;
  send: (
    value: Record<string, unknown>,
    settled?: (error?: string) => void,
  ) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");
  const key = fields?.map((field) => `${field.ref}:${field.kind}`).join("|");
  // A new step on the page (new set of fields) starts a fresh form.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per page step
  useEffect(() => {
    setValues({});
    setStatus("");
  }, [key]);
  if (!fields) return null;
  if (!fields.length)
    return (
      <p className="border-t px-3 py-2 text-xs text-muted-foreground">
        This page isn’t asking for anything to type. Use “Buttons on this page”
        or tap the page.
      </p>
    );
  const changed = fields.filter((field) => field.ref in values);
  const submit = (andSubmit: boolean) => {
    if (!changed.length && !andSubmit) return;
    setStatus("Sending…");
    send(
      {
        type: "fill",
        submit: andSubmit,
        fields: (changed.length ? changed : fields.slice(-1)).map((field) => ({
          ref: field.ref,
          value: values[field.ref] ?? field.value ?? "",
        })),
      },
      (error) => setStatus(error ?? (andSubmit ? "Sent ✓" : "Filled ✓")),
    );
    // Secrets leave this form as soon as they are sent.
    setValues((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([ref]) =>
            fields.find((field) => field.ref === ref)?.kind !== "password",
        ),
      ),
    );
  };
  return (
    <form
      className="grid gap-2 border-t px-3 py-3"
      autoComplete="on"
      onSubmit={(event) => {
        event.preventDefault();
        submit(true);
      }}
    >
      <p className="text-xs text-muted-foreground">
        This page is asking for the following. Change only what you need; it is
        typed straight into the page, never saved or shown to the agent.
      </p>
      {fields.map((field) => {
        const value = values[field.ref] ?? field.value ?? "";
        const update = (next: string) =>
          setValues((current) => ({ ...current, [field.ref]: next }));
        return (
          <div key={field.ref} className="grid gap-1">
            <label
              htmlFor={`page-field-${field.ref}`}
              className="text-xs font-medium"
            >
              {field.label}
              {field.filled && field.kind === "password" && (
                <span className="ml-2 font-normal text-muted-foreground">
                  already filled
                </span>
              )}
            </label>
            {field.kind === "select" ? (
              <select
                id={`page-field-${field.ref}`}
                value={value}
                onChange={(event) => update(event.target.value)}
                className="h-9 rounded-md border bg-background px-2 text-base sm:text-sm"
              >
                {field.options?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label || option.value}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id={`page-field-${field.ref}`}
                type={
                  field.kind === "password"
                    ? "password"
                    : field.kind === "email"
                      ? "email"
                      : field.kind === "tel"
                        ? "tel"
                        : "text"
                }
                inputMode={
                  field.kind === "code" || field.kind === "number"
                    ? "numeric"
                    : undefined
                }
                autoComplete={
                  field.kind === "password"
                    ? "current-password"
                    : field.kind === "email"
                      ? "username"
                      : field.kind === "code"
                        ? "one-time-code"
                        : "off"
                }
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={value}
                onChange={(event) => update(event.target.value)}
                className="h-9 text-base sm:text-sm"
              />
            )}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" type="submit">
          Fill and continue
        </Button>
        <Button
          size="sm"
          type="button"
          variant="outline"
          disabled={!changed.length}
          onClick={() => submit(false)}
        >
          Fill only
        </Button>
        {status && (
          <span role="status" className="text-xs text-muted-foreground">
            {status}
          </span>
        )}
      </div>
    </form>
  );
}
