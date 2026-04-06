"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function UrlInput() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;

    setLoading(true);
    setError("");

    try {
      const extractRes = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });

      if (!extractRes.ok) {
        throw new Error("Failed to extract job data");
      }

      const extracted = await extractRes.json();

      const createRes = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: extracted.url,
          jobTitle: extracted.jobTitle || "Unknown Position",
          company: extracted.company || "Unknown Company",
        }),
      });

      if (!createRes.ok) {
        throw new Error("Failed to save application");
      }

      setUrl("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2">
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
      {error && <span className="text-red-400 text-xs">{error}</span>}
    </form>
  );
}
