/** @jest-environment jsdom */

import { createElement } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import DashboardPage from "@/app/page";
import { useClientApi } from "@/hooks/use-client-api";

jest.mock("@/hooks/use-client-api", () => ({ useClientApi: jest.fn() }));

const api = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(useClientApi).mockReturnValue(api);
});

it("renders all six metrics, four status counts, and recent application fields", async () => {
  api.mockResolvedValue({
    total: 8, applied: 4, interview: 2, offer: 1, rejected: 1,
    weeklyCount: 3, monthlyCount: 6,
    recentApplications: [{ id: "a1", jobTitle: "Staff Engineer", company: "Acme", status: "Interview", appliedDate: "2026-09-10T00:00:00.000Z" }],
  });
  render(createElement(DashboardPage));

  await waitFor(() => expect(screen.getByText("Total Applied", { selector: ".stat-label" })).toBeInTheDocument());
  for (const label of ["Total Applied", "Interviewing", "Offers", "Rejected", "This Week", "This Month"]) {
    expect(screen.getByText(label, { selector: ".stat-label" })).toBeInTheDocument();
  }
  const summary = screen.getByRole("region", { name: "Status summary" });
  for (const label of ["Applied", "Interview", "Offer", "Rejected"]) {
    expect(within(summary).getByText(label, { selector: "[data-status-label]" })).toBeInTheDocument();
  }
  expect(screen.getByText("Staff Engineer")).toBeInTheDocument();
  expect(screen.getByText("Acme")).toBeInTheDocument();
});

it("keeps an alert for stats errors", async () => {
  api.mockRejectedValue(new Error("Stats unavailable"));
  render(createElement(DashboardPage));
  expect(await screen.findByRole("alert")).toHaveTextContent("Stats unavailable");
  expect(screen.getByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
  expect(screen.getByTestId("dashboard-content")).toHaveAttribute("aria-busy", "true");
});

it("shows first-application guidance for an empty dashboard", async () => {
  api.mockResolvedValue({ total: 0, applied: 0, interview: 0, offer: 0, rejected: 0, weeklyCount: 0, monthlyCount: 0, recentApplications: [] });
  render(createElement(DashboardPage));
  expect(await screen.findByText("No applications yet.")).toBeInTheDocument();
  expect(screen.getByText(/Add application card above/i)).toBeInTheDocument();
});

it("scopes recent date and status assertions to the recent row", async () => {
  api.mockResolvedValue({ total: 1, applied: 1, interview: 0, offer: 0, rejected: 0, weeklyCount: 1, monthlyCount: 1, recentApplications: [{ id: "a1", jobTitle: "Staff Engineer", company: "Acme", status: "Applied", appliedDate: "2026-09-10T00:00:00.000Z" }] });
  render(createElement(DashboardPage));
  const row = await screen.findByRole("listitem");
  expect(row).toHaveTextContent("Staff Engineer");
  expect(row).toHaveTextContent("Acme");
  expect(row).toHaveTextContent("Applied");
  expect(row.querySelector("time")).toHaveAttribute("datetime", "2026-09-10T00:00:00.000Z");
});
