import { calendarWeek, groupScheduledApplications, isCivilDate, localCivilDate } from "@/lib/application-calendar";

it("keeps a Monday-to-Sunday week across month and year boundaries", () => {
  expect(calendarWeek("2026-12-31")).toEqual([
    "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03",
  ]);
  expect(calendarWeek("2026-12-31", 1)[0]).toBe("2027-01-04");
});

it("keeps Sunday dates intact across daylight saving changes and ignores unscheduled records", () => {
  const days = calendarWeek("2026-03-08");
  expect(days[6]).toBe("2026-03-08");
  const due = { id: "due", nextStepDate: "2026-03-08" };
  const records = [due, { id: "elsewhere", nextStepDate: "2026-03-09" }, { id: "unscheduled", nextStepDate: null }];
  expect([...groupScheduledApplications(records, days)]).toEqual([["2026-03-08", [due]]]);
  expect(localCivilDate(new Date(2026, 2, 8, 23, 45))).toBe("2026-03-08");
});

it("recognizes Gregorian leap days without coercing impossible dates", () => {
  expect(isCivilDate("2000-02-29")).toBe(true);
  expect(isCivilDate("2100-02-29")).toBe(false);
});
