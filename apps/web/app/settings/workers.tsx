import type { WorkerRecord } from "@harness/core/scheduling";
import { Check, Copy, Download, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const online = (worker: WorkerRecord) =>
  !worker.draining && !!worker.seenAt && worker.seenAt > Date.now() - 30000;
const ago = (value: number | null) => {
  if (!value) return "never";
  const seconds = Math.round((Date.now() - value) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
};

type Pending = {
  id: string;
  name: string;
  markdown: string;
  filename: string;
  copied: boolean;
};

/**
 * Workers are the machines that actually run agents and browsers. Adding one is
 * three steps: name it, paste the generated setup into a coding agent on that
 * machine, then wait here until it reports in.
 */
export function WorkersCard({
  api,
  onError,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<unknown>;
  onError: (message: string) => void;
}) {
  const [workers, setWorkers] = useState<WorkerRecord[]>([]);
  const [name, setName] = useState("");
  const [controlUrl, setControlUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  useEffect(() => setControlUrl(window.location.origin), []);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void api("workers")
        .then((value) => {
          if (!cancelled) setWorkers(value as WorkerRecord[]);
        })
        .catch((error) => onError(error.message));
    load();
    // Poll faster while waiting for a new machine to connect.
    const timer = setInterval(load, pending ? 3000 : 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, onError, pending]);
  const newWorker = pending && workers.find((item) => item.id === pending.id);
  const connected = !!newWorker && online(newWorker);
  const local = controlUrl && /\/\/(localhost|127\.0\.0\.1)/.test(controlUrl);

  async function copy(value: Pending) {
    let copied = false;
    try {
      await navigator.clipboard.writeText(value.markdown);
      copied = true;
    } catch {
      // Clipboard may need another gesture; the text stays available below.
    }
    setPending({ ...value, copied });
    setShowSetup(!copied);
  }
  async function create() {
    setBusy(true);
    try {
      const response = await fetch("/api/workers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          serverUrl: controlUrl.trim(),
          format: "markdown",
        }),
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error ?? "Could not create the setup.");
      }
      const markdown = await response.text();
      const id = markdown.match(/^- Worker ID: (\S+)$/m)?.[1] ?? "";
      const filename =
        response.headers
          .get("content-disposition")
          ?.match(/filename="([^"]+)"/)?.[1] ?? "worker-setup.md";
      setShowSetup(false);
      await copy({ id, name: name.trim(), markdown, filename, copied: false });
      setWorkers((await api("workers")) as WorkerRecord[]);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card id="machines">
      <CardHeader>
        <CardTitle>Machines (workers)</CardTitle>
        <p className="text-sm text-muted-foreground">
          Agents and their browser run on machines you own, such as this Mac or
          a Raspberry Pi. This website only coordinates them. Any online machine
          with free capacity picks up work.
        </p>
      </CardHeader>
      <CardContent className="grid gap-5">
        <ul className="grid gap-2" aria-label="Connected machines">
          {!workers.length && (
            <li className="text-sm text-muted-foreground">
              No machines yet. Add one below so agents can run.
            </li>
          )}
          {workers.map((worker) => {
            const up = online(worker);
            return (
              <li
                key={worker.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border p-3 text-sm"
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-2 rounded-full",
                    worker.draining
                      ? "bg-muted-foreground"
                      : up
                        ? "bg-success"
                        : "bg-warning",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {worker.name}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {worker.draining
                        ? "Revoked"
                        : up
                          ? "Online"
                          : `Offline · last seen ${ago(worker.seenAt)}`}
                    </span>
                  </p>
                  {worker.report && (
                    <p className="text-xs text-muted-foreground">
                      {worker.report.hostname} · agents:{" "}
                      {worker.report.providers
                        .filter((item) => item !== "demo")
                        .join(", ") || "none"}{" "}
                      · browser: {worker.report.browserHost ? "yes" : "no"}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !!worker.draining}
                  onClick={() => {
                    setBusy(true);
                    void api("workers", "DELETE", { id: worker.id })
                      .then(async () =>
                        setWorkers((await api("workers")) as WorkerRecord[]),
                      )
                      .catch((error) => onError(error.message))
                      .finally(() => setBusy(false));
                  }}
                >
                  Revoke
                </Button>
              </li>
            );
          })}
        </ul>
        <section className="grid gap-4 rounded-lg border bg-background/40 p-4 text-sm">
          <h3 className="font-medium">Add a machine</h3>
          <Step n={1} done={!!pending} title="Name it">
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <Input
                aria-label="New machine name"
                placeholder="e.g. MacBook Air"
                value={name}
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
              />
              <Button disabled={busy || !name.trim() || !controlUrl.trim()}>
                Create setup
              </Button>
            </form>
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer">Advanced: address</summary>
              <label htmlFor="worker-control-url" className="mt-2 grid gap-1">
                Address the new machine uses to reach this server
                <Input
                  id="worker-control-url"
                  aria-label="Worker control URL"
                  value={controlUrl}
                  onChange={(event) => setControlUrl(event.target.value)}
                />
              </label>
              <p className="mt-1">
                Pre-filled with the address you are using now. Change it only if
                the other machine reaches this server differently.
              </p>
            </details>
            {local && (
              <p className="mt-2 text-xs text-warning">
                {controlUrl} only works on this same computer. Open Settings
                from the address other devices use (for example your tailnet
                HTTPS URL) before adding another machine.
              </p>
            )}
          </Step>
          <Step
            n={2}
            done={connected}
            title="Paste the setup into a coding agent on that machine"
          >
            {pending ? (
              <div className="grid gap-2">
                <p className="text-muted-foreground">
                  {pending.copied
                    ? "Copied to your clipboard. "
                    : "Copy the setup below. "}
                  On {pending.name}, open a terminal, start{" "}
                  <code className="rounded bg-muted px-1">codex</code> or{" "}
                  <code className="rounded bg-muted px-1">claude</code>, and
                  paste it. The agent installs the worker and tells you if a
                  login is needed.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void copy(pending)}
                  >
                    {pending.copied ? <Check /> : <Copy />}
                    {pending.copied ? "Copy again" : "Copy setup"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const url = URL.createObjectURL(
                        new Blob([pending.markdown], {
                          type: "text/markdown; charset=utf-8",
                        }),
                      );
                      const link = document.createElement("a");
                      link.href = url;
                      link.download = pending.filename;
                      document.body.append(link);
                      link.click();
                      link.remove();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    }}
                  >
                    <Download /> Download
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowSetup(!showSetup)}
                  >
                    {showSetup ? "Hide setup" : "Show setup"}
                  </Button>
                </div>
                {showSetup && (
                  <textarea
                    aria-label="Agent setup instructions"
                    readOnly
                    rows={8}
                    value={pending.markdown}
                    onFocus={(event) => event.currentTarget.select()}
                    className="rounded border bg-background p-2 font-mono text-xs"
                  />
                )}
                <p className="text-xs text-muted-foreground">
                  Keep it private: it contains this machine&apos;s access key.
                  If it leaks, press Revoke above.
                </p>
              </div>
            ) : (
              <p className="text-muted-foreground">
                After step 1 you get a setup message to paste.
              </p>
            )}
          </Step>
          <Step n={3} done={connected} title="Wait for it to connect">
            {!pending ? (
              <p className="text-muted-foreground">
                It appears in the list above once it reports in.
              </p>
            ) : connected ? (
              <p className="text-success">
                {pending.name} is online and ready for work.
              </p>
            ) : (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Waiting for{" "}
                {pending.name} to connect. This page updates automatically.
              </p>
            )}
          </Step>
        </section>
      </CardContent>
    </Card>
  );
}

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[1.75rem_1fr] gap-x-3">
      <span
        className={cn(
          "grid size-7 place-items-center rounded-full border text-xs",
          done && "border-success bg-success text-background",
        )}
      >
        {done ? <Check className="size-4" /> : n}
      </span>
      <div className="grid gap-2 pt-1">
        <p className="font-medium">{title}</p>
        {children}
      </div>
    </div>
  );
}
