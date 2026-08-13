import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, useReducer } from "react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ExtensionInstallations,
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

jest.mock("react", () => {
  const actual = jest.requireActual<typeof import("react")>("react");
  return {
    ...actual,
    useCallback: jest.fn((callback) => callback),
    useEffect: jest.fn(),
    useReducer: jest.fn(),
    useState: jest.fn((initial) => [initial, jest.fn()]),
  };
});

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

  it("wires the rendered Settings dismiss control to remove the live secret", () => {
    const dispatch = jest.fn();
    const secret = {
      code: "jt_pair_v1.selector.live-secret",
      expiresAt: "2026-08-13T12:10:00.000Z",
    };
    (useReducer as jest.Mock).mockReturnValue([secret, dispatch]);

    const rendered = ExtensionInstallations({
      api: jest.fn(),
      origins: [ORIGIN],
    });
    const html = renderToStaticMarkup(rendered);
    expect(html).toContain(secret.code);

    const panel = findElementByType(rendered, PairingCodePanel);
    expect(panel).not.toBeNull();
    panel?.props.onDismiss();
    expect(dispatch).toHaveBeenCalledWith({ type: "dismissed" });
  });

  it("renders opaque installation ids in the deep-linked management section", () => {
    expect(source).toContain('id="extension-installations"');
    expect(source).toContain("installation.id");
    expect(source).toContain("Installation ID");
  });
});

function findElementByType(
  value: React.ReactNode,
  type: React.ElementType,
): React.ReactElement<{ onDismiss(): void }> | null {
  if (!React.isValidElement(value)) return null;
  const element = value as React.ReactElement<{
    children?: React.ReactNode;
    onDismiss?(): void;
  }>;
  if (element.type === type && element.props.onDismiss) {
    return element as React.ReactElement<{ onDismiss(): void }>;
  }
  return React.Children.toArray(element.props.children).reduce<React.ReactElement<{
    onDismiss(): void;
  }> | null>(
    (found, child) => found ?? findElementByType(child, type),
    null,
  );
}
