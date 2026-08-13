import { createHash } from "node:crypto";

export type ApplicationIdentity = Readonly<{
  canonicalUrl: string;
  identityKey: string;
}>;

export class InvalidApplicationIdentityError extends Error {
  constructor() {
    super("Invalid application URL identity");
    this.name = "InvalidApplicationIdentityError";
  }
}

export function canonicalizeApplicationUrl(rawUrl: string): ApplicationIdentity {
  if (
    typeof rawUrl !== "string" ||
    rawUrl.length === 0 ||
    rawUrl !== rawUrl.normalize("NFC") ||
    /\p{Cc}/u.test(rawUrl)
  ) {
    invalid();
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    invalid();
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    url.href !== url.href.normalize("NFC")
  ) {
    invalid();
  }

  requireDecodedNfc(url.pathname);
  const pairs: Array<readonly [string, string]> = [];
  for (const [name, value] of url.searchParams) {
    if (name !== name.normalize("NFC") || value !== value.normalize("NFC")) invalid();
    if (!isTrackingParameter(name)) pairs.push([name, value]);
  }
  pairs.sort(comparePair);

  url.search = "";
  for (const [name, value] of pairs) url.searchParams.append(name, value);
  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  const canonicalUrl = url.href;
  const identityKey = `url-v1:${createHash("sha256").update(canonicalUrl).digest("hex")}`;
  return Object.freeze({ canonicalUrl, identityKey });
}

function isTrackingParameter(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized.startsWith("utm_") ||
    normalized === "gclid" ||
    normalized === "fbclid" ||
    normalized === "trk" ||
    normalized === "ref" ||
    normalized === "source"
  );
}

function comparePair(
  left: readonly [string, string],
  right: readonly [string, string],
): number {
  const nameOrder = Buffer.compare(Buffer.from(left[0]), Buffer.from(right[0]));
  return nameOrder === 0
    ? Buffer.compare(Buffer.from(left[1]), Buffer.from(right[1]))
    : nameOrder;
}

function requireDecodedNfc(pathname: string): void {
  try {
    const decoded = decodeURIComponent(pathname);
    if (decoded !== decoded.normalize("NFC")) invalid();
  } catch (error) {
    if (error instanceof InvalidApplicationIdentityError) throw error;
    invalid();
  }
}

function invalid(): never {
  throw new InvalidApplicationIdentityError();
}
