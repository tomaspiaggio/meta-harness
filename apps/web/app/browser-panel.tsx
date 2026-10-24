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
  onResume,
  open,
  onOpenChange,
  needsLogin = false,
  onSteps,
}: {
  workspaceId: string;
  sessionId: string;
  onResume: () => void;
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
  const [controlling, setControlling] = useState(false);
  const [typed, setTyped] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
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
  const visible = open || (needsLogin && !dismissed);
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

  async function connect(takeControl = false) {
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
          if (["downloads", "download"].includes(message.type) && streamKey) {
            const decrypted = await crypto.subtle.decrypt(
              { name: "AES-GCM", iv: decode(message.data.iv) },
              streamKey,
              decode(message.data.ciphertext),
            );
            const value = JSON.parse(new TextDecoder().decode(decrypted));
            if (message.type === "downloads") setDownloads(value);
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
  const inputRef = useRef<
    (value: Record<string, unknown>, settled?: (error?: string) => void) => void
  >(() => {});
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

  function input(
    value: Record<string, unknown>,
    settled?: (error?: string) => void,
  ) {
    const ws = socket.current;
    if (!controlling || phase !== "Live" || !key.current || !ws) {
      settled?.("Take control of the browser first.");
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
  const activity = !onSteps && steps.length > 0 && (
    <BrowserSteps steps={steps} />
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
          className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-card pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:inset-auto sm:bottom-4 sm:right-4 sm:top-20 sm:w-[calc(100vw-2rem)] sm:max-w-6xl sm:rounded-xl sm:border sm:pt-0 sm:pb-0 sm:shadow-2xl lg:left-[18rem] lg:w-auto"
        >
          <div className="flex flex-wrap items-center gap-2 border-b p-3">
            <strong className="text-sm" title={browser?.name}>
              Browser
            </strong>
            <span className="text-xs text-muted-foreground">{host}</span>
            <span
              role="status"
              data-testid="browser-stream-status"
              className="flex items-center gap-1.5 text-xs"
            >
              <span
                aria-hidden
                className={`size-2 rounded-full ${phase === "Live" ? "bg-success" : phase === "Disconnected" ? "bg-destructive" : "bg-warning"}`}
              />
              {phase} · {controlling ? "You have control" : "Watching"}
              {latency !== null && controlling ? ` · ${latency} ms` : ""}
            </span>
            <div className="ml-auto flex flex-wrap justify-end gap-2">
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
                  Give control back
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant={needsLogin ? "default" : "outline"}
                  disabled={busy}
                  onClick={() => void connect(true)}
                >
                  {needsLogin ? "1. Take control to sign in" : "Take control"}
                </Button>
              )}
              {needsLogin && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void release(true)}
                >
                  {controlling ? "2. Done — continue task" : "Continue task"}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                aria-label="Close browser view"
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
                <X />
                <span className="hidden sm:inline">Close</span>
              </Button>
            </div>
          </div>
          {needsLogin && (
            <div
              role="note"
              className="grid gap-1 border-b bg-warning/10 px-3 py-2 text-sm"
            >
              <strong className="font-medium">
                The agent is paused until you sign in
                {site ? ` to ${site}` : ""}.
              </strong>
              <span className="text-xs text-muted-foreground">
                {controlling
                  ? `Use “Sign in privately” below, or tap and type on the page.${/google/.test(site) ? " If Google asks for a passkey, tap “Try another way” and use your password." : ""} When you see the signed-in page, press Done — continue task.`
                  : "Press Take control, complete the login in this browser, then press Continue task. Your password goes only to the site; the agent and conversation never see it."}
              </span>
            </div>
          )}
          {controlling && downloads.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
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
            className="relative flex min-h-0 flex-1 items-center justify-center bg-muted sm:bg-neutral-950"
            aria-busy={!hasFrame}
          >
            <canvas
              ref={canvas}
              width={1280}
              height={800}
              tabIndex={0}
              aria-label="Remote browser"
              data-ready={hasFrame}
              className="block h-auto max-h-full w-auto max-w-full touch-none outline-none focus:ring-2 focus:ring-primary"
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
          {controlling && <SealedSignIn send={input} />}
          {controlling && (
            <form
              className="flex items-center gap-2 border-t px-3 py-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (typed) input({ type: "text", text: typed });
                setTyped("");
              }}
            >
              <Input
                aria-label="Type into the page"
                placeholder="Tap a field on the page, then type here"
                value={typed}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => setTyped(event.target.value)}
                className="h-9 min-w-0 flex-1 text-base sm:text-sm"
              />
              <Button size="sm" type="submit" variant="outline">
                Type
              </Button>
              {(["Backspace", "Tab", "Enter"] as const).map((key) => (
                <Button
                  key={key}
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    input({ type: "key", event: "down", key });
                    input({ type: "key", event: "up", key });
                  }}
                >
                  {key === "Backspace" ? "⌫" : key}
                </Button>
              ))}
            </form>
          )}
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {controlling
              ? "You control the browser and the agent is paused. Click and type on the page (paste works). Esc or Give control back returns it without sending a message."
              : "Live, read-only view of what the agent sees. Watching never interrupts the agent, and closing sends nothing."}
          </p>
        </section>,
        document.body,
      )}
      {activity}
    </>
  );
}

const sealedFields = [
  {
    field: "username",
    label: "Email or username",
    type: "email",
    autoComplete: "username",
  },
  {
    field: "password",
    label: "Password",
    type: "password",
    autoComplete: "current-password",
  },
  {
    field: "code",
    label: "Verification code",
    type: "text",
    autoComplete: "one-time-code",
  },
] as const;

/**
 * Phone-friendly sign-in. Each value is encrypted with this view's key, typed
 * into the matching field on the remote page and submitted. It is cleared here
 * and never stored, logged, or shown to the agent or the conversation.
 */
function SealedSignIn({
  send,
}: {
  send: (
    value: Record<string, unknown>,
    settled?: (error?: string) => void,
  ) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, string>>({});
  return (
    <details className="border-t px-3 py-2 text-sm" open>
      <summary className="cursor-pointer font-medium">
        Sign in privately
        <span className="ml-2 font-normal text-xs text-muted-foreground">
          Typed straight into the page; never saved or shown to the agent
        </span>
      </summary>
      <div className="mt-2 grid gap-2">
        {sealedFields.map((item) => (
          <form
            key={item.field}
            className="grid gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              const value = values[item.field] ?? "";
              if (!value) return;
              setStatus((current) => ({
                ...current,
                [item.field]: "Sending…",
              }));
              send({ type: "credential", field: item.field, value }, (error) =>
                setStatus((current) => ({
                  ...current,
                  [item.field]: error ?? "Entered and submitted ✓",
                })),
              );
              setValues((current) => ({ ...current, [item.field]: "" }));
            }}
          >
            <div className="flex gap-2">
              <Input
                aria-label={item.label}
                placeholder={item.label}
                type={item.type}
                autoComplete={item.autoComplete}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={values[item.field] ?? ""}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [item.field]: event.target.value,
                  }))
                }
                className="h-9 min-w-0 flex-1"
              />
              <Button size="sm" variant="outline" className="h-9">
                Enter
              </Button>
            </div>
            {status[item.field] && (
              <p className="text-xs text-muted-foreground" role="status">
                {status[item.field]}
              </p>
            )}
          </form>
        ))}
        <p className="text-xs text-muted-foreground">
          Go step by step: send the email, wait for the next screen, then the
          password, then any code. If a site asks for a passkey, tap “Try
          another way” on the page first.
        </p>
      </div>
    </details>
  );
}
