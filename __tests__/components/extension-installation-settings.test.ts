/** @jest-environment jsdom */

import { createElement } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import {
  ExtensionInstallations,
  createExtensionPairingCode,
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
});
