import { createHash, createHmac } from "node:crypto";

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
const SESSION_KEY_LABEL = "jobtracker/session-key/v1\0";
const SESSION_FINGERPRINT_LABEL = "jobtracker/session-fingerprint/v1\0";

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
  it("issues a domain-separated signed v1 token with a keyed fingerprint", () => {
    const token = createSessionToken({ config, now: NOW });
    const [encodedPayload, encodedSignature] = token.split(".");
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );
    const sessionKey = deriveTestSessionKey(config);
    const expectedFingerprint = createHmac("sha256", sessionKey)
      .update(SESSION_FINGERPRINT_LABEL, "utf8")
      .update(APP_ACCESS_TOKEN, "utf8")
      .digest("base64url");
    const expectedSignature = createHmac("sha256", sessionKey)
      .update(encodedPayload, "utf8")
      .digest("base64url");
    const unkeyedFingerprint = createHash("sha256")
      .update(APP_ACCESS_TOKEN, "utf8")
      .digest("base64url");

    expect(payload).toEqual({
      v: 1,
      exp: Math.floor(NOW / 1000) + SESSION_MAX_AGE_SECONDS,
      fp: expectedFingerprint,
    });
    expect(payload.fp).not.toBe(unkeyedFingerprint);
    expect(encodedSignature).toBe(expectedSignature);
    expect(token).not.toContain(APP_ACCESS_TOKEN);
    expect(encodedPayload).not.toContain(APP_ACCESS_TOKEN);
    expect(verifySessionToken(token, { config, now: NOW })).toBe(true);
  });

  it("accepts the token immediately before expiry and rejects it at expiry", () => {
    const token = createSessionToken({ config, now: NOW });
    const expiry = NOW + SESSION_MAX_AGE_SECONDS * 1000;

    expect(verifySessionToken(token, { config, now: expiry - 1 })).toBe(
      true,
    );
    expect(verifySessionToken(token, { config, now: expiry })).toBe(false);
  });

  it.each([NaN, Infinity, -Infinity, -1, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid issuance clock %s",
    (now) => {
      expect(() => createSessionToken({ config, now })).toThrow(
        "Invalid authentication clock",
      );
    },
  );

  it.each([NaN, Infinity, -Infinity, -1, Number.MAX_SAFE_INTEGER + 1])(
    "returns false for invalid verification clock %s",
    (now) => {
      const token = createSessionToken({ config, now: NOW });

      expect(verifySessionToken(token, { config, now })).toBe(false);
    },
  );

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

  it("rejects padded and otherwise non-canonical base64url segments", () => {
    const token = createSessionToken({ config, now: NOW });
    const [payload, signature] = token.split(".");

    expect(
      verifySessionToken(`${payload}=.${signature}`, { config, now: NOW }),
    ).toBe(false);
    expect(
      verifySessionToken(`${payload}.${signature}=`, { config, now: NOW }),
    ).toBe(false);
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
    const token = signTestPayload(payload, config);

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

  it("invalidates a session after canonical app-origin rotation", () => {
    const token = createSessionToken({ config, now: NOW });

    expect(
      verifySessionToken(token, {
        config: { ...config, appOrigin: "https://new-jobs.example.com" },
        now: NOW,
      }),
    ).toBe(false);
  });

  it("changes the keyed fingerprint when the secret or origin changes", () => {
    const original = sessionFingerprint(
      createSessionToken({ config, now: NOW }),
    );
    const newSecret = sessionFingerprint(
      createSessionToken({
        config: {
          ...config,
          encryptionSecret: "rotated-secret-" + "s".repeat(32),
        },
        now: NOW,
      }),
    );
    const newOrigin = sessionFingerprint(
      createSessionToken({
        config: { ...config, appOrigin: "https://new-jobs.example.com" },
        now: NOW,
      }),
    );

    expect(newSecret).not.toBe(original);
    expect(newOrigin).not.toBe(original);
  });
});

describe("session cookie metadata", () => {
  it("uses Secure for the canonical HTTPS application origin", () => {
    expect(SESSION_COOKIE_NAME).toBe("jobtracker_session");
    expect(getSessionCookieOptions({ config })).toEqual({
      httpOnly: true,
      sameSite: "strict",
      secure: true,
      path: "/",
      maxAge: 2_592_000,
    });
  });

  it.each(["http://localhost:3000", "http://127.0.0.1:3000"])(
    "does not mark an explicit loopback HTTP cookie Secure (%s)",
    (appOrigin) => {
      expect(
        getSessionCookieOptions({ config: { ...config, appOrigin } }).secure,
      ).toBe(false);
    },
  );

  it.each([
    "http://jobs.example.com",
    "http://[::1]:3000",
    "https://jobs.example.com/",
  ])("rejects a non-canonical or unsafe cookie origin %s", (appOrigin) => {
    expect(() =>
      getSessionCookieOptions({ config: { ...config, appOrigin } }),
    ).toThrow("Invalid application origin for session cookie");
  });
});

describe("authenticateApiRequest", () => {
  it.each(["Bearer", "bearer", "BEARER"])(
    "accepts the case-insensitive %s authorization scheme",
    (scheme) => {
      const request = apiRequest("POST", {
        authorization: `${scheme} ${APP_ACCESS_TOKEN}`,
      });

      expect(authenticateApiRequest(request, { config, now: NOW })).toEqual({
        authenticated: true,
        via: "bearer",
      });
    },
  );

  it("accepts one or more ASCII spaces before the Bearer credential", () => {
    const request = apiRequest("POST", {
      authorization: `Bearer    ${APP_ACCESS_TOKEN}`,
    });

    expect(authenticateApiRequest(request, { config, now: NOW })).toEqual({
      authenticated: true,
      via: "bearer",
    });
  });

  it.each([
    `Bearer\t${APP_ACCESS_TOKEN}`,
    `Bearer ${APP_ACCESS_TOKEN}\textra`,
    `Bearer ${APP_ACCESS_TOKEN} extra`,
    `Basic ${APP_ACCESS_TOKEN}`,
    "Bearer",
  ])("rejects a non-exact authorization header %j", (authorization) => {
    const request = apiRequest("GET", { authorization });

    expect(authenticateApiRequest(request, { config, now: NOW })).toEqual(
      unauthorized,
    );
  });

  it("rejects trailing whitespace preserved by the request adapter", () => {
    const request = requestWithRawAuthorization(
      `Bearer ${APP_ACCESS_TOKEN} `,
    );

    expect(authenticateApiRequest(request, { config, now: NOW })).toEqual(
      unauthorized,
    );
  });

  it("accepts a valid session cookie on allowlisted safe methods without Origin", () => {
    const token = createSessionToken({ config, now: NOW });

    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const request = apiRequest(method, {
        cookie: `theme=dark; ${SESSION_COOKIE_NAME}=${token}`,
      });
      expect(authenticateApiRequest(request, { config, now: NOW })).toEqual({
        authenticated: true,
        via: "session",
      });
    }
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "PURGE"])(
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

  it.each(["POST", "PUT", "PATCH", "DELETE", "PURGE"])(
    "rejects a cookie-authenticated %s request without Origin",
    (method) => {
      const token = createSessionToken({ config, now: NOW });
      const request = apiRequest(method, {
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
      });

      expect(authenticateApiRequest(request, { config, now: NOW })).toEqual({
        authenticated: false,
        status: 403,
        error: { error: "Origin not allowed", code: "origin_not_allowed" },
      });
    },
  );

  it.each(["https://evil.example.com", `${APP_ORIGIN}/`])(
    "rejects an unsafe session request with Origin %j",
    (origin) => {
      const token = createSessionToken({ config, now: NOW });
      const request = apiRequest("DELETE", {
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
        origin,
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

  it.each([NaN, Infinity, -Infinity, -1, Number.MAX_SAFE_INTEGER + 1])(
    "returns unauthorized for invalid authentication clock %s",
    (now) => {
      const token = createSessionToken({ config, now: NOW });
      const request = apiRequest("GET", {
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
      });

      expect(authenticateApiRequest(request, { config, now })).toEqual(
        unauthorized,
      );
    },
  );

  it("rejects duplicate, percent-encoded, and quoted valid session cookies", () => {
    const token = createSessionToken({ config, now: NOW });

    for (const cookie of [
      `${SESSION_COOKIE_NAME}=${token}; ${SESSION_COOKIE_NAME}=${token}`,
      `${SESSION_COOKIE_NAME}=${token.replace(".", "%2E")}`,
      `${SESSION_COOKIE_NAME}="${token}"`,
    ]) {
      const request = apiRequest("GET", { cookie });

      expect(authenticateApiRequest(request, { config, now: NOW })).toEqual(
        unauthorized,
      );
    }
  });
});

function apiRequest(method: string, headers: Record<string, string> = {}) {
  return new Request("https://jobs.example.com/api/applications", {
    method,
    headers,
  });
}

function requestWithRawAuthorization(authorization: string): Request {
  return {
    method: "GET",
    headers: {
      has: (name: string) => name.toLowerCase() === "authorization",
      get: (name: string) =>
        name.toLowerCase() === "authorization" ? authorization : null,
    } as Headers,
  } as unknown as Request;
}

function flipLast(value: string): string {
  const replacement = value.endsWith("A") ? "B" : "A";
  return value.slice(0, -1) + replacement;
}

function deriveTestSessionKey(authConfig: AuthConfig): Buffer {
  return createHmac("sha256", authConfig.encryptionSecret)
    .update(SESSION_KEY_LABEL, "utf8")
    .update(authConfig.appOrigin, "utf8")
    .digest();
}

function signTestPayload(payload: string, authConfig: AuthConfig): string {
  const encodedPayload = Buffer.from(payload, "utf8").toString("base64url");
  const signature = createHmac("sha256", deriveTestSessionKey(authConfig))
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function sessionFingerprint(token: string): string {
  const [encodedPayload] = token.split(".");
  return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"))
    .fp;
}
