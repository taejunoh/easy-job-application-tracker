"use client";

import { useEffect, useState } from "react";

import { useClientApi } from "@/hooks/use-client-api";
import type { ClientApi } from "@/lib/client-api";
import { RESUME_UPLOAD_FIELD } from "@/lib/resume/constants";
import { ExtensionInstallations } from "@/components/ExtensionInstallations";

const PROVIDERS = [
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Google Gemini" },
  { value: "anthropic", label: "Anthropic" },
];

export default function SettingsPage() {
  const api = useClientApi();
  const [provider, setProvider] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  const [hasExistingKey, setHasExistingKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [githubUrl, setGithubUrl] = useState("");
  const [resumeText, setResumeText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);

  useEffect(() => {
    api<SettingsResponse>("/api/settings?includeResume=true")
      .then((data) => {
        setProvider(data.llmProvider);
        setHasExistingKey(data.hasApiKey);
        setLinkedinUrl(data.linkedinUrl || "");
        setGithubUrl(data.githubUrl || "");
        setResumeText(data.resumeText || "");
      })
      .catch((failure: unknown) => {
        setMessage(errorMessage(failure, "Failed to load settings."));
        setMessageIsError(true);
      });
  }, [api]);

  async function handleSave() {
    setSaving(true);
    setMessage("");
    setMessageIsError(false);

    const body: Record<string, string> = {
      llmProvider: provider,
      linkedinUrl,
      githubUrl,
      resumeText,
    };
    if (apiKey.trim()) body.apiKey = apiKey;

    try {
      await saveSettings(api, (savedHasApiKey) => {
        setMessage("Settings saved.");
        setMessageIsError(false);
        setHasExistingKey(savedHasApiKey);
        setApiKey("");
      }, body);
    } catch (failure) {
      setMessage(errorMessage(failure, "Failed to save settings."));
      setMessageIsError(true);
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setMessage("");
    setMessageIsError(false);

    try {
      await api("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      });
      setMessage("Connection successful. LLM provider is working.");
      setMessageIsError(false);
    } catch (failure) {
      setMessage(errorMessage(failure, "Test failed. Could not connect."));
      setMessageIsError(true);
    }

    setTesting(false);
  }

  return (
    <div className="settings-page">
      <header className="page-header">
        <p className="eyebrow">Workspace preferences</p>
        <h1 className="page-title">Settings</h1>
      </header>

      <div className="settings-card card">
        <h2 className="panel-heading">
          LLM Provider
        </h2>

        <div className="settings-field">
          <label htmlFor="settings-provider" className="input-label">Provider</label>
          <select
            id="settings-provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="field"
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-field">
          <label htmlFor="settings-api-key" className="input-label">
            API Key {hasExistingKey && "(key saved - enter new to replace)"}
          </label>
          <div className="settings-key-row">
            <input
              id="settings-api-key"
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasExistingKey ? "Enter new key to replace" : "Enter your API key"}
              className="field"
            />
            <button
              onClick={() => setShowKey(!showKey)}
              className="secondary-button settings-visibility-button"
            >
              {showKey ? "Hide" : "Show"}
            </button>
          </div>
        </div>

        {/* Current status */}
        {hasExistingKey && (
          <div className="settings-status">
            <div className="input-label">Current Configuration</div>
            <div className="settings-status-value">
              {PROVIDERS.find((p) => p.value === provider)?.label || provider}
              <span className="status-ok">-- API key configured</span>
            </div>
          </div>
        )}

        <hr className="border-gray-700 my-6" />

        <h2 className="panel-heading">
          Profile URLs
        </h2>
        <p className="panel-copy">
          Used by the extension to auto-fill application forms.
        </p>

        <div className="settings-field">
          <label htmlFor="settings-linkedin" className="input-label">LinkedIn Profile</label>
          <input
            id="settings-linkedin"
            type="url"
            value={linkedinUrl}
            onChange={(e) => setLinkedinUrl(e.target.value)}
            placeholder="https://linkedin.com/in/yourprofile"
            className="field"
          />
        </div>

        <div className="settings-field">
          <label htmlFor="settings-github" className="input-label">GitHub Profile</label>
          <input
            id="settings-github"
            type="url"
            value={githubUrl}
            onChange={(e) => setGithubUrl(e.target.value)}
            placeholder="https://github.com/yourusername"
            className="field"
          />
        </div>

        <hr className="border-gray-700 my-6" />

        <h2 className="panel-heading">
          Resume
        </h2>
        <p className="panel-copy">
          Upload your resume file or paste text to compare keywords against job descriptions.
        </p>

        <div className="settings-field">
          <label className="upload-control">
            <span>{uploading ? "Parsing..." : "Upload Resume (.pdf, .txt)"}</span>
            <input
              type="file"
              accept=".pdf,.txt"
              className="hidden"
              disabled={uploading}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setUploading(true);
                setMessage("");
                setMessageIsError(false);
                try {
                  const formData = new FormData();
                  formData.append(RESUME_UPLOAD_FIELD, file);
                  const data = await api<{ text: string }>("/api/parse-resume", {
                    method: "POST",
                    body: formData,
                  });
                  setResumeText(data.text);
                  setMessage("Resume parsed. Click Save Settings to keep it.");
                  setMessageIsError(false);
                } catch (failure) {
                  setMessage(errorMessage(failure, "Failed to parse resume file."));
                  setMessageIsError(true);
                }
                setUploading(false);
                e.target.value = "";
              }}
            />
          </label>
        </div>

        <div className="settings-field">
          <label htmlFor="settings-resume" className="sr-only">Resume text</label>
          <textarea
            id="settings-resume"
            value={resumeText}
            onChange={(e) => setResumeText(e.target.value)}
            placeholder="Or paste your resume text here..."
            rows={10}
            className="field resume-textarea"
          />
        </div>

        <div className="settings-actions">
          <button
            onClick={handleSave}
            disabled={saving}
            className="primary-button"
          >
            {saving ? "Saving..." : "Save Settings"}
          </button>
          <button
            onClick={handleTest}
            disabled={testing || !hasExistingKey}
            className="secondary-button"
          >
            {testing ? "Testing..." : "Test Connection"}
          </button>
        </div>

        {message && (
          <div
            role={messageIsError ? "alert" : "status"}
            className={`mt-3 text-sm ${messageIsError ? "text-red-400" : "text-gray-300"}`}
          >
            {message}
          </div>
        )}
      </div>
      <ExtensionInstallations api={api} />
      <style>{settingsStyles}</style>
    </div>
  );
}

