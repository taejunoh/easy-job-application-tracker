export function isCivilDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = utcDate(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function localCivilDate(date: Date): string {
  return [String(date.getFullYear()).padStart(4, "0"), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

export function utcDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** Use UTC arithmetic on civil dates so DST cannot move an event to another day. */
export function calendarWeek(day: string, offset = 0): string[] {
  const monday = utcDate(day);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7 + 7 * offset);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

export function groupScheduledApplications<T extends { nextStepDate?: string | null }>(
  applications: readonly T[],
  days: readonly string[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const application of applications) {
    const day = application.nextStepDate;
    if (!day || !days.includes(day)) continue;
    const records = groups.get(day);
    if (records) records.push(application);
    else groups.set(day, [application]);
  }
  return groups;
}
