import { createHmac } from "node:crypto";

import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  authenticateApiRequest,
  createSessionToken,
  getSessionCookieOptions,
  verifyBearerToken,
  verifySessionToken,
  type AuthConfig,
} from "@/lib/security/auth";

const NOW = Date.UTC(2026, 6, 13, 12, 0, 0);
const APP_ACCESS_TOKEN = "access-token-" + "a".repeat(32);
const ENCRYPTION_SECRET = "encryption-secret-" + "e".repeat(32);
const APP_ORIGIN = "https://jobs.example.com";

const config: AuthConfig = {
  appAccessToken: APP_ACCESS_TOKEN,
  encryptionSecret: ENCRYPTION_SECRET,
  appOrigin: APP_ORIGIN,
};

const unauthorized = {
  authenticated: false,
  status: 401,
  error: { error: "Authentication required", code: "unauthorized" },
};

describe("verifyBearerToken", () => {
  it("accepts only the configured access token", () => {
    expect(verifyBearerToken(APP_ACCESS_TOKEN, { config })).toBe(true);
    expect(verifyBearerToken(`${APP_ACCESS_TOKEN}x`, { config })).toBe(false);
    expect(verifyBearerToken("", { config })).toBe(false);
  });

  it("safely compares SHA-256-sized values for candidates of any length", () => {
    expect(() => verifyBearerToken("x", { config })).not.toThrow();
    expect(() => verifyBearerToken("x".repeat(10_000), { config })).not.toThrow();
    expect(verifyBearerToken("x", { config })).toBe(false);
    expect(verifyBearerToken("x".repeat(10_000), { config })).toBe(false);
  });
});

