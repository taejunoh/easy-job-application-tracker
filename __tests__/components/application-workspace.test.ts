/** @jest-environment jsdom */

import { createElement, useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ApplicationChangesContext } from "@/components/ApplicationChanges";
import UrlInput from "@/components/UrlInput";
import ApplicationsPage from "@/app/applications/page";
import { useClientApi } from "@/hooks/use-client-api";

jest.mock("@/hooks/use-client-api", () => ({ useClientApi: jest.fn() }));
const push = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const application = {
  id: "app-1",
  jobTitle: "Platform Engineer",
  company: "Acme Labs",
  status: "Interview",
  appliedDate: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-12T18:00:00.000Z",
  location: "New York",
  jobType: "Remote",
  url: "https://jobs.example.test/roles/1",
  salary: null,
  notes: "Bring portfolio",
  description: null,
  nextStep: null,
  nextStepDate: null,
};

const second = { ...application, id: "app-2", jobTitle: "Product Engineer", company: "Fieldwork" };
const api = jest.fn();

function today() {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((part) => String(part).padStart(2, "0")).join("-");
}

beforeEach(() => {
  jest.clearAllMocks();
  let records = [application, second];
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/settings")) return { resumeText: "" };
    if (init?.method === "POST") {
      const record = { ...application, ...JSON.parse(String(init.body)), id: "new-application", status: "Applied" };
      records = [...records, record];
      return { id: record.id, result: "created" };
    }
    if (init?.method === "PATCH") {
      const changed = { ...records.find(({ id }) => url.endsWith(id))!, ...JSON.parse(String(init.body)) };
      records = records.map((record) => record.id === changed.id ? changed : record);
      return changed;
    }
    if (init?.method === "DELETE") {
      records = records.filter(({ id }) => !url.endsWith(id));
      return { success: true };
    }
    return records;
  });
  jest.mocked(useClientApi).mockReturnValue(api);
});

it("keeps the same record and draft across views, saves a real calendar event, and refreshes on delete", async () => {
  render(createElement(ApplicationsPage));
  fireEvent.click(await screen.findByRole("link", { name: "Platform Engineer" }));
  const panel = screen.getByRole("complementary", { name: "Application record" });
  expect(within(panel).getByRole("heading", { name: "Acme Labs" })).toBeInTheDocument();
  fireEvent.click(within(panel).getByRole("button", { name: "Edit application" }));
  fireEvent.change(within(panel).getByLabelText("Next step"), { target: { value: "Send portfolio" } });
  fireEvent.change(within(panel).getByLabelText("Next step date"), { target: { value: today() } });

  const list = screen.getByRole("tab", { name: "List" });
  fireEvent.keyDown(list, { key: "ArrowRight" });
  expect(screen.getByRole("tab", { name: "Board" })).toHaveFocus();
  expect(screen.getByRole("tab", { name: "Board" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("complementary", { name: "Application record" })).toBe(panel);
  expect(within(panel).getByLabelText("Next step")).toHaveValue("Send portfolio");
  expect(within(screen.getByRole("tabpanel")).getByRole("button", { name: /Acme Labs.*Platform Engineer/ })).toHaveAttribute("aria-pressed", "true");

  fireEvent.click(screen.getByRole("tab", { name: "Calendar" }));
  expect(within(screen.getByRole("tabpanel")).queryByText("Send portfolio")).not.toBeInTheDocument();
  fireEvent.click(within(panel).getByRole("button", { name: "Save Changes" }));
  expect(await within(screen.getByRole("tabpanel")).findByRole("button", { name: /Send portfolio.*Acme Labs/ })).toHaveAttribute("aria-pressed", "true");

  fireEvent.click(within(panel).getByRole("button", { name: /Close application record/ }));
  expect(screen.queryByRole("complementary", { name: "Application record" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Send portfolio.*Acme Labs/ }));
  const reopened = screen.getByRole("complementary", { name: "Application record" });
  expect(within(reopened).getByRole("heading", { name: "Acme Labs" })).toBeInTheDocument();
  fireEvent.click(within(reopened).getByRole("button", { name: "Edit application" }));
  fireEvent.click(within(reopened).getByRole("button", { name: "Delete Application" }));
  fireEvent.click(within(reopened).getByRole("button", { name: "Yes, Delete" }));
  await waitFor(() => expect(screen.queryByRole("complementary")).not.toBeInTheDocument());
  await waitFor(() => expect(screen.queryByRole("button", { name: /Send portfolio.*Acme Labs/ })).not.toBeInTheDocument());
  expect(screen.getByRole("tab", { name: "Calendar" })).toHaveAttribute("aria-selected", "true");
  expect(push).not.toHaveBeenCalled();
});

it("prompts before discarding a dirty record and preserves it when declined", async () => {
  const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);
  try {
    render(createElement(ApplicationsPage));
    fireEvent.click(await screen.findByRole("link", { name: "Platform Engineer" }));
    const panel = screen.getByRole("complementary", { name: "Application record" });
    fireEvent.click(within(panel).getByRole("button", { name: "Edit application" }));
    fireEvent.change(within(panel).getByRole("textbox", { name: "Notes" }), { target: { value: "Unsaved note" } });

    fireEvent.click(screen.getByRole("link", { name: "Product Engineer" }));
    expect(confirm).toHaveBeenCalled();
    expect(within(panel).getByRole("textbox", { name: "Notes" })).toHaveValue("Unsaved note");
    fireEvent.click(within(panel).getByRole("button", { name: /Close application record/ }));
    expect(screen.getByRole("complementary", { name: "Application record" })).toBe(panel);

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("link", { name: "Product Engineer" }));
    expect(within(panel).getByRole("heading", { name: "Fieldwork" })).toBeInTheDocument();
  } finally {
    confirm.mockRestore();
  }
});


