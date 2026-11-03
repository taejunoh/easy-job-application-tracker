import { isStaleApplication } from "@/lib/attention";

/** Pure helpers for ordering the applications table and deriving its "Next step" column. */

export type SortKey = "jobTitle" | "company" | "status" | "appliedDate";
export type SortDirection = "asc" | "desc";

export interface SortState {
  key: SortKey;
  direction: SortDirection;
}

/** The API returns newest applications first, so the table starts in that order. */
export const DEFAULT_SORT: SortState = { key: "appliedDate", direction: "desc" };

interface Sortable {
  jobTitle: string;
  company: string;
  status: string;
  appliedDate: string;
}

const STATUS_ORDER = ["Applied", "Interview", "Offer", "Rejected"];

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function compareBy(key: SortKey, a: Sortable, b: Sortable): number {
  switch (key) {
    case "jobTitle":
      return compareText(a.jobTitle, b.jobTitle);
    case "company":
      return compareText(a.company, b.company);
    case "status": {
      const rank = (status: string) => {
        const index = STATUS_ORDER.indexOf(status);
        return index === -1 ? STATUS_ORDER.length : index;
      };
      return rank(a.status) - rank(b.status);
    }
    case "appliedDate": {
      const time = (value: string) => {
        const parsed = new Date(value).getTime();
        return Number.isFinite(parsed) ? parsed : 0;
      };
      return time(a.appliedDate) - time(b.appliedDate);
    }
  }
}

/** Returns a sorted copy. Ties keep their incoming order in both directions. */
export function sortApplications<T extends Sortable>(
  applications: readonly T[],
  { key, direction }: SortState,
): T[] {
  const sign = direction === "asc" ? 1 : -1;
  return applications
    .map((application, index) => ({ application, index }))
    .sort((left, right) => {
      const result = compareBy(key, left.application, right.application) * sign;
      return result !== 0 ? result : left.index - right.index;
    })
    .map(({ application }) => application);
}

/** Clicking the active column flips its direction; a new column starts ascending (dates newest first). */
export function nextSortState(current: SortState, key: SortKey): SortState {
  if (current.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: key === "appliedDate" ? "desc" : "asc" };
}

export function ariaSortFor(
  current: SortState,
  key: SortKey,
): "ascending" | "descending" | "none" {
  if (current.key !== key) return "none";
  return current.direction === "asc" ? "ascending" : "descending";
}

export type NextStep = "Follow up" | "Prepare" | "Decide" | "-";

/** Derived, never stored: what to do next given the status and age of an application. */
export function nextStep(
  application: { status: string; appliedDate: string },
  now: Date,
): NextStep {
  if (application.status === "Applied") {
    return isStaleApplication(application, now) ? "Follow up" : "-";
  }
  if (application.status === "Interview") return "Prepare";
  if (application.status === "Offer") return "Decide";
  return "-";
}
