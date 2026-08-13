import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  PairingCodePanel,
  createExtensionPairingCode,
  pairingSecretReducer,
  revokeExtensionInstallation,
} from "@/components/ExtensionInstallations";

const source = readFileSync(
  join(process.cwd(), "src/components/ExtensionInstallations.tsx"),
  "utf8",
);
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

  it("renders the once-only secret and removes it after the dismiss state transition", () => {
    const secret = "jt_pair_v1.selector.secret";
    const issued = pairingSecretReducer(null, {
      type: "issued",
      code: secret,
      expiresAt: "2026-08-13T12:10:00.000Z",
    });
    const visible = renderToStaticMarkup(
      createElement(PairingCodePanel, {
        secret: issued,
        onDismiss: jest.fn(),
      }),
    );

    expect(visible).toContain("Shown once.");
    expect(visible).toContain(secret);
    expect(visible).toContain('aria-label="Dismiss pairing code"');

    const dismissed = pairingSecretReducer(issued, { type: "dismissed" });
    const hidden = renderToStaticMarkup(
      createElement(PairingCodePanel, {
        secret: dismissed,
        onDismiss: jest.fn(),
      }),
    );
    expect(hidden).not.toContain(secret);
    expect(hidden).toBe("");
    expect(source).not.toMatch(/localStorage|sessionStorage/u);
  });

  it("renders opaque installation ids in the deep-linked management section", () => {
    expect(source).toContain('id="extension-installations"');
    expect(source).toContain("installation.id");
    expect(source).toContain("Installation ID");
  });
});
