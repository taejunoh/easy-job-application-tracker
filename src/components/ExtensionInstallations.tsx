"use client";

import { useCallback, useEffect, useState } from "react";

import type { ClientApi } from "@/lib/client-api";

type Installation = Readonly<{
  id: string;
  origin: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}>;

type Props = Readonly<{
  api: ClientApi;
  origins?: readonly string[];
}>;

export function ExtensionInstallations({ api, origins = [] }: Props) {
  const [installations, setInstallations] = useState<readonly Installation[]>([]);
  const [configuredOrigins, setConfiguredOrigins] = useState(origins);
  const [origin, setOrigin] = useState(origins[0] ?? "");
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    const response = await api<{
      installations: readonly Installation[];
      configuredOrigins?: readonly string[];
    }>(
      "/api/extension/installations",
    );
    setInstallations(response.installations);
    if (response.configuredOrigins) {
      setConfiguredOrigins(response.configuredOrigins);
      setOrigin((selected) =>
        response.configuredOrigins!.includes(selected)
          ? selected
          : (response.configuredOrigins![0] ?? ""),
      );
    }
  }, [api]);

  useEffect(() => {
    refresh().catch(() => setMessage("Failed to load extension installations."));
  }, [refresh]);

  async function createPairingCode() {
    setBusy(true);
    setMessage("");
    try {
      const response = await createExtensionPairingCode(api, origin);
      setPairingCode(response.code);
      setExpiresAt(response.expiresAt);
    } catch {
      setMessage("Failed to create pairing code.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    setMessage("");
    try {
      await revokeExtensionInstallation(api, id);
      await refresh();
    } catch {
      setMessage("Failed to revoke extension installation.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bg-gray-900 rounded-lg p-6 max-w-lg mt-6">
      <h2 className="text-sm font-medium text-gray-400 uppercase mb-4">
        Chrome extension installations
      </h2>
      <p className="text-xs text-gray-500 mb-4">
        Create a ten-minute, one-time pairing code for a configured extension.
      </p>

      <div className="flex gap-2 mb-4">
        <select
          aria-label="Extension origin"
          value={origin}
          onChange={(event) => setOrigin(event.target.value)}
          className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-xs"
        >
          {configuredOrigins.map((configuredOrigin) => (
            <option key={configuredOrigin} value={configuredOrigin}>
              {configuredOrigin}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy || origin === ""}
          onClick={createPairingCode}
          className="px-3 py-2 bg-blue-600 text-white text-xs rounded disabled:opacity-50"
        >
          Create pairing code
        </button>
      </div>

      {pairingCode && (
        <div className="bg-gray-800 border border-blue-700 rounded p-3 mb-4">
          <p className="text-xs text-gray-400 mb-2">
            Shown once. Expires {expiresAt ? new Date(expiresAt).toLocaleString() : "soon"}.
          </p>
          <code className="block break-all text-sm text-blue-300">{pairingCode}</code>
          <button
            type="button"
            aria-label="Dismiss pairing code"
            onClick={() => {
              setPairingCode(null);
              setExpiresAt(null);
            }}
            className="mt-3 text-xs text-gray-400 hover:text-white"
          >
            Dismiss
          </button>
        </div>
      )}

      {installations.length === 0 ? (
        <p className="text-xs text-gray-500">No extension installations yet.</p>
      ) : (
        <ul className="space-y-2">
          {installations.map((installation) => (
            <li key={installation.id} className="bg-gray-800 rounded p-3 text-xs">
              <div className="break-all text-gray-300">{installation.origin}</div>
              <div className="text-gray-500 mt-1">
                {installation.revokedAt
                  ? "Revoked"
                  : `Expires ${new Date(installation.expiresAt).toLocaleDateString()}`}
              </div>
              {!installation.revokedAt && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => revoke(installation.id)}
                  className="mt-2 text-red-400 hover:text-red-300 disabled:opacity-50"
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {message && <p role="alert" className="text-xs text-red-400 mt-3">{message}</p>}
    </section>
  );
}

export function createExtensionPairingCode(api: ClientApi, origin: string) {
  return api<{ code: string; expiresAt: string }>("/api/extension/pairing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ origin }),
  });
}

export async function revokeExtensionInstallation(
  api: ClientApi,
  id: string,
): Promise<void> {
  await api(`/api/extension/installations/${id}`, { method: "DELETE" });
}
