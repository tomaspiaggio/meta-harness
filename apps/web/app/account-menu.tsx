"use client";

import { LogOut, UserRound } from "lucide-react";
import { Avatar, DropdownMenu } from "radix-ui";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type Profile = { name: string | null; email: string; image: string | null };

export function AccountMenu() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/auth/profile", { signal: controller.signal })
      .then(async (response) => {
        if (response.ok) setProfile((await response.json()).user);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const initials = (profile?.name || profile?.email || "")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  async function signOut() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok)
        throw new Error("Could not sign out. Please try again.");
      setProfile(null);
      location.replace("/login");
    } catch {
      setError("Could not sign out. Please try again.");
      setBusy(false);
    }
  }
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 rounded-full"
          aria-label="Account menu"
        >
          <Avatar.Root className="flex size-8 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium">
            {profile?.image && (
              <Avatar.Image
                src={profile.image}
                alt=""
                referrerPolicy="no-referrer"
                className="size-full object-cover"
              />
            )}
            <Avatar.Fallback aria-hidden="true">
              {initials || <UserRound className="size-4" />}
            </Avatar.Fallback>
          </Avatar.Root>
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="z-50 min-w-56 max-w-[calc(100vw-2rem)] rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <DropdownMenu.Label className="px-3 py-2">
            <p className="text-sm font-medium">
              {profile?.name || "Your account"}
            </p>
            {profile?.email && (
              <p className="mt-0.5 break-all text-xs font-normal text-muted-foreground">
                {profile.email}
              </p>
            )}
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item
            disabled={busy}
            onSelect={(event) => {
              event.preventDefault();
              void signOut();
            }}
            className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-50"
          >
            <LogOut className="size-4" />
            {busy ? "Signing out…" : "Sign out"}
          </DropdownMenu.Item>
          {error && (
            <p
              role="alert"
              className="max-w-64 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
