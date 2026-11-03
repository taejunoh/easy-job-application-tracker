/** @jest-environment jsdom */

import { createElement } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import AppShell from "@/components/AppShell";
import ApplicationDetail from "@/components/ApplicationDetail";
import ApplicationTable from "@/components/ApplicationTable";
import { ExtensionInstallations } from "@/components/ExtensionInstallations";
import UrlInput from "@/components/UrlInput";
import SettingsPage from "@/app/settings/page";
import {
  READ_ONLY_MESSAGE,
  WritesStoppedProvider,
  useWritesStopped,
} from "@/components/WriteState";
import { useClientApi } from "@/hooks/use-client-api";
import type { ClientApi } from "@/lib/client-api";

jest.mock("@/hooks/use-client-api", () => ({ useClientApi: jest.fn() }));
jest.mock("next/navigation", () => ({
  usePathname: () => "/applications",
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
}));
jest.mock("@/components/Sidebar", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/UrlInputWrapper", () => ({ __esModule: true, default: () => null }));

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const api = jest.fn();

const application = {
  id: "app-1",
  url: "https://jobs.example.com/roles/1",
  jobTitle: "Platform Engineer",
  company: "Example Systems",
  status: "Applied",
  appliedDate: "2026-09-10T00:00:00.000Z",
  description: "TypeScript",
  notes: "Note",
  salary: "$150k",
  location: "New York, NY",
  jobType: "Hybrid",
};

beforeEach(() => {
  jest.clearAllMocks();
  api.mockImplementation((path: string) => {
    if (path.startsWith("/api/settings")) {
      return Promise.resolve({ llmProvider: "openai", hasApiKey: true, resumeText: "" });
    }
    if (path === "/api/extension/installations") {
      return Promise.resolve({
        installations: [{ id: "018f9f72-f2e9-7c29-a6fc-001122334499", origin: ORIGIN, createdAt: "2026-08-13T12:00:00.000Z", expiresAt: "2026-08-13T13:00:00.000Z", lastUsedAt: null, revokedAt: null }],
        configuredOrigins: [ORIGIN],
      });
    }
    return Promise.resolve({});
  });
  jest.mocked(useClientApi).mockReturnValue(api as unknown as ClientApi);
});

function stopped(child: React.ReactElement) {
  return createElement(WritesStoppedProvider, { value: true }, child);
}

describe("AppShell write-stop banner", () => {
  it("shows the read-only banner and provides the state when writes are stopped", () => {
    function Probe() {
      return createElement("p", null, useWritesStopped() ? "STOPPED" : "ENABLED");
    }
    render(createElement(AppShell, { writesStopped: true }, createElement(Probe)));
    expect(screen.getByRole("status")).toHaveTextContent(READ_ONLY_MESSAGE);
    expect(screen.getByText("STOPPED")).toBeInTheDocument();
  });

  it("shows no banner and leaves controls enabled by default", () => {
    function Probe() {
      return createElement("p", null, useWritesStopped() ? "STOPPED" : "ENABLED");
    }
    render(createElement(AppShell, null, createElement(Probe)));
    expect(screen.queryByText(READ_ONLY_MESSAGE)).not.toBeInTheDocument();
    expect(screen.getByText("ENABLED")).toBeInTheDocument();
  });
});

describe("controls whose routes are blocked by the write stop", () => {
  it("disables every submit path of the add-application form but keeps tabs and inputs usable", () => {
    render(stopped(createElement(UrlInput, { manualEntryEnabled: true })));
    fireEvent.change(screen.getByLabelText("Job URL"), { target: { value: "https://example.com/job" } });
    expect(screen.getByRole("button", { name: "+ Add" })).toBeDisabled();
    expect(screen.getByText(/Adding applications is unavailable/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Paste Text" }));
    fireEvent.change(screen.getByLabelText("Job description"), { target: { value: "text" } });
    expect(screen.getByRole("button", { name: "Extract" })).toBeDisabled();

    fireEvent.click(screen.getByRole("tab", { name: "Manual" }));
    expect(screen.getByRole("button", { name: "Save Application" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "URL" })).toBeEnabled();
  });

  it("leaves the add-application form enabled when writes are allowed", () => {
    render(createElement(UrlInput));
    fireEvent.change(screen.getByLabelText("Job URL"), { target: { value: "https://example.com/job" } });
    expect(screen.getByRole("button", { name: "+ Add" })).toBeEnabled();
  });

  it("makes the application detail read-only without disabling navigation", () => {
    render(stopped(createElement(ApplicationDetail, { application })));
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Application" })).toBeDisabled();
    expect(screen.getByLabelText("Job title")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Status")).toBeDisabled();
    expect(screen.getByRole("button", { name: /Back to Applications/ })).toBeEnabled();
  });

  it("shows the status as a plain badge, not an editor, in the applications list", () => {
    render(stopped(createElement(ApplicationTable, {
      applications: [{ ...application, location: null, jobType: null }],
      onStatusChange: jest.fn(),
    })));
    const row = screen.getAllByRole("row")[1];
    expect(within(row).queryByRole("button", { name: /Status for/ })).not.toBeInTheDocument();
    expect(within(row).queryByRole("combobox")).not.toBeInTheDocument();
    expect(row.querySelector(".status-applied")).toHaveTextContent("Applied");
    expect(row.querySelector(`[title="${READ_ONLY_MESSAGE}"]`)).not.toBeNull();
  });

  it("disables pairing and revoke but keeps the origin picker", async () => {
    render(stopped(createElement(ExtensionInstallations, { api: api as unknown as ClientApi })));
    const section = await screen.findByRole("region", { name: "Chrome extension installations" });
    await within(section).findByRole("button", { name: "Revoke" });
    expect(within(section).getByRole("button", { name: "Create pairing code" })).toBeDisabled();
    expect(within(section).getByRole("button", { name: "Revoke" })).toBeDisabled();
    expect(within(section).getByLabelText("Extension origin")).toBeEnabled();
  });

  it("disables Save Settings but keeps unguarded settings actions enabled", async () => {
    render(stopped(createElement(SettingsPage)));
    await waitFor(() => expect(screen.getByRole("button", { name: "Test Connection" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Save Settings" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Show" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));
    expect(api).not.toHaveBeenCalledWith("/api/settings", expect.objectContaining({ method: "PUT" }));
  });
});
