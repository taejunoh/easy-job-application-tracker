import {
  DEFAULT_SORT,
  ariaSortFor,
  nextSortState,
  nextStep,
  sortApplications,
} from "@/lib/application-list";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const rows = [
  { id: "1", jobTitle: "backend Engineer", company: "Zeta", status: "Offer", appliedDate: daysAgo(10) },
  { id: "2", jobTitle: "Analyst", company: "acme", status: "Applied", appliedDate: daysAgo(40) },
  { id: "3", jobTitle: "Designer 10", company: "Beta", status: "Rejected", appliedDate: daysAgo(5) },
  { id: "4", jobTitle: "Designer 2", company: "Beta", status: "Interview", appliedDate: daysAgo(5) },
];

const ids = (list: Array<{ id: string }>) => list.map((row) => row.id);

describe("sortApplications", () => {
  it("sorts text columns case-insensitively and naturally", () => {
    expect(ids(sortApplications(rows, { key: "jobTitle", direction: "asc" }))).toEqual(["2", "1", "4", "3"]);
    expect(ids(sortApplications(rows, { key: "company", direction: "asc" }))).toEqual(["2", "3", "4", "1"]);
    expect(ids(sortApplications(rows, { key: "company", direction: "desc" }))).toEqual(["1", "3", "4", "2"]);
  });

  it("sorts status in pipeline order", () => {
    expect(ids(sortApplications(rows, { key: "status", direction: "asc" }))).toEqual(["2", "4", "1", "3"]);
    expect(ids(sortApplications(rows, { key: "status", direction: "desc" }))).toEqual(["3", "1", "4", "2"]);
  });

  it("sorts applied date by time", () => {
    expect(ids(sortApplications(rows, DEFAULT_SORT))).toEqual(["3", "4", "1", "2"]);
    expect(ids(sortApplications(rows, { key: "appliedDate", direction: "asc" }))).toEqual(["2", "1", "3", "4"]);
  });

  it("keeps ties in incoming order for both directions and does not mutate", () => {
    const before = ids(rows);
    expect(ids(sortApplications(rows, { key: "company", direction: "asc" })).slice(1, 3)).toEqual(["3", "4"]);
    expect(ids(sortApplications(rows, { key: "company", direction: "desc" })).slice(1, 3)).toEqual(["3", "4"]);
    expect(ids(rows)).toEqual(before);
  });

  it("puts unknown statuses and unparseable dates last or first without throwing", () => {
    const odd = [
      { id: "x", jobTitle: "A", company: "A", status: "Weird", appliedDate: "nope" },
      { id: "y", jobTitle: "B", company: "B", status: "Applied", appliedDate: daysAgo(1) },
    ];
    expect(ids(sortApplications(odd, { key: "status", direction: "asc" }))).toEqual(["y", "x"]);
    expect(ids(sortApplications(odd, { key: "appliedDate", direction: "asc" }))).toEqual(["x", "y"]);
  });
});

describe("sort state", () => {
  it("toggles the active column and starts new columns in a sensible direction", () => {
    expect(nextSortState(DEFAULT_SORT, "appliedDate")).toEqual({ key: "appliedDate", direction: "asc" });
    expect(nextSortState(DEFAULT_SORT, "company")).toEqual({ key: "company", direction: "asc" });
    expect(nextSortState({ key: "company", direction: "asc" }, "appliedDate")).toEqual({ key: "appliedDate", direction: "desc" });
    expect(nextSortState({ key: "company", direction: "asc" }, "company")).toEqual({ key: "company", direction: "desc" });
  });

  it("maps to aria-sort values", () => {
    expect(ariaSortFor(DEFAULT_SORT, "appliedDate")).toBe("descending");
    expect(ariaSortFor({ key: "status", direction: "asc" }, "status")).toBe("ascending");
    expect(ariaSortFor(DEFAULT_SORT, "company")).toBe("none");
  });
});

describe("nextStep", () => {
  it("derives the next step from status and age", () => {
    expect(nextStep({ status: "Applied", appliedDate: daysAgo(31) }, NOW)).toBe("Follow up");
    expect(nextStep({ status: "Applied", appliedDate: daysAgo(30) }, NOW)).toBe("-");
    expect(nextStep({ status: "Applied", appliedDate: daysAgo(3) }, NOW)).toBe("-");
    expect(nextStep({ status: "Interview", appliedDate: daysAgo(90) }, NOW)).toBe("Prepare");
    expect(nextStep({ status: "Offer", appliedDate: daysAgo(1) }, NOW)).toBe("Decide");
    expect(nextStep({ status: "Rejected", appliedDate: daysAgo(90) }, NOW)).toBe("-");
    expect(nextStep({ status: "Unknown", appliedDate: daysAgo(90) }, NOW)).toBe("-");
  });
});
