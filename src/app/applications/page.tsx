"use client";

import { Suspense, useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ApplicationTable from "@/components/ApplicationTable";
import ApplicationDetail from "@/components/ApplicationDetail";
import { ApplicationBoard, ApplicationCalendar, ApplicationTabs, type ApplicationView } from "@/components/ApplicationViews";
import { useApplicationChanges } from "@/components/ApplicationChanges";
import PageHeader from "@/components/PageHeader";
import { useClientApi } from "@/hooks/use-client-api";
import { localCivilDate } from "@/lib/application-calendar";
import type { ApplicationRecord } from "@/lib/application-record";
import type { ClientApi } from "@/lib/client-api";
import { displayJobType } from "@/lib/location";
import {
  ATTENTION_PARAM,
  STALE_AFTER_DAYS,
  filterStaleApplications,
  parseAttentionFilter,
} from "@/lib/attention";

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
  const { revision: createRevision } = useApplicationChanges();
  const router = useRouter();
  const searchParams = useSearchParams();
  const attention = parseAttentionFilter(searchParams.get(ATTENTION_PARAM));
  const [applications, setApplications] = useState<ApplicationRecord[]>([]);
  const [view, setView] = useState<ApplicationView>("list");
  const [selected, setSelected] = useState<ApplicationRecord | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const recordTrigger = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const restoreViewFocus = useRef(false);
  const draftState = useRef({ dirty: false, busy: false });
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

    return api<ApplicationRecord[]>(`/api/applications?${params}`);
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
        setSelected((current) => current ? data.find(({ id }) => id === current.id) ?? current : current);
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
  }, [refreshApplications, refreshRevision, createRevision]);

  const selectedId = selected?.id;
  useEffect(() => {
    if (selectedId) closeButton.current?.focus();
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId && restoreViewFocus.current) {
      restoreViewFocus.current = false;
      const source = recordTrigger.current;
      if (source?.isConnected && source.getClientRects().length) source.focus();
      else document.getElementById(`application-tab-${view}`)?.focus();
      recordTrigger.current = null;
    }
  }, [selectedId, view]);

  const reportDraftState = useCallback((state: { dirty: boolean; busy: boolean }) => {
    draftState.current = state;
  }, []);

  function canLeaveRecord() {
    return !draftState.current.busy && (!draftState.current.dirty || window.confirm("Discard unsaved application changes?"));
  }

  function openRecord(id: string, trigger: HTMLElement) {
    if (id === selectedId) {
      recordTrigger.current = trigger;
      closeButton.current?.focus();
      return;
    }
    const record = visibleApplications.find((application) => application.id === id);
    if (!record || !canLeaveRecord()) return;
    recordTrigger.current = trigger;
    draftState.current = { dirty: false, busy: false };
    setSelected(record);
  }

  function closeRecord() {
    restoreViewFocus.current = true;
    draftState.current = { dirty: false, busy: false };
    setSelected(null);
  }

  function refreshAfterMutation() {
    if (!mounted.current) return;
    // Invalidate any GET started before this mutation finished.
    requestSequence.current += 1;
    setRefreshRevision((revision) => revision + 1);
  }

  function handleRecordSaved(record: ApplicationRecord) {
    const merge = (current: ApplicationRecord) => {
      if (current.id !== record.id) return current;
      // Inline status is the only workspace edit that can overlap a detail save.
      return isOlderRecord(record, current)
        ? { ...record, status: current.status, updatedAt: current.updatedAt }
        : record;
    };
    setApplications((records) => records.map(merge));
    setSelected((current) => current && merge(current));
    refreshAfterMutation();
  }

  function handleRecordDeleted() {
    setApplications((records) => records.filter((record) => record.id !== selectedId));
    closeRecord();
    refreshAfterMutation();
  }

  async function handleStatusChange(id: string, status: string) {
    setError("");
    try {
      const changed = await updateApplicationStatus(api, refreshAfterMutation, id, status);
      if (mounted.current) {
        // The response can be older than a concurrent record edit; only merge this mutation's field.
        const merge = (current: ApplicationRecord) => current.id === id && !isOlderRecord(changed, current)
          ? { ...current, status, updatedAt: changed?.updatedAt ?? current.updatedAt }
          : current;
        setApplications((records) => records.map(merge));
        setSelected((current) => current && merge(current));
      }
    } catch (failure) {
      setError(errorMessage(failure, "Failed to update application status."));
    }
  }

  return (
    <div className="applications-page" data-record-open={Boolean(selected)}>
      <PageHeader
        eyebrow="Workspace / Applications"
        title="Applications"
        subtitle="Keep every application, conversation, and next step in view."
      />

      <div className="workspace-header">
        <ApplicationTabs view={view} onChange={setView} />
        <div className="applications-toolbar" role="group" aria-label="Filter applications">
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

      </div>
      <div className="workspace-layout">
        <div className="workspace-views" aria-busy={loading}>
          {loading && <p className="workspace-view-note workspace-loading" role="status">Loading applications…</p>}
          <section role="tabpanel" id="application-view-list" aria-labelledby="application-tab-list" hidden={view !== "list"}>
            <div className="workspace-view-heading">
              <h2>All applications</h2>
              <span className="workspace-mono">{visibleApplications.length} shown</span>
            </div>
            <ApplicationTable
              applications={visibleApplications}
              onStatusChange={handleStatusChange}
              selectedId={selectedId}
              onOpen={openRecord}
            />
          </section>
          <section role="tabpanel" id="application-view-board" aria-labelledby="application-tab-board" hidden={view !== "board"}>
            {view === "board" && <>
              <div className="workspace-view-heading">
                <h2>Applications by status</h2>
                <span className="workspace-mono">{visibleApplications.length} shown</span>
              </div>
              <ApplicationBoard applications={visibleApplications} selectedId={selectedId} onOpen={openRecord} />
            </>}
          </section>
          <section role="tabpanel" id="application-view-calendar" aria-labelledby="application-tab-calendar" hidden={view !== "calendar"}>
            {view === "calendar" && <ApplicationCalendar
              applications={visibleApplications}
              selectedId={selectedId}
              onOpen={openRecord}
              today={localCivilDate(now)}
              offset={weekOffset}
              onChangeWeek={setWeekOffset}
            />}
          </section>
        </div>
        {selected && (
          <aside className="workspace-record-panel" aria-label="Application record" onKeyDown={(event) => {
            if (event.key === "Escape" && !event.defaultPrevented && canLeaveRecord()) closeRecord();
          }}>
            <div className="workspace-record-bar">
              <p className="eyebrow">Application record</p>
              <button
                ref={closeButton}
                type="button"
                className="secondary-button workspace-record-close"
                onClick={() => { if (canLeaveRecord()) closeRecord(); }}
              >
                <span className="workspace-record-close-label">Close<span className="sr-only"> application record</span> <span aria-hidden="true">×</span></span>
                <span className="workspace-record-back-label"><span aria-hidden="true">← </span>Back to view</span>
              </button>
            </div>
            <ApplicationDetail
              key={selected.id}
              application={selected}
              embedded
              onSaved={handleRecordSaved}
              onDeleted={handleRecordDeleted}
              onDraftStateChange={reportDraftState}
            />
          </aside>
        )}
      </div>
    </div>
  );
}

export async function updateApplicationStatus(
  api: ClientApi,
  scheduleRefresh: () => void,
  id: string,
  status: string,
): Promise<ApplicationRecord> {
  const changed = await api<ApplicationRecord>(`/api/applications/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  scheduleRefresh();
  return changed;
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

function isOlderRecord(candidate: ApplicationRecord | undefined, current: ApplicationRecord): boolean {
  return Boolean(candidate?.updatedAt && current.updatedAt && Date.parse(candidate.updatedAt) < Date.parse(current.updatedAt));
}

function initialStatus(value: string | null): string {
  return value !== null && STATUSES.includes(value) ? value : "All";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
