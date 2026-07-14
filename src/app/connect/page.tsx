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
    <div className="flex min-h-dvh items-center justify-center bg-gray-950 px-4 py-10 sm:px-6">
      <main className="w-full max-w-md" aria-labelledby="connect-title">
        <div className="mb-5 flex items-center justify-between border-b border-gray-800 pb-3">
          <div className="font-mono text-sm font-semibold tracking-wide text-blue-400">
            JOBTRACKER
          </div>
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-gray-400">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />
            Access locked
          </div>
        </div>

        <section className="border border-gray-800 bg-gray-900 p-6 shadow-2xl shadow-black/30 sm:p-8">
          <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.18em] text-gray-400">
            Single-user console
          </p>
          <h1 id="connect-title" className="text-2xl font-semibold text-gray-100">
            Connect to your tracker
          </h1>
          <p className="mt-3 text-sm leading-6 text-gray-400">
            Enter the server access token configured for this JobTracker instance.
            It is exchanged for a secure browser session and is not saved here.
          </p>

          <form
            onSubmit={handleSubmit}
            className="mt-7"
            aria-busy={loading}
          >
            <label
              htmlFor="access-token"
              className="mb-2 block text-xs font-medium uppercase tracking-wider text-gray-400"
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
              className="w-full border border-gray-700 bg-gray-950 px-3 py-3 font-mono text-sm text-gray-100 outline-none transition placeholder:text-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-wait disabled:opacity-60"
              placeholder="Paste server access token"
              aria-describedby="token-help connect-status"
              aria-invalid={Boolean(error)}
            />
            <p id="token-help" className="mt-2 text-xs leading-5 text-gray-400">
              The token stays in this field only until the session is created.
            </p>

            <p
              id="connect-status"
              role={error ? "alert" : "status"}
              className={`mt-4 min-h-5 text-sm ${
                error ? "text-red-400" : "text-gray-400"
              }`}
              aria-atomic="true"
            >
              {error || (loading ? "Verifying access…" : "")}
            </p>

            <button
              type="submit"
              disabled={loading || token.length === 0}
              className="mt-5 w-full border border-blue-500 bg-blue-600 px-4 py-3 text-sm font-semibold text-white outline-none transition hover:bg-blue-500 focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900 disabled:cursor-not-allowed disabled:border-gray-700 disabled:bg-gray-800 disabled:text-gray-400"
            >
              {loading ? "Connecting…" : "Connect"}
            </button>
          </form>
        </section>

        <p className="mt-4 text-center font-mono text-[11px] uppercase tracking-[0.12em] text-gray-400">
          Private operations workspace
        </p>
      </main>
    </div>
  );
}

function connectionError(status: number): string {
  if (status === 401) {
    return "That access token was not accepted.";
  }
  if (status === 403) {
    return "Open JobTracker from its configured application address and retry.";
  }
  return "JobTracker could not create a session. Retry in a moment.";
}
