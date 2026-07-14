"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import ApplicationTable from "@/components/ApplicationTable";
import { useClientApi } from "@/hooks/use-client-api";
import type { ClientApi } from "@/lib/client-api";

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
  const api = useClientApi();
  const [applications, setApplications] = useState<Application[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [jobTypeFilter, setJobTypeFilter] = useState("All");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const requestSequence = useRef(0);

  const loadApplications = useCallback(() => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (statusFilter !== "All") params.set("status", statusFilter);
    if (jobTypeFilter !== "All") params.set("jobType", jobTypeFilter);

    return api<Application[]>(`/api/applications?${params}`);
  }, [api, search, statusFilter, jobTypeFilter]);

  const refreshApplications = useCallback(async () => {
    await loadLatestApplications(
      requestSequence,
      loadApplications,
      (data) => {
        setApplications(data);
        setError("");
      },
      (failure) => {
        setError(errorMessage(failure, "Failed to load applications."));
      },
      setLoading,
    );
  }, [loadApplications]);
  const activeRefresh = useRef(refreshApplications);

  useEffect(() => {
    activeRefresh.current = refreshApplications;
  }, [refreshApplications]);

  useEffect(() => {
    void refreshApplications();
  }, [refreshApplications]);

  async function handleStatusChange(id: string, status: string) {
    setError("");
    try {
      await updateApplicationStatus(api, activeRefresh, id, status);
    } catch (failure) {
      setError(errorMessage(failure, "Failed to update application status."));
    }
  }

  return (
    <div aria-busy={loading}>
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

      {error && (
        <div role="alert" className="mb-4 text-sm text-red-400">
          {error}
        </div>
      )}

      <ApplicationTable
        applications={applications}
        onStatusChange={handleStatusChange}
      />
    </div>
  );
}

export async function updateApplicationStatus(
  api: ClientApi,
  activeRefresh:
    | (() => void | Promise<void>)
    | { current: () => void | Promise<void> },
  id: string,
  status: string,
): Promise<void> {
  await api(`/api/applications/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  const refresh =
    typeof activeRefresh === "function"
      ? activeRefresh
      : activeRefresh.current;
  await refresh();
}

export async function loadLatestApplications<T>(
  sequence: { current: number },
  request: () => Promise<T>,
  apply: (data: T) => void,
  fail: (error: unknown) => void,
  setLoading: (loading: boolean) => void,
): Promise<void> {
  const requestId = ++sequence.current;
  setLoading(true);
  try {
    const data = await request();
    if (requestId === sequence.current) apply(data);
  } catch (error) {
    if (requestId === sequence.current) fail(error);
  } finally {
    if (requestId === sequence.current) setLoading(false);
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
