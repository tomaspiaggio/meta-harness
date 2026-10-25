"use client";

/**
 * Web Push on this device. iPhone and iPad only allow it in the app opened from
 * the Home Screen, and only after a tap asks for permission.
 */
export function pushSupported() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** iOS outside the Home Screen app, where Safari offers no notifications. */
export function needsHomeScreen() {
  if (typeof window === "undefined") return false;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return ios && !standalone;
}

function deviceLabel() {
  const agent = navigator.userAgent;
  const device = /iPhone/.test(agent)
    ? "iPhone"
    : /iPad/.test(agent)
      ? "iPad"
      : /Android/.test(agent)
        ? "Android"
        : /Mac/.test(agent)
          ? "Mac"
          : /Windows/.test(agent)
            ? "Windows"
            : "Browser";
  return window.matchMedia("(display-mode: standalone)").matches
    ? `${device} app`
    : `${device} browser`;
}

// Remembers that the owner turned notifications on here, so a dropped
// subscription is renewed but a deliberately disabled one is not.
const ENABLED = "harness-push";
function remember(on: boolean) {
  try {
    if (on) localStorage.setItem(ENABLED, "on");
    else localStorage.removeItem(ENABLED);
  } catch {}
}
function remembered() {
  try {
    return localStorage.getItem(ENABLED) === "on";
  } catch {
    return false;
  }
}

const bytes = (value: string) =>
  Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (character) => character.charCodeAt(0),
  );

async function post(body: Record<string, unknown>) {
  const response = await fetch("/api/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error ?? "Notification request failed.");
  return data;
}

async function save(subscription: PushSubscription, results?: boolean) {
  const value = subscription.toJSON();
  return post({
    action: "subscribe",
    endpoint: value.endpoint,
    keys: value.keys,
    label: deviceLabel(),
    ...(results === undefined ? {} : { results }),
  });
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** Must run from a tap: iOS only shows the permission prompt for one. */
export async function enablePush(results: boolean) {
  if (!pushSupported())
    throw new Error("This browser does not support notifications.");
  // Ask first, while the tap still counts as user interaction.
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw new Error(
      permission === "denied"
        ? "Notifications are blocked. Allow them in Settings → Notifications → Meta Harness, then try again."
        : "Notifications were not allowed.",
    );
  const registration = await navigator.serviceWorker.register("/sw.js", {
    scope: "/",
  });
  await navigator.serviceWorker.ready;
  const { publicKey } = await (await fetch("/api/push")).json();
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: bytes(publicKey),
    }));
  await save(subscription, results);
  remember(true);
  return subscription;
}

export async function disablePush() {
  remember(false);
  const subscription = await currentSubscription();
  if (!subscription) return;
  await post({ action: "unsubscribe", endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}

export async function setResults(results: boolean) {
  const subscription = await currentSubscription();
  if (subscription) await save(subscription, results);
}

export async function testPush() {
  const subscription = await currentSubscription();
  if (!subscription) throw new Error("Notifications are off on this device.");
  await post({ action: "test", endpoint: subscription.endpoint });
}

/**
 * iOS can drop a subscription after a while. Each time the app opens with
 * permission already granted, register again so the server keeps a live one.
 */
export async function refreshPush() {
  if (
    !pushSupported() ||
    Notification.permission !== "granted" ||
    !remembered()
  )
    return;
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (!registration) return;
  const response = await fetch("/api/push");
  if (!response.ok) return;
  const { publicKey } = await response.json();
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: bytes(publicKey),
    }));
  await save(subscription);
}
