/** @jest-environment jsdom */

import { createElement } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import ApplicationDetail from "@/components/ApplicationDetail";
import { useClientApi } from "@/hooks/use-client-api";

jest.mock("@/hooks/use-client-api", () => ({ useClientApi: jest.fn() }));

const push = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: jest.fn(), refresh: jest.fn() }),
}));

const application = {
  id: "app-1",
  url: "https://jobs.example.com/roles/platform-engineer?source=long-link",
  jobTitle: "Platform Engineer",
  company: "Example Systems",
  status: "Applied",
  appliedDate: "2026-09-10T00:00:00.000Z",
  description: "TypeScript React Kubernetes",
  notes: "Follow up next week",
  salary: "$150k - $180k",
  location: "New York, NY",
  jobType: "Hybrid",
};

const api = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  api.mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/api/settings?includeResume=true") {
      return Promise.resolve({ resumeText: "TypeScript React" });
    }
    if (init?.method === "PATCH") return Promise.resolve({});
    if (init?.method === "DELETE") return Promise.resolve({});
    return Promise.resolve({});
  });
  jest.mocked(useClientApi).mockReturnValue(api);
});

it("presents a labeled hierarchy before metadata and separate content sections", async () => {
  render(createElement(ApplicationDetail, { application }));

  expect(screen.getByLabelText("Job title")).toHaveValue("Platform Engineer");
  expect(screen.getByLabelText("Company")).toHaveValue("Example Systems");
  expect(screen.getByLabelText("Status")).toHaveValue("Applied");
  expect(screen.getByRole("heading", { name: "Job Description" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Source URL" })).toBeInTheDocument();
  expect(screen.getByText("Date Applied")).toBeInTheDocument();
  expect(screen.getByLabelText("Location")).toHaveValue("New York, NY");
  expect(screen.getByLabelText("Salary Range")).toHaveValue("$150k - $180k");
  expect(screen.getByLabelText("Job Type")).toHaveValue("Hybrid");
  expect(screen.getByLabelText("Job title").compareDocumentPosition(screen.getByText("Date Applied")))
    .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(screen.getByRole("link", { name: application.url })).toHaveClass("source-link");
});

it("keeps keyword percentage and matched/missing details behind a toggle", async () => {
  render(createElement(ApplicationDetail, { application }));
  const toggle = await screen.findByRole("button", { name: /Keyword Match Analysis/i });
  expect(toggle).toHaveTextContent("67%");
  expect(screen.queryByText("Matched", { selector: "h4" })).not.toBeInTheDocument();
  fireEvent.click(toggle);
  expect(await screen.findByText("Matched", { selector: "h4" })).toBeInTheDocument();
  expect(screen.getByText("Missing", { selector: "h4" })).toBeInTheDocument();
  expect(screen.getByText("TypeScript")).toBeInTheDocument();
});

it("links to settings when a description has no resume available", async () => {
  api.mockImplementation((path: string) =>
    path === "/api/settings?includeResume=true" ? Promise.resolve({ resumeText: "" }) : Promise.resolve({}),
  );
  render(createElement(ApplicationDetail, { application }));
  const settingsLink = await screen.findByRole("link", { name: "Settings" });
  expect(settingsLink).toHaveAttribute("href", "/settings");
  fireEvent.click(settingsLink);
  expect(push).toHaveBeenCalledWith("/settings");
});

it("toggles keyword analysis from anywhere in its full header", async () => {
  render(createElement(ApplicationDetail, { application }));
  const heading = await screen.findByRole("heading", { name: "Keyword Match Analysis" });
  expect(screen.queryByText("Matched", { selector: "h4" })).not.toBeInTheDocument();
  fireEvent.click(heading);
  expect(await screen.findByText("Matched", { selector: "h4" })).toBeInTheDocument();
});

it("keeps the original high, medium, and low keyword score thresholds", async () => {
  const cases = [
    { resumeText: "TypeScript React Kubernetes", expected: "score-high" },
    { resumeText: "TypeScript React", expected: "score-medium" },
    { resumeText: "Python", expected: "score-low" },
  ];
  for (const { resumeText, expected } of cases) {
    api.mockImplementation((path: string) =>
      path === "/api/settings?includeResume=true" ? Promise.resolve({ resumeText }) : Promise.resolve({}),
    );
    const { unmount } = render(createElement(ApplicationDetail, { application }));
    const analysis = await screen.findByRole("heading", { name: "Keyword Match Analysis" });
    expect(analysis.closest("button")).toHaveClass(expected);
    unmount();
  }
});

it("shows saving then Saved and sends the existing PATCH body", async () => {
  let resolveSave: (() => void) | undefined;
  api.mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/api/settings?includeResume=true") return Promise.resolve({ resumeText: "" });
    if (init?.method === "PATCH") return new Promise<void>((resolve) => { resolveSave = resolve; });
    return Promise.resolve({});
  });
  render(createElement(ApplicationDetail, { application }));
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  expect(await screen.findByRole("button", { name: "Saving..." })).toBeDisabled();
  expect(api).toHaveBeenCalledWith(`/api/applications/${application.id}`, expect.objectContaining({
    method: "PATCH",
    body: JSON.stringify(applicationBody()),
  }));
  await act(async () => resolveSave?.());
  expect(await screen.findByText("Saved")).toBeInTheDocument();
});

it("confirms deletion and navigates only after the DELETE resolves", async () => {
  let resolveDelete: (() => void) | undefined;
  api.mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/api/settings?includeResume=true") return Promise.resolve({ resumeText: "" });
    if (init?.method === "DELETE") return new Promise<void>((resolve) => { resolveDelete = resolve; });
    return Promise.resolve({});
  });
  render(createElement(ApplicationDetail, { application }));
  fireEvent.click(screen.getByRole("button", { name: "Delete Application" }));
  expect(screen.getByText("Are you sure?")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Yes, Delete" }));
  expect(push).not.toHaveBeenCalled();
  await act(async () => resolveDelete?.());
  await waitFor(() => expect(push).toHaveBeenCalledWith("/applications"));
});

function applicationBody() {
  return {
    jobTitle: application.jobTitle,
    company: application.company,
    status: application.status,
    description: application.description,
    notes: application.notes,
    salary: application.salary,
    location: application.location,
    jobType: application.jobType,
  };
}
