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

it("keeps status changes isolated from row navigation", () => {
  const onStatusChange = jest.fn();
  render(createElement(ApplicationTable, { applications: [application], onStatusChange }));
  const status = screen.getByLabelText("Status for Senior Engineer");

  fireEvent.click(status);
  fireEvent.keyDown(status, { key: "Enter" });
  fireEvent.change(status, { target: { value: "Interview" } });

  expect(onStatusChange).toHaveBeenCalledTimes(1);
  expect(onStatusChange).toHaveBeenCalledWith("app-1", "Interview");
  expect(push).not.toHaveBeenCalled();
});

it("gives first-application guidance that points to the shell action and a job URL", () => {
  render(createElement(ApplicationTable, { applications: [], onStatusChange: jest.fn() }));

  expect(screen.getByText(/Add application button above/i)).toBeInTheDocument();
  expect(screen.getByText(/first job URL/i)).toBeInTheDocument();
});
