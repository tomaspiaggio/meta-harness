import type { Locator, Page } from "patchright";
import { showClick } from "./cursor";
import { locate } from "./grounding";

export const VIEWPORT = { width: 1280, height: 800 };
type Point = { x: number; y: number };

/** Actions that move or type with real input events (quarita-style). */
export const pointerActions = [
  "click",
  "fill",
  "type",
  "press",
  "hover",
  "scroll",
  "select",
  "wait",
  "snapshot",
];

async function label(locator: Locator) {
  return locator
    .evaluate((element) =>
      (
        element.getAttribute("aria-label") ||
        element.getAttribute("placeholder") ||
        element.getAttribute("title") ||
        element.getAttribute("name") ||
        (element.tagName === "INPUT" ? "field" : element.textContent) ||
        "element"
      )
        .trim()
        .slice(0, 100),
    )
    .catch(() => "element");
}

/**
 * Resolve where to act, in order of preference: a ref from the snapshot, a CSS
 * selector, a plain-language description (visual grounding), or x/y read from
 * the latest screenshot. Screenshot pixels equal viewport coordinates.
 */
async function resolve(
  page: Page,
  args: Record<string, unknown>,
): Promise<{ point: Point; label: string; locator?: Locator } | null> {
  let locator: Locator | undefined;
  if (typeof args.ref === "string") {
    if (!/^[a-z]?\d{1,6}$/.test(args.ref))
      throw new Error("Use a ref exactly as shown in the snapshot, like e12.");
    locator = page.locator(`aria-ref=${args.ref}`);
  } else if (typeof args.selector === "string" && args.selector)
    locator = page.locator(args.selector).first();
  if (locator) {
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    const box = await locator.boundingBox({ timeout: 5000 });
    if (!box)
      throw new Error(
        "That element is not visible. Take a snapshot or screenshot and retry.",
      );
    return {
      locator,
      label: await label(locator),
      point: {
        x: Math.round(box.x + box.width / 2),
        y: Math.round(box.y + box.height / 2),
      },
    };
  }
  if (typeof args.description === "string" && args.description.trim()) {
    const screenshot = await page.screenshot({ type: "jpeg", quality: 80 });
    return {
      label: args.description.trim().slice(0, 100),
      point: await locate(screenshot, args.description, VIEWPORT),
    };
  }
  if (Number.isFinite(args.x) && Number.isFinite(args.y)) {
    const point = {
      x: Math.round(Number(args.x)),
      y: Math.round(Number(args.y)),
    };
    if (
      point.x < 0 ||
      point.y < 0 ||
      point.x >= VIEWPORT.width ||
      point.y >= VIEWPORT.height
    )
      throw new Error(
        `Coordinates must be inside the ${VIEWPORT.width}x${VIEWPORT.height} screenshot.`,
      );
    return { point, label: `point (${point.x}, ${point.y})` };
  }
  return null;
}

async function settle(page: Page) {
  await page.waitForTimeout(300);
  await Promise.race([
    page.waitForLoadState("networkidle").catch(() => {}),
    page.waitForTimeout(3000),
  ]);
}

async function refuseSecretField(page: Page) {
  const secret = await page
    .evaluate(() => {
      const element = document.activeElement as HTMLInputElement | null;
      return (
        element?.type === "password" ||
        /password|one-time-code/i.test(element?.autocomplete ?? "")
      );
    })
    .catch(() => false);
  if (secret)
    throw new Error(
      "This field requires manual login. Call needs_login so the owner signs in privately.",
    );
}

export async function performAction(
  page: Page,
  action: string,
  args: Record<string, unknown>,
): Promise<{ targetLabel?: string; point?: Point; snapshot?: string }> {
  if (action === "snapshot")
    return {
      snapshot: await page.ariaSnapshot({ mode: "ai", timeout: 10000 }),
    };
  if (action === "wait") {
    await page.waitForTimeout(
      Math.max(0, Math.min(10, Number(args.seconds) || 1)) * 1000,
    );
    return {};
  }
  if (action === "press") {
    const key = String(args.key ?? "");
    if (
      !/^(?:(?:Control|Meta|Shift|Alt|ControlOrMeta)\+)*[A-Za-z0-9]{1,12}$/.test(
        key,
      )
    )
      throw new Error(
        "Use a key like Enter, Tab, Escape, ArrowDown or ControlOrMeta+A.",
      );
    await page.keyboard.press(key);
    await settle(page);
    return { targetLabel: key };
  }
  const target = await resolve(page, args);
  if (action === "scroll") {
    const point = target?.point ?? {
      x: VIEWPORT.width / 2,
      y: VIEWPORT.height / 2,
    };
    const amount = Math.max(1, Math.min(10, Number(args.amount) || 1));
    const delta =
      (args.direction === "up" ? -1 : 1) * (VIEWPORT.height / 2) * amount;
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, delta);
    await settle(page);
    return { targetLabel: target?.label };
  }
  if (action === "type" || action === "fill") {
    const text = String(args.text ?? "");
    if (!text || text.length > 4000)
      throw new Error("Provide text of at most 4000 characters.");
    if (target) {
      await showClick(page, target.point);
      await page.mouse.click(target.point.x, target.point.y);
    }
    await refuseSecretField(page);
    // fill keeps its old meaning (replace); type appends unless overwrite.
    if (action === "fill" || args.overwrite === true)
      await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type(text, { delay: 10 });
    if (args.submit === true) await page.keyboard.press("Enter");
    await settle(page);
    return {
      targetLabel: target?.label ?? "focused field",
      point: target?.point,
    };
  }
  if (!target)
    throw new Error(
      "Say where to act: description, x/y from the screenshot, ref from snapshot, or selector.",
    );
  if (action === "hover") {
    await showClick(page, target.point);
    await page.mouse.move(target.point.x, target.point.y);
  } else if (action === "select") {
    if (!target.locator)
      throw new Error(
        "select needs a ref or selector for the <select> element.",
      );
    await target.locator.selectOption(String(args.value ?? args.text ?? ""));
  } else {
    await showClick(page, target.point);
    await page.mouse.click(target.point.x, target.point.y, {
      button: args.button === "right" ? "right" : "left",
      clickCount: args.double === true ? 2 : 1,
    });
  }
  await settle(page);
  return { targetLabel: target.label, point: target.point };
}
