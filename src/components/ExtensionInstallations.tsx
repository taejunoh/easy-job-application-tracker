"use client";

import { useCallback, useEffect, useReducer, useState } from "react";

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

export type PairingSecret = Readonly<{
  code: string;
  expiresAt: string;
}>;

type PairingSecretAction =
  | Readonly<{ type: "issued"; code: string; expiresAt: string }>
  | Readonly<{ type: "dismissed" }>;

export function pairingSecretReducer(
  _state: PairingSecret | null,
  action: PairingSecretAction,
): PairingSecret | null {
  return action.type === "issued"
    ? { code: action.code, expiresAt: action.expiresAt }
    : null;
}

export function PairingCodePanel({
  secret,
  onDismiss,
}: Readonly<{
  secret: PairingSecret | null;
  onDismiss: () => void;
}>) {
  if (secret === null) return null;
  return (
    <div className="pairing-secret-panel">
      <p className="panel-copy">
        Shown once. Expires {new Date(secret.expiresAt).toLocaleString()}.
      </p>
      <code className="pairing-secret">{secret.code}</code>
      <button
        type="button"
        aria-label="Dismiss pairing code"
        onClick={onDismiss}
        className="secondary-button pairing-dismiss"
      >
        Dismiss
      </button>
    </div>
  );
}

export function ExtensionInstallations({ api, origins = [] }: Props) {
  const [installations, setInstallations] = useState<readonly Installation[]>([]);
  const [configuredOrigins, setConfiguredOrigins] = useState(origins);
  const [origin, setOrigin] = useState(origins[0] ?? "");
  const [pairingSecret, dispatchPairingSecret] = useReducer(
    pairingSecretReducer,
    null,
  );
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
    dispatchPairingSecret({ type: "dismissed" });
    try {
      const response = await createExtensionPairingCode(api, origin);
      dispatchPairingSecret({
        type: "issued",
        code: response.code,
        expiresAt: response.expiresAt,
      });
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
    <section
      id="extension-installations"
      aria-labelledby="extension-installations-heading"
      className="extension-installations card"
    >
      <h2 id="extension-installations-heading" className="panel-heading">
        Chrome extension installations
      </h2>
      <p className="panel-copy">
        Create a ten-minute, one-time pairing code for a configured extension.
      </p>

      <div className="extension-controls">
        <label htmlFor="extension-origin" className="field-label">
          <span className="input-label">Extension origin</span>
          <select
            id="extension-origin"
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
            className="field"
          >
            {configuredOrigins.map((configuredOrigin) => (
              <option key={configuredOrigin} value={configuredOrigin}>
                {configuredOrigin}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={busy || origin === ""}
          onClick={createPairingCode}
          className="primary-button"
        >
          Create pairing code
        </button>
      </div>

      <PairingCodePanel
        secret={pairingSecret}
        onDismiss={() => dispatchPairingSecret({ type: "dismissed" })}
      />

      {installations.length === 0 ? (
        <p className="panel-copy">No extension installations yet.</p>
      ) : (
        <ul className="space-y-2">
          {installations.map((installation) => (
            <li key={installation.id} className="installation-item">
              <div className="installation-origin">{installation.origin}</div>
              <div className="installation-id">
                Installation ID <code>{installation.id}</code>
              </div>
              <div className="installation-status">
                {installation.revokedAt
                  ? "Revoked"
                  : `Expires ${new Date(installation.expiresAt).toLocaleDateString()}`}
              </div>
              {!installation.revokedAt && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => revoke(installation.id)}
                  className="danger-link"
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {message && <p role="alert" className="inline-alert">{message}</p>}
      <style>{extensionInstallationsStyles}</style>
    </section>
  );
}

const extensionInstallationsStyles = `
.extension-installations { margin-top: 1.25rem; max-width: 46rem; padding: clamp(1rem, 3vw, 1.6rem); }
.extension-controls { align-items: end; display: grid; gap: 0.75rem; grid-template-columns: minmax(0, 1fr) auto; margin-top: 1rem; }
.extension-installations .field { background: var(--surface); color: var(--text); min-width: 0; }
.extension-installations ul { list-style: none; margin: 1rem 0 0; padding: 0; }
.extension-installations .primary-button { white-space: nowrap; }
.pairing-secret-panel { background: #eef4ef; border: 1px solid #b9cec3; border-radius: 0.5rem; margin: 1rem 0; padding: 0.9rem; }
.pairing-secret { color: var(--primary); display: block; font-size: 0.9rem; overflow-wrap: anywhere; }
.pairing-dismiss { margin-top: 0.65rem; }
.installation-item { background: #f7f8f4; border: 1px solid var(--border); border-radius: 0.5rem; list-style: none; margin-top: 0.65rem; padding: 0.85rem; }
.installation-origin, .installation-id, .installation-status { overflow-wrap: anywhere; }
.installation-origin { color: var(--text); font-size: 0.9rem; font-weight: 700; }
.installation-id, .installation-status { color: var(--muted); font-size: 0.78rem; margin-top: 0.35rem; }
.extension-installations .danger-link { font-size: 0.8rem; min-height: 44px; }
.extension-installations .inline-alert { margin-top: 0.8rem; padding: 0.65rem 0.8rem; }
@media (max-width: 560px) { .extension-controls { grid-template-columns: 1fr; } .extension-installations .primary-button { width: 100%; } }
`;

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
