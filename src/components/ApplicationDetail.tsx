"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { analyzeKeywordMatch } from "@/lib/keyword-matcher";

interface Application {
  id: string;
  url: string;
  jobTitle: string;
  company: string;
  status: string;
  appliedDate: string;
  description: string | null;
  notes: string | null;
  salary: string | null;
  location: string | null;
  jobType: string | null;
}

const STATUSES = ["Applied", "Interview", "Offer", "Rejected"];
const JOB_TYPES = ["", "Remote", "Hybrid", "Onsite"];

interface ApplicationDetailProps {
  application: Application;
}

export default function ApplicationDetail({
  application,
}: ApplicationDetailProps) {
  const router = useRouter();
  const [form, setForm] = useState({
    jobTitle: application.jobTitle,
    company: application.company,
    status: application.status,
    description: application.description || "",
    notes: application.notes || "",
    salary: application.salary || "",
    location: application.location || "",
    jobType: application.jobType || "",
  });
  const [saving, setSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [saved, setSaved] = useState(false);
  const [resumeText, setResumeText] = useState<string | null>(null);
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [debouncedDescription, setDebouncedDescription] = useState(form.description);

  useEffect(() => {
    fetch("/api/settings?includeResume=true")
      .then((res) => res.json())
      .then((data) => setResumeText(data.resumeText || ""))
      .catch(() => setResumeText(""));
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedDescription(form.description), 300);
    return () => clearTimeout(timer);
  }, [form.description]);

  const keywordAnalysis = useMemo(() => {
    if (!debouncedDescription || !resumeText) return null;
    return analyzeKeywordMatch(debouncedDescription, resumeText);
  }, [debouncedDescription, resumeText]);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    const res = await fetch(`/api/applications/${application.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setSaving(false);
    if (res.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    await fetch(`/api/applications/${application.id}`, { method: "DELETE" });
    router.push("/applications");
  }

  function updateField(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  return (
    <div>
      <button
        onClick={() => router.push("/applications")}
        className="text-sm text-gray-400 hover:text-gray-200 mb-4 inline-block"
      >
        &larr; Back to Applications
      </button>

      <div className="flex items-start justify-between mb-6">
        <div>
          <input
            value={form.jobTitle}
            onChange={(e) => updateField("jobTitle", e.target.value)}
            className="text-xl font-semibold bg-transparent border-b border-transparent hover:border-gray-700 focus:border-blue-500 focus:outline-none text-gray-100 w-full"
          />
          <input
            value={form.company}
            onChange={(e) => updateField("company", e.target.value)}
            className="text-sm bg-transparent border-b border-transparent hover:border-gray-700 focus:border-blue-500 focus:outline-none text-gray-400 mt-1 w-full"
          />
        </div>
        <select
          value={form.status}
          onChange={(e) => updateField("status", e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1 text-sm text-gray-300 focus:outline-none"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <div>
          <label className="text-xs text-gray-500 uppercase block mb-1">
            Date Applied
          </label>
          <div className="text-gray-200">
            {new Date(application.appliedDate).toLocaleDateString()}
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-500 uppercase block mb-1">
            Location
          </label>
          <input
            value={form.location}
            onChange={(e) => updateField("location", e.target.value)}
            placeholder="e.g., San Francisco, CA"
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100 w-full focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="text-xs text-gray-500 uppercase block mb-1">
            Salary Range
          </label>
          <input
            value={form.salary}
            onChange={(e) => updateField("salary", e.target.value)}
            placeholder="e.g., $120k - $160k"
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100 w-full focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="text-xs text-gray-500 uppercase block mb-1">
            Job Type
          </label>
          <select
            value={form.jobType}
            onChange={(e) => updateField("jobType", e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-300 w-full focus:outline-none"
          >
            {JOB_TYPES.map((t) => (
              <option key={t} value={t} className="bg-gray-900">
                {t || "Not specified"}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mb-6">
        <label className="text-xs text-gray-500 uppercase block mb-1">
          Job Description
        </label>
        <textarea
          value={form.description}
          onChange={(e) => updateField("description", e.target.value)}
          placeholder="Paste the job description here..."
          rows={6}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 w-full focus:outline-none focus:border-blue-500 resize-y"
        />
      </div>

      {/* Keyword Match Analysis */}
      {form.description && resumeText === "" && (
        <div className="mb-6 bg-gray-800 border border-gray-700 rounded-lg p-4">
          <p className="text-sm text-gray-400">
            Add your resume in{" "}
            <button
              onClick={() => router.push("/settings")}
              className="text-blue-400 hover:underline"
            >
              Settings
            </button>{" "}
            to see keyword match analysis.
          </p>
        </div>
      )}

      {keywordAnalysis && keywordAnalysis.totalJobKeywords > 0 && (
        <div className="mb-6 bg-gray-800 border border-gray-700 rounded-lg overflow-hidden">
          <button
            onClick={() => setShowAnalysis(!showAnalysis)}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-700/50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-gray-200">
                Keyword Match Analysis
              </span>
              <span
                className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                  keywordAnalysis.matchPercentage >= 70
                    ? "bg-green-900/50 text-green-400"
                    : keywordAnalysis.matchPercentage >= 40
                      ? "bg-yellow-900/50 text-yellow-400"
                      : "bg-red-900/50 text-red-400"
                }`}
              >
                {keywordAnalysis.matchPercentage}%
              </span>
            </div>
            <span className="text-gray-500 text-sm">
              {showAnalysis ? "▲" : "▼"}
            </span>
          </button>

          {showAnalysis && (
            <div className="px-4 pb-4 border-t border-gray-700">
              {/* Progress bar */}
              <div className="mt-3 mb-2">
                <div className="w-full bg-gray-700 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full transition-all ${
                      keywordAnalysis.matchPercentage >= 70
                        ? "bg-green-500"
                        : keywordAnalysis.matchPercentage >= 40
                          ? "bg-yellow-500"
                          : "bg-red-500"
                    }`}
                    style={{ width: `${keywordAnalysis.matchPercentage}%` }}
                  />
                </div>
              </div>
              <p className="text-xs text-gray-400 mb-4">
                {keywordAnalysis.matchedKeywords.length} of{" "}
                {keywordAnalysis.totalJobKeywords} keywords matched
              </p>

              {/* Matched Keywords */}
              {keywordAnalysis.matchedKeywords.length > 0 && (
                <div className="mb-3">
                  <h4 className="text-xs text-green-400 font-medium uppercase mb-2">
                    Matched
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {keywordAnalysis.matchedKeywords.map((k) => (
                      <span
                        key={k.keyword}
                        className="text-xs px-2 py-1 rounded bg-green-900/30 text-green-300 border border-green-800/50"
                      >
                        {k.keyword}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Missing Keywords */}
              {keywordAnalysis.missingKeywords.length > 0 && (
                <div>
                  <h4 className="text-xs text-red-400 font-medium uppercase mb-2">
                    Missing
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {keywordAnalysis.missingKeywords.map((k) => (
                      <span
                        key={k.keyword}
                        className="text-xs px-2 py-1 rounded bg-red-900/30 text-red-300 border border-red-800/50"
                      >
                        {k.keyword}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="mb-6">
        <label className="text-xs text-gray-500 uppercase block mb-1">
          Notes
        </label>
        <textarea
          value={form.notes}
          onChange={(e) => updateField("notes", e.target.value)}
          placeholder="Add notes about this application..."
          rows={4}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 w-full focus:outline-none focus:border-blue-500 resize-none"
        />
      </div>

      <div className="mb-6">
        <label className="text-xs text-gray-500 uppercase block mb-1">
          Source URL
        </label>
        <a
          href={application.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 text-sm hover:underline break-all"
        >
          {application.url}
        </a>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Changes"}
          </button>
          {saved && (
            <span className="text-green-400 text-sm">Saved</span>
          )}
        </div>

        {showDeleteConfirm ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-400">Are you sure?</span>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-3 py-1.5 bg-red-600 text-white text-xs rounded hover:bg-red-700"
            >
              {deleting ? "Deleting..." : "Yes, Delete"}
            </button>
            <button
              onClick={() => setShowDeleteConfirm(false)}
              className="px-3 py-1.5 bg-gray-700 text-gray-300 text-xs rounded hover:bg-gray-600"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="px-3 py-1.5 text-red-400 text-xs hover:text-red-300"
          >
            Delete Application
          </button>
        )}
      </div>
    </div>
  );
}
