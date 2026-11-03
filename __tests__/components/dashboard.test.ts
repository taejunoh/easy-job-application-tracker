/** @jest-environment jsdom */

import { createElement } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import DashboardPage from "@/app/page";
import { useClientApi } from "@/hooks/use-client-api";

jest.mock("@/hooks/use-client-api", () => ({ useClientApi: jest.fn() }));

const api = jest.fn();

function mockApi(stats: unknown, applied: unknown = []) {
  api.mockImplementation((path: string) => {
    if (path === "/api/stats") return Promise.resolve(stats);
    if (path === "/api/applications?status=Applied") return Promise.resolve(applied);
    return Promise.reject(new Error(`Unexpected request ${path}`));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(useClientApi).mockReturnValue(api);
});

it("renders all six metrics, four status counts, and recent application fields", async () => {
  mockApi({
    total: 8, applied: 4, interview: 2, offer: 1, rejected: 1,
    weeklyCount: 3, monthlyCount: 6,
    recentApplications: [{ id: "a1", jobTitle: "Staff Engineer", company: "Acme", status: "Interview", appliedDate: "2026-09-10T00:00:00.000Z" }],
  });
  render(createElement(DashboardPage));

  await waitFor(() => expect(screen.getByText("Total Applied", { selector: ".stat-label" })).toBeInTheDocument());
  for (const label of ["Total Applied", "Stale applications", "Interviewing", "Offers", "Rejected", "This Week", "This Month"]) {
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
  mockApi({ total: 0, applied: 0, interview: 0, offer: 0, rejected: 0, weeklyCount: 0, monthlyCount: 0, recentApplications: [] });
  render(createElement(DashboardPage));
  expect(await screen.findByText("No applications yet.")).toBeInTheDocument();
  expect(screen.getByText(/Add application card above/i)).toBeInTheDocument();
});

it("scopes recent date and status assertions to the recent row", async () => {
  mockApi({ total: 1, applied: 1, interview: 0, offer: 0, rejected: 0, weeklyCount: 1, monthlyCount: 1, recentApplications: [{ id: "a1", jobTitle: "Staff Engineer", company: "Acme", status: "Applied", appliedDate: "2026-09-10T00:00:00.000Z" }] });
  render(createElement(DashboardPage));
  const row = await screen.findByRole("listitem");
  expect(row).toHaveTextContent("Staff Engineer");
  expect(row).toHaveTextContent("Acme");
  expect(row).toHaveTextContent("Applied");
  expect(row.querySelector("time")).toHaveAttribute("datetime", "2026-09-10T00:00:00.000Z");
});

it("links a stale-application count to the filtered applications list next to interviews and offers", async () => {
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  mockApi(
    { total: 5, applied: 3, interview: 2, offer: 1, rejected: 0, weeklyCount: 1, monthlyCount: 2, recentApplications: [] },
    [
      { id: "old", status: "Applied", appliedDate: daysAgo(45) },
      { id: "older", status: "Applied", appliedDate: daysAgo(120) },
      { id: "new", status: "Applied", appliedDate: daysAgo(3) },
    ],
  );
  render(createElement(DashboardPage));

  const section = await screen.findByRole("region", { name: "What needs your attention" });
  const stale = within(section).getByRole("link", { name: /Stale applications/ });
  expect(stale).toHaveAttribute("href", "/applications?attention=stale");
  expect(stale).toHaveTextContent("2");
  expect(within(section).getByRole("link", { name: /Interviewing/ })).toHaveAttribute("href", "/applications?status=Interview");
  expect(within(section).getByRole("link", { name: /Offers/ })).toHaveAttribute("href", "/applications?status=Offer");
});

it("keeps the dashboard usable when the stale count cannot be loaded", async () => {
  api.mockImplementation((path: string) =>
    path === "/api/stats"
      ? Promise.resolve({ total: 1, applied: 1, interview: 0, offer: 0, rejected: 0, weeklyCount: 0, monthlyCount: 0, recentApplications: [] })
      : Promise.reject(new Error("list unavailable")),
  );
  render(createElement(DashboardPage));

  const section = await screen.findByRole("region", { name: "What needs your attention" });
  expect(within(section).queryByRole("link", { name: /Stale applications/ })).not.toBeInTheDocument();
  expect(within(section).getByText("Stale applications")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
