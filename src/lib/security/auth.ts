import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { getServerEnv } from "../server-env";

export const SESSION_COOKIE_NAME = "jobtracker_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export type AuthConfig = Readonly<{
  appAccessToken: string;
  encryptionSecret: string;
  appOrigin: string;
}>;

export type AuthOptions = Readonly<{
  config?: AuthConfig;
  now?: number;
}>;

export type SessionCookieOptions = Readonly<{
  httpOnly: true;
  sameSite: "strict";
  secure: boolean;
  path: "/";
  maxAge: number;
}>;

export type AuthenticationError = Readonly<{
  authenticated: false;
  status: 401 | 403;
  error: Readonly<{
    error: "Authentication required" | "Origin not allowed";
    code: "unauthorized" | "origin_not_allowed";
  }>;
}>;

export type AuthenticationSuccess = Readonly<{
  authenticated: true;
  via: "bearer" | "session";
}>;

export type ApiAuthenticationResult =
  | AuthenticationSuccess
  | AuthenticationError;

type SessionPayload = Readonly<{
  v: 1;
  exp: number;
  fp: string;
}>;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const UNAUTHORIZED: AuthenticationError = Object.freeze({
  authenticated: false,
  status: 401,
  error: Object.freeze({
    error: "Authentication required",
    code: "unauthorized",
  }),
});

const ORIGIN_NOT_ALLOWED: AuthenticationError = Object.freeze({
  authenticated: false,
  status: 403,
  error: Object.freeze({
    error: "Origin not allowed",
    code: "origin_not_allowed",
  }),
});

export function verifyBearerToken(
  candidate: string | null | undefined,
  options: Pick<AuthOptions, "config"> = {},
): boolean {
  if (typeof candidate !== "string") {
    return false;
  }

  const config = resolveConfig(options.config);
  return timingSafeEqual(sha256(candidate), sha256(config.appAccessToken));
}

export function createSessionToken(options: AuthOptions = {}): string {
  const config = resolveConfig(options.config);
  const payload: SessionPayload = {
    v: 1,
    exp: nowInSeconds(options.now) + SESSION_MAX_AGE_SECONDS,
    fp: sha256(config.appAccessToken).toString("base64url"),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = sign(encodedPayload, config.encryptionSecret);

  return `${encodedPayload}.${signature.toString("base64url")}`;
}

export function verifySessionToken(
  token: string | null | undefined,
  options: AuthOptions = {},
): boolean {
  if (typeof token !== "string") {
    return false;
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return false;
  }

  const [encodedPayload, encodedSignature] = parts;
  const signature = decodeBase64Url(encodedSignature);
  if (signature === null || signature.length !== 32) {
    return false;
  }

  const config = resolveConfig(options.config);
  const expectedSignature = sign(encodedPayload, config.encryptionSecret);
  if (!timingSafeEqual(signature, expectedSignature)) {
    return false;
  }

  const payloadBuffer = decodeBase64Url(encodedPayload);
  if (payloadBuffer === null) {
    return false;
  }

  const payload = parseSessionPayload(payloadBuffer);
  if (payload === null || payload.exp <= nowInSeconds(options.now)) {
    return false;
  }

  const fingerprint = decodeBase64Url(payload.fp);
  if (fingerprint === null || fingerprint.length !== 32) {
    return false;
  }

  return timingSafeEqual(fingerprint, sha256(config.appAccessToken));
}

export function getSessionCookieOptions(
  nodeEnv = process.env.NODE_ENV,
): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: nodeEnv === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

export function authenticateApiRequest(
  request: Request,
  options: AuthOptions = {},
): ApiAuthenticationResult {
  const config = resolveConfig(options.config);

  if (request.headers.has("authorization")) {
    const authorization = request.headers.get("authorization");
    const match = authorization?.match(/^Bearer ([^\s]+)$/u);
    if (
      match === undefined ||
      match === null ||
      !verifyBearerToken(match[1], { config })
    ) {
      return UNAUTHORIZED;
    }
    return { authenticated: true, via: "bearer" };
  }

  const sessionToken = readCookie(
    request.headers.get("cookie"),
    SESSION_COOKIE_NAME,
  );
  if (!verifySessionToken(sessionToken, { config, now: options.now })) {
    return UNAUTHORIZED;
  }

  if (
    UNSAFE_METHODS.has(request.method.toUpperCase()) &&
    request.headers.get("origin") !== config.appOrigin
  ) {
    return ORIGIN_NOT_ALLOWED;
  }

  return { authenticated: true, via: "session" };
}

function resolveConfig(config: AuthConfig | undefined): AuthConfig {
  return config ?? getServerEnv();
}

function nowInSeconds(now: number | undefined): number {
  return Math.floor((now ?? Date.now()) / 1000);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function sign(encodedPayload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(encodedPayload, "utf8").digest();
}

function decodeBase64Url(value: string): Buffer | null {
  if (
    value.length === 0 ||
    value.length % 4 === 1 ||
    !BASE64URL_PATTERN.test(value)
  ) {
    return null;
  }

  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
}

function parseSessionPayload(encoded: Buffer): SessionPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(encoded.toString("utf8"));
  } catch {
    return null;
  }

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    !("v" in value) ||
    value.v !== 1 ||
    !("exp" in value) ||
    !Number.isSafeInteger(value.exp) ||
    !("fp" in value) ||
    typeof value.fp !== "string" ||
    value.fp.length !== 43
  ) {
    return null;
  }

  return value as SessionPayload;
}

function readCookie(header: string | null, name: string): string | undefined {
  if (header === null) {
    return undefined;
  }

  let value: string | undefined;
  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== name) {
      continue;
    }
    if (value !== undefined) {
      return undefined;
    }
    value = entry.slice(separator + 1).trim();
  }
  return value;
}
