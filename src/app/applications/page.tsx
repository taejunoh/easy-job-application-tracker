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
  const [refreshRevision, setRefreshRevision] = useState(0);
  const requestSequence = useRef(0);
  const mounted = useRef(false);

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
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestSequence.current += 1;
    };
  }, []);

  useEffect(() => {
    void refreshApplications();
  }, [refreshApplications, refreshRevision]);

  async function handleStatusChange(id: string, status: string) {
    setError("");
    try {
      await updateApplicationStatus(
        api,
        () => {
          if (mounted.current) {
            setRefreshRevision((revision) => revision + 1);
          }
        },
        id,
        status,
      );
    } catch (failure) {
      setError(errorMessage(failure, "Failed to update application status."));
    }
  }

  return (
    <div className="applications-page" aria-busy={loading}>
      <header className="page-header">
        <p className="eyebrow">Your opportunity log</p>
        <h1 className="page-title">Applications</h1>
        <p className="page-subtitle">Keep every application, conversation, and next step in view.</p>
      </header>

      <div className="applications-toolbar card">
        <label className="filter-field filter-search">
          <span className="input-label">Search applications</span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by title or company"
            className="field"
          />
        </label>
        <label className="filter-field">
          <span className="input-label">Status</span>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="field">
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s === "All" ? "All statuses" : s}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          <span className="input-label">Job type</span>
          <select value={jobTypeFilter} onChange={(e) => setJobTypeFilter(e.target.value)} className="field">
            {JOB_TYPES.map((t) => (
              <option key={t} value={t}>
                {t === "All" ? "All types" : t}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <div role="alert" className="inline-alert mb-4">
          {error}
        </div>
      )}

      {loading && <p className="loading-state" role="status">Loading applications…</p>}

      <ApplicationTable
        applications={applications}
        onStatusChange={handleStatusChange}
      />
      <style>{`
        .applications-toolbar { align-items: end; display: grid; gap: 0.8rem; grid-template-columns: minmax(0, 1.6fr) repeat(2, minmax(9rem, 0.7fr)); margin-bottom: 1rem; padding: 0.9rem 1rem 1rem; }
        .applications-toolbar .field { background: var(--surface); border: 1px solid var(--border); border-radius: 0.5rem; color: var(--text); padding: 0.55rem 0.7rem; width: 100%; }
        .applications-toolbar .field::placeholder { color: var(--muted); opacity: 1; }
        .applications-toolbar .field:focus-visible { border-color: var(--primary); outline: 3px solid var(--primary); outline-offset: 2px; }
        @media (max-width: 768px) {
          .applications-toolbar { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}

export async function updateApplicationStatus(
  api: ClientApi,
  scheduleRefresh: () => void,
  id: string,
  status: string,
): Promise<void> {
  await api(`/api/applications/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  scheduleRefresh();
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