it("shows saved fields even when a record is reopened before its refresh returns", async () => {
  const dispatch = api.getMockImplementation()!;
  let resolveList: ((records: unknown) => void) | undefined;
  api.mockImplementation((url: string, init?: RequestInit) => {
    if (url.startsWith("/api/applications?") && resolveList === undefined && api.mock.calls.length > 1) {
      return new Promise((resolve) => { resolveList = resolve; });
    }
    return dispatch(url, init);
  });

  render(createElement(ApplicationsPage));
  fireEvent.click(await screen.findByRole("link", { name: "Platform Engineer" }));
  const panel = screen.getByRole("complementary", { name: "Application record" });
  fireEvent.click(within(panel).getByRole("button", { name: "Edit application" }));
  fireEvent.change(within(panel).getByRole("textbox", { name: "Notes" }), { target: { value: "Just saved" } });
  fireEvent.click(within(panel).getByRole("button", { name: "Save Changes" }));
  await within(panel).findByText("Just saved");
  await waitFor(() => expect(resolveList).toBeDefined());

  fireEvent.click(within(panel).getByRole("button", { name: /Close application record/ }));
  fireEvent.click(screen.getByRole("link", { name: "Platform Engineer" }));
  expect(within(screen.getByRole("complementary")).getByText("Just saved")).toBeInTheDocument();
  await act(async () => resolveList?.([{ ...application, notes: "Just saved" }, second]));
});

it("refreshes the current Board after a successful create through the existing input", async () => {
  function WithAddForm() {
    const [revision, setRevision] = useState(0);
    return createElement(ApplicationChangesContext.Provider, {
      value: { revision, notify: () => setRevision((previous) => previous + 1) },
    }, createElement(UrlInput, { manualEntryEnabled: true }), createElement(ApplicationsPage));
  }
  render(createElement(WithAddForm));
  await screen.findByRole("link", { name: "Platform Engineer" });
  fireEvent.click(screen.getByRole("tab", { name: "Board" }));
  fireEvent.click(screen.getByRole("tab", { name: "Manual" }));
  fireEvent.change(screen.getByLabelText("Job URL"), { target: { value: "https://jobs.example.test/roles/3" } });
  fireEvent.change(screen.getByLabelText("Job Title"), { target: { value: "Design Engineer" } });
  fireEvent.change(screen.getByLabelText("Company"), { target: { value: "Aurora Labs" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Application" }));

  const board = screen.getByRole("tabpanel", { name: "Board" });
  expect(await within(board).findByRole("button", { name: /Aurora Labs.*Design Engineer/ })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Board" })).toHaveAttribute("aria-selected", "true");
});

it("keeps the newer saved status when an older inline edit returns after the record leaves the filter", async () => {
  const dispatch = api.getMockImplementation()!;
  let completeInline: ((value: unknown) => void) | undefined;
  const newer = { ...application, status: "Rejected", updatedAt: "2026-11-10T16:00:00.000Z" };
  api.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      const { status } = JSON.parse(String(init.body));
      if (status === "Offer") return new Promise((resolve) => { completeInline = resolve; });
      return Promise.resolve(newer);
    }
    if (url.includes("status=Interview")) return Promise.resolve([second]);
    return dispatch(url, init);
  });

  render(createElement(ApplicationsPage));
  fireEvent.click(await screen.findByRole("link", { name: "Platform Engineer" }));
  fireEvent.click(screen.getByRole("button", { name: /Status for Platform Engineer/ }));
  fireEvent.change(screen.getByRole("combobox", { name: "Status for Platform Engineer" }), { target: { value: "Offer" } });
  expect(completeInline).toBeDefined();

  const panel = screen.getByRole("complementary");
  fireEvent.click(within(panel).getByRole("button", { name: "Edit application" }));
  fireEvent.change(within(panel).getByRole("combobox", { name: "Status" }), { target: { value: "Rejected" } });
  fireEvent.change(within(screen.getByRole("group", { name: "Filter applications" })).getByRole("combobox", { name: "Status" }), { target: { value: "Interview" } });
  fireEvent.click(within(panel).getByRole("button", { name: "Save Changes" }));
  await within(panel).findByRole("heading", { name: "Acme Labs" });
  expect(within(panel).getByText("Rejected")).toBeInTheDocument();
  await act(async () => completeInline?.({ ...application, status: "Offer", updatedAt: "2026-11-10T15:59:00.000Z" }));
  expect(within(panel).getByText("Rejected")).toBeInTheDocument();
});