describe("session tokens", () => {
  it("issues a signed v1 token with a 30-day expiry and no raw access token", () => {
    const token = createSessionToken({ config, now: NOW });
    const [encodedPayload, encodedSignature] = token.split(".");
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );

    expect(payload).toEqual({
      v: 1,
      exp: Math.floor(NOW / 1000) + SESSION_MAX_AGE_SECONDS,
      fp: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(encodedSignature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toContain(APP_ACCESS_TOKEN);
    expect(encodedPayload).not.toContain(APP_ACCESS_TOKEN);
    expect(verifySessionToken(token, { config, now: NOW })).toBe(true);
  });

  it("accepts the token immediately before expiry and rejects it at expiry", () => {
    const token = createSessionToken({ config, now: NOW });
    const expiry = NOW + SESSION_MAX_AGE_SECONDS * 1000;

    expect(verifySessionToken(token, { config, now: expiry - 1_000 })).toBe(
      true,
    );
    expect(verifySessionToken(token, { config, now: expiry })).toBe(false);
  });

  it("rejects tampered payloads and signatures", () => {
    const token = createSessionToken({ config, now: NOW });
    const [payload, signature] = token.split(".");

    expect(
      verifySessionToken(`${flipLast(payload)}.${signature}`, {
        config,
        now: NOW,
      }),
    ).toBe(false);
    expect(
      verifySessionToken(`${payload}.${flipLast(signature)}`, {
        config,
        now: NOW,
      }),
    ).toBe(false);
  });

  it.each([
    "",
    "one-part",
    "too.many.parts",
    ".signature",
    "payload.",
    "not+base64url.signature",
    "payload.not+base64url",
  ])("rejects malformed token encoding %j", (token) => {
    expect(verifySessionToken(token, { config, now: NOW })).toBe(false);
  });

  it.each([
    "not-json",
    "null",
    "[]",
    "{}",
    JSON.stringify({ v: 2, exp: Math.floor(NOW / 1000) + 60, fp: "a".repeat(43) }),
    JSON.stringify({ v: 1, exp: "later", fp: "a".repeat(43) }),
    JSON.stringify({ v: 1, exp: Math.floor(NOW / 1000) + 60, fp: "short" }),
    JSON.stringify({
      v: 1,
      exp: Math.floor(NOW / 1000) + 60,
      fp: "a".repeat(43),
      extra: true,
    }),
  ])("rejects a signed malformed session payload %j", (payload) => {
    const token = signTestPayload(payload, ENCRYPTION_SECRET);

    expect(verifySessionToken(token, { config, now: NOW })).toBe(false);
  });

  it("invalidates a session after access-token rotation", () => {
    const token = createSessionToken({ config, now: NOW });

    expect(
      verifySessionToken(token, {
        config: { ...config, appAccessToken: "rotated-" + "r".repeat(32) },
        now: NOW,
      }),
    ).toBe(false);
  });

  it("invalidates a session after encryption-secret rotation", () => {
    const token = createSessionToken({ config, now: NOW });

    expect(
      verifySessionToken(token, {
        config: {
          ...config,
          encryptionSecret: "rotated-secret-" + "s".repeat(32),
        },
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe("session cookie metadata", () => {
  it("uses the approved cookie name and production attributes", () => {
    expect(SESSION_COOKIE_NAME).toBe("jobtracker_session");
    expect(getSessionCookieOptions("production")).toEqual({
      httpOnly: true,
      sameSite: "strict",
      secure: true,
      path: "/",
      maxAge: 2_592_000,
    });
  });

  it("does not mark the development cookie secure", () => {
    expect(getSessionCookieOptions("development").secure).toBe(false);
  });
});

describe("authenticateApiRequest", () => {
  it("accepts an exact Bearer authorization header", () => {
    const request = apiRequest("POST", {
      authorization: `Bearer ${APP_ACCESS_TOKEN}`,
    });

    expect(authenticateApiRequest(request, { config, now: NOW })).toEqual({
      authenticated: true,
      via: "bearer",
    });
  });

  it.each([
    `bearer ${APP_ACCESS_TOKEN}`,
    `Bearer  ${APP_ACCESS_TOKEN}`,
    `Bearer\t${APP_ACCESS_TOKEN}`,
    `Basic ${APP_ACCESS_TOKEN}`,
    "Bearer",
  ])("rejects a non-exact authorization header %j", (authorization) => {
    const request = apiRequest("GET", { authorization });

    expect(authenticateApiRequest(request, { config, now: NOW })).toEqual(
      unauthorized,
    );
  });

  it("accepts a valid session cookie on safe methods without Origin", () => {
    const token = createSessionToken({ config, now: NOW });

    for (const method of ["GET", "HEAD"]) {
      const request = apiRequest(method, {
        cookie: `theme=dark; ${SESSION_COOKIE_NAME}=${token}`,
      });
      expect(authenticateApiRequest(request, { config, now: NOW })).toEqual({
        authenticated: true,
        via: "session",
      });
    }
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "accepts a same-origin session cookie for %s",
    (method) => {
      const token = createSessionToken({ config, now: NOW });
      const request = apiRequest(method, {
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
        origin: APP_ORIGIN,
      });

      expect(authenticateApiRequest(request, { config, now: NOW })).toEqual({
        authenticated: true,
        via: "session",
      });
    },
  );

  it.each([undefined, "https://evil.example.com", `${APP_ORIGIN}/`])(
    "rejects an unsafe session request with Origin %j",
    (origin) => {
      const token = createSessionToken({ config, now: NOW });
      const request = apiRequest("POST", {
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
        ...(origin === undefined ? {} : { origin }),
      });

      expect(authenticateApiRequest(request, { config, now: NOW })).toEqual({
        authenticated: false,
        status: 403,
        error: { error: "Origin not allowed", code: "origin_not_allowed" },
      });
    },
  );

  it("does not require Origin for an unsafe Bearer request", () => {
    const request = apiRequest("DELETE", {
      authorization: `Bearer ${APP_ACCESS_TOKEN}`,
    });

    expect(authenticateApiRequest(request, { config, now: NOW })).toEqual({
      authenticated: true,
      via: "bearer",
    });
  });

  it("gives a valid Bearer header precedence over cookie authentication", () => {
    const token = createSessionToken({ config, now: NOW });
    const request = apiRequest("PATCH", {
      authorization: `Bearer ${APP_ACCESS_TOKEN}`,
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      origin: "https://evil.example.com",
    });

    expect(authenticateApiRequest(request, { config, now: NOW })).toEqual({
      authenticated: true,
      via: "bearer",
    });
  });

  it("fails closed instead of falling back when Bearer is malformed or invalid", () => {
    const token = createSessionToken({ config, now: NOW });

    for (const authorization of ["Basic invalid", "Bearer invalid"]) {
      const request = apiRequest("GET", {
        authorization,
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
      });
      expect(authenticateApiRequest(request, { config, now: NOW })).toEqual(
        unauthorized,
      );
    }
  });

  it.each([undefined, "invalid", "expired"])(
    "returns the stable unauthorized error for a %s session",
    (sessionState) => {
      const cookie =
        sessionState === undefined
          ? undefined
          : sessionState === "invalid"
            ? `${SESSION_COOKIE_NAME}=invalid`
            : `${SESSION_COOKIE_NAME}=${createSessionToken({ config, now: NOW })}`;
      const request = apiRequest("GET", cookie === undefined ? {} : { cookie });
      const now =
        sessionState === "expired"
          ? NOW + SESSION_MAX_AGE_SECONDS * 1000
          : NOW;

      expect(authenticateApiRequest(request, { config, now })).toEqual(
        unauthorized,
      );
    },
  );
});

function apiRequest(method: string, headers: Record<string, string> = {}) {
  return new Request("https://jobs.example.com/api/applications", {
    method,
    headers,
  });
}

function flipLast(value: string): string {
  const replacement = value.endsWith("A") ? "B" : "A";
  return value.slice(0, -1) + replacement;
}

function signTestPayload(payload: string, secret: string): string {
  const encodedPayload = Buffer.from(payload, "utf8").toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}
