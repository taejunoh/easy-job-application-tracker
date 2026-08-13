import { createHash } from "node:crypto";

import {
  InvalidApplicationIdentityError,
  canonicalizeApplicationUrl,
} from "@/lib/applications/identity";

describe("canonical application URL identity", () => {
  it.each([
    [
      "lowercases origin, removes a default port/tracking, and trims a non-root slash",
      "HTTPS://Example.COM:443/jobs/42/?utm_source=newsletter&jobId=7&gclid=click",
      "https://example.com/jobs/42?jobId=7",
    ],
    [
      "preserves meaningful provider IDs",
      "https://jobs.example.test/view?currentJobId=123&ref=feed",
      "https://jobs.example.test/view?currentJobId=123",
    ],
    [
      "sorts decoded pairs by UTF-8 name then value",
      "https://example.test/job?z=1&%C3%A9=2&a=%C3%A9&a=a",
      "https://example.test/job?a=a&a=%C3%A9&z=1&%C3%A9=2",
    ],
    [
      "preserves duplicate and empty names and values",
      "https://example.test/job?=b&x&=a&x=",
      "https://example.test/job?=a&=b&x=&x=",
    ],
    [
      "keeps a root trailing slash",
      "http://example.test:80/",
      "http://example.test/",
    ],
    [
      "removes every known tracking spelling without removing similar names",
      "https://example.test/job?UTM_Campaign=x&fbclid=f&gclid=g&trk=t&ref=r&source=s&utmish=keep",
      "https://example.test/job?utmish=keep",
    ],
    [
      "uses the platform query serializer",
      "https://example.test/job?q=hello%20world&mark=~",
      "https://example.test/job?mark=%7E&q=hello+world",
    ],
  ])("%s", (_name, input, canonicalUrl) => {
    const result = canonicalizeApplicationUrl(input);

    expect(result).toEqual({
      canonicalUrl,
      identityKey: `url-v1:${createHash("sha256").update(canonicalUrl).digest("hex")}`,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("accepts NFC Unicode and rejects canonically equivalent decomposed input", () => {
    expect(canonicalizeApplicationUrl("https://example.test/café").canonicalUrl).toBe(
      "https://example.test/caf%C3%A9",
    );
    expect(() => canonicalizeApplicationUrl("https://example.test/cafe\u0301")).toThrow(
      InvalidApplicationIdentityError,
    );
    expect(() => canonicalizeApplicationUrl("https://example.test/job?q=e\u0301")).toThrow(
      InvalidApplicationIdentityError,
    );
  });

  it.each([
    "https://user@example.test/job",
    "https://user:secret@example.test/job",
    "https://example.test/job#apply",
    "ftp://example.test/job",
    "not a URL",
  ])("rejects %s", (input) => {
    expect(() => canonicalizeApplicationUrl(input)).toThrow(InvalidApplicationIdentityError);
  });
});
