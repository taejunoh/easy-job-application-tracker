/** @jest-environment jsdom */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import SettingsPage from "@/app/settings/page";
import { useClientApi } from "@/hooks/use-client-api";

jest.mock("@/hooks/use-client-api", () => ({ useClientApi: jest.fn() }));

const api = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  api.mockImplementation((requestPath: string) =>
    Promise.resolve(
      requestPath === "/api/extension/installations"
        ? { installations: [], configuredOrigins: [] }
        : { llmProvider: "openai", hasApiKey: true, linkedinUrl: "", githubUrl: "", resumeText: "" },
    ),
  );
  jest.mocked(useClientApi).mockReturnValue(api);
});

it("draws each section divider once instead of stacking an hr on the heading border", async () => {
  const { container } = render(createElement(SettingsPage));
  await waitFor(() => expect(screen.getByRole("button", { name: "Test Connection" })).toBeEnabled());

  expect(container.querySelectorAll("hr")).toHaveLength(0);
  const headings = container.querySelectorAll(".settings-card > .panel-heading");
  expect(headings).toHaveLength(3);
  expect(container.querySelector(".settings-page > style")?.textContent).toContain(
    ".settings-card > .panel-heading:not(:first-child) { border-top: 1px solid var(--border)",
  );
});

it("styles Show and Test Connection as secondary buttons from the shared stylesheet", async () => {
  render(createElement(SettingsPage));
  await waitFor(() => expect(screen.getByRole("button", { name: "Test Connection" })).toBeEnabled());

  expect(screen.getByRole("button", { name: "Show" })).toHaveClass("secondary-button");
  expect(screen.getByRole("button", { name: "Test Connection" })).toHaveClass("secondary-button");

  const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
  expect(css).toMatch(/^\.secondary-button \{[^}]*padding: 0\.5rem 1rem/mu);
});

it("lets settings inputs and the resume field fill the card via the shared field style", () => {
  render(createElement(SettingsPage));
  for (const id of ["settings-api-key", "settings-linkedin", "settings-github", "settings-resume"]) {
    expect(document.getElementById(id)).toHaveClass("field");
  }

  const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
  expect(css).toMatch(/^\.field \{[^}]*width: 100%/mu);
});
