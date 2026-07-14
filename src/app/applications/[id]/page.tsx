"use client";

import { useEffect, useState, use } from "react";
import ApplicationDetail from "@/components/ApplicationDetail";
import { useClientApi } from "@/hooks/use-client-api";

interface Application {
  id: string;
  url: string;
  jobTitle: string;
  company: string;
  status: string;
  appliedDate: string;
  description: string | null;
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
  const api = useClientApi();
  const [application, setApplication] = useState<Application | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Application>(`/api/applications/${id}`)
      .then(setApplication)
      .catch((failure: unknown) => {
        setError(
          failure instanceof Error
            ? failure.message
            : "Failed to load application.",
        );
      });
  }, [api, id]);

  if (error) {
    return <div role="alert" className="text-red-400">{error}</div>;
  }

  if (!application) {
    return <div className="text-gray-400">Loading...</div>;
  }

  return <ApplicationDetail application={application} />;
}
