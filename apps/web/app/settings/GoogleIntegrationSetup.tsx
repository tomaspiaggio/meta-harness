"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type Group = "gmail" | "drive" | "docs" | "sheets" | "calendar";
type Account = {
  id: string;
  label: string;
  revision: string;
  enabled: boolean;
  accountEmail: string;
  status: string;
  grantedGroups: Group[];
};
const groups: { id: Group; label: string }[] = [
  { id: "calendar", label: "Calendar events read" },
  { id: "gmail", label: "Gmail read/search" },
  { id: "drive", label: "Drive read/search" },
  { id: "docs", label: "Docs read" },
  { id: "sheets", label: "Sheets read" },
];
export function GoogleIntegrationSetup() {
  const [label, setLabel] = useState("");
  const [selected, setSelected] = useState<Group[]>(["gmail"]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [configured, setConfigured] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const response = await fetch("/api/integrations/google/status");
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    setAccounts(value.connections);
    setConfigured(value.configured);
  }, []);
  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("google");
    if (result === "connected")
      setNotice(
        "Google account connected. Review and save each workspace’s tools before using it.",
      );
    if (result === "failed")
      setNotice(
        "Google data access was not connected. Try again and grant the selected read scopes and offline access. Existing accounts were preserved.",
      );
    const refresh = () => {
      void load().catch((e) => setError(e.message));
    };
    refresh();
    window.addEventListener("integrations-changed", refresh);
    return () => window.removeEventListener("integrations-changed", refresh);
  }, [load]);
  async function connect(account?: Account) {
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/integrations/google/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label,
          groups: selected,
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
  return (
    <div className="space-y-3 rounded border p-3">
      <strong>Google Workspace accounts</strong>
      {notice && <p role="status">{notice}</p>}
      <p>
        Connect data access separately from owner sign-in. Choose read groups,
        then explicitly enable tools for each workspace below. Drafts, editing
        and sending are unavailable.
      </p>
      {!configured && (
        <p>
          Configure the separate Google resource OAuth client, exact callback
          URI and encryption key. See docs/google-integrations.md.
        </p>
      )}
      <label className="block">
        Account label{" "}
        <input
          className="rounded border p-1"
          value={label}
          maxLength={100}
          placeholder="Work account"
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-3">
        {groups.map((group) => (
          <label key={group.id}>
            <input
              type="checkbox"
              checked={selected.includes(group.id)}
              onChange={(e) =>
                setSelected((current) =>
                  e.target.checked
                    ? [...current, group.id]
                    : current.filter((id) => id !== group.id),
                )
              }
            />{" "}
            {group.label}
          </label>
        ))}
      </div>
      <Button
        disabled={busy || !configured || !selected.length || !label.trim()}
        onClick={() => void connect()}
      >
        Add Google account
      </Button>
      {accounts.map((account) => (
        <div key={account.id} className="space-y-1 border-t pt-2">
          <p>
            <strong>{account.label}</strong> ·{" "}
            {account.accountEmail || "No account authorized"} · {account.status}
          </p>
          <p>
            Granted read groups: {account.grantedGroups.join(", ") || "none"}.{" "}
            {account.enabled ? "" : "Connection disabled."}
          </p>
          <Button
            variant="outline"
            disabled={busy || !configured || !selected.length}
            onClick={() => void connect(account)}
          >
            Reconnect / change read scopes
          </Button>{" "}
          <Button
            variant="outline"
            disabled={busy || account.status === "disconnected"}
            onClick={() => void disconnect(account)}
          >
            Disconnect data access
          </Button>
        </div>
      ))}
      <p>
        Disconnect removes this connection’s stored token and invalidates
        workspace grants. To revoke Google project authorization, use your
        Google Account’s third-party access settings; revocation can affect
        other connections to the same project.
      </p>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
