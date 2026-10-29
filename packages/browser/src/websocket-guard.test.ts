import assert from "node:assert/strict";
import { test } from "node:test";
import { websocketGuard } from "./websocket-guard";

/** Runs the page script against a stand-in browser WebSocket. */
function guarded(page = "https://discord.com/login") {
  class NativeWebSocket {
    url: string;
    constructor(url: string) {
      this.url = url;
    }
  }
  const window = { WebSocket: NativeWebSocket as unknown };
  new Function("window", "location", websocketGuard)(window, { href: page });
  return window.WebSocket as new (
    url: string,
  ) => { url: string };
}

test("the page guard refuses private WebSockets and leaves public ones native", () => {
  const Socket = guarded();
  for (const url of [
    "wss://gateway.discord.gg/?v=9&encoding=json",
    "wss://8.8.8.8/socket",
    "https://example.com/socket",
    "/relative",
  ])
    assert.doesNotThrow(() => new Socket(url), url);
  for (const url of [
    "ws://127.0.0.1:3000",
    "ws://localhost:3000",
    "ws://jetdad:3000",
    "ws://192.168.1.20/",
    "ws://10.0.0.5/",
    "ws://100.64.0.2/",
    "ws://169.254.169.254/",
    "wss://[::1]/",
    "wss://[fd7a:115c:a1e0::2]/",
    "ws://printer.local/",
    "ws://user:pass@example.com/",
    "ftp://example.com/",
  ])
    assert.throws(() => new Socket(url), /blocked/, url);
  // Guarding twice keeps one wrapper.
  const window = { WebSocket: Socket as unknown };
  new Function("window", "location", websocketGuard)(window, {
    href: "https://x.test/",
  });
  assert.equal(window.WebSocket, Socket);
});
