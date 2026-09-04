import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { getServerEnv } from "../server-env";
import {
  digestInstallationSecret,
  parseInstallationToken,
  verifyCredentialDigest,
} from "./extension-credentials";

export const SESSION_COOKIE_NAME = "jobtracker_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export type AuthConfig = Readonly<{
  appAccessToken: string;
  encryptionSecret: string;
  appOrigin: string;
  corsAllowedOrigins?: readonly string[];
  applicationWritesEnabled: boolean;
}>;

export type InstallationAuthenticationRecord = Readonly<{
  id: string;
  origin: string;
  tokenDigest: string;
  expiresAt: Date;
  revokedAt: Date | null;
}>;

export type InstallationAuthenticationStore = Readonly<{
  findForAuthentication(
    selector: string,
  ): Promise<InstallationAuthenticationRecord | null>;
  touch(id: string, usedAt: Date): Promise<boolean>;
}>;

export type AuthOptions = Readonly<{
  config?: AuthConfig;
  now?: number;
  installationStore?: InstallationAuthenticationStore;
  touchInstallation?: boolean;
}>;

export type SessionCookieOptions = Readonly<{
  httpOnly: true;
  sameSite: "strict";
  secure: boolean;
  path: "/";
  maxAge: number;
}>;

export type UnauthorizedAuthenticationError = Readonly<{
  authenticated: false;
  status: 401;
  error: Readonly<{
    error: "Authentication required";
    code: "unauthorized";
  }>;
}>;

export type OriginAuthenticationError = Readonly<{
  authenticated: false;
  status: 403;
  error: Readonly<{
    error: "Origin not allowed";
    code: "origin_not_allowed";
  }>;
}>;

export type AuthenticationError =
  | UnauthorizedAuthenticationError
  | OriginAuthenticationError;

export type AuthenticationSuccess = Readonly<{
  authenticated: true;
}> & (
  | Readonly<{ via: "bearer" | "session" }>
  | Readonly<{
      via: "installation";
      principal: Readonly<{
        kind: "installation";
        installationId: string;
        origin: string;
      }>;
    }>
);

export type ApiAuthenticationResult =
  | AuthenticationSuccess
  | AuthenticationError;

type SessionPayload = Readonly<{
  v: 1;
  exp: number;
  fp: string;
}>;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SESSION_KEY_LABEL = "jobtracker/session-key/v1\0";
const SESSION_FINGERPRINT_LABEL = "jobtracker/session-fingerprint/v1\0";

const UNAUTHORIZED: UnauthorizedAuthenticationError = Object.freeze({
  authenticated: false,
  status: 401,
  error: Object.freeze({
    error: "Authentication required",
    code: "unauthorized",
  }),
});

