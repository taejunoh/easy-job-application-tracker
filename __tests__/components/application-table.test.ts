/** @jest-environment jsdom */

import { createElement } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import ApplicationTable from "@/components/ApplicationTable";

const push = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

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
});

it("renders all six application fields with semantic table headers", () => {
  render(createElement(ApplicationTable, { applications: [application], onStatusChange: jest.fn() }));

  expect(screen.getByRole("table")).toBeInTheDocument();
  for (const heading of ["Job Title", "Company", "Status", "Date Applied", "Location", "Type"]) {
    expect(screen.getByRole("columnheader", { name: heading })).toBeInTheDocument();
  }

  const row = screen.getAllByRole("row")[1];
  expect(row).toHaveTextContent("Senior Engineer");
  expect(row).toHaveTextContent("Acme Labs");
  expect(row).toHaveTextContent("Applied");
  expect(row).toHaveTextContent("New York");
  expect(row).toHaveTextContent("Remote");
  expect(within(row).getByRole("link", { name: /Senior Engineer/i })).toHaveAttribute(
    "href",
    "/applications/app-1",
  );
});

it("navigates a row with click, Enter, or Space", () => {
  render(createElement(ApplicationTable, { applications: [application], onStatusChange: jest.fn() }));
  const row = screen.getAllByRole("row")[1];

  fireEvent.click(row);
  fireEvent.keyDown(row, { key: "Enter" });
  fireEvent.keyDown(row, { key: " " });

  expect(push).toHaveBeenCalledTimes(3);
  expect(push).toHaveBeenCalledWith("/applications/app-1");
});

it("shows status as the dashboard's colored badge with no select until activated", () => {
  render(createElement(ApplicationTable, { applications: [application], onStatusChange: jest.fn() }));
  const row = screen.getAllByRole("row")[1];

  expect(row.querySelector(".status-applied")).toHaveTextContent("Applied");
  expect(within(row).queryByRole("combobox")).not.toBeInTheDocument();
  expect(
    within(row).getByRole("button", { name: "Status for Senior Engineer: Applied. Change status" }),
  ).toBeInTheDocument();
});

it("reveals a focused select on click and reports the change without navigating the row", () => {
  const onStatusChange = jest.fn();
  render(createElement(ApplicationTable, { applications: [application], onStatusChange }));

  fireEvent.click(screen.getByRole("button", { name: /Status for Senior Engineer/ }));
  const select = screen.getByLabelText("Status for Senior Engineer");
  expect(select.tagName).toBe("SELECT");
  expect(select).toHaveFocus();

  fireEvent.click(select);
  fireEvent.keyDown(select, { key: "Enter" });
  fireEvent.change(select, { target: { value: "Interview" } });

  expect(onStatusChange).toHaveBeenCalledTimes(1);
  expect(onStatusChange).toHaveBeenCalledWith("app-1", "Interview");
  expect(push).not.toHaveBeenCalled();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Status for Senior Engineer/ })).toHaveFocus();
});

it("cancels the edit with Escape without changing the status", () => {
  const onStatusChange = jest.fn();
  render(createElement(ApplicationTable, { applications: [application], onStatusChange }));

  fireEvent.click(screen.getByRole("button", { name: /Status for Senior Engineer/ }));
  fireEvent.keyDown(screen.getByLabelText("Status for Senior Engineer"), { key: "Escape" });

  expect(onStatusChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Status for Senior Engineer/ })).toHaveFocus();
  expect(push).not.toHaveBeenCalled();
});

it("closes the select when focus leaves it", () => {
  const onStatusChange = jest.fn();
  render(createElement(ApplicationTable, { applications: [application], onStatusChange }));

  fireEvent.click(screen.getByRole("button", { name: /Status for Senior Engineer/ }));
  fireEvent.blur(screen.getByLabelText("Status for Senior Engineer"));

  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(onStatusChange).not.toHaveBeenCalled();
});

it("keeps keyboard activation of the badge button from navigating the row", () => {
  render(createElement(ApplicationTable, { applications: [application], onStatusChange: jest.fn() }));
  const button = screen.getByRole("button", { name: /Status for Senior Engineer/ });

  fireEvent.keyDown(button, { key: "Enter" });
  fireEvent.keyDown(button, { key: " " });

  expect(push).not.toHaveBeenCalled();
});

it("gives first-application guidance that points to the shell action and a job URL", () => {
  render(createElement(ApplicationTable, { applications: [], onStatusChange: jest.fn() }));

  expect(screen.getByText(/Add application button above/i)).toBeInTheDocument();
  expect(screen.getByText(/first job URL/i)).toBeInTheDocument();
});
