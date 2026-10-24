"use client";
import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Group = "gmail" | "drive" | "docs" | "sheets" | "calendar";
type Account = {
  id: string;
  label: string;
  revision: string;
  enabled: boolean;
  accountEmail: string;
  status: "ready" | "reconnect" | "disconnected";
  workspaceGrants: number;
  grantsNeedingReview: number;
  grantedGroups: Group[];
};
type Setup = {
  configured: boolean;
  missing: string[];
  invalid: string[];
  expectedRedirectUri: string;
  redirectUri: string | null;
  openAt: string | null;
  reusesOwnerClient: boolean;
};
const groups: { id: Group; label: string }[] = [
  { id: "gmail", label: "Gmail" },
  { id: "drive", label: "Drive" },
  { id: "docs", label: "Docs" },
  { id: "sheets", label: "Sheets" },
  { id: "calendar", label: "Calendar" },
];
// Fixed callback vocabulary; the callback never forwards provider error text.
const failures: Record<string, string> = {
  cancelled:
    "Google consent was cancelled. Nothing was stored; existing accounts are unchanged.",
  signed_out:
    "Your harness session ended before Google returned. Sign in again, then retry from this page.",
  not_configured:
    "Resource OAuth is not configured on this control server, so the Google response was discarded.",
  mismatch:
    "Google returned to a different address, or the 10-minute consent window expired. Start again from this page.",
  consent:
    "Google returned, but the account was not connected. Approve offline access and every selected read group, and reconnect with the same Google account.",
};
const statusStyle = {
  ready: "bg-success-soft text-success",
  reconnect: "bg-warning-soft text-warning",
  disconnected: "bg-muted text-muted-foreground",
} as const;

function Chip({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        className,
      )}
    >
      {children}
    </span>
  );
}

function Step({
  index,
  title,
  done,
  active,
  children,
}: {
  index: number;
  title: string;
  done: boolean;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="relative grid grid-cols-[1.75rem_1fr] gap-3 pb-5 last:pb-0">
      <span
        aria-hidden
        className="absolute top-8 bottom-1 left-[0.8125rem] w-px bg-border [li:last-child>&]:hidden"
      />
      <span
        aria-hidden
        className={cn(
          "z-10 flex size-7 items-center justify-center rounded-full border font-serif text-sm",
          done
            ? "border-success bg-success-soft text-success"
            : active
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-card text-muted-foreground",
        )}
      >
        {done ? <Check className="size-3.5" /> : index}
      </span>
      <div className="min-w-0 space-y-2 pt-0.5">
        <h4
          className={cn(
            "text-sm font-medium",
            !done && !active && "text-muted-foreground",
          )}
        >
          {title}
          <span className="sr-only">
            {done ? " (complete)" : active ? " (next step)" : ""}
          </span>
        </h4>
        {children}
      </div>
    </li>
  );
}

function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-md border bg-background py-1 pr-1 pl-2.5">
      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={value}>
        {value}
      </code>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={copied ? "Copied" : "Copy callback URL"}
        onClick={() =>
          void navigator.clipboard
            .writeText(value)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => {})
        }
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

