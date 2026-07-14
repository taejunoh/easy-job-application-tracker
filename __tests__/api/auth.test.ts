import {
  DELETE as deleteSession,
  POST as createSession,
} from "@/app/api/auth/session/route";
import {
  OPTIONS as verifyPreflight,
  POST as verifyAccess,
} from "@/app/api/auth/verify/route";
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  verifySessionToken,
} from "@/lib/security/auth";

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
      CORS_ALLOWED_ORIGINS:
        "https://jobs.example.com,chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    },
    "production",
  );

  return { ...actual, getServerEnv: () => config };
});

const APP_ORIGIN = "https://jobs.example.com";
const EXTENSION_ORIGIN =
  "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const ACCESS_TOKEN = "access-token-" + "a".repeat(32);

describe("POST /api/auth/session", () => {
  it("creates a signed HttpOnly 30-day session for the exact app origin", async () => {
    const response = await createSession(
      sessionRequest("POST", APP_ORIGIN, JSON.stringify({ token: ACCESS_TOKEN })),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ authenticated: true });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(response.headers.get("Vary")).toBe("Origin");

    const cookie = response.headers.get("Set-Cookie");
    expect(cookie).not.toBeNull();
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=[^;]+;`));
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS}`);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=strict");
    expect(cookie).not.toContain(ACCESS_TOKEN);

    const value = cookie?.match(new RegExp(`^${SESSION_COOKIE_NAME}=([^;]+)`))?.[1];
    expect(verifySessionToken(value)).toBe(true);
  });

  it("rejects an invalid token without setting a cookie", async () => {
    const response = await createSession(
      sessionRequest("POST", APP_ORIGIN, JSON.stringify({ token: "wrong" })),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authentication required",
      code: "unauthorized",
    });
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
  });

  it.each([
    ["missing", undefined],
    ["extension", EXTENSION_ORIGIN],
    ["unknown", "https://evil.example.com"],
    ["opaque", "null"],
  ])("rejects a %s origin before validating credentials", async (_, origin) => {
    const response = await createSession(
      sessionRequest("POST", origin, JSON.stringify({ token: ACCESS_TOKEN })),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Origin not allowed",
      code: "origin_not_allowed",
    });
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      origin === EXTENSION_ORIGIN ? EXTENSION_ORIGIN : null,
    );
  });

  it.each(["{", "not-json", ""])(
    "returns a stable 400 for malformed JSON %j",
    async (body) => {
      const response = await createSession(
        sessionRequest("POST", APP_ORIGIN, body),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid request",
        code: "invalid_request",
      });
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        APP_ORIGIN,
      );
      expect(response.headers.get("Set-Cookie")).toBeNull();
    },
  );
});

describe("DELETE /api/auth/session", () => {
  it.each([
    ["without a cookie", undefined],
    ["with an invalid cookie", `${SESSION_COOKIE_NAME}=invalid`],
  ])("clears the session idempotently %s", async (_, cookie) => {
    const response = await deleteSession(
      sessionRequest("DELETE", APP_ORIGIN, undefined, cookie),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ authenticated: false });
    expect(response.headers.get("Set-Cookie")).toMatch(
      new RegExp(`^${SESSION_COOKIE_NAME}=;.*Max-Age=0`),
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
  });

  it.each([
    ["missing", undefined],
    ["extension", EXTENSION_ORIGIN],
    ["unknown", "https://evil.example.com"],
  ])("rejects a %s origin even when the cookie is absent", async (_, origin) => {
    const response = await deleteSession(sessionRequest("DELETE", origin));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Origin not allowed",
      code: "origin_not_allowed",
    });
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("POST /api/auth/verify", () => {
  it.each([APP_ORIGIN, EXTENSION_ORIGIN])(
    "accepts a valid Bearer token from %s without returning it",
    async (origin) => {
      const response = await verifyAccess(verifyRequest(origin, ACCESS_TOKEN));

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ authenticated: true });
      expect(text).not.toContain(ACCESS_TOKEN);
      expect(response.headers.get("Set-Cookie")).toBeNull();
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
        origin === APP_ORIGIN ? "true" : null,
      );
    },
  );

  it.each([
    ["missing header", undefined],
    ["wrong token", "wrong"],
    ["empty token", ""],
  ])("returns 401 for a %s", async (_, token) => {
    const response = await verifyAccess(verifyRequest(EXTENSION_ORIGIN, token));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authentication required",
      code: "unauthorized",
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      EXTENSION_ORIGIN,
    );
  });

  it("does not accept or leak a valid session cookie in place of Bearer auth", async () => {
    const sessionResponse = await createSession(
      sessionRequest("POST", APP_ORIGIN, JSON.stringify({ token: ACCESS_TOKEN })),
    );
    const cookie = sessionResponse.headers.get("Set-Cookie")?.split(";", 1)[0];
    const response = await verifyAccess(
      new Request("https://jobs.example.com/api/auth/verify", {
        method: "POST",
        headers: {
          Origin: EXTENSION_ORIGIN,
          Cookie: cookie ?? "",
        },
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authentication required",
      code: "unauthorized",
    });
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("returns 401 for a malformed authorization scheme", async () => {
    const response = await verifyAccess(
      new Request("https://jobs.example.com/api/auth/verify", {
        method: "POST",
        headers: {
          Origin: EXTENSION_ORIGIN,
          Authorization: `Basic ${ACCESS_TOKEN}`,
        },
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authentication required",
      code: "unauthorized",
    });
  });

  it.each([
    ["missing", undefined],
    ["unknown", "https://evil.example.com"],
    ["opaque", "null"],
  ])("returns 403 for a %s origin", async (_, origin) => {
    const response = await verifyAccess(verifyRequest(origin, ACCESS_TOKEN));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Origin not allowed",
      code: "origin_not_allowed",
    });
  });

  it("allows a POST preflight from the configured extension only", async () => {
    const response = verifyPreflight(
      new Request("https://jobs.example.com/api/auth/verify", {
        method: "OPTIONS",
        headers: {
          Origin: EXTENSION_ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "Authorization, Content-Type",
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      EXTENSION_ORIGIN,
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST");
  });

  it.each(["GET", "DELETE"])(
    "rejects a %s preflight method",
    async (method) => {
      const response = verifyPreflight(
        new Request("https://jobs.example.com/api/auth/verify", {
          method: "OPTIONS",
          headers: {
            Origin: EXTENSION_ORIGIN,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": "Authorization",
          },
        }),
      );

      expect(response.status).toBe(403);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    },
  );
});

function sessionRequest(
  method: "POST" | "DELETE",
  origin?: string,
  body?: string,
  cookie?: string,
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (origin !== undefined) headers.set("Origin", origin);
  if (cookie !== undefined) headers.set("Cookie", cookie);

  return new Request("https://jobs.example.com/api/auth/session", {
    method,
    headers,
    body,
  });
}

function verifyRequest(origin?: string, token?: string): Request {
  const headers = new Headers();
  if (origin !== undefined) headers.set("Origin", origin);
  if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);

  return new Request("https://jobs.example.com/api/auth/verify", {
    method: "POST",
    headers,
  });
}
