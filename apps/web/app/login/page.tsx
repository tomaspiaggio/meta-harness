"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
export default function Login() {
  const [hosted, setHosted] = useState<boolean | null>(null);
  useEffect(() => {
    void fetch("/api/auth/status")
      .then((response) => response.json())
      .then((value) => setHosted(!!value.hosted))
      .catch(() => setError("Cannot reach the control plane."));
  }, []);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
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
        {hosted
          ? "Sign in with the configured owner identity."
          : "Enter this control plane’s access token."}
      </p>
      {hosted ? (
        <Button className="mt-6" asChild>
          <a href="/api/auth/login">Sign in securely</a>
        </Button>
      ) : hosted === false ? (
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
