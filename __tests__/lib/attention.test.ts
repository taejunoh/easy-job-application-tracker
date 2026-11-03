import {
  STALE_APPLICATIONS_HREF,
  buildAttentionItems,
  countStaleApplications,
  filterStaleApplications,
  isStaleApplication,
  parseAttentionFilter,
} from "@/lib/attention";

const NOW = new Date("2026-11-02T12:00:00.000Z");

function daysAgo(days: number, extraMs = 0): string {
  return new Date(NOW.getTime() - days * 86_400_000 - extraMs).toISOString();
}

describe("isStaleApplication", () => {
  it("is stale only for Applied applications more than 30 days old", () => {
    expect(isStaleApplication({ status: "Applied", appliedDate: daysAgo(31) }, NOW)).toBe(true);
    expect(isStaleApplication({ status: "Applied", appliedDate: daysAgo(30, 1) }, NOW)).toBe(true);
    expect(isStaleApplication({ status: "Applied", appliedDate: daysAgo(30) }, NOW)).toBe(false);
    expect(isStaleApplication({ status: "Applied", appliedDate: daysAgo(2) }, NOW)).toBe(false);
  });

  it("ignores every other status however old", () => {
    for (const status of ["Interview", "Offer", "Rejected"]) {
      expect(isStaleApplication({ status, appliedDate: daysAgo(400) }, NOW)).toBe(false);
    }
  });

  it("treats a future or unparseable date as not stale", () => {
    expect(isStaleApplication({ status: "Applied", appliedDate: daysAgo(-5) }, NOW)).toBe(false);
    expect(isStaleApplication({ status: "Applied", appliedDate: "not a date" }, NOW)).toBe(false);
  });

  it("accepts Date values", () => {
    expect(isStaleApplication({ status: "Applied", appliedDate: new Date(daysAgo(90)) }, NOW)).toBe(true);
  });
});

describe("filterStaleApplications and countStaleApplications", () => {
  const applications = [
    { id: "old", status: "Applied", appliedDate: daysAgo(45) },
    { id: "recent", status: "Applied", appliedDate: daysAgo(3) },
    { id: "interview", status: "Interview", appliedDate: daysAgo(90) },
    { id: "older", status: "Applied", appliedDate: daysAgo(120) },
  ];

  it("keeps order and only the stale rows", () => {
    expect(filterStaleApplications(applications, NOW).map((a) => a.id)).toEqual(["old", "older"]);
    expect(countStaleApplications(applications, NOW)).toBe(2);
  });

  it("does not mutate its input", () => {
    const copy = JSON.stringify(applications);
    filterStaleApplications(applications, NOW);
    expect(JSON.stringify(applications)).toBe(copy);
  });
});

describe("parseAttentionFilter", () => {
  it("recognises only the stale filter", () => {
    expect(parseAttentionFilter("stale")).toBe("stale");
    expect(parseAttentionFilter("other")).toBeNull();
    expect(parseAttentionFilter("")).toBeNull();
    expect(parseAttentionFilter(null)).toBeNull();
    expect(parseAttentionFilter(undefined)).toBeNull();
  });
});

describe("buildAttentionItems", () => {
  it("lists stale, interviewing, and offers with links to the matching list", () => {
    const items = buildAttentionItems({ stale: 3, interview: 2, offer: 1 });
    expect(items.map((item) => [item.key, item.count, item.href])).toEqual([
      ["stale", 3, STALE_APPLICATIONS_HREF],
      ["interview", 2, "/applications?status=Interview"],
      ["offer", 1, "/applications?status=Offer"],
    ]);
    expect(STALE_APPLICATIONS_HREF).toBe("/applications?attention=stale");
  });

  it("keeps an unknown stale count distinct from zero", () => {
    expect(buildAttentionItems({ stale: null, interview: 0, offer: 0 })[0].count).toBeNull();
    expect(buildAttentionItems({ stale: 0, interview: 0, offer: 0 })[0].count).toBe(0);
  });
});
