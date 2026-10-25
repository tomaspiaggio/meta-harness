import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { timeAgo } from "../shell";

type Status = {
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastFile?: string;
  bytes?: number;
  kept?: number;
  remote?: string;
  error?: string | null;
  overdue: boolean;
};

/**
 * Hourly encrypted backups of this control plane to the owner's Drive. Only the
 * owner's private key can open them; this card only shows whether they run.
 */
export function BackupsCard({
  api,
  onError,
}: {
  api: (path: string) => Promise<unknown>;
  onError: (message: string) => void;
}) {
  const [status, setStatus] = useState<Status | null | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount
  useEffect(() => {
    void api("backups")
      .then((value) => setStatus((value as { status: Status | null }).status))
      .catch((error) => onError(error.message));
  }, []);
  if (status === undefined) return null;
  const healthy = status && !status.error && !status.overdue;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Backups</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        {!status ? (
          <p className="text-muted-foreground">
            Off-site backups are not set up on this control host.
          </p>
        ) : (
          <>
            <p className="text-muted-foreground">
              Every hour, encrypted so only your private key can open them.
              Hourly copies are kept for 2 days, daily for 30 days and weekly
              for 6 months.
            </p>
            <p className={healthy ? "" : "text-destructive"}>
              {status.lastSuccessAt
                ? `Last backup ${timeAgo(status.lastSuccessAt)}`
                : "No successful backup yet"}
              {status.bytes
                ? ` · ${(status.bytes / 1048576).toFixed(1)} MB`
                : ""}
              {status.kept ? ` · ${status.kept} kept` : ""}
              {status.remote
                ? ` · ${status.remote.replace(/^[^:]+:/, "")}`
                : ""}
            </p>
            {status.error && (
              <p className="text-destructive">
                Last attempt{" "}
                {status.lastAttemptAt ? timeAgo(status.lastAttemptAt) : ""}{" "}
                failed: {status.error}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
