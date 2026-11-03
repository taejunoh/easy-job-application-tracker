/** @jest-environment jsdom */

import { createElement } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import {
  ExtensionInstallations,
  createExtensionPairingCode,
  extensionLabel,
  revokeExtensionInstallation,
} from "@/components/ExtensionInstallations";
import type { ClientApi } from "@/lib/client-api";

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

describe("ExtensionInstallations", () => {
  it("creates a one-time code for the selected configured origin", async () => {
    const api = jest.fn().mockResolvedValue({
      code: "jt_pair_v1.selector.secret",
      expiresAt: "2026-08-13T12:10:00.000Z",
    });

    await expect(createExtensionPairingCode(api, ORIGIN)).resolves.toEqual({
      code: "jt_pair_v1.selector.secret",
      expiresAt: "2026-08-13T12:10:00.000Z",
    });
    expect(api).toHaveBeenCalledWith("/api/extension/pairing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origin: ORIGIN }),
    });
  });

  it("revokes by opaque installation id", async () => {
    const api = jest.fn().mockResolvedValue({ revoked: true });
    const id = "018f9f72-f2e9-7c29-a6fc-001122334499";

    await revokeExtensionInstallation(api, id);
    expect(api).toHaveBeenCalledWith(`/api/extension/installations/${id}`, {
      method: "DELETE",
    });
  });

  it("renders the management section with opaque ids and clears a live pairing secret on dismiss", async () => {
    const secret = "jt_pair_v1.selector.live-secret";
    const api = jest.fn((path: string, init?: RequestInit) => {
      if (path === "/api/extension/installations") {
        return Promise.resolve({
          installations: [{ id: "018f9f72-f2e9-7c29-a6fc-001122334499", origin: ORIGIN, createdAt: "2026-08-13T12:00:00.000Z", expiresAt: "2026-08-13T13:00:00.000Z", lastUsedAt: null, revokedAt: null }],
          configuredOrigins: [ORIGIN],
        });
      }
      if (init?.method === "POST") return Promise.resolve({ code: secret, expiresAt: "2026-08-13T12:10:00.000Z" });
      return Promise.resolve({});
    });

    render(createElement(ExtensionInstallations, { api: api as ClientApi }));
    const section = await screen.findByRole("region", { name: "Chrome extension installations" });
    expect(section).toHaveAttribute("id", "extension-installations");
    expect(await within(section).findByText(/018f9f72-f2e9-7c29-a6fc-001122334499/)).toBeInTheDocument();

    fireEvent.click(within(section).getByRole("button", { name: "Create pairing code" }));
    expect(await within(section).findByText(secret)).toBeInTheDocument();
    fireEvent.click(within(section).getByRole("button", { name: "Dismiss pairing code" }));
    await waitFor(() => expect(within(section).queryByText(secret)).not.toBeInTheDocument());
  });

  it("shows a friendly label with the raw origin kept as secondary text", async () => {
    const api = jest.fn((path: string) =>
      path === "/api/extension/installations"
        ? Promise.resolve({
            installations: [{ id: "018f9f72-f2e9-7c29-a6fc-001122334499", origin: ORIGIN, createdAt: "2026-08-13T12:00:00.000Z", expiresAt: "2026-08-13T13:00:00.000Z", lastUsedAt: null, revokedAt: null }],
            configuredOrigins: [ORIGIN],
          })
        : Promise.resolve({}),
    );

    render(createElement(ExtensionInstallations, { api: api as ClientApi }));
    const section = await screen.findByRole("region", { name: "Chrome extension installations" });
    const item = (await within(section).findByText("JobTracker Chrome extension", { selector: ".installation-name" })).closest("li") as HTMLElement;

    expect(item).toHaveTextContent(ORIGIN);
    expect(within(item).getByText(ORIGIN, { selector: "code" })).toBeInTheDocument();
    expect(within(section).getByRole("option", { name: "JobTracker Chrome extension" })).toHaveValue(ORIGIN);
    expect(within(section).getByText(ORIGIN, { selector: ".extension-origin-hint code" })).toBeInTheDocument();
  });

  it("explains how pairing works", async () => {
    const api = jest.fn().mockResolvedValue({ installations: [], configuredOrigins: [ORIGIN] });
    render(createElement(ExtensionInstallations, { api: api as ClientApi }));
    const section = await screen.findByRole("region", { name: "Chrome extension installations" });

    expect(within(section).getByText(/enter this JobTracker URL and the code, then choose Connect/)).toBeInTheDocument();
  });
});

describe("extensionLabel", () => {
  const OTHER = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";

  it("uses one friendly name for a single extension origin", () => {
    expect(extensionLabel(ORIGIN, [ORIGIN])).toEqual({ name: "JobTracker Chrome extension", origin: ORIGIN });
  });

  it("adds the end of the extension ID when several origins exist", () => {
    expect(extensionLabel(ORIGIN, [ORIGIN, OTHER]).name).toBe("JobTracker Chrome extension (ID ending klmnop)");
    expect(extensionLabel(OTHER, [ORIGIN, OTHER]).name).toBe("JobTracker Chrome extension (ID ending fedcba)");
  });

  it("falls back to the raw origin for anything that is not a Chrome extension origin", () => {
    expect(extensionLabel("https://example.com", [])).toEqual({ name: "https://example.com", origin: "https://example.com" });
  });
});