const ORIGIN_NOT_ALLOWED: OriginAuthenticationError = Object.freeze({
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
  const now = authenticationTimeInSeconds(options.now);
  if (now === null) {
    throw new RangeError("Invalid authentication clock");
  }
  const sessionKey = deriveSessionKey(config);
  const payload: SessionPayload = {
    v: 1,
    exp: now + SESSION_MAX_AGE_SECONDS,
    fp: sessionFingerprint(sessionKey, config.appAccessToken).toString(
      "base64url",
    ),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = sign(encodedPayload, sessionKey);

  return `${encodedPayload}.${signature.toString("base64url")}`;
}

export function verifySessionToken(
  token: string | null | undefined,
  options: AuthOptions = {},
): boolean {
  if (typeof token !== "string") {
    return false;
  }

  const now = authenticationTimeInSeconds(options.now);
  if (now === null) {
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
  const sessionKey = deriveSessionKey(config);
  const expectedSignature = sign(encodedPayload, sessionKey);
  if (!timingSafeEqual(signature, expectedSignature)) {
    return false;
  }

  const payloadBuffer = decodeBase64Url(encodedPayload);
  if (payloadBuffer === null) {
    return false;
  }

  const payload = parseSessionPayload(payloadBuffer);
  if (payload === null || payload.exp <= now) {
    return false;
  }

  const fingerprint = decodeBase64Url(payload.fp);
  if (fingerprint === null || fingerprint.length !== 32) {
    return false;
  }

  return timingSafeEqual(
    fingerprint,
    sessionFingerprint(sessionKey, config.appAccessToken),
  );
}

export function getSessionCookieOptions(
  options: Pick<AuthOptions, "config"> = {},
): SessionCookieOptions {
  const appOrigin = resolveConfig(options.config).appOrigin;
  const secure = secureCookieForOrigin(appOrigin);

  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

export function authenticateApiRequest(
  request: Request,
  options: AuthOptions = {},
): ApiAuthenticationResult {
  const config = resolveConfig(options.config);
  const now = authenticationTimeInSeconds(options.now);
  if (now === null) {
    return UNAUTHORIZED;
  }

  if (request.headers.has("authorization")) {
    const authorization = request.headers.get("authorization");
    const match = authorization?.match(/^Bearer +([^\s]+)$/iu);
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
  if (!verifySessionToken(sessionToken, { config, now: now * 1000 })) {
    return UNAUTHORIZED;
  }

  if (
    !SAFE_METHODS.has(request.method.toUpperCase()) &&
    request.headers.get("origin") !== config.appOrigin
  ) {
    return ORIGIN_NOT_ALLOWED;
  }

  return { authenticated: true, via: "session" };
}

export async function authenticateApiRequestAsync(
  request: Request,
  options: AuthOptions = {},
): Promise<ApiAuthenticationResult> {
  const config = resolveConfig(options.config);
  const now = authenticationTimeInSeconds(options.now);
  if (now === null) return UNAUTHORIZED;

  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer +([^\s]+)$/iu);
  if (authorization !== null && match === null) return UNAUTHORIZED;

  if (match) {
    const origin = request.headers.get("origin");
    if (origin !== null && isExtensionOrigin(origin)) {
      const parsed = parseInstallationToken(match[1]);
      if (
        parsed === null ||
        !(config.corsAllowedOrigins ?? []).includes(origin)
      ) return UNAUTHORIZED;
      const store =
        options.installationStore ?? (await defaultInstallationStore());
      const record = await store.findForAuthentication(parsed.selector);
      if (
        record === null ||
        record.origin !== origin ||
        record.revokedAt !== null ||
        record.expiresAt.getTime() <= now * 1000
      ) {
        return UNAUTHORIZED;
      }
      const digest = digestInstallationSecret(
        parsed.selector,
        parsed.secret,
        origin,
        config.encryptionSecret,
      );
      if (!verifyCredentialDigest(record.tokenDigest, digest)) {
        return UNAUTHORIZED;
      }
      if (
        config.applicationWritesEnabled &&
        options.touchInstallation !== false &&
        !(await store.touch(record.id, new Date(now * 1000)))
      ) {
        return UNAUTHORIZED;
      }
      return {
        authenticated: true,
        via: "installation",
        principal: Object.freeze({
          kind: "installation",
          installationId: record.id,
          origin,
        }),
      };
    }
  }

  return authenticateApiRequest(request, options);
}

function resolveConfig(config: AuthConfig | undefined): AuthConfig {
  return config ?? getServerEnv();
}

function authenticationTimeInSeconds(now: number | undefined): number | null {
  const value = now ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return Math.floor(value / 1000);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function deriveSessionKey(config: AuthConfig): Buffer {
  return createHmac("sha256", config.encryptionSecret)
    .update(SESSION_KEY_LABEL, "utf8")
    .update(config.appOrigin, "utf8")
    .digest();
}

function sessionFingerprint(sessionKey: Buffer, accessToken: string): Buffer {
  return createHmac("sha256", sessionKey)
    .update(SESSION_FINGERPRINT_LABEL, "utf8")
    .update(accessToken, "utf8")
    .digest();
}

function sign(encodedPayload: string, sessionKey: Buffer): Buffer {
  return createHmac("sha256", sessionKey)
    .update(encodedPayload, "utf8")
    .digest();
}

function secureCookieForOrigin(appOrigin: string): boolean {
  let origin: URL;
  try {
    origin = new URL(appOrigin);
  } catch {
    throw new Error("Invalid application origin for session cookie");
  }

  if (origin.origin !== appOrigin) {
    throw new Error("Invalid application origin for session cookie");
  }
  if (origin.protocol === "https:") {
    return true;
  }
  if (
    origin.protocol === "http:" &&
    (origin.hostname === "localhost" || origin.hostname === "127.0.0.1")
  ) {
    return false;
  }
  throw new Error("Invalid application origin for session cookie");
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

function isExtensionOrigin(origin: string | null): boolean {
  return (
    typeof origin === "string" &&
    /^chrome-extension:\/\/[a-p]{32}$/u.test(origin)
  );
}

async function defaultInstallationStore(): Promise<InstallationAuthenticationStore> {
  const installationStoreModule = await import(
    "./extension-installation-store"
  );
  return installationStoreModule.extensionInstallationAuthenticationStore;
}
