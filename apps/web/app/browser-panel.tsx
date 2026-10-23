"use client";
import type { BrowserIdentity } from "@harness/core/browser";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorNote, StatusBadge } from "./shell";

type BrowserView = Omit<BrowserIdentity, "stateCipher" | "userPublicKey">;
const decode = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
function encode(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 16384)
    text += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(text);
}
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
  const [browser, setBrowser] = useState<BrowserView | null>(null);
  const [backend, setBackend] = useState("managed");
  const [hostName, setHostName] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [frame, setFrame] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const keys = useRef<CryptoKeyPair | null>(null);
  const transport = useRef<CryptoKey | null>(null);
  const currentImage = useRef<string | null>(null);
  const sending = useRef(false);
  const inputQueue = useRef<Promise<void>>(Promise.resolve());
  async function request(body: Record<string, unknown>) {
    const response = await fetch("/api/browser", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, workspaceId, sessionId }),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error ?? "Browser request failed.");
    if (result.browser) setBrowser(result.browser);
    return result;
  }
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (document.hidden) return;
      try {
        const response = await fetch(
          `/api/browser?workspace=${encodeURIComponent(workspaceId)}`,
        );
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        if (!cancelled) {
          setBrowser(result.browser);
          setBackend(result.backend ?? "managed");
          setHostName(result.host?.name ?? result.host?.hostname ?? null);
        }
      } catch (error) {
        if (!cancelled)
          setError(
            error instanceof Error
              ? error.message
              : "Cannot reach browser service.",
          );
      }
    };
    void load();
    const timer = setInterval(() => void load(), open ? 3000 : 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [workspaceId, open]);
  useEffect(
    () => () => {
      if (currentImage.current) URL.revokeObjectURL(currentImage.current);
      keys.current = null;
      transport.current = null;
    },
    [],
  );
  const showFrame = async (value: {
    publicKey: string;
    iv: string;
    ciphertext: string;
  }) => {
    if (!keys.current) return;
    const peer = await crypto.subtle.importKey(
      "raw",
      decode(value.publicKey),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const key = await crypto.subtle.deriveKey(
      { name: "ECDH", public: peer },
      keys.current.privateKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const bytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(value.iv) },
      key,
      decode(value.ciphertext),
    );
    transport.current = key;
    const image = URL.createObjectURL(
      new Blob([bytes], { type: "image/jpeg" }),
    );
    if (currentImage.current) URL.revokeObjectURL(currentImage.current);
    currentImage.current = image;
    setFrame(image);
  };
  const executeManual = async (input?: Record<string, unknown>) => {
    if (!keys.current) return;
    sending.current = true;
    try {
      let encrypted: { iv: string; ciphertext: string } | undefined;
      if (input) {
        if (!transport.current)
          throw new Error("Wait for the encrypted browser view to connect.");
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const bytes = new TextEncoder().encode(JSON.stringify(input));
        encrypted = {
          iv: encode(iv),
          ciphertext: encode(
            new Uint8Array(
              await crypto.subtle.encrypt(
                { name: "AES-GCM", iv },
                transport.current,
                bytes,
              ),
            ),
          ),
        };
      }
      const result = await request({
        action: "manual",
        id: crypto.randomUUID(),
        ...(encrypted ? { input: encrypted } : {}),
      });
      if (result.frame) await showFrame(result.frame);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Browser input has no confirmed outcome. Check the page before repeating it.",
      );
    } finally {
      sending.current = false;
    }
  };
  const manual = (input?: Record<string, unknown>): Promise<void> => {
    if (!input && sending.current) return Promise.resolve();
    const operation = inputQueue.current.then(() => executeManual(input));
    inputQueue.current = operation.catch(() => {});
    return operation;
  };
  const manualRef = useRef(manual);
  manualRef.current = manual;
  useEffect(() => {
    if (!open || browser?.mode !== "human" || !keys.current) return;
    const timer = setInterval(() => {
      if (!document.hidden) void manualRef.current();
    }, 1000);
    return () => clearInterval(timer);
  }, [open, browser?.mode]);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Browser action failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  const takeover = () =>
    void perform(async () => {
      if (!crypto.subtle)
        throw new Error("Browser takeover requires HTTPS (or localhost).");
      const pair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        false,
        ["deriveKey"],
      );
      const publicKey = encode(
        new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
      );
      await request({
        action: "takeover",
        publicKey,
        force: browser?.mode === "human" && !keys.current,
      });
      keys.current = pair;
      transport.current = null;
      onOpenChange(true);
      await manualRef.current();
    });
  const returnControl = () =>
    void perform(async () => {
      onOpenChange(false);
      await inputQueue.current;
      await request({ action: "return", generation: browser?.generation });
      keys.current = null;
      transport.current = null;
      setText("");
      setFrame(null);
      if (currentImage.current) {
        URL.revokeObjectURL(currentImage.current);
        currentImage.current = null;
      }
      onResume();
    });
  let agentFrame: string | undefined;
  if (browser?.mode === "agent" && browser.frame) {
    try {
      agentFrame = (JSON.parse(browser.frame) as { image?: string }).image;
    } catch {
      /* Ignore a transient expired frame. */
    }
  }
  const attention =
    needsLogin || browser?.mode === "human" || browser?.mode === "paused";
  const showing = open || attention;
  if (!showing) return null;
  return (
    <section
      aria-label="Workspace browser"
      className="my-4 rounded-xl border bg-card p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">
          {["personal-chrome", "extension"].includes(backend)
            ? "Your Chrome"
            : attention
              ? "Browser sign-in"
              : "Browser"}
        </h3>
        {hostName && (
          <span className="text-xs text-muted-foreground">{hostName}</span>
        )}
        {browser && (
          <StatusBadge
            status={
              needsLogin && browser.mode !== "human"
                ? ["personal-chrome", "extension"].includes(backend)
                  ? "Needs your input"
                  : "Sign-in required"
                : browser.mode === "human"
                  ? "Manual control"
                  : browser.mode === "paused"
                    ? "Needs input"
                    : browser.status
            }
          />
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {browser?.lastUrl ??
            (["personal-chrome", "extension"].includes(backend)
              ? "Your Chrome · existing signed-in accounts"
              : "Managed browser · screenshots and manual takeover")}
        </span>
        {!attention && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Close browser view
          </Button>
        )}
        {browser?.mode !== "agent" && browser && (
          <Button size="sm" disabled={busy} onClick={returnControl}>
            Return to agent
          </Button>
        )}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!!showing && (
        <div className="mt-3 grid gap-3">
          {attention && !frame && (
            <p className="text-sm text-muted-foreground">
              {["personal-chrome", "extension"].includes(backend)
                ? "This browser runs on the host shown above. Sign in here if this host needs authentication; its accounts may differ from your other machines. Extension setup is available in Settings if it is disconnected."
                : "Sign in to the workspace browser below."}{" "}
              Return control when finished.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={attention ? "default" : "outline"}
              disabled={busy}
              onClick={takeover}
            >
              {browser?.mode === "human" && !keys.current
                ? "Continue sign-in in this tab"
                : ["personal-chrome", "extension"].includes(backend)
                  ? attention
                    ? "Sign in"
                    : "Take control"
                  : attention
                    ? "Sign in"
                    : "Take control"}
            </Button>
            {browser?.mode === "agent" && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const result = await request({ action: "screenshot" });
                    if (result.image)
                      setBrowser((previous) =>
                        previous
                          ? {
                              ...previous,
                              frame: JSON.stringify({
                                image: result.image,
                              }),
                            }
                          : previous,
                      );
                  })
                }
              >
                Refresh screenshot
              </Button>
            )}
          </div>
          {browser?.mode === "human" && (
            <p className="text-xs text-warning">
              Agent input and model capture are paused. This view and your input
              are encrypted for this tab. Return control when login is complete;
              disconnected views stay paused.
            </p>
          )}
          {(browser?.mode === "human" ? frame : agentFrame) && (
            <button
              type="button"
              aria-label="Click in remote browser"
              className="block w-full overflow-hidden rounded border bg-black"
              disabled={browser?.mode !== "human"}
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                void manual({
                  type: "click",
                  x:
                    event.detail === 0
                      ? 640
                      : Math.floor(
                          ((event.clientX - box.left) / box.width) * 1280,
                        ),
                  y:
                    event.detail === 0
                      ? 400
                      : Math.floor(
                          ((event.clientY - box.top) / box.height) * 800,
                        ),
                });
              }}
            >
              <Image
                unoptimized
                src={
                  browser?.mode === "human"
                    ? (frame ?? "")
                    : `data:image/jpeg;base64,${agentFrame}`
                }
                width={1280}
                height={800}
                alt="Current browser page"
                className="h-auto w-full"
              />
            </button>
          )}
          {browser?.mode === "human" && keys.current && (
            <>
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void manual({ type: "navigate", url });
                }}
              >
                <Input
                  type="url"
                  aria-label="Browser address"
                  placeholder="https://…"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
                <Button size="sm">Go</Button>
              </form>
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = text;
                  setText("");
                  void manual({ type: "text", text: value });
                }}
              >
                <Input
                  type="password"
                  autoComplete="off"
                  aria-label="Type into the focused browser field"
                  placeholder="Click a field above, then type here…"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  maxLength={4000}
                />
                <Button size="sm">Type</Button>
              </form>
              <div className="flex flex-wrap gap-2">
                {["Tab", "Enter", "Backspace", "Escape"].map((key) => (
                  <Button
                    key={key}
                    size="sm"
                    variant="outline"
                    onClick={() => void manual({ type: "key", key })}
                  >
                    {key}
                  </Button>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void manual({ type: "scroll", dy: -600 })}
                >
                  Scroll up
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void manual({ type: "scroll", dy: 600 })}
                >
                  Scroll down
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
