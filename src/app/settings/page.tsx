"use client";

import { useEffect, useState } from "react";

const PROVIDERS = [
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Google Gemini" },
  { value: "anthropic", label: "Anthropic" },
];

export default function SettingsPage() {
  const [provider, setProvider] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  const [hasExistingKey, setHasExistingKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        setProvider(data.llmProvider);
        setHasExistingKey(data.hasApiKey);
      });
  }, []);

  async function handleSave() {
    setSaving(true);
    setMessage("");

    const body: Record<string, string> = { llmProvider: provider };
    if (apiKey) body.apiKey = apiKey;

    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      setMessage("Settings saved.");
      setHasExistingKey(true);
      setApiKey("");
    } else {
      setMessage("Failed to save settings.");
    }

    setSaving(false);
  }

  async function handleTest() {
    setTesting(true);
    setMessage("");

    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      });

      if (res.ok) {
        setMessage("Connection successful. LLM provider is working.");
      } else {
        setMessage("Test failed. Check your API key and provider.");
      }
    } catch {
      setMessage("Test failed. Could not connect.");
    }

    setTesting(false);
  }

  return (
    <div>
      <h1 className="text-xl font-semibold mb-6">Settings</h1>

      <div className="bg-gray-900 rounded-lg p-6 max-w-lg">
        <h2 className="text-sm font-medium text-gray-400 uppercase mb-4">
          LLM Provider
        </h2>

        <div className="mb-4">
          <label className="text-xs text-gray-500 block mb-1">Provider</label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-300 w-full focus:outline-none"
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <div className="mb-4">
          <label className="text-xs text-gray-500 block mb-1">
            API Key {hasExistingKey && "(key saved - enter new to replace)"}
          </label>
          <div className="flex gap-2">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasExistingKey ? "Enter new key to replace" : "Enter your API key"}
              className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={() => setShowKey(!showKey)}
              className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-gray-400 hover:text-gray-200"
            >
              {showKey ? "Hide" : "Show"}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Settings"}
          </button>
          <button
            onClick={handleTest}
            disabled={testing || !hasExistingKey}
            className="px-4 py-2 bg-gray-700 text-gray-300 text-sm rounded hover:bg-gray-600 disabled:opacity-50"
          >
            {testing ? "Testing..." : "Test Connection"}
          </button>
        </div>

        {message && (
          <div className="mt-3 text-sm text-gray-300">{message}</div>
        )}
      </div>
    </div>
  );
}
