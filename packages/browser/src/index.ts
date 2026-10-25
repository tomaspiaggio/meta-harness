import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  type BrowserAssignment,
  type BrowserIdentity,
  browserLoginState,
} from "@harness/core/browser";
import type { Browser, BrowserContext, Page } from "patchright";
import {
  browserPeer,
  decryptBytes,
  encryptBytes,
  openState,
  sealState,
} from "./crypto";

import {
  type BrowserBackend,
  browserBackend,
  chromeConnectionInstructions,
  personalChromeEndpoint,
} from "./personal-chrome";

export { browserBackend } from "./personal-chrome";

export function managedBrowserExecutable(): string | undefined {
  if (process.env.HARNESS_BROWSER_EXECUTABLE)
    return process.env.HARNESS_BROWSER_EXECUTABLE;
  if (process.platform === "linux" && managedBrowserChannel() === "chromium")
    return ["/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
}

const installedChrome: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  linux: "/opt/google/chrome/chrome",
};
/**
 * Google rejects sign-in from Chrome for Testing and from a user agent that
 * announces HeadlessChrome. An installed stable Chrome is preferred; an explicit
 * executable or HARNESS_BROWSER_CHANNEL=chromium keeps the bundled build.
 */
export function managedBrowserChannel(): "chrome" | "chromium" {
  const requested = process.env.HARNESS_BROWSER_CHANNEL;
  if (requested === "chrome" || requested === "chromium") return requested;
  if (process.env.HARNESS_BROWSER_EXECUTABLE) return "chromium";
  const chrome = installedChrome[process.platform];
  return chrome && existsSync(chrome) ? "chrome" : "chromium";
}
/** Remove the headless marker; the rest of the user agent stays truthful. */
export function visibleUserAgent(value: string): string {
  return value.replace(/HeadlessChrome\//, "Chrome/");
}

type Context = {
  attached: boolean;
  context: BrowserContext;
  page: Page;
  lastUsed: number;
  generation: number;
  peer?: ReturnType<typeof browserPeer>;
  userKey?: string;
  display?: Awaited<ReturnType<typeof browserDisplay>>;
  downloads?: BrowserDownloads;
  listeners: Set<(page: Page) => void>;
  notices?: NativeNotice[];
  noticeListeners?: Set<(value: NativeNotice) => void>;
};
function privateAddress(address: string): boolean {
  if (address.includes(":"))
    return (
      address === "::1" ||
      address === "::" ||
      /^(fc|fd|fe[89ab])/i.test(address) ||
      address.toLowerCase().startsWith("::ffff:") ||
      !/^[23]/.test(address)
    );
  const [a, b] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
export async function validateBrowserUrl(
  value: string,
  allowTestLoopback = false,
  kind: "navigation" | "resource" = "navigation",
): Promise<string> {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    value.length > (kind === "resource" ? 65536 : 4000)
  )
    throw new Error(
      "Only HTTP(S) browser destinations without embedded credentials are permitted.",
    );
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), {
    all: true,
  });
  if (
    !addresses.length ||
    (!allowTestLoopback &&
      addresses.some((record) => privateAddress(record.address)))
  )
    throw new Error(
      "Private-network browser destinations require a separately isolated resource binding.",
    );
  return url.toString();
}
export function safeBrowserUrl(value: string): string {
  try {
    const url = new URL(value);
    // about:blank and other opaque URLs have a "null" origin.
    if (!["http:", "https:"].includes(url.protocol)) return "about:blank";
    return `${url.origin}${url.pathname}`;
  } catch {
    return "about:blank";
  }
}

import { redactFormValues } from "./accessibility";
import { performAction, pointerActions } from "./actions";
import { installCursor } from "./cursor";
import { browserDisplay } from "./display";
import { BrowserDownloads } from "./downloads";
import { ExtensionRelay, extensionPairing } from "./extension-relay";
import { type NativeNotice, tameNativeUi } from "./native";
import { readGoogleSheet } from "./sheets";

export class BrowserActionNotStarted extends Error {}

