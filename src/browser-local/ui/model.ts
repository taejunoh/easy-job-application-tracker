type SearchableApplication = {
  company: string;
  jobTitle: string;
  status: string;
  notes: string | null;
  location: string | null;
  salary: string | null;
  nextStep: string | null;
  jobType: string | null;
  url: string;
  description: string | null;
};

export function filterApplications<T extends SearchableApplication>(
  applications: readonly T[],
  search: string,
  status: string,
): T[] {
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return applications.filter((application) => {
    if (status && application.status !== status) return false;
    if (!terms.length) return true;

    const haystack = [
      application.company, application.jobTitle, application.status, application.notes,
      application.location, application.salary, application.nextStep, application.jobType,
      application.url, application.description,
    ].join(" ").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

type DatedApplication = { id: string; appliedDate: string; createdAt: string };

export function sortApplications<T extends DatedApplication>(applications: readonly T[]): T[] {
  return [...applications].sort((left, right) =>
    right.appliedDate.localeCompare(left.appliedDate)
    || right.createdAt.localeCompare(left.createdAt)
    || left.id.localeCompare(right.id));
}
