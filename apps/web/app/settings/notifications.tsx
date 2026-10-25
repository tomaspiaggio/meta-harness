import { Bell, BellOff, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  currentSubscription,
  disablePush,
  enablePush,
  needsHomeScreen,
  pushSupported,
  setResults,
  testPush,
} from "../push-client";

type Device = {
  label: string;
  results: boolean;
  lastSentAt: number | null;
  error: string | null;
};

/**
 * Notifications on this device when the agent needs you: a question, a sign-in,
 * a schedule to review, or a failed task. Each device opts in separately.
 */
export function NotificationsCard({
  onError,
}: {
  onError: (message: string) => void;
}) {
  const [state, setState] = useState<
    "loading" | "unsupported" | "home-screen" | "off" | "on"
  >("loading");
  const [device, setDevice] = useState<Device | null>(null);
  const [devices, setDevices] = useState(0);
  const [results, setResultsState] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  async function load() {
    if (needsHomeScreen()) return setState("home-screen");
    if (!pushSupported()) return setState("unsupported");
    const subscription = await currentSubscription();
    const response = await fetch(
      `/api/push${subscription ? `?endpoint=${encodeURIComponent(subscription.endpoint)}` : ""}`,
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    setDevices(data.devices);
    setDevice(data.device);
    setResultsState(!!data.device?.results);
    setState(
      subscription && data.device && Notification.permission === "granted"
        ? "on"
        : "off",
    );
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount
  useEffect(() => {
    void load().catch((error) => onError(error.message));
  }, []);

  async function run(action: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setNotice("");
    try {
      await action();
      if (done) setNotice(done);
      await load();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p className="text-muted-foreground">
          Get a notification on this device when an agent needs you: a question,
          a sign-in, a schedule to review, or a task that failed. Tapping it
          opens the conversation.
        </p>
        {state === "loading" && (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        )}
        {state === "home-screen" && (
          <p className="rounded-md bg-muted p-3">
            On iPhone and iPad, notifications only work in the app on your Home
            Screen. In Safari tap Share → Add to Home Screen, open Meta Harness
            from there, and turn notifications on in its Settings.
          </p>
        )}
        {state === "unsupported" && (
          <p className="rounded-md bg-muted p-3">
            This browser does not support notifications.
          </p>
        )}
        {state === "off" && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={busy}
              onClick={() =>
                void run(
                  () => enablePush(results),
                  "Notifications are on. Send a test to check.",
                )
              }
            >
              <Bell /> Turn on for this device
            </Button>
          </div>
        )}
        {state === "on" && (
          <>
            <p>
              On for this device{device ? ` (${device.label})` : ""}.
              {device?.error && (
                <span className="ml-1 text-destructive">{device.error}</span>
              )}
            </p>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={results}
                disabled={busy}
                onChange={(event) => {
                  const next = event.target.checked;
                  setResultsState(next);
                  void run(() => setResults(next));
                }}
              />
              Also when a result is ready
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(testPush, "Test sent. It should arrive in seconds.")
                }
              >
                Send a test
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void run(disablePush)}
              >
                <BellOff /> Turn off
              </Button>
            </div>
          </>
        )}
        {state !== "loading" && (
          <p className="text-xs text-muted-foreground">
            {devices === 1
              ? "1 device receives notifications."
              : `${devices} devices receive notifications.`}
          </p>
        )}
        {notice && (
          <p role="status" className="text-primary">
            {notice}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