const settingsStyles = `
.settings-card { max-width: 46rem; padding: clamp(1rem, 3vw, 1.6rem); }
.settings-field { margin-top: 1rem; min-width: 0; }
.settings-key-row { align-items: stretch; display: flex; gap: 0.5rem; min-width: 0; }
.settings-key-row .field { flex: 1 1 auto; min-width: 0; }
.settings-card > .panel-heading:not(:first-child) { border-top: 1px solid var(--border); margin-top: 1.5rem; padding-top: 1.5rem; }
.settings-status { background: #f2f5f0; border: 1px solid var(--border); border-radius: 0.5rem; margin-top: 1rem; padding: 0.8rem; }
.settings-status-value { color: var(--text); font-size: 0.9rem; }
.status-ok { color: #245e3a; font-size: 0.8rem; margin-left: 0.5rem; }
.settings-card .field { background: var(--surface); color: var(--text); }
.settings-card .field::placeholder { color: var(--muted); opacity: 1; }
.settings-card .secondary-button { background: var(--surface); border: 1px solid var(--border); color: var(--text); min-height: 44px; min-width: 44px; }
.settings-visibility-button { flex: 0 0 44px; padding-left: 0.25rem; padding-right: 0.25rem; width: 44px; }
.settings-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1rem; }
.upload-control { align-items: center; background: #eef4ef; border: 1px solid #b9cec3; border-radius: 0.5rem; color: var(--primary); cursor: pointer; display: inline-flex; font-size: 0.85rem; font-weight: 700; min-height: 44px; padding: 0.6rem 0.8rem; }
.resume-textarea { line-height: 1.5; resize: vertical; }
`;

interface SettingsResponse {
  llmProvider: string;
  hasApiKey: boolean;
  linkedinUrl?: string | null;
  githubUrl?: string | null;
  resumeText?: string | null;
}

export async function saveSettings(
  api: ClientApi,
  markSaved: (hasApiKey: boolean) => void,
  body: Record<string, string>,
): Promise<void> {
  const response = await api<{ hasApiKey?: unknown }>("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  markSaved(
    response.hasApiKey === true || Boolean(body.apiKey?.trim()),
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
