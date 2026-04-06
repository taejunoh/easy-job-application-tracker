"use client";

import { useEffect, useState, use } from "react";
import ApplicationDetail from "@/components/ApplicationDetail";

interface Application {
  id: string;
  url: string;
  jobTitle: string;
  company: string;
  status: string;
  appliedDate: string;
  notes: string | null;
  salary: string | null;
  location: string | null;
  jobType: string | null;
}

export default function ApplicationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [application, setApplication] = useState<Application | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch(`/api/applications/${id}`)
      .then((res) => {
        if (!res.ok) throw new Error("Not found");
        return res.json();
      })
      .then(setApplication)
      .catch(() => setError(true));
  }, [id]);

  if (error) {
    return <div className="text-red-400">Application not found.</div>;
  }

  if (!application) {
    return <div className="text-gray-400">Loading...</div>;
  }

  return <ApplicationDetail application={application} />;
}
