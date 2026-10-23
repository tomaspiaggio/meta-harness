"use client";
import type { BrowserIdentity } from "@harness/core/browser";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorNote } from "./shell";

type View = Omit<BrowserIdentity, "stateCipher" | "userPublicKey">;
type Step = { id: string; label: string; status: string; image?: string };
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
  onResume,
  open,
  onOpenChange,
  needsLogin = false,
}: {
  workspaceId: string;
  sessionId: string;
  onResume: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  needsLogin?: boolean;
}) {
  const [browser, setBrowser] = useState<View | null>(null);
  const [host, setHost] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const stepCursor = useRef("");
  const [error, setError] = useState("");
  const [phase, setPhase] = useState("Connecting");
  const [hasFrame, setHasFrame] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [controlling, setControlling] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const key = useRef<CryptoKey | null>(null);
  const queue = useRef(Promise.resolve());
  const sequence = useRef(0);
  const pending = useRef(
    new Map<string, { at: number; resolve: () => void; done: Promise<void> }>(),
  );
  const mounted = useRef(true);
  const generation = useRef(0);
  const held = useRef(new Set<string>());
  const hoverAt = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleRef = useRef(false);
  const wheelHandler = useRef<(event: WheelEvent) => void>(() => {});
  const visible = open || (needsLogin && !dismissed);
  visibleRef.current = visible;
  useEffect(() => {
    if (!needsLogin) setDismissed(false);
  }, [needsLogin]);

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
    if (data.steps) setSteps(data.steps);
    stepCursor.current = data.stepCursor ?? "";
  }
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

  async function connect(takeControl = false) {
    if (retry.current) clearTimeout(retry.current);
    setBusy(true);
    setError("");
    setPhase("Connecting");
    socket.current?.close();
    pending.current.clear();
    key.current = null;
    sequence.current = 0;
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
      const data = await request(
        takeControl
          ? { action: "takeover", publicKey, force: true }
          : { action: "enable" },
      );
      if (!takeControl && data.browser.mode !== "agent")
        throw new Error(
          "This browser is paused for another view. Choose Sign in or Take control to reconnect here.",
        );
      const target = new URL("/api/browser-stream", location.origin);
      target.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      target.searchParams.set("browser", data.browser.id);
      target.searchParams.set("key", publicKey);
      const ws = new WebSocket(target);
      socket.current = ws;
      setControlling(takeControl);
      held.current.clear();
      let streamKey: CryptoKey | null = null;
      ws.onmessage = async (event) => {
        if (socket.current !== ws) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === "error") {
            setError(message.error);
            return;
          }
          if (message.type === "ack") {
            const receipt = pending.current.get(message.id);
            if (receipt) {
              setLatency(Date.now() - receipt.at);
              receipt.resolve();
              pending.current.delete(message.id);
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
          setControlling(false);
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
          if (visibleRef.current) void connectRef.current(takeControl);
        }, 1500);
      } else setPhase("Disconnected");
    } finally {
      setBusy(false);
    }
  }
  const connectRef = useRef(connect);
  connectRef.current = connect;
  useEffect(() => {
    if (visible) void connectRef.current(false);
    else socket.current?.close();
    return () => {
      if (retry.current) clearTimeout(retry.current);
      socket.current?.close();
    };
  }, [visible]);

  function input(value: Record<string, unknown>) {
    const ws = socket.current;
    if (!controlling || phase !== "Live" || !key.current || !ws) return;
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
        pending.current.set(id, { at: Date.now(), resolve, done });
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
  async function release(resume = false) {
    setBusy(true);
    try {
      await queue.current;
      if (pending.current.size)
        await Promise.race([
          Promise.all(
            [...pending.current.values()].map((receipt) => receipt.done),
          ),
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    "Some input is unconfirmed. Inspect the page before releasing control.",
                  ),
                ),
              2500,
            ),
          ),
        ]);
      socket.current?.close();
      await request({
        action: "return",
        generation: generation.current,
        resume,
      });
      setControlling(false);
      onResume();
      await connect(false);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not release control.",
      );
    } finally {
      setBusy(false);
    }
  }
  function pointer(
    event:
      | React.PointerEvent<HTMLCanvasElement>
      | React.WheelEvent<HTMLCanvasElement>,
    type: string,
  ) {
    if (!controlling) return;
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
    if (!controlling || !canvas.current) return;
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
  const activity = steps.length > 0 && (
    <details className="my-3 rounded-xl border bg-card px-4 py-3" open>
      <summary className="cursor-pointer text-sm">
        Browser activity · {steps.length} recent steps
      </summary>
      <ol className="mt-3 grid gap-3 sm:grid-cols-2">
        {steps.map((step) => (
          <li key={step.id} className="rounded-lg border p-2 text-xs">
            <div className="mb-2 flex justify-between gap-2">
              <span>{step.label}</span>
              <span className="text-muted-foreground">{step.status}</span>
            </div>
            {step.image && (
              <Image
                src={`data:image/jpeg;base64,${step.image}`}
                alt={step.label}
                width={320}
                height={200}
                unoptimized
                className="w-full rounded"
              />
            )}
          </li>
        ))}
      </ol>
    </details>
  );
  if (!visible || typeof document === "undefined") return activity;
  return (
    <>
      {createPortal(
        <section
          aria-label="Workspace browser"
          onKeyDownCapture={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (controlling) void release();
              else {
                setDismissed(true);
                onOpenChange(false);
              }
            }
          }}
          className="fixed bottom-4 right-4 top-20 z-50 flex w-[calc(100vw-2rem)] max-w-6xl flex-col overflow-hidden rounded-xl border bg-card shadow-2xl lg:left-[18rem] lg:w-auto"
        >
          <div className="flex flex-wrap items-center gap-2 border-b p-3">
            <strong className="text-sm" title={browser?.name}>
              Browser
            </strong>
            <span className="text-xs text-muted-foreground">{host}</span>
            <span
              role="status"
              data-testid="browser-stream-status"
              className="text-xs"
            >
              {phase} · {controlling ? "You have control" : "Watching"}
              {latency !== null && controlling ? ` · ${latency} ms` : ""}
            </span>
            <div className="ml-auto flex gap-2">
              {phase === "Disconnected" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void connect(false)}
                >
                  Reconnect
                </Button>
              )}
              {controlling ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void release()}
                >
                  Release control · Esc
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void connect(true)}
                >
                  {needsLogin ? "Sign in" : "Take control"}
                </Button>
              )}
              {needsLogin && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void release(true)}
                >
                  Continue task
                </Button>
              )}
              {
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (controlling)
                      void release().then(() => {
                        setDismissed(true);
                        onOpenChange(false);
                      });
                    else {
                      setDismissed(true);
                      onOpenChange(false);
                    }
                  }}
                >
                  Close browser view
                </Button>
              }
            </div>
          </div>
          <form
            className="flex items-center gap-2 border-b px-3 py-2"
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
              disabled={!controlling}
              className="h-8 border-0 bg-transparent text-xs"
            />
            {controlling && (
              <Button size="sm" variant="ghost" type="submit">
                Go
              </Button>
            )}
          </form>
          {error && (
            <div className="p-3">
              <ErrorNote>{error}</ErrorNote>
            </div>
          )}
          <div
            className="relative min-h-0 flex-1 bg-neutral-950"
            aria-busy={!hasFrame}
          >
            <canvas
              ref={canvas}
              width={1280}
              height={800}
              tabIndex={0}
              aria-label="Remote browser"
              data-ready={hasFrame}
              className="block h-full w-full touch-none object-contain outline-none focus:ring-2 focus:ring-primary"
              onPointerDown={(event) => {
                if (controlling) {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  pointer(event, "mousePressed");
                }
              }}
              onPointerUp={(event) => pointer(event, "mouseReleased")}
              onPointerMove={(event) => {
                if (controlling && Date.now() - hoverAt.current > 35) {
                  hoverAt.current = Date.now();
                  pointer(event, "mouseMoved");
                }
              }}
              onContextMenu={(event) => event.preventDefault()}
              onKeyDown={(event) => {
                if (!controlling) return;
                event.preventDefault();
                event.stopPropagation();
                if (event.key === "Escape") {
                  void release();
                  return;
                }
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
                if (controlling) {
                  event.preventDefault();
                  input({
                    type: "text",
                    text: event.clipboardData.getData("text/plain"),
                  });
                }
              }}
            />
            {!hasFrame && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-white">
                {phase === "Disconnected"
                  ? "Stream disconnected. Reconnect to view the browser."
                  : "Connecting to the browser…"}
              </div>
            )}
          </div>
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {controlling
              ? "Click and type directly. Paste works here. Esc releases control without sending a message."
              : "Live, read-only view. Watching and closing this view do not send a message."}
          </p>
        </section>,
        document.body,
      )}
      {activity}
    </>
  );
}
