/**
 * Pure helpers for the "what needs your attention" dashboard section and the
 * matching `/applications?attention=stale` list filter. Nothing here is stored:
 * staleness is derived from `status` and `appliedDate` at the time of reading.
 */

export const STALE_AFTER_DAYS = 30;
export const ATTENTION_PARAM = "attention";
export const ATTENTION_STALE = "stale";
export const STALE_APPLICATIONS_HREF = `/applications?${ATTENTION_PARAM}=${ATTENTION_STALE}`;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StaleCandidate {
  status: string;
  appliedDate: string | Date;
}

export type AttentionFilter = typeof ATTENTION_STALE;

/** An application is stale when it is still "Applied" more than 30 days after it was applied. */
export function isStaleApplication(application: StaleCandidate, now: Date): boolean {
  if (application.status !== "Applied") return false;
  const applied = new Date(application.appliedDate).getTime();
  if (!Number.isFinite(applied)) return false;
  return now.getTime() - applied > STALE_AFTER_DAYS * DAY_MS;
}

export function filterStaleApplications<T extends StaleCandidate>(
  applications: readonly T[],
  now: Date,
): T[] {
  return applications.filter((application) => isStaleApplication(application, now));
}

export function countStaleApplications(
  applications: readonly StaleCandidate[],
  now: Date,
): number {
  return filterStaleApplications(applications, now).length;
}

/** Returns the recognised attention filter from a query value, or null. */
export function parseAttentionFilter(value: string | null | undefined): AttentionFilter | null {
  return value === ATTENTION_STALE ? ATTENTION_STALE : null;
}

export interface AttentionItem {
  key: "stale" | "interview" | "offer";
  label: string;
  hint: string;
  count: number | null;
  href: string;
}

export interface AttentionCounts {
  /** Null when the stale count could not be computed (for example the list failed to load). */
  stale: number | null;
  interview: number;
  offer: number;
}

export function buildAttentionItems(counts: AttentionCounts): AttentionItem[] {
  return [
    {
      key: "stale",
      label: "Stale applications",
      hint: `Applied ${STALE_AFTER_DAYS}+ days ago, no update`,
      count: counts.stale,
      href: STALE_APPLICATIONS_HREF,
    },
    {
      key: "interview",
      label: "Interviewing",
      hint: "Prepare for what is next",
      count: counts.interview,
      href: "/applications?status=Interview",
    },
    {
      key: "offer",
      label: "Offers",
      hint: "Decisions waiting on you",
      count: counts.offer,
      href: "/applications?status=Offer",
    },
  ];
}
