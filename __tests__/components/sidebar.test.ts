/** @jest-environment jsdom */

import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import Sidebar, { endSession } from "@/components/Sidebar";

const pathname = "/applications/abc";
const replace = jest.fn();

jest.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace }),
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    createElement("a", { href, ...props }, children),
}));

describe("Sidebar", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

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

  it("offers a visible Sign out control that clears the session and returns to /connect", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(createElement(Sidebar));

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/connect"));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/session", { method: "DELETE" });
  });

  it("stays on the page and reports a failed sign out", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;
    render(createElement(Sidebar));

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Sign out failed");
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
  });
});

describe("endSession", () => {
  it("returns true only for an ok response and false for network errors", async () => {
    await expect(endSession(jest.fn().mockResolvedValue({ ok: true }))).resolves.toBe(true);
    await expect(endSession(jest.fn().mockResolvedValue({ ok: false }))).resolves.toBe(false);
    await expect(endSession(jest.fn().mockRejectedValue(new Error("offline")))).resolves.toBe(false);
  });
});
