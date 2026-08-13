import "server-only";

import {
  createHmac,
  randomBytes as secureRandomBytes,
  randomUUID as secureRandomUUID,
  timingSafeEqual,
} from "node:crypto";

const PAIRING_PREFIX = "jt_pair_v1";
const INSTALLATION_PREFIX = "jt_install_v1";
const PAIRING_DIGEST_LABEL = "jobtracker/extension-pairing/v1\0";
const INSTALLATION_DIGEST_LABEL = "jobtracker/extension-installation/v1\0";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

type CredentialOptions = Readonly<{
  encryptionSecret: string;
  origin: string;
  randomBytes?: (size: number) => Buffer;
  randomUUID?: () => string;
}>;

type ParsedCredential = Readonly<{ selector: string; secret: string }>;

export type IssuedCredential = Readonly<{
  selector: string;
  secret: string;
  digest: string;
}>;

export type IssuedPairingCredential = IssuedCredential &
  Readonly<{ code: string }>;
export type IssuedInstallationCredential = IssuedCredential &
  Readonly<{ token: string }>;

export function createPairingCredential(
  options: CredentialOptions,
): IssuedPairingCredential {
  const issued = issueCredential(options);
  return Object.freeze({
    ...issued,
    code: `${PAIRING_PREFIX}.${issued.selector}.${issued.secret}`,
    digest: digestPairingSecret(
      issued.selector,
      issued.secret,
      options.origin,
      options.encryptionSecret,
    ),
  });
}

export function createInstallationCredential(
  options: CredentialOptions,
): IssuedInstallationCredential {
  const issued = issueCredential(options);
  return Object.freeze({
    ...issued,
    token: `${INSTALLATION_PREFIX}.${issued.selector}.${issued.secret}`,
    digest: digestInstallationSecret(
      issued.selector,
      issued.secret,
      options.origin,
      options.encryptionSecret,
    ),
  });
}

export function parsePairingCode(value: unknown): ParsedCredential | null {
  return parseCredential(value, PAIRING_PREFIX);
}

export function parseInstallationToken(
  value: unknown,
): ParsedCredential | null {
  return parseCredential(value, INSTALLATION_PREFIX);
}

export function digestPairingSecret(
  selector: string,
  secret: string,
  origin: string,
  encryptionSecret: string,
): string {
  return credentialDigest(
    PAIRING_DIGEST_LABEL,
    selector,
    secret,
    origin,
    encryptionSecret,
  );
}

export function digestInstallationSecret(
  selector: string,
  secret: string,
  origin: string,
  encryptionSecret: string,
): string {
  return credentialDigest(
    INSTALLATION_DIGEST_LABEL,
    selector,
    secret,
    origin,
    encryptionSecret,
  );
}

export function verifyCredentialDigest(
  expected: unknown,
  candidate: unknown,
): boolean {
  if (
    typeof expected !== "string" ||
    typeof candidate !== "string" ||
    !DIGEST_PATTERN.test(expected) ||
    !DIGEST_PATTERN.test(candidate)
  ) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(candidate, "hex"),
  );
}

function issueCredential(options: CredentialOptions): IssuedCredential {
  const selector = (options.randomUUID ?? secureRandomUUID)();
  if (!UUID_PATTERN.test(selector)) {
    throw new Error("Invalid extension credential selector");
  }
  const bytes = (options.randomBytes ?? secureRandomBytes)(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
    throw new Error("Invalid extension credential entropy");
  }
  return Object.freeze({
    selector,
    secret: bytes.toString("base64url"),
    digest: "",
  });
}

function parseCredential(
  value: unknown,
  prefix: string,
): ParsedCredential | null {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (
    parts.length !== 3 ||
    parts[0] !== prefix ||
    !UUID_PATTERN.test(parts[1]) ||
    !SECRET_PATTERN.test(parts[2])
  ) {
    return null;
  }
  const decoded = Buffer.from(parts[2], "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== parts[2]) {
    return null;
  }
  return Object.freeze({ selector: parts[1], secret: parts[2] });
}

function credentialDigest(
  label: string,
  selector: string,
  secret: string,
  origin: string,
  encryptionSecret: string,
): string {
  return createHmac("sha256", encryptionSecret)
    .update(label, "utf8")
    .update(selector, "utf8")
    .update("\0", "utf8")
    .update(origin, "utf8")
    .update("\0", "utf8")
    .update(secret, "utf8")
    .digest("hex");
}
