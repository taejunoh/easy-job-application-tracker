"use client";

import { useEffect, useState } from "react";
import StatCard from "@/components/StatCard";
import StatusBadge from "@/components/StatusBadge";

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

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    fetch("/api/stats")
      .then((res) => res.json())
      .then(setStats);
  }, []);

  if (!stats) {
    return <div className="text-gray-400">Loading...</div>;
  }

  return (
    <div>
      <h1 className="text-xl font-semibold mb-6">Dashboard</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total Applied" value={stats.total} color="text-blue-400" />
        <StatCard label="Interviewing" value={stats.interview} color="text-yellow-400" />
        <StatCard label="Offers" value={stats.offer} color="text-green-400" />
        <StatCard label="Rejected" value={stats.rejected} color="text-red-400" />
      </div>

      <div className="grid grid-cols-2 gap-4 mb-8">
        <StatCard label="This Week" value={stats.weeklyCount} color="text-cyan-400" />
        <StatCard label="This Month" value={stats.monthlyCount} color="text-purple-400" />
      </div>

      <div className="mb-4">
        <h2 className="text-sm font-medium text-gray-400 uppercase mb-2">
          Status Breakdown
        </h2>
        <div className="bg-gray-900 rounded-lg p-4">
          {stats.total === 0 ? (
            <div className="text-gray-500 text-sm">No applications yet. Paste a URL above to get started.</div>
          ) : (
            <div className="flex gap-1 h-4 rounded overflow-hidden">
              {stats.applied > 0 && (
                <div
                  className="bg-blue-500"
                  style={{ width: `${(stats.applied / stats.total) * 100}%` }}
                  title={`Applied: ${stats.applied}`}
                />
              )}
              {stats.interview > 0 && (
                <div
                  className="bg-yellow-500"
                  style={{ width: `${(stats.interview / stats.total) * 100}%` }}
                  title={`Interview: ${stats.interview}`}
                />
              )}
              {stats.offer > 0 && (
                <div
                  className="bg-green-500"
                  style={{ width: `${(stats.offer / stats.total) * 100}%` }}
                  title={`Offer: ${stats.offer}`}
                />
              )}
              {stats.rejected > 0 && (
                <div
                  className="bg-red-500"
                  style={{ width: `${(stats.rejected / stats.total) * 100}%` }}
                  title={`Rejected: ${stats.rejected}`}
                />
              )}
            </div>
          )}
          <div className="flex gap-4 mt-2 text-xs text-gray-400">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 bg-blue-500 rounded-full" /> Applied
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 bg-yellow-500 rounded-full" /> Interview
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 bg-green-500 rounded-full" /> Offer
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 bg-red-500 rounded-full" /> Rejected
            </span>
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-sm font-medium text-gray-400 uppercase mb-2">
          Recent Applications
        </h2>
        <div className="bg-gray-900 rounded-lg divide-y divide-gray-800">
          {stats.recentApplications.length === 0 ? (
            <div className="p-4 text-gray-500 text-sm">No applications yet.</div>
          ) : (
            stats.recentApplications.map((app) => (
              <div key={app.id} className="p-3 flex items-center justify-between">
                <div>
                  <div className="text-sm text-gray-100">{app.jobTitle}</div>
                  <div className="text-xs text-gray-400">{app.company}</div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-500">
                    {new Date(app.appliedDate).toLocaleDateString()}
                  </span>
                  <StatusBadge status={app.status} />
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
