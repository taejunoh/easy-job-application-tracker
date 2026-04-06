"use client";

import { useEffect, useState, useCallback } from "react";
import ApplicationTable from "@/components/ApplicationTable";

interface Application {
  id: string;
  jobTitle: string;
  company: string;
  status: string;
  appliedDate: string;
  location: string | null;
  jobType: string | null;
}

const STATUSES = ["All", "Applied", "Interview", "Offer", "Rejected"];
const JOB_TYPES = ["All", "Remote", "Hybrid", "Onsite"];

export default function ApplicationsPage() {
  const [applications, setApplications] = useState<Application[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [jobTypeFilter, setJobTypeFilter] = useState("All");

  const fetchApplications = useCallback(() => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (statusFilter !== "All") params.set("status", statusFilter);
    if (jobTypeFilter !== "All") params.set("jobType", jobTypeFilter);

    fetch(`/api/applications?${params}`)
      .then((res) => res.json())
      .then(setApplications);
  }, [search, statusFilter, jobTypeFilter]);

  useEffect(() => {
    fetchApplications();
  }, [fetchApplications]);

  async function handleStatusChange(id: string, status: string) {
    await fetch(`/api/applications/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    fetchApplications();
  }

  return (
    <div>
      <h1 className="text-xl font-semibold mb-6">Applications</h1>

      <div className="flex gap-3 mb-4">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by title or company..."
          className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-300 focus:outline-none"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === "All" ? "All Statuses" : s}
            </option>
          ))}
        </select>
        <select
          value={jobTypeFilter}
          onChange={(e) => setJobTypeFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-300 focus:outline-none"
        >
          {JOB_TYPES.map((t) => (
            <option key={t} value={t}>
              {t === "All" ? "All Types" : t}
            </option>
          ))}
        </select>
      </div>

      <ApplicationTable
        applications={applications}
        onStatusChange={handleStatusChange}
      />
    </div>
  );
}
