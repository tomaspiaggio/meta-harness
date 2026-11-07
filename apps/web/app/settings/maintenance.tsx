import type { WorkerRecord } from "@harness/core/scheduling";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type Window = {
  id: string;
  startsAt: number;
  endsAt: number;
  workers: string[];
  note: string;
};
const when = (time: number) =>
  new Date(time).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * Planned downtime. Its machines take no new work during it, and agents hold
 * long work that wouldn't finish before it starts.
 */
export function MaintenanceCard({
  api,
  onError,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<unknown>;
  onError: (message: string) => void;
}) {
  const [windows, setWindows] = useState<Window[]>([]);
  const [workers, setWorkers] = useState<WorkerRecord[]>([]);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [machines, setMachines] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () =>
    void Promise.all([api("maintenance-windows"), api("workers")])
      .then(([list, known]) => {
        setWindows(list as Window[]);
        setWorkers(
          (known as WorkerRecord[]).filter((worker) => !worker.draining),
        );
      })
      .catch((error) => onError(error.message));
  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once
  useEffect(load, []);
  const name = (id: string) =>
    workers.find((worker) => worker.id === id)?.name ?? id;
  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      load();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Maintenance</CardTitle>
        <p className="text-sm text-muted-foreground">
          Planned downtime. Its machines take no new work while it lasts;
          messages wait and run when it ends. Agents hold long work that
          wouldn't finish before it starts.
        </p>
      </CardHeader>
      <CardContent className="grid gap-4">
        {windows.map((window) => {
          const started = window.startsAt <= Date.now();
          return (
            <div
              key={window.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
            >
              <div>
                <div>
                  {when(window.startsAt)} – {when(window.endsAt)}
                  {started && (
                    <span className="ml-2 text-warning">· in progress</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {window.workers.length
                    ? window.workers.map(name).join(", ")
                    : "All machines"}
                  {window.note ? ` · ${window.note}` : ""}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  perform(() =>
                    api("maintenance-windows", "DELETE", { id: window.id }),
                  )
                }
              >
                {started ? "End now" : "Cancel"}
              </Button>
            </div>
          );
        })}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1 text-sm">
            <label htmlFor="maintenance-starts">Starts</label>
            <Input
              id="maintenance-starts"
              type="datetime-local"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
            />
          </div>
          <div className="grid gap-1 text-sm">
            <label htmlFor="maintenance-ends">Ends</label>
            <Input
              id="maintenance-ends"
              type="datetime-local"
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          <span className="text-muted-foreground">Machines:</span>
          {workers.map((worker) => (
            <label key={worker.id} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={machines.includes(worker.id)}
                onChange={(event) =>
                  setMachines((current) =>
                    event.target.checked
                      ? [...current, worker.id]
                      : current.filter((id) => id !== worker.id),
                  )
                }
              />
              {worker.name}
            </label>
          ))}
          <span className="text-xs text-muted-foreground">
            (none checked: all)
          </span>
        </div>
        <Input
          placeholder="Note (optional), e.g. memory limits and reboot"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <Button
          className="justify-self-start"
          disabled={busy || !startsAt || !endsAt}
          onClick={() =>
            perform(async () => {
              await api("maintenance-windows", "POST", {
                // datetime-local is the viewer's local time.
                startsAt: new Date(startsAt).getTime(),
                endsAt: new Date(endsAt).getTime(),
                workers: machines,
                note,
              });
              setStartsAt("");
              setEndsAt("");
              setMachines([]);
              setNote("");
            })
          }
        >
          Schedule maintenance
        </Button>
      </CardContent>
    </Card>
  );
}
