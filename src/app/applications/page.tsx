"use client";

import { Suspense, useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ApplicationTable from "@/components/ApplicationTable";
import PageHeader from "@/components/PageHeader";
import { useClientApi } from "@/hooks/use-client-api";
import type { ClientApi } from "@/lib/client-api";
import { displayJobType } from "@/lib/location";
import {
  ATTENTION_PARAM,
  STALE_AFTER_DAYS,
  filterStaleApplications,
  parseAttentionFilter,
} from "@/lib/attention";

interface Application {
  id: string;
  jobTitle: string;
  company: string;
  status: string;
  appliedDate: string;
  updatedAt?: string | null;
  location: string | null;
  jobType: string | null;
}

const STATUSES = ["All", "Applied", "Interview", "Offer", "Rejected"];
const JOB_TYPES = ["All", "Remote", "Hybrid", "Onsite"];

export default function ApplicationsPage() {
  return (
    <Suspense fallback={null}>
      <ApplicationsView />
    </Suspense>
  );
}

function ApplicationsView() {
  const api = useClientApi();
  const router = useRouter();
  const searchParams = useSearchParams();
  const attention = parseAttentionFilter(searchParams.get(ATTENTION_PARAM));
  const [applications, setApplications] = useState<Application[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState(() => initialStatus(searchParams.get("status")));
  const [now] = useState(() => new Date());
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
    else if (attention) params.set("status", "Applied");
    // Remote also matches rows with no stored type whose location says remote,
    // which the server cannot filter on, so that case filters on the client.
    if (jobTypeFilter !== "All" && jobTypeFilter !== "Remote") {
      params.set("jobType", jobTypeFilter);
    }

    return api<Application[]>(`/api/applications?${params}`);
  }, [api, search, statusFilter, jobTypeFilter, attention]);

  const visibleApplications = useMemo(() => {
    const byAttention = attention ? filterStaleApplications(applications, now) : applications;
    return jobTypeFilter === "Remote"
      ? byAttention.filter((application) => displayJobType(application) === "Remote")
      : byAttention;
  }, [applications, attention, now, jobTypeFilter]);

  function clearAttentionFilter() {
    const next = new URLSearchParams(searchParams.toString());
    next.delete(ATTENTION_PARAM);
    const query = next.toString();
    router.replace(query ? `/applications?${query}` : "/applications");
  }

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
      <PageHeader
        eyebrow="Your opportunity log"
        title="Applications"
        subtitle="Keep every application, conversation, and next step in view."
      />

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

      {attention && (
        <div className="attention-filter" role="status">
          <span>
            Showing stale applications: still Applied after {STALE_AFTER_DAYS}+ days.
          </span>
          <button type="button" className="secondary-button" onClick={clearAttentionFilter}>
            Clear filter
          </button>
        </div>
      )}

      {error && (
        <div role="alert" className="inline-alert mb-4">
          {error}
        </div>
      )}

      {loading && <p className="loading-state" role="status">Loading applications…</p>}

      <ApplicationTable
        applications={visibleApplications}
        onStatusChange={handleStatusChange}
      />
      <style>{`
        .applications-toolbar { align-items: end; display: grid; gap: 0.8rem; grid-template-columns: minmax(0, 1.6fr) repeat(2, minmax(9rem, 0.7fr)); margin-bottom: 1rem; padding: 0.9rem 1rem 1rem; }
        .applications-toolbar .field { background: var(--surface); border: 1px solid var(--border); border-radius: 0.5rem; color: var(--text); padding: 0.55rem 0.7rem; width: 100%; }
        .applications-toolbar .field::placeholder { color: var(--muted); opacity: 1; }
        .applications-toolbar .field:focus-visible { border-color: var(--primary); outline: 3px solid var(--primary); outline-offset: 2px; }
        .attention-filter { align-items: center; background: #fbf0df; border: 1px solid #d9ad6d; border-radius: 0.5rem; color: #81551d; display: flex; flex-wrap: wrap; gap: 0.75rem; justify-content: space-between; margin-bottom: 1rem; padding: 0.5rem 0.5rem 0.5rem 1rem; }
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

function initialStatus(value: string | null): string {
  return value !== null && STATUSES.includes(value) ? value : "All";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
