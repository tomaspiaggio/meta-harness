"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
export default function Login() {
  const [mode, setMode] = useState<"google" | "oidc" | "setup" | null>(null);
  const [configured, setConfigured] = useState(false);
  const [setupMessage, setSetupMessage] = useState("");
  useEffect(() => {
    void fetch("/api/auth/status")
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok)
          throw new Error(value.error ?? "Cannot reach the control plane.");
        setMode(
          value.mode === "google" || value.mode === "oidc"
            ? value.mode
            : "setup",
        );
        setConfigured(value.configured === true);
        setSetupMessage(
          value.message ??
            "Google sign-in setup is pending on this control server.",
        );
      })
      .catch((error) => setError(error.message));
    if (new URLSearchParams(location.search).has("error"))
      setError(
        "Google sign-in failed or this account is not allowed. Try again with the owner account.",
      );
  }, []);
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
        {mode === "oidc"
          ? "Sign in with the configured owner identity."
          : "Sign in with your allowed Google account."}
      </p>
      {mode === "google" || mode === "setup" ? (
        <>
          <Button
            className="mt-6"
            disabled={busy || !configured}
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
          {!configured && (
            <p role="status" className="mt-4 text-sm text-muted-foreground">
              {setupMessage}
            </p>
          )}
        </>
      ) : mode === "oidc" ? (
        <Button className="mt-6" asChild>
          <a href="/api/auth/login">Sign in securely</a>
        </Button>
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
