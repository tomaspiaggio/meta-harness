"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
export default function Login() {
  const [mode, setMode] = useState<"google" | "oidc" | "token" | null>(null);
  useEffect(() => {
    void fetch("/api/auth/status")
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok)
          throw new Error(value.error ?? "Cannot reach the control plane.");
        setMode(value.mode ?? (value.hosted ? "oidc" : "token"));
      })
      .catch((error) => setError(error.message));
    if (new URLSearchParams(location.search).has("error"))
      setError(
        "Google sign-in failed or this account is not allowed. Try again with the owner account.",
      );
  }, []);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <section className="mx-auto mt-[18vh] max-w-md px-6">
      <div className="mb-10 flex items-center gap-2.5 font-semibold">
        <span className="grid size-6 place-items-center rounded-md bg-primary pb-0.5 font-serif text-lg italic leading-none text-primary-foreground">
          m
        </span>
        meta harness
      </div>
      <h1 className="font-serif text-4xl tracking-tight">
        Connect to <em className="text-primary">your work</em>.
      </h1>
      <p className="mt-2 text-muted-foreground">
        {mode === "google"
          ? "Sign in with your allowed Google account."
          : mode === "oidc"
            ? "Sign in with the configured owner identity."
            : "Enter this control plane’s access token."}
      </p>
      {mode === "google" ? (
        <Button
          className="mt-6"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError("");
            void fetch("/api/auth/sign-in/social", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                provider: "google",
                callbackURL: "/",
                errorCallbackURL: "/login",
              }),
            })
              .then(async (response) => {
                const value = await response.json();
                if (!response.ok || !value.url)
                  throw new Error(
                    "Google sign-in could not start. Check the control plane configuration.",
                  );
                location.assign(value.url);
              })
              .catch((error) => {
                setError(error.message);
                setBusy(false);
              });
          }}
        >
          Continue with Google
        </Button>
      ) : mode === "oidc" ? (
        <Button className="mt-6" asChild>
          <a href="/api/auth/login">Sign in securely</a>
        </Button>
      ) : mode === "token" ? (
        <form
          className="mt-6 flex gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            setError("");
            try {
              const response = await fetch("/api/login", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ token }),
              });
              if (!response.ok)
                throw new Error("Check your access token and try again.");
              location.assign("/tasks");
            } catch (error) {
              setError(
                error instanceof Error ? error.message : "Connection failed.",
              );
            }
          }}
        >
          <Input
            aria-label="Access token"
            placeholder="Access token"
            type="password"
            autoComplete="current-password"
            required
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <Button type="submit">Connect</Button>
        </form>
      ) : (
        <p className="mt-6 text-muted-foreground">Checking authentication…</p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
