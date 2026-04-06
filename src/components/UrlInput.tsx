"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface ExtractedData {
  url: string;
  jobTitle: string;
  company: string;
  warning?: string;
}

export default function UrlInput() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [extracted, setExtracted] = useState<ExtractedData | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editCompany, setEditCompany] = useState("");
  const router = useRouter();

  async function handleExtract(e: React.FormEvent) {
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
        throw new Error("Failed to extract job data");
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
          url: extracted?.url || url.trim(),
          jobTitle: editTitle.trim(),
          company: editCompany.trim(),
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to save application");
      }

      setUrl("");
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
      <form onSubmit={handleExtract} className="flex items-center gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste job URL here..."
          className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
          disabled={loading || extracted !== null}
        />
        {!extracted ? (
          <button
            type="submit"
            disabled={loading || !url.trim()}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Extracting..." : "+ Add"}
          </button>
        ) : null}
      </form>

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
