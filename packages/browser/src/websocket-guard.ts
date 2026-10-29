import type { BrowserContext, Page } from "patchright";

/**
 * Refuses WebSockets to private or loopback addresses and local names, in every
 * page and frame, before site scripts run. It subclasses the browser's own
 * WebSocket, so allowed sockets behave natively. Playwright's routeWebSocket
 * replaces the class with a stand-in for every socket, even unmatched ones,
 * and Discord's web app crashes under it.
 *
 * Limits: a public name that resolves to a private address isn't caught (the
 * HTTP filter checks DNS; WebSockets need a network boundary for that), and
 * sockets opened from web workers aren't wrapped.
 */
// A string, not a function: bundlers can inject helpers that do not exist in
// the page when a function is serialized.
export const websocketGuard = `
(() => {
  var Native = window.WebSocket;
  if (!Native || Native.__harnessGuarded) return;
  var privateV4 = (host) => {
    var parts = host.split(".").map(Number);
    var a = parts[0], b = parts[1];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      a >= 224 || (a === 100 && b >= 64 && b <= 127);
  };
  var blocked = (value) => {
    var url;
    try { url = new URL(String(value), location.href); } catch (error) { return true; }
    // Browsers also accept http(s) and relative URLs and turn them into ws(s).
    if (!/^(wss?|https?):$/.test(url.protocol) || url.username || url.password) return true;
    var host = url.hostname.replace(/^\\[|\\]$/g, "").toLowerCase();
    if (/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(host)) return privateV4(host);
    if (host.includes(":"))
      return host === "::1" || host === "::" || /^(fc|fd|fe[89ab])/.test(host) ||
        host.startsWith("::ffff:") || !/^[23]/.test(host);
    return !host.includes(".") || host === "localhost" ||
      /\\.(localhost|local|internal|lan|home\\.arpa)$/.test(host);
  };
  class HarnessWebSocket extends Native {
    constructor(url, protocols) {
      if (blocked(url))
        throw new DOMException("Private-network WebSockets are blocked in this browser.", "SecurityError");
      if (protocols === undefined) super(url);
      else super(url, protocols);
    }
  }
  Object.defineProperty(HarnessWebSocket, "__harnessGuarded", { value: true });
  Object.defineProperty(HarnessWebSocket, "name", { value: "WebSocket" });
  window.WebSocket = HarnessWebSocket;
})();
`;
export async function guardWebSockets(target: Page | BrowserContext) {
  await target.addInitScript({ content: websocketGuard });
}
