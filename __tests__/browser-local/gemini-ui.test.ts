/** @jest-environment jsdom */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createElement, useState } from "react";
import ApplicationEditor from "../../src/browser-local/ui/ApplicationEditor";

const mockExtract = jest.fn();
jest.mock("../../src/browser-local/ai/gemini", () => ({
  GEMINI_POSTING_MAX_LENGTH: 8_000,
  extractJobDetails: (...args: unknown[]) => mockExtract(...args),
}));

const onSave = jest.fn();
const onDelete = jest.fn();

function EditorHarness() {
  const [open, setOpen] = useState(true);
  return open ? createElement(ApplicationEditor, {
    application: null,
    resumeText: "Private résumé text",
    onSave,
    onDelete,
    onClose: () => setOpen(false),
  }) : null;
}

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value() { this.open = true; } },
    close: { configurable: true, value() { this.open = false; } },
  });
});

function expandAndFill() {
  fireEvent.click(screen.getByRole("button", { name: "Extract with Gemini (optional)" }));
  const key = screen.getByLabelText("Gemini API key") as HTMLInputElement;
  const posting = screen.getByLabelText("Job posting text");
  fireEvent.change(key, { target: { value: "ephemeral-key" } });
  fireEvent.change(posting, { target: { value: "Public posting text" } });
  return key;
}

test("Gemini sends only explicitly pasted content and waits for review before applying", async () => {
  mockExtract.mockResolvedValue({ company: "Reviewed Co.", jobTitle: "Data Analyst" });
  render(createElement(EditorHarness));

  expect(screen.queryByLabelText("Gemini API key")).toBeNull();
  expect(mockExtract).not.toHaveBeenCalled();

  const company = screen.getByLabelText("Company") as HTMLInputElement;
  fireEvent.change(company, { target: { value: "Existing Co." } });
  fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Private notes" } });
  fireEvent.change(screen.getByLabelText("Job description"), { target: { value: "Local description" } });
  const key = expandAndFill();
  expect(key.form).toBeNull();
  expect(mockExtract).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Send to Gemini" }));
  expect(key.value).toBe("");
  expect(mockExtract).toHaveBeenCalledWith("ephemeral-key", "Public posting text", expect.any(AbortSignal));
  await screen.findByText("Reviewed Co.");
  expect(company.value).toBe("Existing Co.");

  fireEvent.click(screen.getByRole("button", { name: "Apply extracted fields" }));
  expect(company.value).toBe("Reviewed Co.");
  expect((screen.getByLabelText("Job title") as HTMLInputElement).value).toBe("Data Analyst");
  fireEvent.change(company, { target: { value: "Edited Co." } });
  expect(company.value).toBe("Edited Co.");
  expect(onSave).not.toHaveBeenCalled();
});

test("closing the editor clears the key and aborts a pending extraction", async () => {
  let complete!: (result: { company: string }) => void;
  mockExtract.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
  render(createElement(EditorHarness));
  const key = expandAndFill();

  fireEvent.click(screen.getByRole("button", { name: "Send to Gemini" }));
  const signal = mockExtract.mock.calls[0][2] as AbortSignal;
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(key.value).toBe("");
  expect(signal.aborted).toBe(true);

  await act(async () => complete({ company: "Late company" }));
  expect(screen.queryByText("Late company")).toBeNull();
});

test("a failed request clears the key and displays a fixed error message", async () => {
  mockExtract.mockRejectedValue(new Error("ephemeral-key"));
  render(createElement(EditorHarness));
  const key = expandAndFill();

  fireEvent.click(screen.getByRole("button", { name: "Send to Gemini" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/Gemini extraction failed/);
  expect(alert.textContent).not.toContain("ephemeral-key");
  expect(key.value).toBe("");
});

test("pasted results are reviewed locally and preserve fields absent from the result", () => {
  render(createElement(EditorHarness));
  const company = screen.getByLabelText("Company") as HTMLInputElement;
  const title = screen.getByLabelText("Job title") as HTMLInputElement;
  fireEvent.change(company, { target: { value: "Existing Co." } });
  fireEvent.click(screen.getByRole("button", { name: "Use another AI (optional)" }));
  const result = screen.getByLabelText("AI result JSON") as HTMLTextAreaElement;

  fireEvent.change(result, { target: { value: JSON.stringify({ company: 12, jobTitle: "Wrong" }) } });
  fireEvent.click(screen.getByRole("button", { name: "Review pasted result" }));
  expect(screen.getByRole("alert").textContent).toMatch(/valid JSON/);
  expect(screen.queryByText("Wrong")).toBeNull();

  fireEvent.change(result, { target: { value: JSON.stringify({ company: null, jobTitle: "Data Analyst", notes: "Ignore" }) } });
  fireEvent.click(screen.getByRole("button", { name: "Review pasted result" }));
  expect(screen.getByText("Data Analyst")).toBeTruthy();
  expect(screen.queryByText("Ignore")).toBeNull();
  expect(title.value).toBe("");

  fireEvent.click(screen.getByRole("button", { name: "Apply extracted fields" }));
  expect(company.value).toBe("Existing Co.");
  expect(title.value).toBe("Data Analyst");
  expect(mockExtract).not.toHaveBeenCalled();
  expect(onSave).not.toHaveBeenCalled();
});

test("collapsing Gemini wipes an unsent key", () => {
  render(createElement(EditorHarness));
  const key = expandAndFill();

  fireEvent.click(screen.getByRole("button", { name: "Extract with Gemini (optional)" }));

  expect(key.value).toBe("");
  expect(screen.queryByLabelText("Gemini API key")).toBeNull();
  expect(mockExtract).not.toHaveBeenCalled();
});

test("Gemini fields too long for the application are rejected before review", async () => {
  mockExtract.mockResolvedValue({ company: "x".repeat(257), jobTitle: "Engineer" });
  render(createElement(EditorHarness));
  expandAndFill();
  fireEvent.click(screen.getByRole("button", { name: "Send to Gemini" }));

  expect((await screen.findByRole("alert")).textContent).toMatch(/256 characters/);
  expect(screen.queryByRole("button", { name: "Apply extracted fields" })).toBeNull();
});

test("Gemini explains how to correct a posting that contains the API key", async () => {
  mockExtract.mockRejectedValue(new Error("Remove the API key from the job posting text."));
  render(createElement(EditorHarness));
  const key = expandAndFill();

  expect(screen.getByText(/Enter it again for each request/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Send to Gemini" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("Remove the API key from the job posting text before sending.");
  expect(key.value).toBe("");
});
