export {};

type Pairing = { port: number; token: string };
type Command = { id: number; method: string; params?: unknown[] };
let socket: WebSocket | undefined;
let paired = false;
let reconnecting = false;
const owned = new Set<number>();
const attached = new Set<number>();
const send = (message: unknown) => {
  if (socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(message));
};
const event = (method: string, params: unknown[]) => send({ method, params });

async function detach() {
  for (const tabId of attached)
    await chrome.debugger.detach({ tabId }).catch(() => {});
  attached.clear();
}
async function remember() {
  await chrome.storage.session.set({ owned: [...owned] });
}
function checkTab(value: unknown): number {
  const tabId = (value as { tabId?: number })?.tabId;
  if (typeof tabId !== "number" || !owned.has(tabId))
    throw new Error("This tab is outside the harness lease.");
  return tabId;
}
async function command(message: Command): Promise<unknown> {
  const params = message.params ?? [];
  if (message.method === "chrome.tabs.create") {
    if (owned.size >= 8)
      throw new Error("Close unused harness tabs before opening more.");
    const value = (params[0] ?? {}) as { url?: string };
    const url = value.url ?? "about:blank";
    if (
      url !== "about:blank" &&
      !["https:", "http:"].includes(new URL(url).protocol)
    )
      throw new Error("Unsupported browser destination.");
    const tab = await chrome.tabs.create({ url, active: false });
    if (tab.id === undefined) throw new Error("Browser did not create a tab.");
    owned.add(tab.id);
    await remember();
    return tab;
  }
  if (message.method === "chrome.tabs.remove") {
    const id = params[0];
    if (typeof id !== "number" || !owned.has(id))
      throw new Error("Cannot close a personal tab.");
    await chrome.tabs.remove(id);
    return {};
  }
  const tabId = checkTab(params[0]);
  const debuggee = params[0] as chrome.debugger.Debuggee;
  if (message.method === "chrome.debugger.attach") {
    if (!attached.has(tabId)) {
      await chrome.debugger.attach({ tabId }, "1.3");
      attached.add(tabId);
    }
    return {};
  }
  if (message.method === "chrome.debugger.detach") {
    await chrome.debugger.detach({ tabId }).catch(() => {});
    attached.delete(tabId);
    return {};
  }
  if (message.method === "chrome.debugger.sendCommand") {
    const method = String(params[1]);
    if (method === "Page.bringToFront") return {};
    if (
      /^(?:Storage\.|Browser\.close|Browser\.grantPermissions|Network\.(?:getAllCookies|getCookies|setCookie|setCookies|deleteCookies|clearBrowserCookies))/.test(
        method,
      )
    )
      throw new Error(
        "Profile credential export and browser-wide changes are unavailable.",
      );
    return chrome.debugger.sendCommand(
      debuggee,
      method,
      params[2] as Record<string, unknown> | undefined,
    );
  }
  throw new Error("Unsupported extension command.");
}

async function connect(reset = false) {
  if (reconnecting) return;
  if (!reset && socket && socket.readyState <= WebSocket.OPEN) return;
  reconnecting = true;
  try {
    if (reset) {
      socket?.close();
      socket = undefined;
      await detach();
    }
    const saved = await chrome.storage.local.get("pairing");
    const pairing = saved.pairing as Pairing | undefined;
    paired = !!pairing;
    if (!pairing) return;
    if (
      !Number.isInteger(pairing.port) ||
      pairing.port < 1024 ||
      pairing.port > 65535 ||
      !/^[a-zA-Z0-9_-]{43}$/.test(pairing.token)
    )
      return;
    const ws = new WebSocket(`ws://127.0.0.1:${pairing.port}/extension`);
    socket = ws;
    ws.onopen = () =>
      ws.send(JSON.stringify({ type: "hello", token: pairing.token }));
    ws.onmessage = async (message) => {
      if (socket !== ws) return;
      try {
        const value = JSON.parse(String(message.data));
        if (value.type === "paired") {
          const saved = await chrome.storage.session.get("owned");
          for (const tabId of Array.isArray(saved.owned) ? saved.owned : []) {
            const tab = await chrome.tabs.get(tabId).catch(() => undefined);
            if (tab) {
              owned.add(tabId);
              event("chrome.tabs.onCreated", [tab]);
            }
          }
          event("extension.initialized", []);
          return;
        }
        if (value.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }
        if (!Number.isSafeInteger(value.id) || typeof value.method !== "string")
          return;
        try {
          send({ id: value.id, result: await command(value) });
        } catch (error) {
          send({
            id: value.id,
            error:
              error instanceof Error
                ? error.message
                : "Browser command failed.",
          });
        }
      } catch {
        ws.close();
      }
    };
    ws.onclose = () => {
      if (socket === ws) {
        socket = undefined;
        void detach();
      }
    };
    ws.onerror = () => ws.close();
  } finally {
    reconnecting = false;
  }
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== undefined && owned.has(source.tabId))
    event("chrome.debugger.onEvent", [source, method, params]);
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== undefined && owned.has(source.tabId)) {
    attached.delete(source.tabId);
    event("chrome.debugger.onDetach", [source, reason]);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (owned.delete(tabId)) {
    attached.delete(tabId);
    event("chrome.tabs.onRemoved", [tabId]);
    void remember();
  }
});
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.type === "status")
    reply({ paired, connected: socket?.readyState === WebSocket.OPEN });
  if (message.type === "reconnect") {
    void connect(true).then(() => reply({ ok: true }));
    return true;
  }
  return false;
});
chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
  void connect();
});
chrome.runtime.onStartup.addListener(() => void connect());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "reconnect") void connect();
});
chrome.action.onClicked.addListener(
  () => void chrome.runtime.openOptionsPage(),
);
void connect();
