"use client";

import { useEffect, useState } from "react";
import PageHeader from "@/components/PageHeader";
import StatCard from "@/components/StatCard";
import StatusBadge from "@/components/StatusBadge";
import { useClientApi } from "@/hooks/use-client-api";
import { buildAttentionItems, countStaleApplications } from "@/lib/attention";

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

const ATTENTION_COLORS = {
  stale: "metric-stale",
  interview: "metric-interview",
  offer: "metric-offer",
} as const;

export default function DashboardPage() {
  const api = useClientApi();
  const [stats, setStats] = useState<Stats | null>(null);
  const [staleCount, setStaleCount] = useState<number | null>(null);
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

  useEffect(() => {
    // /api/stats has a fixed shape, so stale applications are counted from the list.
    api<Array<{ status: string; appliedDate: string }>>("/api/applications?status=Applied")
      .then((applications) => {
        setStaleCount(
          Array.isArray(applications)
            ? countStaleApplications(applications, new Date())
            : null,
        );
      })
      .catch(() => setStaleCount(null));
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
          {buildAttentionItems({
            stale: staleCount,
            interview: stats.interview,
            offer: stats.offer,
          }).map((item) => (
            <StatCard
              key={item.key}
              label={item.label}
              hint={item.hint}
              value={item.count}
              color={ATTENTION_COLORS[item.key]}
              href={item.count === null ? undefined : item.href}
            />
          ))}
        </div>
      </section>

      <section aria-label="Supporting statistics" className="supporting-stats">
        <div className="metric-grid metric-grid-supporting">
          <StatCard label="Total" value={stats.total} color="metric-total" />
          <StatCard label="Applied" value={stats.applied} color="metric-applied" />
          <StatCard label="Rejected" value={stats.rejected} color="metric-rejected" />
          <StatCard label="This Week" value={stats.weeklyCount} color="metric-week" />
          <StatCard label="This Month" value={stats.monthlyCount} color="metric-month" />
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
    <PageHeader
      eyebrow="Your work in motion"
      title="Dashboard"
      subtitle="Keep a clear record of every opportunity."
    />
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