export function GoogleIntegrationSetup() {
  const [label, setLabel] = useState("");
  const [selected, setSelected] = useState<Group[]>(["gmail", "drive"]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const load = useCallback(async () => {
    const response = await fetch("/api/integrations/google/status");
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    setAccounts(value.connections);
    setSetup(value.setup);
  }, []);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("google");
    if (result === "connected")
      setNotice({
        ok: true,
        text: "Google account connected. Grant its tools to a workspace below before agents can use it.",
      });
    if (result === "failed")
      setNotice({
        ok: false,
        text:
          failures[params.get("reason") ?? ""] ??
          "Google data access was not connected. Existing accounts were preserved.",
      });
    if (result) {
      // Keep reloads from replaying a stale consent result.
      params.delete("google");
      params.delete("reason");
      const query = params.toString();
      history.replaceState(
        null,
        "",
        `${location.pathname}${query ? `?${query}` : ""}`,
      );
    }
    const refresh = () => {
      void load().catch((e) => setError(e.message));
    };
    refresh();
    window.addEventListener("integrations-changed", refresh);
    return () => window.removeEventListener("integrations-changed", refresh);
  }, [load]);
  async function connect(account?: Account, scopes = selected) {
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/integrations/google/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label,
          groups: scopes,
          ...(account
            ? { connectionId: account.id, expectedRevision: account.revision }
            : {}),
        }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      window.location.assign(value.authorizationUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }
  async function disconnect(account: Account) {
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/integrations/google/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: account.id,
          expectedRevision: account.revision,
        }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      await load();
      window.dispatchEvent(new Event("integrations-changed"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const configured = setup?.configured ?? false;
  const connected = accounts.some((account) => account.status === "ready");
  const granted = accounts.some(
    (account) => account.status === "ready" && account.workspaceGrants > 0,
  );
  const blocker = !configured
    ? "Finish step 1 on the control server first."
    : setup?.openAt
      ? `Open Settings at ${setup.openAt} to connect; Google returns only to the registered origin.`
      : !selected.length
        ? "Select at least one read group."
        : !label.trim()
          ? "Name this account to continue."
          : "";
  const badge = !setup
    ? { text: "Checking…", style: "bg-muted text-muted-foreground" }
    : !configured
      ? { text: "Setup needed", style: "bg-warning-soft text-warning" }
      : granted
        ? { text: "Active", style: statusStyle.ready }
        : connected
          ? { text: "Grant a workspace", style: "bg-warning-soft text-warning" }
          : { text: "Ready to connect", style: "bg-secondary text-foreground" };
  return (
    <section
      aria-labelledby="google-workspace-heading"
      className="space-y-4 rounded-lg border bg-background/40 p-4 text-sm"
    >
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-64 space-y-1">
          <h3
            id="google-workspace-heading"
            className="font-serif text-lg leading-tight"
          >
            Google Workspace
          </h3>
          <p className="max-w-prose text-muted-foreground">
            Read-only Gmail, Drive, Docs, Sheets and Calendar tools. Signing in
            to Meta Harness grants no Google data access; each account needs its
            own consent. Drafts, edits and sending are unavailable.
          </p>
        </div>
        <Chip className={cn("mt-1 shrink-0", badge.style)}>{badge.text}</Chip>
      </header>
      {notice && (
        <p
          role="status"
          className={cn(
            "rounded-md px-3 py-2",
            notice.ok
              ? "bg-success-soft text-success"
              : "bg-warning-soft text-warning",
          )}
        >
          {notice.text}
        </p>
      )}
      <ol className="list-none">
        <Step
          index={1}
          title="Configure the resource OAuth client"
          done={configured}
          active={!!setup && !configured}
        >
          {!setup ? (
            <p className="text-xs text-muted-foreground">Checking setup…</p>
          ) : configured ? (
            <p className="text-xs text-muted-foreground">
              Configured on this control server. Callback{" "}
              <code className="font-mono break-all">{setup.redirectUri}</code>
              {setup.reusesOwnerClient && (
                <span className="mt-1 block text-warning">
                  This reuses the owner sign-in client. A separate Web client
                  keeps data consent and revocation independent from login.
                </span>
              )}
            </p>
          ) : (
            <div className="space-y-3">
              {(setup.missing.length > 0 || setup.invalid.length > 0) && (
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">
                    The control server&apos;s <code>.env</code> is missing or
                    has invalid values for:
                  </p>
                  <ul className="flex flex-wrap gap-1.5">
                    {setup.missing.map((name) => (
                      <li key={name}>
                        <Chip className="bg-warning-soft font-mono text-warning">
                          {name}
                        </Chip>
                      </li>
                    ))}
                    {setup.invalid.map((name) => (
                      <li key={name}>
                        <Chip className="bg-danger-soft font-mono text-danger">
                          {name} · invalid
                        </Chip>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <ol className="list-decimal space-y-1.5 pl-4 text-xs text-muted-foreground marker:text-foreground">
                <li>
                  In Google Cloud, enable the Gmail and Drive APIs (plus Docs,
                  Sheets or Calendar if needed) and add your account as a test
                  user.
                </li>
                <li>
                  Create a separate <strong>Web application</strong> OAuth
                  client with this exact authorized redirect URI:
                  <span className="mt-1 block">
                    <CopyValue value={setup.expectedRedirectUri} />
                  </span>
                </li>
                <li>
                  On the control host run{" "}
                  <code className="rounded bg-muted px-1 font-mono text-foreground">
                    pnpm google:resource-env
                  </code>
                  . It prompts for the client ID and secret without echoing,
                  generates the encryption key and updates <code>.env</code> in
                  place.
                </li>
                <li>
                  Restart the control server after active turns finish, then
                  reload this page.
                </li>
              </ol>
            </div>
          )}
        </Step>
        <Step
          index={2}
          title="Connect a Google account"
          done={connected}
          active={configured && !connected}
        >
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void connect();
            }}
          >
            <fieldset className="space-y-1.5">
              <legend className="text-xs text-muted-foreground">
                Read access to request
              </legend>
              <div className="flex flex-wrap gap-1.5">
                {groups.map((group) => {
                  const on = selected.includes(group.id);
                  return (
                    <label
                      key={group.id}
                      className={cn(
                        "flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50",
                        on
                          ? "border-primary bg-primary/10 text-foreground"
                          : "bg-card text-muted-foreground hover:bg-accent",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={on}
                        onChange={(e) =>
                          setSelected((current) =>
                            e.target.checked
                              ? [...current, group.id]
                              : current.filter((id) => id !== group.id),
                          )
                        }
                      />
                      <Check
                        aria-hidden
                        className={cn("size-3", !on && "hidden")}
                      />
                      {group.label}
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <div className="flex flex-wrap items-end gap-2">
              <label
                htmlFor="google-account-label"
                className="grid min-w-48 flex-1 gap-1"
              >
                <span className="text-xs text-muted-foreground">
                  Account label
                </span>
                <Input
                  id="google-account-label"
                  value={label}
                  maxLength={100}
                  placeholder="Personal Gmail"
                  onChange={(e) => setLabel(e.target.value)}
                />
              </label>
              <Button type="submit" disabled={busy || !!blocker}>
                {busy ? "Opening Google…" : "Continue to Google"}
              </Button>
            </div>
            {blocker && (
              <p className="text-xs text-muted-foreground">{blocker}</p>
            )}
          </form>
          {accounts.length > 0 && (
            <ul className="divide-y rounded-md border bg-card">
              {accounts.map((account) => {
                const authorized = !!account.accountEmail;
                return (
                  <li
                    key={account.id}
                    className="flex flex-wrap items-center justify-between gap-2 p-3"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{account.label}</span>
                        <Chip className={statusStyle[account.status]}>
                          {account.status === "ready"
                            ? "Connected"
                            : account.status === "reconnect"
                              ? "Reconnect needed"
                              : authorized
                                ? "Disconnected"
                                : "Consent not completed"}
                        </Chip>
                        {!account.enabled && (
                          <Chip className="bg-muted text-muted-foreground">
                            Disabled
                          </Chip>
                        )}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {account.accountEmail || "No Google account authorized"}
                        {account.grantedGroups.length > 0 &&
                          ` · ${account.grantedGroups.join(", ")}`}
                        {account.status === "ready" &&
                          ` · ${account.workspaceGrants} workspace${account.workspaceGrants === 1 ? "" : "s"}`}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          busy ||
                          !configured ||
                          !!setup?.openAt ||
                          !selected.length
                        }
                        title="Uses the read groups selected above"
                        onClick={() => void connect(account)}
                      >
                        {authorized ? "Reconnect" : "Authorize"}
                      </Button>
                      {account.status !== "disconnected" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-danger hover:text-danger"
                          disabled={busy}
                          onClick={() => void disconnect(account)}
                        >
                          Disconnect
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Step>
        <Step
          index={3}
          title="Grant tools to a workspace"
          done={granted}
          active={connected && !granted}
        >
          <p className="text-xs text-muted-foreground">
            {connected
              ? "In the account card below, tick the tools each workspace may use and save. Optional file, label, calendar and range limits narrow access further."
              : "Connected accounts grant nothing by default. Each workspace gets only the tools you explicitly save."}
            {accounts.some((account) => account.grantsNeedingReview > 0) &&
              " Some grants changed after a reconnect and need review."}
          </p>
        </Step>
      </ol>
      <p className="border-t pt-3 text-xs text-muted-foreground">
        Disconnect erases the stored token and invalidates workspace grants. To
        revoke Google&apos;s authorization itself, use your Google
        Account&apos;s third-party access page.
      </p>
      {error && (
        <p
          role="alert"
          className="rounded-md bg-danger-soft px-3 py-2 text-danger"
        >
          {error}
        </p>
      )}
    </section>
  );
}
