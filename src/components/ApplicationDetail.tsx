"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Application {
  id: string;
  url: string;
  jobTitle: string;
  company: string;
  status: string;
  appliedDate: string;
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
    notes: application.notes || "",
    salary: application.salary || "",
    location: application.location || "",
    jobType: application.jobType || "",
  });
  const [saving, setSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleSave() {
    setSaving(true);
    await fetch(`/api/applications/${application.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setSaving(false);
    router.refresh();
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
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save Changes"}
        </button>

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
