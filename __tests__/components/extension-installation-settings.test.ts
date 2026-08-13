import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createExtensionPairingCode,
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

  it("renders a once-only secret with an explicit state-clearing dismissal", () => {
    expect(source).toContain("Shown once.");
    expect(source).toContain("setPairingCode(null)");
    expect(source).toContain("setExpiresAt(null)");
    expect(source).not.toMatch(/localStorage|sessionStorage/u);
  });
});
