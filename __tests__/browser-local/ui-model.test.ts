import { filterApplications, sortApplications } from "../../src/browser-local/ui/model";

const sample = [
  { company: "Maple", jobTitle: "Front End", status: "Applied", notes: "Remote in Canada", location: null, salary: null, nextStep: null, jobType: null, url: "", description: null },
  { company: "Oak", jobTitle: "Design", status: "Interview", notes: null, location: "Canada", salary: null, nextStep: null, jobType: null, url: "", description: null },
];

test("requires every search term and the selected status", () => {
  expect(filterApplications(sample, "   front CANADA ", "Applied")).toEqual([sample[0]]);
  expect(filterApplications(sample, "Canada", "Interview")).toEqual([sample[1]]);
  expect(filterApplications(sample, "remote design", "")).toEqual([]);
});

test("orders applications by applied date and then by creation date", () => {
  const earlier = { appliedDate: "2026-11-12", createdAt: "2026-11-13", id: "a" };
  const later = { appliedDate: "2026-11-13", createdAt: "2026-11-13", id: "b" };
  const newest = { appliedDate: "2026-11-13", createdAt: "2026-11-14", id: "c" };
  const records = [earlier, newest, later];

  expect(sortApplications(records)).toEqual([newest, later, earlier]);
  expect(records).toEqual([earlier, newest, later]);
});
