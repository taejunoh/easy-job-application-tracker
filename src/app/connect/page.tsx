"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { sanitizeReturnPath } from "@/lib/return-path";
import { resetClientApiSessionRedirect } from "@/lib/client-api";

export async function connectWithAccessToken(token: string): Promise<Response> {
  const response = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (response.ok) resetClientApiSessionRedirect();
  return response;
}

export function connectDestination(search: string): string {
  const next = new URLSearchParams(search).get("next");
  return sanitizeReturnPath(next) ?? "/";
}

export default function ConnectPage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const response = await connectWithAccessToken(token);
      if (!response.ok) {
        setError(connectionError(response.status));
        setLoading(false);
        return;
      }

      setToken("");
      router.replace(connectDestination(window.location.search));
    } catch {
      setError("JobTracker could not be reached. Check the connection and retry.");
      setLoading(false);
    }
  }

  return (
    <div className="connect-page">
      <main className="w-full max-w-md" aria-labelledby="connect-title">
        <div className="connect-topline">
          <div className="connect-brand">
            JOBTRACKER
          </div>
          <div className="connect-state">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />
            Access locked
          </div>
        </div>

        <section className="connect-card">
          <p className="connect-eyebrow">
            Single-user console
          </p>
          <h1 id="connect-title" className="page-title">
            Connect to your tracker
          </h1>
          <p className="connect-copy">
            Enter the server access token configured for this JobTracker instance.
            It is exchanged for a secure browser session and is not saved here.
          </p>

          <form
            onSubmit={handleSubmit}
            className="connect-form"
            aria-busy={loading}
          >
            <label
              htmlFor="access-token"
              className="input-label"
            >
              Access token
            </label>
            <input
              id="access-token"
              name="access-token"
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
              autoFocus
              disabled={loading}
            className="connect-token field"
              placeholder="Paste server access token"
              aria-describedby="token-help connect-status"
              aria-invalid={Boolean(error)}
            />
            <p id="token-help" className="connect-help">
              The token stays in this field only until the session is created.
            </p>

            <p
              id="connect-status"
              role={error ? "alert" : "status"}
              className={`connect-status ${
                error ? "connect-error" : ""
              }`}
              aria-live="polite"
              aria-atomic="true"
            >
              {error || (loading ? "Verifying access…" : "")}
            </p>

            <button
              type="submit"
              disabled={loading || token.length === 0}
              className="primary-button connect-submit"
            >
              {loading ? "Connecting…" : "Connect"}
            </button>
          </form>
        </section>

        <p className="connect-footer">
          Private operations workspace
        </p>
      </main>
      <style>{connectStyles}</style>
    </div>
  );
}

const connectStyles = `
.connect-page { align-items: center; background: var(--canvas); display: flex; justify-content: center; min-height: 100dvh; padding: 2.5rem 1rem; }
.connect-page main { min-width: 0; width: 100%; }
.connect-topline { align-items: center; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; margin-bottom: 1.25rem; padding-bottom: 0.8rem; }
.connect-brand { color: var(--primary); font-family: var(--font-mono); font-size: 0.85rem; font-weight: 800; letter-spacing: 0.08em; }
.connect-state { align-items: center; color: var(--muted); display: flex; font-family: var(--font-mono); font-size: 0.68rem; gap: 0.45rem; letter-spacing: 0.1em; text-transform: uppercase; }
.connect-card { background: var(--surface); border: 1px solid var(--border); border-radius: 0.75rem; box-shadow: var(--shadow); padding: clamp(1.25rem, 4vw, 2rem); }
.connect-eyebrow, .connect-footer { color: var(--muted); font-family: var(--font-mono); font-size: 0.68rem; letter-spacing: 0.12em; text-transform: uppercase; }
.connect-eyebrow { margin: 0 0 0.75rem; }
.connect-card .page-title { font-size: clamp(1.8rem, 5vw, 2.4rem); }
.connect-copy, .connect-help { color: var(--muted); line-height: 1.55; }
.connect-copy { font-size: 0.9rem; margin: 0.75rem 0 0; }
.connect-form { margin-top: 1.75rem; }
.connect-token { background: var(--surface); border: 1px solid var(--border); color: var(--text); display: block; font-family: var(--font-mono); margin-top: 0.1rem; min-width: 0; width: 100%; }
.connect-token::placeholder { color: var(--muted); opacity: 1; }
.connect-token:disabled { cursor: wait; opacity: 0.6; }
.connect-help { font-size: 0.78rem; margin: 0.45rem 0 0; }
.connect-status { color: var(--muted); font-size: 0.88rem; min-height: 1.5rem; margin: 0.9rem 0 0; }
.connect-error { color: var(--destructive); }
.connect-submit { margin-top: 0.7rem; width: 100%; }
.connect-submit:disabled { background: #dfe5df; border-color: #c8d1c9; color: var(--muted); cursor: not-allowed; opacity: 0.72; }
.connect-footer { margin: 1rem 0 0; text-align: center; }
`;

function connectionError(status: number): string {
  if (status === 401) {
    return "That access token was not accepted.";
  }
  if (status === 403) {
    return "Open JobTracker from its configured application address and retry.";
  }
  return "JobTracker could not create a session. Retry in a moment.";
}
