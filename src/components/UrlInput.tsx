"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type InputMode = "url" | "text";

interface ExtractedData {
  url: string;
  jobTitle: string;
  company: string;
  warning?: string;
}

export default function UrlInput() {
  const [mode, setMode] = useState<InputMode>("url");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [textUrl, setTextUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
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
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to extract job data");
      }

      const data = await res.json();
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
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim(), url: textUrl.trim() || undefined }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to extract job data");
      }

      const data = await res.json();
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

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: extracted?.url || textUrl.trim() || url.trim() || "",
          jobTitle: editTitle.trim(),
          company: editCompany.trim(),
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to save application");
      }

      setUrl("");
      setText("");
      setTextUrl("");
      setExtracted(null);
      setEditTitle("");
      setEditCompany("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  function handleCancel() {
    setExtracted(null);
    setEditTitle("");
    setEditCompany("");
    setError("");
  }

  return (
    <div>
      {/* Mode tabs */}
      <div className="flex gap-1 mb-2">
        <button
          onClick={() => { setMode("url"); setError(""); setExtracted(null); }}
          className={`px-3 py-1 text-xs rounded ${
            mode === "url"
              ? "bg-gray-700 text-white"
              : "text-gray-400 hover:text-gray-200"
          }`}
        >
          URL
        </button>
        <button
          onClick={() => { setMode("text"); setError(""); setExtracted(null); }}
          className={`px-3 py-1 text-xs rounded ${
            mode === "text"
              ? "bg-gray-700 text-white"
              : "text-gray-400 hover:text-gray-200"
          }`}
        >
          Paste Text
        </button>
      </div>

      {/* URL mode */}
      {mode === "url" && !extracted && (
        <form onSubmit={handleExtractUrl} className="flex items-center gap-2">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste job URL here..."
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading || !url.trim()}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Extracting..." : "+ Add"}
          </button>
        </form>
      )}

      {/* Text paste mode */}
      {mode === "text" && !extracted && (
        <form onSubmit={handleExtractText} className="space-y-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste the job description text here (copy from LinkedIn, Indeed, etc.)..."
            rows={4}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none"
            disabled={loading}
          />
          <div className="flex items-center gap-2">
            <input
              type="url"
              value={textUrl}
              onChange={(e) => setTextUrl(e.target.value)}
              placeholder="Job URL (optional, for reference)"
              className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
              disabled={loading}
            />
            <button
              type="submit"
              disabled={loading || !text.trim()}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "Extracting..." : "Extract"}
            </button>
          </div>
        </form>
      )}

      {/* Confirmation form */}
      {extracted && (
        <div className="mt-3 bg-gray-900 border border-gray-700 rounded-lg p-4">
          {extracted.warning && (
            <div className="text-yellow-400 text-xs mb-3">
              {extracted.warning}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="text-xs text-gray-500 block mb-1">
                Job Title
              </label>
              <input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                placeholder="Enter job title"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">
                Company
              </label>
              <input
                value={editCompany}
                onChange={(e) => setEditCompany(e.target.value)}
                placeholder="Enter company name"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={loading}
              className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 disabled:opacity-50"
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
        <div className="mt-2 text-red-400 text-xs">{error}</div>
      )}
    </div>
  );
}
