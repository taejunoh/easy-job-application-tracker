/** @jest-environment jsdom */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import type { LocalApplicationInput } from "../../src/browser-local/storage";
import ApplicationEditor from "../../src/browser-local/ui/ApplicationEditor";

test("saves a company and title as a URL-less Saved record", async () => {
  HTMLDialogElement.prototype.showModal = jest.fn();
  HTMLDialogElement.prototype.close = jest.fn();
  const save = jest.fn<Promise<void>, [LocalApplicationInput]>().mockResolvedValue(undefined);
  const close = jest.fn();
  const { container } = render(createElement(ApplicationEditor, {
    application: null,
    resumeText: "",
    onSave: save,
    onDelete: jest.fn(),
    onClose: close,
  }));

  fireEvent.change(screen.getByLabelText("Company"), { target: { value: "Example" } });
  fireEvent.change(screen.getByLabelText("Job title"), { target: { value: "Engineer" } });
  await act(async () => {
    fireEvent.click(container.querySelector<HTMLButtonElement>('button[type="submit"]:not([value])')!);
  });

  expect(save).toHaveBeenCalledWith(expect.objectContaining({
    company: "Example",
    jobTitle: "Engineer",
    url: "",
    status: "Saved",
    appliedDate: null,
  }));
  expect(close).toHaveBeenCalled();
});
