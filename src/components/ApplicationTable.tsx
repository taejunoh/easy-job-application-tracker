"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import StatusEditor from "@/components/StatusEditor";
import { READ_ONLY_MESSAGE, useWritesStopped } from "@/components/WriteState";
import {
  DEFAULT_SORT,
  ariaSortFor,
  nextSortState,
  nextStep,
  sortApplications,
  type SortKey,
  type SortState,
} from "@/lib/application-list";
import { displayJobType, normalizeLocation } from "@/lib/location";

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

const SORTABLE_COLUMNS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "jobTitle", label: "Job Title" },
  { key: "company", label: "Company" },
  { key: "status", label: "Status" },
  { key: "appliedDate", label: "Date Applied" },
];

interface ApplicationTableProps {
  applications: Application[];
  onStatusChange: (id: string, status: string) => void;
}

export default function ApplicationTable({
  applications,
  onStatusChange,
}: ApplicationTableProps) {
  const router = useRouter();
  const writesStopped = useWritesStopped();
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [now] = useState(() => new Date());
  const sorted = useMemo(() => sortApplications(applications, sort), [applications, sort]);

  if (applications.length === 0) {
    return (
      <div className="applications-empty card empty-state" role="status">
        <strong>No applications found.</strong>
        <span>Use the Add application button above to paste your first job URL.</span>
      </div>
    );
  }

  const navigateToApplication = (id: string) => {
    router.push(`/applications/${id}`);
  };

  return (
    <div className="applications-table-shell card">
      <table className="applications-table">
        <caption className="sr-only">Your job applications</caption>
        <thead>
          <tr>
            {SORTABLE_COLUMNS.map(({ key, label }) => {
              const ariaSort = ariaSortFor(sort, key);
              return (
                <th key={key} scope="col" aria-sort={ariaSort}>
                  <button
                    type="button"
                    className="sort-button"
                    onClick={() => setSort((current) => nextSortState(current, key))}
                  >
                    {label}
                    <span aria-hidden="true" className="sort-indicator">
                      {ariaSort === "ascending" ? "▲" : ariaSort === "descending" ? "▼" : "↕"}
                    </span>
                  </button>
                </th>
              );
            })}
            <th scope="col">Last updated</th>
            <th scope="col">Location</th>
            <th scope="col">Type</th>
            <th scope="col">Next step</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((application) => {
            const detailHref = `/applications/${application.id}`;
            const date = new Date(application.appliedDate);
            const updated = application.updatedAt ? new Date(application.updatedAt) : null;
            const step = nextStep(application, now);

            return (
              <tr
                key={application.id}
                tabIndex={0}
                className="application-row application-card"
                data-testid={`application-card-${application.id}`}
                onClick={() => navigateToApplication(application.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    navigateToApplication(application.id);
                  }
                }}
              >
                <td className="application-cell application-title-cell" data-label="Job Title">
                  <a
                    className="application-title-link"
                    href={detailHref}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      navigateToApplication(application.id);
                    }}
                  >
                    {application.jobTitle}
                  </a>
                </td>
                <td className="application-cell application-company-cell" data-label="Company">
                  <a
                    className="application-company-link"
                    title={application.company}
                    href={detailHref}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      navigateToApplication(application.id);
                    }}
                  >
                    {application.company}
                  </a>
                </td>
                <td className="application-cell application-status-cell" data-label="Status">
                  <StatusEditor
                    id={application.id}
                    jobTitle={application.jobTitle}
                    status={application.status}
                    onChange={onStatusChange}
                    readOnlyReason={writesStopped ? READ_ONLY_MESSAGE : undefined}
                  />
                </td>
                <td className="application-cell application-date-cell" data-label="Date Applied">
                  <time dateTime={application.appliedDate}>{date.toLocaleDateString()}</time>
                </td>
                <td className="application-cell application-updated-cell" data-label="Last updated">
                  {updated && Number.isFinite(updated.getTime()) ? (
                    <time dateTime={application.updatedAt ?? undefined}>{updated.toLocaleDateString()}</time>
                  ) : (
                    "-"
                  )}
                </td>
                <td className="application-cell" data-label="Location">
                  {normalizeLocation(application.location) || "-"}
                </td>
                <td className="application-cell" data-label="Type">
                  {displayJobType(application) || "-"}
                </td>
                <td
                  className={`application-cell application-next-step-cell${step === "-" ? "" : " has-next-step"}`}
                  data-label="Next step"
                >
                  {step}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <style>{`
        .applications-table-shell { overflow: hidden; }
        .applications-table { border-collapse: collapse; color: var(--text); font-size: 0.9rem; table-layout: fixed; width: 100%; }
        .applications-table th { background: #f0f2ec; color: var(--muted); font-size: 0.72rem; letter-spacing: 0.08em; padding: 0.8rem 0.7rem; text-align: left; text-transform: uppercase; }
        .applications-table th:nth-child(1) { width: 19%; }
        .applications-table th:nth-child(2) { width: 14%; }
        .applications-table th:nth-child(3) { width: 13%; }
        .applications-table th:nth-child(4) { width: 11%; }
        .applications-table th:nth-child(5) { width: 11%; }
        .applications-table th:nth-child(6) { width: 13%; }
        .applications-table th:nth-child(7) { width: 8%; }
        .applications-table th:nth-child(8) { width: 11%; }
        .sort-button { align-items: center; background: transparent; border: 0; color: inherit; cursor: pointer; display: inline-flex; font: inherit; gap: 0.3rem; letter-spacing: inherit; min-height: 44px; padding: 0; text-align: left; text-transform: inherit; }
        .sort-button:hover { color: var(--primary); }
        .sort-indicator { font-size: 0.65rem; opacity: 0.6; }
        th[aria-sort="ascending"] .sort-indicator, th[aria-sort="descending"] .sort-indicator { color: var(--primary); opacity: 1; }
        th[aria-sort="ascending"], th[aria-sort="descending"] { color: var(--primary); }
        .application-row { border-top: 1px solid var(--border); cursor: pointer; outline-offset: -3px; transition: background-color 120ms ease; }
        .application-row:hover, .application-row:focus-visible { background: #f7f8f4; }
        .application-cell { color: var(--muted); min-width: 0; overflow-wrap: anywhere; padding: 0.95rem 0.7rem; vertical-align: middle; }
        .application-title-cell, .application-company-cell { color: var(--text); font-weight: 650; }
        .application-title-link, .application-company-link { color: inherit; text-decoration: none; }
        .application-company-cell { overflow: hidden; overflow-wrap: normal; word-break: normal; }
        .application-company-link { display: block; hyphens: manual; overflow: hidden; overflow-wrap: normal; text-overflow: ellipsis; }
        .application-title-link:hover, .application-company-link:hover { color: var(--primary); text-decoration: underline; text-underline-offset: 0.18em; }
        .application-title-link { font-weight: 750; }
        .application-status-cell { min-width: 144px; overflow-wrap: normal; white-space: nowrap; }
        .status-edit-button { align-items: center; background: transparent; border: 0; border-radius: 999px; cursor: pointer; display: inline-flex; gap: 0.25rem; padding: 0; }
        .status-edit-button:hover .status-edit-caret { color: var(--primary); }
        .status-edit-caret { color: var(--muted); font-size: 0.75rem; }
        .application-status-cell select { background: #e9f3ed; border: 1px solid #b9cec3; border-radius: 999px; color: var(--primary); cursor: pointer; min-height: 44px; padding: 0.3rem 1.7rem 0.3rem 0.65rem; width: 100%; }
        .application-status-cell select { min-width: 116px; }
        .application-status-cell select:focus-visible { outline: 3px solid var(--primary); outline-offset: 2px; }
        .application-date-cell time, .application-updated-cell time { white-space: nowrap; }
        .application-cell.has-next-step { color: var(--text); font-weight: 650; }
        @media (min-width: 769px) { .application-company-link { min-height: 0; } }
        @media (max-width: 768px) {
          .applications-table-shell { background: transparent; border: 0; box-shadow: none; overflow: visible; }
          .applications-table, .applications-table tbody, .application-row, .application-cell { display: block; width: 100%; }
          .applications-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
          .application-row { background: var(--surface); border: 1px solid var(--border); border-radius: 0.75rem; margin-bottom: 0.75rem; padding: 0.85rem 1rem; }
          .application-row:hover, .application-row:focus-visible { background: var(--surface); }
          .application-cell { align-items: baseline; border-top: 1px solid #edf0e9; display: flex; gap: 1rem; justify-content: space-between; padding: 0.7rem 0; text-align: right; }
          .application-cell:first-child { border-top: 0; }
          .application-cell::before { color: var(--muted); content: attr(data-label); flex: 0 0 auto; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; text-align: left; text-transform: uppercase; }
          .application-title-cell, .application-company-cell { display: block; padding: 0.15rem 0 0.3rem; text-align: left; }
          .application-title-cell::before, .application-company-cell::before { display: none; }
          .application-company-cell { color: var(--muted); font-size: 0.86rem; padding-bottom: 0.8rem; }
          .application-title-link { font-size: 1.05rem; }
          .application-company-link { color: var(--muted); }
          .application-status-cell { min-width: 0; }
          .application-status-cell select { min-width: 0; }
          .application-status-cell select { max-width: 12rem; }
        }
      `}</style>
    </div>
  );
}
