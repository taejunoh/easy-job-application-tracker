/** @jest-environment jsdom */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import type { TrackerStorage } from "../../src/browser-local/ui/BrowserLocalApp";
import { BackupPanel } from "../../src/browser-local/ui/SettingsPanels";

jest.mock("../../browser-local/resume-file.mjs", () => ({}));

type Preview = Awaited<ReturnType<TrackerStorage["previewBackup"]>>;

function preview(applicationCount: number): Preview {
  return { applicationCount, hasResume: false, exportedAt: "2026-11-13T00:00:00.000Z" };
}

test("a late preview cannot replace the latest selected backup", async () => {
  let resolveFirst!: (value: Preview) => void;
  const first = new Promise<Preview>((resolve) => { resolveFirst = resolve; });
  const storage = {
    previewBackup: jest.fn((json: string) => json === "first" ? first : Promise.resolve(preview(2))),
  } as unknown as TrackerStorage;
  render(createElement(BackupPanel, { storage, onRestore: jest.fn() }));
  const input = screen.getByLabelText("Backup file");
  await act(async () => {
    fireEvent.change(input, { target: { files: [{ size: 5, text: async () => "first" }] } });
  });
  await act(async () => {
    fireEvent.change(input, { target: { files: [{ size: 6, text: async () => "second" }] } });
  });
  expect(screen.getByText(/2 applications/)).toBeTruthy();

  await act(async () => resolveFirst(preview(1)));

  expect(screen.queryByText(/1 application/)).toBeNull();
  expect(screen.getByText(/2 applications/)).toBeTruthy();
});

test("selecting an invalid backup removes the previous confirmation", async () => {
  const storage = {
    previewBackup: jest.fn((json: string) => json === "valid" ? Promise.resolve(preview(2)) : Promise.reject(new Error())),
  } as unknown as TrackerStorage;
  render(createElement(BackupPanel, { storage, onRestore: jest.fn() }));
  const input = screen.getByLabelText("Backup file");
  await act(async () => {
    fireEvent.change(input, { target: { files: [{ size: 5, text: async () => "valid" }] } });
  });
  expect(screen.getByRole("button", { name: "Replace data and restore" })).toBeTruthy();

  await act(async () => {
    fireEvent.change(input, { target: { files: [{ size: 7, text: async () => "invalid" }] } });
  });

  expect(screen.queryByRole("button", { name: "Replace data and restore" })).toBeNull();
  expect(screen.getByRole("alert").textContent).toMatch(/a JobTracker backup/);
});
