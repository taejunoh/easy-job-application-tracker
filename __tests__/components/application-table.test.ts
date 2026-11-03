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

it("renders all application fields with semantic table headers", () => {
  render(createElement(ApplicationTable, { applications: [application], onStatusChange: jest.fn() }));

  expect(screen.getByRole("table")).toBeInTheDocument();
  for (const heading of ["Job Title", "Company", "Status", "Date Applied", "Last updated", "Location", "Type", "Next step"]) {
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

it("keeps the job type on one line in a column wide enough for it", () => {
  render(createElement(ApplicationTable, { applications: [application], onStatusChange: jest.fn() }));

  const type = screen.getAllByRole("row")[1].querySelector('[data-label="Type"]');
  expect(type).toHaveClass("application-type-cell");
  const styles = document.querySelector("style")?.textContent ?? "";
  expect(styles).toMatch(/\.application-type-cell \{[^}]*white-space: nowrap/u);
  expect(styles).toMatch(/th:nth-child\(7\) \{ width: 5\.25rem; \}/u);
});

it("scrolls the table inside its card instead of overlapping columns on narrow desktops", () => {
  render(createElement(ApplicationTable, { applications: [application], onStatusChange: jest.fn() }));

  const styles = document.querySelector("style")?.textContent ?? "";
  expect(styles).toMatch(
    /@media \(min-width: 769px\) \{[^\n]*\.applications-table-shell \{ overflow-x: auto; \} \.applications-table \{ min-width: 54rem; \}/u,
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

describe("data display cleanup", () => {
  const messy = {
    ...application,
    id: "app-2",
    company: "Acme Labs International",
    location: "  New York City ,  New York ",
    jobType: null,
  };

  it("normalizes the displayed location without changing the input", () => {
    const input = { ...messy };
    render(createElement(ApplicationTable, { applications: [input], onStatusChange: jest.fn() }));
    const row = screen.getAllByRole("row")[1];

    expect(row).toHaveTextContent("New York, NY");
    expect(row).not.toHaveTextContent("New York City");
    expect(input.location).toBe("  New York City ,  New York ");
  });

  it("shows Remote in the Type column when the type is empty and the location is remote", () => {
    render(createElement(ApplicationTable, {
      applications: [{ ...messy, location: "Remote - US" }],
      onStatusChange: jest.fn(),
    }));
    expect(within(screen.getAllByRole("row")[1]).getByText("Remote", { selector: "td" })).toBeInTheDocument();
  });

  it("keeps a stored job type and shows a dash when nothing indicates a type", () => {
    render(createElement(ApplicationTable, {
      applications: [
        { ...messy, id: "a", location: "Remote", jobType: "Hybrid" },
        { ...messy, id: "b", location: "Austin, Texas", jobType: null },
      ],
      onStatusChange: jest.fn(),
    }));
    const typeCell = (rowIndex: number) =>
      screen.getAllByRole("row")[rowIndex].querySelector('[data-label="Type"]');
    const types = [typeCell(1)?.textContent, typeCell(2)?.textContent].sort();
    expect(types).toEqual(["-", "Hybrid"]);
  });

  it("wraps company names only at word boundaries and exposes the full name", () => {
    const { container } = render(createElement(ApplicationTable, { applications: [messy], onStatusChange: jest.fn() }));
    const link = screen.getByRole("link", { name: "Acme Labs International" });
    expect(link).toHaveAttribute("title", "Acme Labs International");
    expect(link.textContent).toBe("Acme Labs International");

    const css = container.querySelector("style")?.textContent ?? "";
    expect(css).toMatch(/\.application-company-link \{[^}]*overflow-wrap: normal/u);
    expect(css).not.toMatch(/\.application-company-(?:link|cell) \{[^}]*overflow-wrap: (?:anywhere|break-word)/u);
  });
});

describe("findability", () => {
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = [
    { ...application, id: "r1", jobTitle: "Beta Role", company: "Zed", status: "Interview", appliedDate: daysAgo(5), updatedAt: "2026-10-30T10:00:00.000Z" },
    { ...application, id: "r2", jobTitle: "Alpha Role", company: "Acme", status: "Applied", appliedDate: daysAgo(60), updatedAt: "2026-09-01T10:00:00.000Z" },
    { ...application, id: "r3", jobTitle: "Gamma Role", company: "Mid", status: "Offer", appliedDate: daysAgo(20) },
    { ...application, id: "r4", jobTitle: "Delta Role", company: "Old", status: "Rejected", appliedDate: daysAgo(90), updatedAt: null },
  ];
  const titles = () =>
    screen.getAllByRole("row").slice(1).map((row) => row.querySelector(".application-title-link")?.textContent);

  it("starts newest first and exposes aria-sort on each sortable header", () => {
    render(createElement(ApplicationTable, { applications: rows, onStatusChange: jest.fn() }));

    expect(titles()).toEqual(["Beta Role", "Gamma Role", "Alpha Role", "Delta Role"]);
    expect(screen.getByRole("columnheader", { name: "Date Applied" })).toHaveAttribute("aria-sort", "descending");
    for (const name of ["Job Title", "Company", "Status"]) {
      expect(screen.getByRole("columnheader", { name })).toHaveAttribute("aria-sort", "none");
    }
    for (const name of ["Last updated", "Location", "Type", "Next step"]) {
      expect(screen.getByRole("columnheader", { name })).not.toHaveAttribute("aria-sort");
    }
  });

  it("sorts by a header button, toggles direction, and updates aria-sort", () => {
    render(createElement(ApplicationTable, { applications: rows, onStatusChange: jest.fn() }));

    fireEvent.click(within(screen.getByRole("columnheader", { name: "Job Title" })).getByRole("button"));
    expect(titles()).toEqual(["Alpha Role", "Beta Role", "Delta Role", "Gamma Role"]);
    expect(screen.getByRole("columnheader", { name: "Job Title" })).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByRole("columnheader", { name: "Date Applied" })).toHaveAttribute("aria-sort", "none");

    fireEvent.click(within(screen.getByRole("columnheader", { name: "Job Title" })).getByRole("button"));
    expect(titles()).toEqual(["Gamma Role", "Delta Role", "Beta Role", "Alpha Role"]);
    expect(screen.getByRole("columnheader", { name: "Job Title" })).toHaveAttribute("aria-sort", "descending");

    fireEvent.click(within(screen.getByRole("columnheader", { name: "Company" })).getByRole("button"));
    expect(titles()).toEqual(["Alpha Role", "Gamma Role", "Delta Role", "Beta Role"]);

    fireEvent.click(within(screen.getByRole("columnheader", { name: "Status" })).getByRole("button"));
    expect(titles()).toEqual(["Alpha Role", "Beta Role", "Gamma Role", "Delta Role"]);
  });

  it("re-sorts when the incoming rows change", () => {
    const { rerender } = render(createElement(ApplicationTable, { applications: rows, onStatusChange: jest.fn() }));
    fireEvent.click(within(screen.getByRole("columnheader", { name: "Company" })).getByRole("button"));
    rerender(createElement(ApplicationTable, { applications: rows.slice(0, 2), onStatusChange: jest.fn() }));
    expect(titles()).toEqual(["Alpha Role", "Beta Role"]);
  });

  it("shows last updated from updatedAt and a dash when it is missing", () => {
    render(createElement(ApplicationTable, { applications: rows, onStatusChange: jest.fn() }));
    const cell = (index: number) => screen.getAllByRole("row")[index].querySelector('[data-label="Last updated"]');

    expect(cell(1)?.querySelector("time")).toHaveAttribute("datetime", "2026-10-30T10:00:00.000Z");
    expect(cell(2)?.textContent).toBe("-");
    expect(cell(3)?.querySelector("time")).toHaveAttribute("datetime", "2026-09-01T10:00:00.000Z");
    expect(cell(4)?.textContent).toBe("-");
  });

  it("derives the next step from status and age", () => {
    render(createElement(ApplicationTable, { applications: rows, onStatusChange: jest.fn() }));
    const step = (index: number) => screen.getAllByRole("row")[index].querySelector('[data-label="Next step"]')?.textContent;

    expect(step(1)).toBe("Prepare");
    expect(step(2)).toBe("Decide");
    expect(step(3)).toBe("Follow up");
    expect(step(4)).toBe("-");
  });
});
