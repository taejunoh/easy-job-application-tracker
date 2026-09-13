"use client";

import { useRouter } from "next/navigation";

interface Application {
  id: string;
  jobTitle: string;
  company: string;
  status: string;
  appliedDate: string;
  location: string | null;
  jobType: string | null;
}

interface ApplicationTableProps {
  applications: Application[];
  onStatusChange: (id: string, status: string) => void;
}

const STATUSES = ["Applied", "Interview", "Offer", "Rejected"];

export default function ApplicationTable({
  applications,
  onStatusChange,
}: ApplicationTableProps) {
  const router = useRouter();

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
            <th scope="col">Job Title</th>
            <th scope="col">Company</th>
            <th scope="col">Status</th>
            <th scope="col">Date Applied</th>
            <th scope="col">Location</th>
            <th scope="col">Type</th>
          </tr>
        </thead>
        <tbody>
          {applications.map((application) => {
            const statusId = `application-status-${application.id}`;
            const detailHref = `/applications/${application.id}`;
            const date = new Date(application.appliedDate);

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
                  <label className="sr-only" htmlFor={statusId} />
                  <select
                    id={statusId}
                    value={application.status}
                    aria-label={`Status for ${application.jobTitle}`}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                    onChange={(event) => {
                      event.stopPropagation();
                      onStatusChange(application.id, event.target.value);
                    }}
                  >
                    {STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="application-cell application-date-cell" data-label="Date Applied">
                  <time dateTime={application.appliedDate}>{date.toLocaleDateString()}</time>
                </td>
                <td className="application-cell" data-label="Location">
                  {application.location || "-"}
                </td>
                <td className="application-cell" data-label="Type">
                  {application.jobType || "-"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <style>{`
        .applications-table-shell { overflow: hidden; }
        .applications-table { border-collapse: collapse; color: var(--text); font-size: 0.9rem; table-layout: fixed; width: 100%; }
        .applications-table th { background: #f0f2ec; color: var(--muted); font-size: 0.72rem; letter-spacing: 0.08em; padding: 0.8rem 0.9rem; text-align: left; text-transform: uppercase; }
        .applications-table th:nth-child(1) { width: 22%; }
        .applications-table th:nth-child(2) { width: 18%; }
        .applications-table th:nth-child(3) { width: 20%; }
        .applications-table th:nth-child(4) { width: 15%; }
        .applications-table th:nth-child(5) { width: 15%; }
        .applications-table th:nth-child(6) { width: 10%; }
        .application-row { border-top: 1px solid var(--border); cursor: pointer; outline-offset: -3px; transition: background-color 120ms ease; }
        .application-row:hover, .application-row:focus-visible { background: #f7f8f4; }
        .application-cell { color: var(--muted); min-width: 0; overflow-wrap: anywhere; padding: 0.95rem 0.9rem; }
        .application-title-cell, .application-company-cell { color: var(--text); font-weight: 650; }
        .application-title-link, .application-company-link { color: inherit; text-decoration: none; }
        .application-title-link:hover, .application-company-link:hover { color: var(--primary); text-decoration: underline; text-underline-offset: 0.18em; }
        .application-title-link { font-weight: 750; }
        .application-status-cell { min-width: 144px; }
        .application-status-cell select { background: #e9f3ed; border: 1px solid #b9cec3; border-radius: 999px; color: var(--primary); cursor: pointer; min-height: 44px; padding: 0.3rem 1.7rem 0.3rem 0.65rem; width: 100%; }
        .application-status-cell select { min-width: 116px; }
        .application-status-cell select:focus-visible { outline: 3px solid var(--primary); outline-offset: 2px; }
        .application-date-cell time { white-space: nowrap; }
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
