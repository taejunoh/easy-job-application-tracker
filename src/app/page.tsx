"use client";

import { useEffect, useState } from "react";
import StatCard from "@/components/StatCard";
import StatusBadge from "@/components/StatusBadge";
import { useClientApi } from "@/hooks/use-client-api";

interface Stats {
  total: number;
  applied: number;
  interview: number;
  offer: number;
  rejected: number;
  weeklyCount: number;
  monthlyCount: number;
  recentApplications: Array<{
    id: string;
    jobTitle: string;
    company: string;
    status: string;
    appliedDate: string;
  }>;
}

const statusItems = [
  { label: "Applied", key: "applied" as const },
  { label: "Interview", key: "interview" as const },
  { label: "Offer", key: "offer" as const },
  { label: "Rejected", key: "rejected" as const },
];

export default function DashboardPage() {
  const api = useClientApi();
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Stats>("/api/stats")
      .then((data) => {
        setStats(data);
        setError("");
      })
      .catch((failure: unknown) => {
        setError(errorMessage(failure, "Failed to load dashboard."));
      });
  }, [api]);

  if (!stats) {
    return (
      <div className="dashboard-page" data-testid="dashboard-content" aria-busy="true">
        <DashboardHeader />
        {error ? <div role="alert" className="inline-alert">{error}</div> : <div className="loading-state">Loading...</div>}
      </div>
    );
  }

  return (
    <div className="dashboard-page" data-testid="dashboard-content" aria-busy="false">
      <DashboardHeader />

      <section className="pipeline-section" aria-labelledby="pipeline-heading">
        <p className="eyebrow">Active pipeline</p>
        <h2 id="pipeline-heading" className="section-title">What needs your attention</h2>
        <div className="metric-grid metric-grid-primary">
          <StatCard label="Interviewing" value={stats.interview} color="metric-interview" />
          <StatCard label="Offers" value={stats.offer} color="metric-offer" />
        </div>
      </section>

      <section aria-label="Supporting statistics" className="supporting-stats">
        <div className="metric-grid metric-grid-supporting">
          <StatCard label="Total Applied" value={stats.total} color="metric-applied" />
          <StatCard label="Rejected" value={stats.rejected} color="metric-rejected" />
          <StatCard label="This Week" value={stats.weeklyCount} color="metric-week" />
          <StatCard label="This Month" value={stats.monthlyCount} color="metric-month" />
        </div>
      </section>

      <section className="status-summary-section" aria-labelledby="status-summary-heading">
        <p className="eyebrow">At a glance</p>
        <h2 id="status-summary-heading" className="section-title">Status summary</h2>
        <div className="status-summary card">
          {statusItems.map(({ label, key }) => (
            <div className="status-summary-item" key={key}>
              <StatusBadge status={label} />
              <strong className="status-summary-count">{stats[key]}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="recent-section" aria-labelledby="recent-heading">
        <p className="eyebrow">Your journal</p>
        <h2 id="recent-heading" className="section-title">Recent Applications</h2>
        <div className="recent-list card" role="list">
          {stats.recentApplications.length === 0 ? (
            <div className="empty-state">
              <strong>No applications yet.</strong>
              <span>Use the Add application card above to record your first one.</span>
            </div>
          ) : (
            stats.recentApplications.map((application) => (
              <div key={application.id} className="recent-row" role="listitem">
                <div className="recent-identity">
                  <div className="recent-title">{application.jobTitle}</div>
                  <div className="recent-company">{application.company}</div>
                </div>
                <div className="recent-meta">
                  <time dateTime={application.appliedDate} className="recent-date">
                    {new Date(application.appliedDate).toLocaleDateString()}
                  </time>
                  <StatusBadge status={application.status} />
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function DashboardHeader() {
  return (
    <header className="page-header">
      <p className="eyebrow">Your work in motion</p>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-subtitle">Keep a clear record of every opportunity.</p>
    </header>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
