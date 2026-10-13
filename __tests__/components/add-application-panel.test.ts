/** @jest-environment jsdom */

import { createElement, lazy, Suspense } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import AppShell from "@/components/AppShell";
import { useClientApi } from "@/hooks/use-client-api";
import { useRouter } from "next/navigation";

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: (loader: () => Promise<{ default: React.ComponentType }>) => {
    const Loaded = lazy(loader);
    return (props: Record<string, unknown>) => createElement(Suspense, { fallback: null }, createElement(Loaded, props));
  },
}));
jest.mock("@/hooks/use-client-api", () => ({ useClientApi: jest.fn() }));
jest.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: jest.fn(),
}));

let pathname = "/applications";
const api = jest.fn();
const router = { refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), push: jest.fn(), replace: jest.fn(), prefetch: jest.fn(), bfcacheId: "test" };

beforeEach(() => {
  pathname = "/applications";
  jest.clearAllMocks();
  jest.mocked(useClientApi).mockReturnValue(api);
  jest.mocked(useRouter).mockReturnValue(router);
});

describe("AddApplicationPanel", () => {
  it("keeps a real UrlInput draft and extracted confirmation across close and pathname transitions", async () => {
    api.mockResolvedValue({ url: "https://example.com/draft", jobTitle: "Role", company: "Acme" });
    const { rerender } = render(createElement(AppShell, null, createElement("p", null, "Page")));
    fireEvent.click(screen.getByRole("button", { name: /add application/i }));
    fireEvent.change(await screen.findByPlaceholderText("Paste job URL here..."), { target: { value: "https://example.com/draft" } });
    fireEvent.click(screen.getByRole("button", { name: "+ Add" }));
    await waitFor(() => expect(screen.getByDisplayValue("Role")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Close add application"));
    pathname = "/settings";
    rerender(createElement(AppShell, null, createElement("p", null, "Settings")));
    pathname = "/applications";
    rerender(createElement(AppShell, null, createElement("p", null, "Page")));
    fireEvent.click(screen.getByRole("button", { name: /add application/i }));
    expect(screen.getByDisplayValue("Role")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Acme")).toBeInTheDocument();
  });
});
