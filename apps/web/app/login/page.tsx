"use client";
import { useState } from "react";

export default function Login() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  return (
    <section className="login">
      <div className="eyebrow">META HARNESS</div>
      <h1>Connect to your work.</h1>
      <p>Enter this control plane’s access token.</p>
      <form
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
        <input
          aria-label="Access token"
          type="password"
          autoComplete="current-password"
          required
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <button type="submit">Connect</button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
