"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useClientApi } from "@/hooks/use-client-api";
import type { ClientApi } from "@/lib/client-api";

type InputMode = "url" | "text" | "manual";

interface ExtractedData {
  url: string;
  jobTitle: string;
  company: string;
  warning?: string;
}

interface UrlInputProps {
  manualEntryEnabled?: boolean;
}

export default function UrlInput({ manualEntryEnabled = false }: UrlInputProps) {
  const api = useClientApi();
  const [mode, setMode] = useState<InputMode>("url");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [textUrl, setTextUrl] = useState("");
  const [manualUrl, setManualUrl] = useState("");
  const [manualTitle, setManualTitle] = useState("");
  const [manualCompany, setManualCompany] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const savingRef = useRef(false);
  const [extracted, setExtracted] = useState<ExtractedData | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editCompany, setEditCompany] = useState("");
  const router = useRouter();

  async function handleExtractUrl(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;

    setLoading(true);
    setError("");
    setExtracted(null);

    try {
      const data = await api<ExtractedData>("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      setExtracted(data);
      setEditTitle(data.jobTitle || "");
      setEditCompany(data.company || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleExtractText(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;

    setLoading(true);
    setError("");
    setExtracted(null);

    try {
      const data = await api<ExtractedData>("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim(), url: textUrl.trim() || undefined }),
      });
      setExtracted(data);
      setEditTitle(data.jobTitle || "");
      setEditCompany(data.company || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!editTitle.trim() || !editCompany.trim()) {
      setError("Job title and company are required");
      return;
    }
    const applicationUrl = extracted?.url || textUrl.trim() || url.trim();
    if (!applicationUrl) {
      setError("Job URL is required");
      return;
    }

    setLoading(true);
    setError("");
    setNotice("");

    try {
      const result = await saveNewApplication(
        api,
        () => {
          setUrl("");
          setText("");
          setTextUrl("");
          setManualUrl("");
          setManualTitle("");
          setManualCompany("");
          setExtracted(null);
          setEditTitle("");
          setEditCompany("");
          router.refresh();
        },
        {
          url: applicationUrl,
          jobTitle: editTitle.trim(),
          company: editCompany.trim(),
        },
      );
      setNotice(
        result.result === "existing"
          ? "This application already exists; its saved details were kept."
          : "Application saved.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleManualSave(e: React.FormEvent) {
    e.preventDefault();
    if (loading || savingRef.current) return;

    const application = {
      url: manualUrl.trim(),
      jobTitle: manualTitle.trim(),
      company: manualCompany.trim(),
    };
    const validationError = validateManualApplication(application);
    if (validationError) {
      setError(validationError);
      return;
    }

    savingRef.current = true;
    setLoading(true);
    setError("");
    setNotice("");

    try {
      const result = await saveNewApplication(
        api,
        () => {
          setUrl("");
          setText("");
          setTextUrl("");
          setManualUrl("");
          setManualTitle("");
          setManualCompany("");
          setExtracted(null);
          setEditTitle("");
          setEditCompany("");
          router.refresh();
        },
        application,
      );
      setNotice(
        result.result === "existing"
          ? "This application already exists; its saved details were kept."
          : "Application saved.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      savingRef.current = false;
      setLoading(false);
    }
  }

  function handleCancel() {
    setExtracted(null);
    setEditTitle("");
    setEditCompany("");
    setError("");
  }

  function handleTabKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    const tabs = Array.from(
      event.currentTarget.closest("[role=tablist]")?.querySelectorAll<HTMLButtonElement>("button[role~='tab']:not(:disabled)") ?? [],
    );
    if (!tabs.length) return;
    const currentIndex = tabs.indexOf(event.currentTarget as HTMLButtonElement);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    tabs[nextIndex].focus();
    tabs[nextIndex].click();
  }

  function selectMode(nextMode: InputMode) {
    setMode(nextMode);
    setError("");
    setExtracted(null);
  }

  return (
    <div className="url-input" aria-busy={loading}>
      {/* Mode tabs */}
      <div className="input-tabs" role="tablist" aria-label="Application source">
        <button
          type="button"
          role="tab"
          id="url-tab"
          aria-controls="url-panel"
          aria-selected={mode === "url"}
          aria-disabled={loading}
          tabIndex={loading ? -1 : mode === "url" ? 0 : -1}
          onKeyDown={handleTabKeyDown}
          onClick={() => selectMode("url")}
          disabled={loading}
          className={`input-tab px-3 py-1 text-xs rounded ${
            mode === "url"
              ? "bg-gray-700 text-white"
              : "text-gray-400 hover:text-gray-200"
          }`}
        >
          URL
        </button>
        <button
          type="button"
          role="tab"
          id="text-tab"
          aria-controls="text-panel"
          aria-selected={mode === "text"}
          aria-disabled={loading}
          tabIndex={loading ? -1 : mode === "text" ? 0 : -1}
          onKeyDown={handleTabKeyDown}
          onClick={() => selectMode("text")}
          disabled={loading}
          className={`input-tab px-3 py-1 text-xs rounded ${
            mode === "text"
              ? "bg-gray-700 text-white"
              : "text-gray-400 hover:text-gray-200"
          }`}
        >
          Paste Text
        </button>
        {manualEntryEnabled && (
          <>
          <button
            type="button"
            role="tab"
            id="manual-tab"
            aria-controls="manual-panel"
            aria-selected={mode === "manual"}
            aria-disabled={loading}
            tabIndex={loading ? -1 : mode === "manual" ? 0 : -1}
            onKeyDown={handleTabKeyDown}
            onClick={() => selectMode("manual")}
            disabled={loading}
            className={`input-tab px-3 py-1 text-xs rounded ${
              mode === "manual"
                ? "bg-gray-700 text-white"
                : "text-gray-400 hover:text-gray-200"
            }`}
          >
            Manual
          </button>
          </>
        )}
      </div>

      {/* URL mode */}
      {mode === "url" && !extracted && (
        <form id="url-panel" role="tabpanel" aria-labelledby="url-tab" onSubmit={handleExtractUrl} className="flex items-center gap-2">
          <label className="inline-field-label" htmlFor="url-input">
            <span className="input-label">Job URL</span>
            <input id="url-input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste job URL here..." className="field flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500" disabled={loading} />
          </label>
          <button
            type="submit"
            disabled={loading || !url.trim()}
            className="primary-button px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Extracting..." : "+ Add"}
          </button>
        </form>
      )}

      {/* Text paste mode */}
      {mode === "text" && !extracted && (
        <form id="text-panel" role="tabpanel" aria-labelledby="text-tab" onSubmit={handleExtractText} className="space-y-2">
          <label className="field-label" htmlFor="text-input">
            <span className="input-label">Job description</span>
            <textarea id="text-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the job description text here (copy from LinkedIn, Indeed, etc.)..." rows={4} className="field w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none" disabled={loading} />
          </label>
          <div className="flex items-center gap-2">
            <label className="inline-field-label" htmlFor="text-url-input">
              <span className="input-label">Job URL</span>
              <input id="text-url-input" type="url" value={textUrl} onChange={(e) => setTextUrl(e.target.value)} placeholder="Job URL (required)" className="field flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500" disabled={loading} />
            </label>
            <button
              type="submit"
              disabled={loading || !text.trim()}
              className="primary-button px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "Extracting..." : "Extract"}
            </button>
          </div>
        </form>
      )}

      {/* Manual mode */}
      {manualEntryEnabled && mode === "manual" && (
        <form id="manual-panel" role="tabpanel" aria-labelledby="manual-tab" onSubmit={handleManualSave} className="space-y-2">
          <div className="grid grid-cols-3 gap-2 manual-fields">
            <div>
              <label htmlFor="manual-job-url" className="text-xs text-gray-500 block mb-1">
                Job URL
              </label>
              <input
                id="manual-job-url"
                type="url"
                value={manualUrl}
                onChange={(e) => setManualUrl(e.target.value)}
                placeholder="https://example.com/job"
                className="field w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                disabled={loading}
                required
              />
            </div>
            <div>
              <label htmlFor="manual-job-title" className="text-xs text-gray-500 block mb-1">
                Job Title
              </label>
              <input
                id="manual-job-title"
                value={manualTitle}
                onChange={(e) => setManualTitle(e.target.value)}
                placeholder="Enter job title"
                maxLength={256}
                className="field w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                disabled={loading}
                required
              />
            </div>
            <div>
              <label htmlFor="manual-company" className="text-xs text-gray-500 block mb-1">
                Company
              </label>
              <input
                id="manual-company"
                value={manualCompany}
                onChange={(e) => setManualCompany(e.target.value)}
                placeholder="Enter company name"
                maxLength={256}
                className="field w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                disabled={loading}
                required
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={loading}
            className="primary-button px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Saving..." : "Save Application"}
          </button>
        </form>
      )}

      {/* Confirmation form */}
      {extracted && (
        <div id={`${mode}-panel`} role="tabpanel" aria-labelledby={`${mode}-tab`} className="confirmation-card mt-3 bg-gray-900 border border-gray-700 rounded-lg p-4">
          {extracted.warning && (
            <div className="extracted-warning text-yellow-400 text-xs mb-3">
              {extracted.warning}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 mb-3 confirmation-fields">
            <div>
              <label htmlFor="confirmation-title" className="text-xs text-gray-500 block mb-1">
                Job Title
              </label>
              <input
                id="confirmation-title"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                placeholder="Enter job title"
                className="field w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label htmlFor="confirmation-company" className="text-xs text-gray-500 block mb-1">
                Company
              </label>
              <input
                id="confirmation-company"
                value={editCompany}
                onChange={(e) => setEditCompany(e.target.value)}
                placeholder="Enter company name"
                className="field w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={loading}
              className="primary-button px-3 py-1.5 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? "Saving..." : "Save Application"}
            </button>
            <button
              onClick={handleCancel}
              className="px-3 py-1.5 bg-gray-700 text-gray-300 text-xs rounded hover:bg-gray-600"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="mt-2 text-red-400 text-xs">{error}</div>
      )}
      {notice && (
        <div role="status" className="mt-2 text-green-400 text-xs">{notice}</div>
      )}
    </div>
  );
}

interface NewApplication {
  url: string;
  jobTitle: string;
  company: string;
}

interface NewApplicationResult {
  id: string;
  result: "created" | "existing";
}

export async function saveNewApplication(
  api: ClientApi,
  clearForm: () => void,
  application: NewApplication,
): Promise<NewApplicationResult> {
  const result = await api<NewApplicationResult>("/api/applications", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(application),
  });
  clearForm();
  return result;
}

interface ManualApplication {
  url: string;
  jobTitle: string;
  company: string;
}

function validateManualApplication(application: ManualApplication): string | null {
  if (!application.url) return "Job URL is required";
  if (!application.jobTitle || !application.company) {
    return "Job title and company are required";
  }
  if (
    [...application.jobTitle].length > 256 ||
    [...application.company].length > 256
  ) {
    return "Job title and company must be 256 characters or fewer";
  }
  if (application.url.length > 2048 || /\p{Cc}/u.test(application.url)) {
    return "Job URL must be a valid HTTP or HTTPS URL";
  }

  let parsed: URL;
  try {
    parsed = new URL(application.url);
  } catch {
    return "Job URL must be a valid HTTP or HTTPS URL";
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    return "Job URL must be a valid HTTP or HTTPS URL";
  }
  return null;
}
