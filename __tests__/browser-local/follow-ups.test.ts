/** @jest-environment jsdom */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import FollowUps from "../../src/browser-local/ui/FollowUps";
import type { LocalApplication } from "../../src/browser-local/storage";

function application(id: string, nextStepDate: string | null, overrides: Partial<LocalApplication> = {}): LocalApplication {
  return {
    id,
    url: `https://example.com/${id}`,
    jobTitle: "Engineer",
    company: id,
    status: "Applied",
    appliedDate: "2026-11-01",
    description: null,
    notes: null,
    salary: null,
    location: null,
    jobType: null,
    nextStep: "Follow up",
    nextStepDate,
    createdAt: "2026-11-01T12:00:00.000Z",
    updatedAt: "2026-11-01T12:00:00.000Z",
    identityKey: null,
    canonicalUrl: null,
    duplicateOfId: null,
    identityState: "canonical",
    ...overrides,
  };
}

test("groups overdue, today, and later this Monday-to-Sunday week with disjoint boundaries", () => {
  const records = [
    application("Sunday overdue", "2026-11-22"),
    application("Monday overdue", "2026-11-23"),
    application("Today", "2026-11-24"),
    application("Sunday this week", "2026-11-29"),
    application("Monday next week", "2026-11-30"),
    application("No date", null),
  ];

  render(createElement(FollowUps, { applications: records, onEdit: jest.fn(), today: new Date(2026, 10, 24, 12) }));

  const overdue = within(screen.getByRole("region", { name: "Overdue" }));
  expect(overdue.getByText("Sunday overdue")).toBeTruthy();
  expect(overdue.getByText("Monday overdue")).toBeTruthy();
  const today = within(screen.getByRole("region", { name: "Today" }));
  expect(today.getByText("Today", { selector: "strong" })).toBeTruthy();
  const later = within(screen.getByRole("region", { name: "Later this week" }));
  expect(later.getByText("Sunday this week")).toBeTruthy();
  expect(screen.queryByText("Monday next week")).toBeNull();
  expect(screen.queryByText("No date")).toBeNull();
});

test("sorts each group by next-step date and opens selected applications for editing", () => {
  const onEdit = jest.fn();
  const earlier = application("Earlier", "2026-11-25");
  const later = application("Later", "2026-11-28");
  const offer = application("Offer", "2026-11-26", { status: "Offer" });
  const rejected = application("Rejected", "2026-11-26", { status: "Rejected" });

  render(createElement(FollowUps, { applications: [later, offer, rejected, earlier], onEdit, today: new Date(2026, 10, 24, 12) }));

  const group = within(screen.getByRole("region", { name: "Later this week" }));
  const buttons = group.getAllByRole("button");
  expect(buttons.map((button) => button.textContent)).toEqual(["EarlierEngineerFollow upNov 25", "OfferEngineerFollow upNov 26", "LaterEngineerFollow upNov 28"]);
  fireEvent.click(buttons[1]);
  expect(onEdit).toHaveBeenCalledWith(offer);
  expect(screen.queryByText("Rejected")).toBeNull();
});
