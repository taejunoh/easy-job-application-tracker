import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import AppShell from "@/components/AppShell";

let mockPathname = "/";

jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

jest.mock("@/components/Sidebar", () => ({
  __esModule: true,
  default: () => "SIDEBAR_SENTINEL",
}));

jest.mock("@/components/UrlInputWrapper", () => ({
  __esModule: true,
  default: () => "URL_INPUT_SENTINEL",
}));

describe("AppShell", () => {
  it("renders /connect children bare with only their main landmark", () => {
    mockPathname = "/connect";

    const markup = renderToStaticMarkup(
      createElement(
        AppShell,
        null,
        createElement("main", { id: "connect-content" }, "Connect"),
      ),
    );

    expect(markup).toContain('<main id="connect-content">Connect</main>');
    expect(markup).not.toContain("SIDEBAR_SENTINEL");
    expect(markup).not.toContain("URL_INPUT_SENTINEL");
    expect(markup).not.toContain('class="flex min-h-screen"');
    expect(countMainLandmarks(markup)).toBe(1);
  });

  it("renders application pages inside the existing shell main", () => {
    mockPathname = "/";

    const markup = renderToStaticMarkup(
      createElement(
        AppShell,
        null,
        createElement("section", { id: "page-content" }, "Dashboard"),
      ),
    );

    expect(markup).toContain("SIDEBAR_SENTINEL");
    expect(markup).toContain("URL_INPUT_SENTINEL");
    expect(markup).toContain('class="flex min-h-screen"');
    expect(markup).toContain('<main class="flex-1 p-6">');
    expect(markup).toContain('<section id="page-content">Dashboard</section>');
    expect(countMainLandmarks(markup)).toBe(1);
  });
});

function countMainLandmarks(markup: string): number {
  return markup.match(/<main(?:\s|>)/gu)?.length ?? 0;
}
