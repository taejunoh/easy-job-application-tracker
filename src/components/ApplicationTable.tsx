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
      <div className="bg-gray-900 rounded-lg p-8 text-center text-gray-500 text-sm">
        No applications found. Paste a job URL above to add your first one.
      </div>
    );
  }

  return (
    <div className="bg-gray-900 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase">
            <th className="text-left p-3">Job Title</th>
            <th className="text-left p-3">Company</th>
            <th className="text-left p-3">Status</th>
            <th className="text-left p-3">Date Applied</th>
            <th className="text-left p-3">Location</th>
            <th className="text-left p-3">Type</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {applications.map((app) => (
            <tr
              key={app.id}
              className="hover:bg-gray-800/50 cursor-pointer"
              onClick={() => router.push(`/applications/${app.id}`)}
            >
              <td className="p-3 text-gray-100">{app.jobTitle}</td>
              <td className="p-3 text-gray-300">{app.company}</td>
              <td className="p-3" onClick={(e) => e.stopPropagation()}>
                <select
                  value={app.status}
                  onChange={(e) => onStatusChange(app.id, e.target.value)}
                  className="bg-transparent text-xs cursor-pointer focus:outline-none"
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s} className="bg-gray-900">
                      {s}
                    </option>
                  ))}
                </select>
              </td>
              <td className="p-3 text-gray-400">
                {new Date(app.appliedDate).toLocaleDateString()}
              </td>
              <td className="p-3 text-gray-400">{app.location || "-"}</td>
              <td className="p-3 text-gray-400">{app.jobType || "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
