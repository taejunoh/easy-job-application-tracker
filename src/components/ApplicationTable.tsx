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

import type { ApplicationSummary } from "@/lib/application-record";
import type { OpenApplication } from "@/components/ApplicationViews";

const SORTABLE_COLUMNS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "company", label: "Company" },
  { key: "jobTitle", label: "Job Title" },
  { key: "status", label: "Status" },
  { key: "appliedDate", label: "Date Applied" },
];

interface ApplicationTableProps {
  applications: readonly ApplicationSummary[];
  selectedId?: string;
  onOpen?: OpenApplication;
  onStatusChange: (id: string, status: string) => void;
}

export default function ApplicationTable({
  applications,
  selectedId,
  onOpen,
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

  const navigateToApplication = (id: string, trigger: HTMLElement) => {
    if (onOpen) onOpen(id, trigger);
    else router.push(`/applications/${id}`);
  };

  return (
    <div className="applications-table-shell">
      <table className="applications-table">
        <caption className="sr-only">Your job applications</caption>
        <thead>
          <tr>
            {SORTABLE_COLUMNS.map(({ key, label }) => {
              const ariaSort = ariaSortFor(sort, key);
              return (
                <th key={key} scope="col" aria-sort={ariaSort} className={`application-column-${key}`}>
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
            <th scope="col" className="application-extra">Last updated</th>
            <th scope="col" className="application-location-cell">Location</th>
            <th scope="col" className="application-extra application-type-cell">Type</th>
            <th scope="col" className="application-extra">Next step</th>
            <th scope="col" className="application-arrow-cell"><span className="sr-only">Open record</span></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((application) => {
            const detailHref = `/applications/${application.id}`;
            const date = new Date(application.appliedDate);
            const updated = application.updatedAt ? new Date(application.updatedAt) : null;
            const step = application.nextStep || nextStep(application, now);
            const isSelected = application.id === selectedId;

            return (
              <tr
                key={application.id}
                tabIndex={onOpen ? undefined : 0}
                className="application-row application-card"
                data-selected={isSelected}
                data-testid={`application-card-${application.id}`}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest("a")) return;
                  navigateToApplication(application.id, event.currentTarget.querySelector("a") ?? event.currentTarget);
                }}
                onKeyDown={(event) => {
                  if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    navigateToApplication(application.id, event.currentTarget);
                  }
                }}
              >
                <td className="application-cell application-company-cell" data-label="Company">
                  <span className="workspace-initial" aria-hidden="true">{[...application.company.trim()][0]?.toUpperCase() || "·"}</span>
                  <div className="application-company-identity">
                    <a
                      className="application-company-link"
                      title={application.company}
                      href={detailHref}
                      aria-current={isSelected || undefined}
                      onClick={(event) => {
                        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                        event.preventDefault();
                        event.stopPropagation();
                        navigateToApplication(application.id, event.currentTarget);
                      }}
                    >
                      {application.company}
                    </a>
                  </div>
                </td>
                <td className="application-cell application-title-cell" data-label="Job Title">
                  <a
                    className="application-title-link"
                    href={detailHref}
                    aria-current={isSelected || undefined}
                    onClick={(event) => {
                      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                      event.preventDefault();
                      event.stopPropagation();
                      navigateToApplication(application.id, event.currentTarget);
                    }}
                  >
                    {application.jobTitle}
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
                <td className="application-cell application-extra application-updated-cell" data-label="Last updated">
                  {updated && Number.isFinite(updated.getTime()) ? (
                    <time dateTime={application.updatedAt ?? undefined}>{updated.toLocaleDateString()}</time>
                  ) : (
                    "-"
                  )}
                </td>
                <td className="application-cell application-location-cell" data-label="Location">
                  {normalizeLocation(application.location) || "-"}
                </td>
                <td className="application-cell application-extra application-type-cell" data-label="Type">
                  {displayJobType(application) || "-"}
                </td>
                <td
                  className={`application-cell application-extra application-next-step-cell${step === "-" ? "" : " has-next-step"}`}
                  data-label="Next step"
                >
                  {step}
                </td>
                <td className="application-cell application-arrow-cell" aria-hidden="true">›</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
