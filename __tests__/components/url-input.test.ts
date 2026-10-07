/** @jest-environment jsdom */

import { createElement } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import UrlInput from "@/components/UrlInput";
import { useClientApi } from "@/hooks/use-client-api";
import { ClientApiError, type ClientApi } from "@/lib/client-api";
import { useRouter } from "next/navigation";

jest.mock("@/hooks/use-client-api", () => ({
  useClientApi: jest.fn(),
}));

jest.mock("next/navigation", () => ({
  useRouter: jest.fn(),
}));

const mockApi = jest.fn() as jest.MockedFunction<ClientApi>;
const mockRefresh = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(useClientApi).mockReturnValue(mockApi);
  jest.mocked(useRouter).mockReturnValue({
    back: jest.fn(),
    forward: jest.fn(),
    refresh: mockRefresh,
    push: jest.fn(),
    replace: jest.fn(),
    prefetch: jest.fn(),
    bfcacheId: "test",
  });
});

describe("UrlInput manual entry", () => {
  it("uses focusable button tabs with roving focus and connected panels", () => {
    render(createElement(UrlInput, { manualEntryEnabled: true }));
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs.every((tab) => tab.tagName)).toBe(true);
    expect(tabs.every((tab) => tab.tagName === "BUTTON")).toBe(true);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("aria-controls", "url-panel");
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(tabs[1]).toHaveFocus();
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tabs[1], { key: "End" });
    expect(tabs[2]).toHaveFocus();
    fireEvent.keyDown(tabs[2], { key: "Home" });
    expect(tabs[0]).toHaveFocus();
  });

  it("associates URL, text, and confirmation fields with labels", async () => {
    mockApi.mockResolvedValue({ url: "https://example.com/job", jobTitle: "Role", company: "Acme" });
    render(createElement(UrlInput));
    expect(screen.getByLabelText("Job URL")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Paste Text" }));
    expect(screen.getByLabelText("Job description")).toBeInTheDocument();
    expect(screen.getByLabelText("Job URL")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Job description"), { target: { value: "Role at Acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Extract" }));
    await screen.findByDisplayValue("Role");
    expect(screen.getByLabelText("Job Title")).toHaveValue("Role");
    expect(screen.getByLabelText("Company")).toHaveValue("Acme");
  });

  it("keeps the selected tabpanel around extracted confirmation", async () => {
    mockApi.mockResolvedValue({ url: "https://example.com/job", jobTitle: "Role", company: "Acme" });
    render(createElement(UrlInput, {}));
    fireEvent.change(screen.getByPlaceholderText("Paste job URL here..."), { target: { value: "https://example.com/job" } });
    fireEvent.click(screen.getByRole("button", { name: "+ Add" }));
    await waitFor(() => expect(screen.getByDisplayValue("Role")).toBeInTheDocument());
    expect(screen.getByRole("tabpanel", { name: "URL" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Application" })).toBeInTheDocument();
  });

  it("keeps Paste Text confirmation connected to the Paste Text tab", async () => {
    mockApi.mockResolvedValue({ url: "https://example.com/job", jobTitle: "Role", company: "Acme" });
    render(createElement(UrlInput));
    fireEvent.click(screen.getByRole("tab", { name: "Paste Text" }));
    fireEvent.change(screen.getByPlaceholderText(/Paste the job description text/i), { target: { value: "Role at Acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Extract" }));
    const panel = await screen.findByRole("tabpanel", { name: "Paste Text" });
    expect(panel).toHaveAttribute("id", "text-panel");
    expect(screen.getByRole("tab", { name: "Paste Text" })).toHaveAttribute("aria-controls", "text-panel");
  });

  it("disables every source tab while extraction is in flight", async () => {
    let resolveRequest!: (value: { url: string; jobTitle: string; company: string }) => void;
    mockApi.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));
    render(createElement(UrlInput, { manualEntryEnabled: true }));
    fireEvent.change(screen.getByPlaceholderText("Paste job URL here..."), { target: { value: "https://example.com/job" } });
    fireEvent.click(screen.getByRole("button", { name: "+ Add" }));
    await waitFor(() => expect(screen.getAllByRole("tab").every((tab) => (tab as HTMLButtonElement).disabled)).toBe(true));
    resolveRequest({ url: "https://example.com/job", jobTitle: "Role", company: "Acme" });
  });

  it("keeps Manual hidden by default", () => {
    render(createElement(UrlInput, {}));
    expect(screen.queryByRole("tab", { name: "Manual" })).not.toBeInTheDocument();
  });

  it("renders the Manual mode tab when enabled", () => {
    render(createElement(UrlInput, { manualEntryEnabled: true }));
    expect(screen.getByRole("tab", { name: "Manual" })).toBeInTheDocument();
  });

  it("saves one trimmed manual application without extracting and clears on success", async () => {
    mockApi.mockResolvedValue({ id: "app-1", result: "created" });
    render(createElement(UrlInput, { manualEntryEnabled: true }));
    fireEvent.click(screen.getByRole("tab", { name: "Manual" }));

    fireEvent.change(screen.getByLabelText("Job URL"), {
      target: { value: "  https://example.invalid/manual-test  " },
    });
    fireEvent.change(screen.getByLabelText("Job Title"), {
      target: { value: "  Validation role  " },
    });
    fireEvent.change(screen.getByLabelText("Company"), {
      target: { value: "  Validation company  " },
    });
    fireEvent.submit(screen.getByLabelText("Job URL").closest("form")!);

    await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(1));
    expect(mockApi).toHaveBeenCalledWith("/api/applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.invalid/manual-test",
        jobTitle: "Validation role",
        company: "Validation company",
      }),
    });
    expect(mockApi.mock.calls.map(([path]) => path)).not.toContain("/api/extract");
    await waitFor(() => {
      expect(screen.getByLabelText("Job URL")).toHaveValue("");
      expect(screen.getByLabelText("Job Title")).toHaveValue("");
      expect(screen.getByLabelText("Company")).toHaveValue("");
      expect(screen.getByRole("status")).toHaveTextContent("Application saved.");
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("blocks required and contract-invalid manual values before calling the API", () => {
    render(createElement(UrlInput, { manualEntryEnabled: true }));
    fireEvent.click(screen.getByRole("tab", { name: "Manual" }));
    const form = screen.getByLabelText("Job URL").closest("form")!;

    fireEvent.submit(form);
    expect(mockApi).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Job URL is required");

    fireEvent.change(screen.getByLabelText("Job URL"), {
      target: { value: "https://user:password@example.invalid/job#details" },
    });
    fireEvent.change(screen.getByLabelText("Job Title"), {
      target: { value: "Validation role" },
    });
    fireEvent.change(screen.getByLabelText("Company"), {
      target: { value: "Validation company" },
    });
    fireEvent.submit(form);

    expect(mockApi).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Job URL must be a valid HTTP or HTTPS URL",
    );
  });

  it.each([
    [503, "upstream unavailable"],
    [409, "Application identity collision"],
  ])("retains manual values and shows an alert after a %i save failure", async (status, message) => {
    mockApi.mockRejectedValue(new ClientApiError(status, "request_failed", message));
    render(createElement(UrlInput, { manualEntryEnabled: true }));
    fireEvent.click(screen.getByRole("tab", { name: "Manual" }));
    fireEvent.change(screen.getByLabelText("Job URL"), {
      target: { value: "https://example.invalid/manual-test" },
    });
    fireEvent.change(screen.getByLabelText("Job Title"), {
      target: { value: "Validation role" },
    });
    fireEvent.change(screen.getByLabelText("Company"), {
      target: { value: "Validation company" },
    });
    fireEvent.submit(screen.getByLabelText("Job URL").closest("form")!);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message));
    expect(screen.getByLabelText("Job URL")).toHaveValue("https://example.invalid/manual-test");
    expect(screen.getByLabelText("Job Title")).toHaveValue("Validation role");
    expect(screen.getByLabelText("Company")).toHaveValue("Validation company");
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("allows only one pending manual save when submit events happen synchronously", async () => {
    let resolveRequest!: (value: { id: string; result: "created" }) => void;
    mockApi.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));
    render(createElement(UrlInput, { manualEntryEnabled: true }));
    fireEvent.click(screen.getByRole("tab", { name: "Manual" }));
    fireEvent.change(screen.getByLabelText("Job URL"), {
      target: { value: "https://example.invalid/manual-test" },
    });
    fireEvent.change(screen.getByLabelText("Job Title"), {
      target: { value: "Validation role" },
    });
    fireEvent.change(screen.getByLabelText("Company"), {
      target: { value: "Validation company" },
    });
    const form = screen.getByLabelText("Job URL").closest("form")!;

    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mockApi).toHaveBeenCalledTimes(1);
    resolveRequest({ id: "app-1", result: "created" });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Application saved."));
  });
});
