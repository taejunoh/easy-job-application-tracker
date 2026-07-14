import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";

import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/security/auth";
import { config, proxy } from "@/proxy";

jest.mock("@/lib/server-env", () => {
  const actual = jest.requireActual<typeof import("@/lib/server-env")>(
    "@/lib/server-env",
  );
  const config = actual.parseServerEnv(
    {
      DATABASE_URL: "postgresql://user:password@db.example.com:5432/jobtracker",
      ENCRYPTION_SECRET: "encryption-secret-" + "e".repeat(32),
      APP_ACCESS_TOKEN: "access-token-" + "a".repeat(32),
      APP_BASE_URL: "https://jobs.example.com",
      CORS_ALLOWED_ORIGINS: "https://jobs.example.com",
    },
    "production",
  );

  return { ...actual, getServerEnv: () => config };
});

describe("auth proxy", () => {
  it.each(["/", "/applications", "/applications/abc", "/settings", "/connect"])(
    "matches application page %s",
    (url) => {
      expect(doesMatch(url)).toBe(true);
    },
  );

  it.each([
    "/api/stats",
    "/api/auth/session",
    "/_next/static/chunk.js",
    "/_next/image",
    "/favicon.ico",
    "/file.svg",
    "/nested/public-file.png",
  ])("does not match API or asset path %s", (url) => {
    expect(doesMatch(url)).toBe(false);
  });

  it("redirects a protected page without a valid session to /connect", () => {
    const response = proxy(new NextRequest("https://jobs.example.com/settings"));

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe(
      "https://jobs.example.com/connect",
    );
  });

  it("does not redirect a protected page with a valid session", () => {
    const request = authenticatedRequest("/applications");

    const response = proxy(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("keeps /connect public when the session is missing or invalid", () => {
    const missing = proxy(new NextRequest("https://jobs.example.com/connect"));
    const invalid = proxy(
      new NextRequest("https://jobs.example.com/connect", {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=invalid` },
      }),
    );

    expect(missing.status).toBe(200);
    expect(invalid.status).toBe(200);
    expect(missing.headers.get("Location")).toBeNull();
    expect(invalid.headers.get("Location")).toBeNull();
  });

  it("redirects /connect with a valid session to the dashboard", () => {
    const response = proxy(authenticatedRequest("/connect"));

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("https://jobs.example.com/");
  });
});

function doesMatch(url: string): boolean {
  return unstable_doesMiddlewareMatch({
    config,
    nextConfig: {},
    url,
  });
}

function authenticatedRequest(pathname: string): NextRequest {
  return new NextRequest(`https://jobs.example.com${pathname}`, {
    headers: {
      Cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}`,
    },
  });
}