export class BrowserHost {
  private contexts = new Map<string, Context>();
  private creating = new Map<
    string,
    { generation: number; promise: Promise<Context> }
  >();
  private attachedBrowser?: Browser;
  private userAgents = new Map<string, string>();
  private relay?: ExtensionRelay;
  readonly backend: BrowserBackend;
  constructor(
    private root: string,
    private options: {
      headless?: boolean;
      allowTestLoopback?: boolean;
      idleMs?: number;
      backend?: BrowserBackend;
      chromeDirectory?: string;
    } = {},
  ) {
    this.backend = options.backend ?? browserBackend();
  }
  async initialize() {
    if (this.backend === "extension") {
      const path =
        process.env.HARNESS_BROWSER_EXTENSION_CONFIG ??
        join(dirname(this.root), "browser-extension.json");
      this.relay = new ExtensionRelay(await extensionPairing(path), path);
      await this.relay.start();
    }
  }
  extensionConnected() {
    return this.relay?.connected() ?? false;
  }
  static async available(): Promise<boolean> {
    if (["personal-chrome", "extension"].includes(browserBackend()))
      return true;
    if (managedBrowserChannel() === "chrome") return true;
    const executable = managedBrowserExecutable();
    if (executable) return existsSync(executable);
    const cache = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (!cache || !["darwin", "linux"].includes(process.platform)) return false;
    // Read the pinned binary manifest without loading the browser driver at idle.
    const require = createRequire(import.meta.url);
    const dependency = createRequire(
      require.resolve("patchright/package.json"),
    );
    const manifest = JSON.parse(
      await readFile(
        join(
          dirname(dependency.resolve("patchright-core/package.json")),
          "browsers.json",
        ),
        "utf8",
      ),
    ) as { browsers: { name: string; revision: string }[] };
    const browser = manifest.browsers.find((item) => item.name === "chromium");
    return (
      !!browser &&
      existsSync(
        join(cache, `chromium-${browser.revision}`, "INSTALLATION_COMPLETE"),
      )
    );
  }
  active() {
    const active = new Map(
      [...this.contexts].map(([id, context]) => [
        id,
        { id, generation: context.generation },
      ]),
    );
    for (const [id, pending] of this.creating)
      if (!active.has(id))
        active.set(id, { id, generation: pending.generation });
    return [...active.values()];
  }
  async synchronize(identities: Pick<BrowserIdentity, "id" | "generation">[]) {
    const allowed = new Map(
      identities.map((identity) => [identity.id, identity.generation]),
    );
    for (const [id, context] of this.contexts) {
      const generation = allowed.get(id);
      if (
        generation === undefined ||
        Date.now() - context.lastUsed > (this.options.idleMs ?? 120000)
      ) {
        await this.release(context);
        this.contexts.delete(id);
      } else context.generation = generation;
    }
    // An approved personal Chrome transport survives idle tab cleanup.
    // No agent or additional browser process is kept alive.
  }
  async forget(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id))
      throw new Error("Invalid browser identity");
    const context = this.contexts.get(id);
    if (context) await this.release(context);
    this.contexts.delete(id);
    await this.disconnectIfIdle();
    const { rm } = await import("node:fs/promises");
    await rm(join(this.root, id), { recursive: true, force: true });
    await rm(join(this.root, `${id}-chrome`), { recursive: true, force: true });
  }
  async close() {
    await Promise.allSettled(
      [...this.creating.values()].map((pending) => pending.promise),
    );
    for (const context of this.contexts.values()) await this.release(context);
    this.contexts.clear();
    await this.disconnectIfIdle();
    await this.relay?.close();
    this.relay = undefined;
  }
  private async release(context: Context) {
    // Never close a user's default browser context. We own only this tab.
    if (context.attached) await context.page.close().catch(() => {});
    else {
      try {
        await context.context.close();
      } finally {
        await context.display?.close();
      }
    }
  }
  private async disconnectIfIdle() {
    if (!this.contexts.size && this.attachedBrowser) {
      const browser = this.attachedBrowser;
      this.attachedBrowser = undefined;
      // connectOverCDP close disconnects the client; it does not exit Chrome.
      await browser.close().catch(() => {});
    }
  }
  private async attach(identity: BrowserIdentity): Promise<Context> {
    const { chromium } = await import("patchright");
    if (!this.attachedBrowser?.isConnected()) {
      this.attachedBrowser = undefined;
      try {
        this.attachedBrowser = await chromium.connectOverCDP(
          this.backend === "extension"
            ? (this.relay?.endpoint() ??
                (() => {
                  throw new Error(
                    "Browser extension relay is not initialized.",
                  );
                })())
            : await personalChromeEndpoint(this.options.chromeDirectory),
          {
            timeout: 20000,
            noDefaults: true,
            ...(this.backend === "extension"
              ? { headers: this.relay?.headers() }
              : {}),
          },
        );
      } catch (error) {
        if (this.backend === "extension")
          throw new Error(
            error instanceof Error
              ? error.message
              : "Browser extension connection failed.",
          );
        throw new Error(chromeConnectionInstructions);
      }
    }
    const browser = this.attachedBrowser;
    const context = browser.contexts()[0];
    if (!context) throw new Error(chromeConnectionInstructions);
    const session = await browser.newBrowserCDPSession();
    let targetId: string | undefined;
    try {
      ({ targetId } = await session.send("Target.createTarget", {
        url: "about:blank",
        background: true,
      }));
      let page: Page | undefined;
      // Match the exact target we created; never pick an existing user tab.
      for (let attempt = 0; attempt < 20 && !page; attempt++) {
        for (const candidate of context.pages()) {
          const cdp = await context.newCDPSession(candidate);
          try {
            const { targetInfo } = await cdp.send("Target.getTargetInfo");
            if (targetInfo.targetId === targetId) {
              page = candidate;
              break;
            }
          } finally {
            await cdp.detach();
          }
        }
        if (!page) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!page)
        throw new Error("Chrome did not create the harness background tab.");
      await page.setViewportSize({ width: 1280, height: 800 });
      page.setDefaultTimeout(10000);
      // Network restrictions apply only to the owned tab, not personal tabs.
      await this.restrictNetwork(page);
      const result: Context = {
        attached: true,
        context,
        page,
        lastUsed: Date.now(),
        generation: identity.generation,
        listeners: new Set(),
      };
      this.contexts.set(identity.id, result);
      return result;
    } catch (error) {
      if (targetId)
        await session.send("Target.closeTarget", { targetId }).catch(() => {});
      await this.disconnectIfIdle();
      throw error;
    } finally {
      await session.detach().catch(() => {});
    }
  }
  private async restrictNetwork(target: Page | BrowserContext) {
    await target.route("**/*", async (route) => {
      try {
        await validateBrowserUrl(
          route.request().url(),
          this.options.allowTestLoopback,
          "resource",
        );
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    await target.routeWebSocket("**/*", async (route) => {
      try {
        await validateBrowserUrl(
          route.url().replace(/^ws/, "http"),
          this.options.allowTestLoopback,
          "resource",
        );
        route.connectToServer();
      } catch {
        route.close();
      }
    });
  }
  private async get(assignment: BrowserAssignment): Promise<Context> {
    const pending = this.creating.get(assignment.identity.id);
    if (pending) return pending.promise;
    const promise = this.getOrCreate(assignment);
    this.creating.set(assignment.identity.id, {
      generation: assignment.identity.generation,
      promise,
    });
    try {
      return await promise;
    } finally {
      this.creating.delete(assignment.identity.id);
    }
  }
  private async getOrCreate(assignment: BrowserAssignment): Promise<Context> {
    const { identity } = assignment;
    const existing = this.contexts.get(identity.id);
    if (
      existing &&
      !existing.page.isClosed() &&
      (!existing.attached || this.attachedBrowser?.isConnected())
    ) {
      existing.generation = identity.generation;
      existing.lastUsed = Date.now();
      return existing;
    }
    this.contexts.delete(identity.id);
    if (this.backend === "personal-chrome" || this.backend === "extension")
      return this.attach(identity);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(identity.id))
      throw new Error("Invalid browser identity path.");
    const { chromium } = await import("patchright");
    const channel = managedBrowserChannel();
    // Chrome must not open a profile written by the newer bundled build.
    const path = join(
      this.root,
      channel === "chrome" ? `${identity.id}-chrome` : identity.id,
    );
    await mkdir(path, { recursive: true, mode: 0o700 });
    if ((await lstat(path)).isSymbolicLink())
      throw new Error("Browser profile cannot be a symlink.");
    const display =
      process.platform === "linux" &&
      process.env.HARNESS_BROWSER_VIRTUAL_DISPLAY === "1"
        ? await browserDisplay()
        : undefined;
    const headless = display ? false : (this.options.headless ?? true);
    const launch = (userAgent?: string) =>
      chromium.launchPersistentContext(path, {
        channel,
        headless,
        ...(display ? { env: { ...process.env, ...display.env } } : {}),
        ...(channel === "chromium"
          ? { executablePath: managedBrowserExecutable() }
          : {}),
        ...(userAgent ? { userAgent } : {}),
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        acceptDownloads: true,
        serviceWorkers: "block",
      });
    // The cached user agent survives worker restarts, so only the very first
    // launch on a host needs the extra relaunch below.
    const agents = join(this.root, "user-agents.json");
    const agentKey = `${channel}:${managedBrowserExecutable() ?? ""}`;
    if (headless && !this.userAgents.has(channel))
      try {
        const cached = JSON.parse(await readFile(agents, "utf8"))[agentKey];
        if (typeof cached === "string" && cached.startsWith("Mozilla/"))
          this.userAgents.set(channel, cached);
      } catch {}
    let context = await launch(
      headless ? this.userAgents.get(channel) : undefined,
    ).catch(async (error) => {
      await display?.close();
      throw error;
    });
    if (headless) {
      // The real version is only known after launching. Browser.getVersion
      // reports the default (HeadlessChrome) agent even under an override, so
      // relaunch only when no agent is known yet or Chrome has updated.
      const session = await context.newCDPSession(
        context.pages()[0] ?? (await context.newPage()),
      );
      const wanted = visibleUserAgent(
        (await session.send("Browser.getVersion")).userAgent,
      );
      await session.detach().catch(() => {});
      if (this.userAgents.get(channel) !== wanted) {
        this.userAgents.set(channel, wanted);
        await writeFile(agents, JSON.stringify({ [agentKey]: wanted }), {
          mode: 0o600,
        }).catch(() => {});
        await context.close();
        context = await launch(wanted).catch(async (error) => {
          await display?.close();
          throw error;
        });
      }
    }
    try {
      context.setDefaultTimeout(10000);
      await this.restrictNetwork(context);
      await installCursor(context);
      if (identity.stateCipher) {
        const state = openState<{
          cookies: Parameters<BrowserContext["addCookies"]>[0];
          origins: {
            origin: string;
            localStorage: { name: string; value: string }[];
          }[];
        }>(assignment.stateKey, identity.stateCipher);
        await context.addCookies(state.cookies);
        await context.addInitScript((origins) => {
          const state = origins.find(
            (entry) =>
              entry.origin ===
              (globalThis as unknown as { location: { origin: string } })
                .location.origin,
          );
          if (state)
            for (const item of state.localStorage)
              localStorage.setItem(item.name, item.value);
        }, state.origins);
      }
      const downloads = new BrowserDownloads(join(path, "harness-downloads"));
      const notices: NativeNotice[] = [];
      const noticeListeners = new Set<(value: NativeNotice) => void>();
      const watch = (page: Page) => {
        page.on("download", (download) => {
          void downloads.receive(download).catch(() => {});
        });
        void tameNativeUi(page, (value) => {
          notices.push(value);
          notices.splice(0, Math.max(0, notices.length - 5));
          for (const listener of noticeListeners) listener(value);
        });
      };
      context.pages().forEach(watch);
      context.on("page", watch);
      const page = context.pages()[0] ?? (await context.newPage());
      const result: Context = {
        attached: false,
        display,
        downloads,
        context,
        page,
        lastUsed: Date.now(),
        generation: identity.generation,
        listeners: new Set(),
        notices,
        noticeListeners,
      };
      // The newest open tab is the active one, as in a person's browser.
      const activate = (next: Page) => {
        result.page = next;
        for (const listener of result.listeners) listener(next);
      };
      context.on("page", (opened) => {
        activate(opened);
        opened.on("close", () => {
          const remaining = context.pages().filter((item) => !item.isClosed());
          const last = remaining.at(-1);
          if (result.page === opened && last) activate(last);
        });
      });
      this.contexts.set(identity.id, result);
      return result;
    } catch (error) {
      await context.close().catch(() => {});
      await display?.close();
      throw error;
    }
  }
  async liveNavigate(page: Page, url: string) {
    await page.goto(
      await validateBrowserUrl(url, this.options.allowTestLoopback),
      { waitUntil: "domcontentloaded", timeout: 20000 },
    );
  }
  async livePage(assignment: BrowserAssignment) {
    if (this.backend !== "managed")
      throw new Error(
        "Live view requires the managed Patchright browser. Upgrade this worker and select managed mode.",
      );
    const context = await this.get(assignment);
    context.lastUsed = Date.now();
    // A profile reopened after its idle timeout starts blank. Return to the
    // page that asked for sign-in so the viewer sees the real login screen.
    const last = assignment.identity.lastUrl;
    const resume =
      last && browserLoginState(last) === "rejected"
        ? "https://accounts.google.com/"
        : last;
    if (context.page.url() === "about:blank" && resume)
      await this.liveNavigate(context.page, resume).catch(() => {});
    return {
      current: () => context.page,
      onPage: (listener: (page: Page) => void) => {
        context.listeners.add(listener);
        return () => context.listeners.delete(listener);
      },
      onNotice: (listener: (value: NativeNotice) => void) => {
        context.noticeListeners?.add(listener);
        return () => context.noticeListeners?.delete(listener);
      },
      downloads: context.downloads,
      touch: () => {
        context.lastUsed = Date.now();
      },
    };
  }
  async execute(
    assignment: BrowserAssignment,
  ): Promise<{ result: Record<string, unknown>; stateCipher?: string }> {
    const { command, identity } = assignment;
    let context: Context;
    try {
      context = await this.get(assignment);
    } catch (error) {
      throw new BrowserActionNotStarted(
        error instanceof Error
          ? error.message
          : "Browser connection failed before execution.",
      );
    }
    const args = JSON.parse(command.arguments) as Record<string, unknown>;
    const page = context.page;
    const actionStarted = Date.now();
    context.lastUsed = Date.now();
    if (command.action === "manual") {
      if (
        identity.mode !== "human" ||
        !identity.userPublicKey ||
        (identity.expiresAt ?? 0) <= Date.now()
      )
        throw new Error("Manual control lease expired.");
      if (context.userKey !== identity.userPublicKey) {
        context.peer = browserPeer(identity.userPublicKey);
        context.userKey = identity.userPublicKey;
      }
      const peer = context.peer;
      if (!peer) throw new Error("Browser encryption session unavailable.");
      if (args.input) {
        const input = JSON.parse(
          Buffer.from(
            decryptBytes(
              peer.key,
              args.input as { iv: string; ciphertext: string },
            ),
          ).toString("utf8"),
        ) as {
          type: string;
          x?: number;
          y?: number;
          text?: string;
          key?: string;
          dy?: number;
        };
        if (
          input.type === "click" &&
          Number.isFinite(input.x) &&
          Number.isFinite(input.y) &&
          (input.x ?? -1) >= 0 &&
          (input.x ?? 1280) < 1280 &&
          (input.y ?? -1) >= 0 &&
          (input.y ?? 800) < 800
        )
          await page.mouse.click(input.x ?? 0, input.y ?? 0);
        else if (
          input.type === "text" &&
          typeof input.text === "string" &&
          input.text.length <= 4000
        )
          await page.keyboard.insertText(input.text);
        else if (
          input.type === "key" &&
          [
            "Enter",
            "Tab",
            "Backspace",
            "Escape",
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
          ].includes(input.key ?? "")
        )
          await page.keyboard.press(input.key ?? "");
        else if (input.type === "scroll" && Number.isFinite(input.dy))
          await page.mouse.wheel(
            0,
            Math.max(-2000, Math.min(2000, input.dy ?? 0)),
          );
        else if (
          input.type === "navigate" &&
          typeof (input as { url?: unknown }).url === "string"
        )
          await page.goto(
            await validateBrowserUrl(
              String((input as { url?: string }).url),
              this.options.allowTestLoopback,
            ),
            { waitUntil: "domcontentloaded", timeout: 20000 },
          );
        else throw new Error("Unsupported manual browser input.");
      }
      const bytes = await page.screenshot({ type: "jpeg", quality: 65 });
      return {
        result: {
          frame: {
            ...encryptBytes(peer.key, bytes),
            publicKey: peer.publicKey,
          },
          width: 1280,
          height: 800,
        },
      };
    }
    context.peer = undefined;
    context.userKey = undefined;
    if (identity.mode !== "agent")
      throw new Error(
        "Browser input and model capture are paused while the user controls it.",
      );
    let targetLabel = "";
    let point: { x: number; y: number } | undefined;
    let snapshot: string | undefined;
    let dropdown: unknown;
    if (command.action === "navigate")
      await page.goto(
        await validateBrowserUrl(
          String(args.url),
          this.options.allowTestLoopback,
        ),
        { waitUntil: "domcontentloaded", timeout: 20000 },
      );
    else if (pointerActions.includes(command.action))
      ({
        targetLabel = "",
        point,
        snapshot,
        dropdown,
      } = await performAction(page, command.action, args));
    else if (
      !["screenshot", "read", "sheet_read", "status"].includes(command.action)
    )
      throw new Error("Unsupported browser action.");
    const result: Record<string, unknown> = {
      url: safeBrowserUrl(page.url()),
      title: await page.title(),
      ...(targetLabel ? { targetLabel } : {}),
      ...(point ? { point } : {}),
      ...(dropdown ? { dropdown } : {}),
      ...(context.notices?.some((notice) => notice.at >= actionStarted)
        ? {
            dialogs: context.notices
              .filter((notice) => notice.at >= actionStarted)
              .map(
                (notice) =>
                  `${notice.kind} ${notice.kind === "alert" ? "acknowledged" : "cancelled"}: ${notice.message}`,
              ),
          }
        : {}),
      ...(snapshot
        ? { snapshot: redactFormValues(snapshot).slice(0, 20000) }
        : {}),
    };
    const login = browserLoginState(page.url());
    if (login) {
      result.login = login;
      // The requested page, not the login wall, is where takeover resumes:
      // reopening it lets the site issue a fresh sign-in redirect.
      if (command.action === "navigate") result.resumeUrl = String(args.url);
      result.status = "needs_login";
      result.hint =
        login === "rejected"
          ? "Google rejected this browser. The requested source was not read. Human sign-in in a supported browser is required; do not weaken account security."
          : "Account sign-in is required. The requested source was not read. Request manual takeover and wait.";
    } else if (command.action === "sheet_read")
      Object.assign(
        result,
        await readGoogleSheet(page, args, this.options.allowTestLoopback),
      );
    else if (command.action === "read") {
      // SPA toolbars can appear before their data. Honor the page's own loading
      // marker, with a bounded wait so a stuck site still returns an honest read.
      result.loading = !(await page
        .waitForFunction(
          () => !document.querySelector('[aria-busy="true"]'),
          undefined,
          { timeout: 5000 },
        )
        .then(
          () => true,
          () => false,
        ));
      const content = page
        .locator(typeof args.selector === "string" ? args.selector : "body")
        .first();
      result.text = (await content.innerText()).slice(0, 16000);
      result.accessibility = redactFormValues(
        await content.ariaSnapshot({ mode: "ai" }),
      ).slice(0, 16000);
      if (result.loading)
        result.hint =
          "The page still reports loading. This is a partial snapshot; read again before concluding that records or events are absent.";
      if (/^https:\/\/docs\.google\.com\/spreadsheets\/d\//.test(page.url()))
        result.hint =
          "Google Sheets cells may be canvas-rendered. Use sheet_read with the current gid and a bounded row range to read actual cell values. A successful page open alone does not verify cell contents.";
    }
    // History thumbnails belong to agent actions only; login pages and all human
    // frames stay out of the model and persisted activity history.
    if (!login)
      result.image = (
        await page.screenshot({ type: "jpeg", quality: 65 })
      ).toString("base64");
    return {
      result,
      ...(context.attached
        ? {}
        : {
            stateCipher: sealState(
              assignment.stateKey,
              await context.context.storageState(),
            ),
          }),
    };
  }
}
