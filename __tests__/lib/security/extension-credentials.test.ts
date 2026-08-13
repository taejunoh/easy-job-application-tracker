import { createHmac } from "node:crypto";

import {
  createInstallationCredential,
  createPairingCredential,
  digestInstallationSecret,
  digestPairingSecret,
  parseInstallationToken,
  parsePairingCode,
  verifyCredentialDigest,
} from "@/lib/security/extension-credentials";

const ENCRYPTION_SECRET = "extension-credential-secret-" + "s".repeat(32);
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const OTHER_ORIGIN = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
const SELECTOR = "018f9f72-f2e9-7c29-a6fc-001122334455";
const SECRET_BYTES = Buffer.from(Array.from({ length: 32 }, (_, i) => i));

describe("extension installation credentials", () => {
  it("issues exact v1 pairing and installation grammars with 256-bit secrets", () => {
    const pairing = createPairingCredential({
      encryptionSecret: ENCRYPTION_SECRET,
      origin: ORIGIN,
      randomBytes: () => SECRET_BYTES,
      randomUUID: () => SELECTOR,
    });
    const installation = createInstallationCredential({
      encryptionSecret: ENCRYPTION_SECRET,
      origin: ORIGIN,
      randomBytes: () => SECRET_BYTES,
      randomUUID: () => SELECTOR,
    });

    expect(pairing.code).toBe(
      `jt_pair_v1.${SELECTOR}.${SECRET_BYTES.toString("base64url")}`,
    );
    expect(installation.token).toBe(
      `jt_install_v1.${SELECTOR}.${SECRET_BYTES.toString("base64url")}`,
    );
    expect(parsePairingCode(pairing.code)).toEqual({
      selector: SELECTOR,
      secret: SECRET_BYTES.toString("base64url"),
    });
    expect(parseInstallationToken(installation.token)).toEqual({
      selector: SELECTOR,
      secret: SECRET_BYTES.toString("base64url"),
    });
    expect(Buffer.from(pairing.secret, "base64url")).toHaveLength(32);
    expect(Buffer.from(installation.secret, "base64url")).toHaveLength(32);
    expect(pairing.digest).not.toContain(pairing.secret);
    expect(installation.digest).not.toContain(installation.secret);
  });

  it("uses distinct domain-separated HMAC digests bound to origin and selector", () => {
    const secret = SECRET_BYTES.toString("base64url");
    const pairing = digestPairingSecret(
      SELECTOR,
      secret,
      ORIGIN,
      ENCRYPTION_SECRET,
    );
    const installation = digestInstallationSecret(
      SELECTOR,
      secret,
      ORIGIN,
      ENCRYPTION_SECRET,
    );
    const unkeyedEquivalent = createHmac("sha256", "wrong-secret")
      .update(secret)
      .digest("hex");

    expect(pairing).toMatch(/^[0-9a-f]{64}$/u);
    expect(installation).toMatch(/^[0-9a-f]{64}$/u);
    expect(pairing).not.toBe(installation);
    expect(pairing).not.toBe(unkeyedEquivalent);
    expect(
      digestPairingSecret(SELECTOR, secret, OTHER_ORIGIN, ENCRYPTION_SECRET),
    ).not.toBe(pairing);
    expect(
      digestPairingSecret(
        "118f9f72-f2e9-7c29-a6fc-001122334455",
        secret,
        ORIGIN,
        ENCRYPTION_SECRET,
      ),
    ).not.toBe(pairing);
  });

  it("compares fixed-size digests without throwing on malformed stored values", () => {
    const digest = digestPairingSecret(
      SELECTOR,
      SECRET_BYTES.toString("base64url"),
      ORIGIN,
      ENCRYPTION_SECRET,
    );

    expect(verifyCredentialDigest(digest, digest)).toBe(true);
    expect(verifyCredentialDigest(digest, `${digest.slice(0, -1)}0`)).toBe(false);
    expect(verifyCredentialDigest(digest, "short")).toBe(false);
    expect(verifyCredentialDigest(digest, "z".repeat(64))).toBe(false);
  });

  it.each([
    "",
    "jt_pair_v1.only-two",
    `jt_pair_v2.${SELECTOR}.${SECRET_BYTES.toString("base64url")}`,
    `jt_pair_v1.not-a-uuid.${SECRET_BYTES.toString("base64url")}`,
    `jt_pair_v1.${SELECTOR}.short`,
    `jt_pair_v1.${SELECTOR}.${"a".repeat(42)}=`,
  ])("rejects malformed pairing code %j", (value) => {
    expect(parsePairingCode(value)).toBeNull();
  });

  it.each([
    "",
    "jt_install_v1.only-two",
    `jt_install_v2.${SELECTOR}.${SECRET_BYTES.toString("base64url")}`,
    `jt_install_v1.not-a-uuid.${SECRET_BYTES.toString("base64url")}`,
    `jt_install_v1.${SELECTOR}.short`,
    `jt_install_v1.${SELECTOR}.${"a".repeat(42)}=`,
  ])("rejects malformed installation token %j", (value) => {
    expect(parseInstallationToken(value)).toBeNull();
  });
});
