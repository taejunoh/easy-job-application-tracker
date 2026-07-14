import { sanitizeReturnPath } from "@/lib/return-path";

describe("sanitizeReturnPath", () => {
  it.each([
    "/",
    "/applications",
    "/applications/probe.json?view=full",
    "/settings?tab=resume&from=dashboard",
  ])("accepts same-origin relative path %s", (value) => {
    expect(sanitizeReturnPath(value)).toBe(value);
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["protocol URL", "https://evil.example/path"],
    ["protocol-relative URL", "//evil.example/path"],
    ["backslash authority", "/\\evil.example/path"],
    ["backslash path", "/applications\\probe"],
    ["connect recursion", "/connect"],
    ["connect child recursion", "/connect/help"],
    ["connect query recursion", "/connect?next=/settings"],
    ["encoded connect recursion", "/%63onnect"],
    ["control character", "/applications\n/settings"],
    ["overly long path", `/${"a".repeat(2_048)}`],
  ])("rejects %s", (_, value) => {
    expect(sanitizeReturnPath(value)).toBeNull();
  });
});
