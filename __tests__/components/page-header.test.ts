/** @jest-environment jsdom */

import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import AppShell from "@/components/AppShell";
import PageHeader from "@/components/PageHeader";

let mockPathname = "/";

jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));
jest.mock("@/components/Sidebar", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/UrlInputWrapper", () => ({
  __esModule: true,
  default: () => createElement("p", null, "URL_INPUT"),
}));

function page() {
  return createElement(
    "div",
    null,
    createElement(PageHeader, { eyebrow: "Eyebrow", title: "Dashboard", subtitle: "Subtitle" }),
    createElement("p", null, "Body"),
  );
}

describe("PageHeader", () => {
  it("renders the title above the add-application panel on the dashboard", () => {
    mockPathname = "/";
    render(createElement(AppShell, null, page()));

    const heading = screen.getByRole("heading", { level: 1, name: "Dashboard" });
    const panel = document.getElementById("add-application-panel") as HTMLElement;
    expect(heading.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelectorAll("h1")).toHaveLength(1);
  });

  it("keeps the title above the toggle and panel on other pages", () => {
    mockPathname = "/applications";
    render(createElement(AppShell, null, page()));

    const heading = screen.getByRole("heading", { level: 1, name: "Dashboard" });
    const toggle = screen.getByRole("button", { name: "+ Add application" });
    const panel = document.getElementById("add-application-panel") as HTMLElement;
    expect(heading.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heading.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders in place when there is no shell", () => {
    render(page());
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByText("Subtitle")).toBeInTheDocument();
  });
});
