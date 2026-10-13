/** @jest-environment jsdom */

import { createElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import Sidebar from "@/components/Sidebar";

const pathname = "/applications/abc";

jest.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    createElement("a", { href, ...props }, children),
}));

describe("Sidebar", () => {
  it("marks the matching route as current without a decorative stripe", () => {
    render(createElement(Sidebar));

    const applications = screen.getByRole("link", { name: "Applications" });
    expect(applications).toHaveAttribute("aria-current", "page");
    expect(applications.className).not.toMatch(/border-l|stripe/i);
    expect(screen.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute("aria-current");
  });

  it("opens and closes the inline mobile menu, returning focus to its trigger on Escape", () => {
    render(createElement(Sidebar));
    const trigger = screen.getByRole("button", { name: /open menu/i });
    const menu = screen.getByRole("navigation");

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(menu).toBeVisible();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });
});
