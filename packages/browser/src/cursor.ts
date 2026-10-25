import type { BrowserContext, Page } from "patchright";

/**
 * A cosmetic pointer drawn into agent-controlled pages, adapted from Autonoma's
 * cursor overlay. CDP input has no visible cursor, so live frames and step
 * screenshots otherwise show unexplained page changes. The overlay never moves
 * the real pointer and is skipped on account sign-in pages.
 */
const CURSOR_ID = "__harness-cursor";
const RING_ID = "__harness-cursor-ring";
const GLIDE_MS = 250;
const RING_VISIBLE_MS = 2500;

// A string, not a function: bundlers can inject helpers that do not exist in
// the page when a function is serialized.
const source = `
(() => {
  if (/(^|\\.)accounts\\.google\\.com$/.test(location.hostname)) return;
  var SVG_NS = "http://www.w3.org/2000/svg";
  var mounted = null;
  var build = () => {
    if (mounted && mounted.isConnected) return;
    var root = document.body || document.documentElement;
    if (!root || document.getElementById(${JSON.stringify(CURSOR_ID)})) return;
    var ring = document.createElement("div");
    ring.id = ${JSON.stringify(RING_ID)};
    Object.assign(ring.style, {
      position: "fixed", left: "0", top: "0", width: "34px", height: "34px",
      marginLeft: "-17px", marginTop: "-17px", borderRadius: "50%",
      border: "3px solid rgba(234, 88, 12, 0.95)",
      boxShadow: "0 0 0 1px rgba(0, 0, 0, 0.45)", opacity: "0",
      pointerEvents: "none", zIndex: "2147483646", transition: "opacity 120ms linear",
    });
    var cursor = document.createElement("div");
    cursor.id = ${JSON.stringify(CURSOR_ID)};
    Object.assign(cursor.style, {
      position: "fixed", left: "0", top: "0", width: "15px", height: "24px",
      pointerEvents: "none", zIndex: "2147483647",
      transform: "translate3d(-100px, -100px, 0)",
      transition: "transform ${GLIDE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)",
    });
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "15");
    svg.setAttribute("height", "24");
    svg.setAttribute("viewBox", "0 0 12 19");
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M0 0 L0 16.5 L4.2 12.4 L6.6 18 L9 17 L6.6 11.4 L11.4 11.4 Z");
    path.setAttribute("fill", "#ffffff");
    path.setAttribute("stroke", "#000000");
    path.setAttribute("stroke-width", "1");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    cursor.appendChild(svg);
    root.appendChild(ring);
    root.appendChild(cursor);
    mounted = cursor;
  };
  build();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  new MutationObserver(build).observe(document, { childList: true, subtree: true });
})();
`;

export async function installCursor(context: BrowserContext) {
  await context.addInitScript({ content: source });
}

/** Glide to the point, then show a click ring. Never fails the browser action. */
export async function showClick(page: Page, point: { x: number; y: number }) {
  const moved = await page
    .evaluate(
      ({ cursorId, ringId, x, y, visibleMs }) => {
        const cursor = document.getElementById(cursorId);
        const ring = document.getElementById(ringId);
        if (!cursor) return false;
        cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        if (ring) {
          const pending = Number(ring.dataset.hideTimer ?? "");
          if (pending > 0) window.clearTimeout(pending);
          ring.style.transform = `translate3d(${x}px, ${y}px, 0)`;
          ring.style.opacity = "1";
          ring.dataset.hideTimer = String(
            window.setTimeout(() => {
              ring.style.opacity = "0";
              delete ring.dataset.hideTimer;
            }, visibleMs),
          );
        }
        return true;
      },
      {
        cursorId: CURSOR_ID,
        ringId: RING_ID,
        x: point.x,
        y: point.y,
        visibleMs: RING_VISIBLE_MS,
      },
    )
    .catch(() => false);
  if (moved) await page.waitForTimeout(GLIDE_MS);
}
