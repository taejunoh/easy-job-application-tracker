/** @jest-environment jsdom */

import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import ApplicationsPage from "@/app/applications/page";
import { useClientApi } from "@/hooks/use-client-api";

jest.mock("@/hooks/use-client-api", () => ({ useClientApi: jest.fn() }));
const replace = jest.fn();
let mockSearch = "";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace }),
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

const api = jest.fn();
const application = {
  id: "app-1",
  jobTitle: "Senior Engineer",
  company: "Acme Labs",
  status: "Applied",
  appliedDate: "2026-09-10T00:00:00.000Z",
  location: "New York",
  jobType: "Remote",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSearch = "";
  jest.mocked(useClientApi).mockReturnValue(api);
});

it("renders labeled search and native status and job type filters", async () => {
  api.mockResolvedValue([application]);
  render(createElement(ApplicationsPage));

  expect(screen.getByRole("heading", { name: "Applications" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Search applications" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Status" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Job type" })).toBeInTheDocument();
  await screen.findByText("Senior Engineer");
});

it("requests the exact combined search, status, and job type values", async () => {
  api.mockResolvedValue([application]);
  render(createElement(ApplicationsPage));
  await screen.findByText("Senior Engineer");

  fireEvent.change(screen.getByRole("textbox", { name: "Search applications" }), {
    target: { value: "Engineer" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Status" }), {
    target: { value: "Interview" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Job type" }), {
    target: { value: "Remote" },
  });

  await waitFor(() => {
    expect(api).toHaveBeenLastCalledWith(
      "/api/applications?search=Engineer&status=Interview",
    );
  });
});

it("sends Hybrid and Onsite as server filters", async () => {
  api.mockResolvedValue([application]);
  render(createElement(ApplicationsPage));
  await screen.findByText("Senior Engineer");

  fireEvent.change(screen.getByRole("combobox", { name: "Job type" }), {
    target: { value: "Hybrid" },
  });

  await waitFor(() => {
    expect(api).toHaveBeenLastCalledWith("/api/applications?jobType=Hybrid");
  });
});

it("includes untyped remote-location rows in the Remote type filter", async () => {
  const storedRemote = { ...application, id: "stored", jobTitle: "Stored Remote", jobType: "Remote", location: "Austin, TX" };
  const derivedRemote = { ...application, id: "derived", jobTitle: "Derived Remote", jobType: null, location: "Remote - US" };
  const onsite = { ...application, id: "onsite", jobTitle: "Onsite Role", jobType: "Onsite", location: "Remote" };
  const untyped = { ...application, id: "untyped", jobTitle: "Untyped Role", jobType: null, location: "Austin, TX" };
  api.mockResolvedValue([storedRemote, derivedRemote, onsite, untyped]);
  render(createElement(ApplicationsPage));
  await screen.findByText("Untyped Role");

  fireEvent.change(screen.getByRole("combobox", { name: "Job type" }), {
    target: { value: "Remote" },
  });

  await waitFor(() => expect(screen.queryByText("Untyped Role")).not.toBeInTheDocument());
  expect(screen.getByText("Stored Remote")).toBeInTheDocument();
  expect(screen.getByText("Derived Remote")).toBeInTheDocument();
  expect(screen.queryByText("Onsite Role")).not.toBeInTheDocument();
});

it("keeps filter values after a request failure and shows an alert", async () => {
  api.mockResolvedValue([application]);
  render(createElement(ApplicationsPage));
  await screen.findByText("Senior Engineer");
  api.mockImplementation((url: string) =>
    url.includes("Engineer")
      ? Promise.reject(new Error("Unavailable"))
      : Promise.resolve([application]),
  );

  const search = screen.getByRole("textbox", { name: "Search applications" });
  const status = screen.getByRole("combobox", { name: "Status" });
  const jobType = screen.getByRole("combobox", { name: "Job type" });
  fireEvent.change(search, { target: { value: "Engineer" } });
  fireEvent.change(status, { target: { value: "Interview" } });
  fireEvent.change(jobType, { target: { value: "Remote" } });

  expect(await screen.findByRole("alert")).toHaveTextContent("Unavailable");
  expect(search).toHaveValue("Engineer");
  expect(status).toHaveValue("Interview");
  expect(jobType).toHaveValue("Remote");
});

describe("attention=stale filter", () => {
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const stale = { ...application, id: "stale", jobTitle: "Stale Role", appliedDate: daysAgo(60) };
  const fresh = { ...application, id: "fresh", jobTitle: "Fresh Role", appliedDate: daysAgo(2) };

  it("requests Applied rows and shows only stale ones with a clear control", async () => {
    mockSearch = "attention=stale";
    api.mockResolvedValue([stale, fresh]);
    render(createElement(ApplicationsPage));

    expect(await screen.findByText("Stale Role")).toBeInTheDocument();
    expect(screen.queryByText("Fresh Role")).not.toBeInTheDocument();
    expect(api).toHaveBeenLastCalledWith("/api/applications?status=Applied");
    expect(screen.getByText(/Showing stale applications/)).toBeInTheDocument();
  });

  it("clears the filter by dropping only the attention parameter", async () => {
    mockSearch = "attention=stale&status=Applied";
    api.mockResolvedValue([stale, fresh]);
    render(createElement(ApplicationsPage));
    await screen.findByText("Stale Role");

    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(replace).toHaveBeenCalledWith("/applications?status=Applied");
  });

  it("clears back to the bare list when attention is the only parameter", async () => {
    mockSearch = "attention=stale";
    api.mockResolvedValue([stale]);
    render(createElement(ApplicationsPage));
    await screen.findByText("Stale Role");

    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(replace).toHaveBeenCalledWith("/applications");
  });

  it("shows every row and no filter notice without the parameter", async () => {
    api.mockResolvedValue([stale, fresh]);
    render(createElement(ApplicationsPage));

    expect(await screen.findByText("Fresh Role")).toBeInTheDocument();
    expect(screen.getByText("Stale Role")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear filter" })).not.toBeInTheDocument();
  });

  it("ignores unknown attention values and seeds the status filter from the URL", async () => {
    mockSearch = "attention=bogus&status=Offer";
    api.mockResolvedValue([fresh]);
    render(createElement(ApplicationsPage));

    expect(await screen.findByText("Fresh Role")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("Offer");
    expect(api).toHaveBeenLastCalledWith("/api/applications?status=Offer");
    expect(screen.queryByText(/Showing stale applications/)).not.toBeInTheDocument();
  });
});
