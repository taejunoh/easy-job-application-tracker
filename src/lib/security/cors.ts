import "server-only";

import { getServerEnv } from "../server-env";

export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 600;

export type CorsAllowed = Readonly<{
  allowed: true;
  headers: Headers;
}>;

export type CorsRejected = Readonly<{
  allowed: false;
  response: Response;
}>;

export type CorsResult = CorsAllowed | CorsRejected;

type CorsConfig = Readonly<{
  appOrigin: string;
  corsAllowedOrigins: readonly string[];
}>;

const HTTP_TOKEN_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const ALLOWED_REQUEST_HEADERS = new Set(["authorization", "content-type"]);
const NEXT_ROUTE_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
const MANAGED_CORS_HEADERS = [
  "Access-Control-Allow-Origin",
  "Access-Control-Allow-Credentials",
  "Access-Control-Allow-Methods",
  "Access-Control-Allow-Headers",
  "Access-Control-Max-Age",
] as const;

const ORIGIN_NOT_ALLOWED = Object.freeze({
  error: "Origin not allowed" as const,
  code: "origin_not_allowed" as const,
});

export function corsHeaders(
  request: Request,
  methods: readonly string[],
): CorsResult {
  const methodPolicy = normalizeMethodPolicy(methods);
  const requestMethod = normalizeHttpToken(request.method);
  if (requestMethod === null || !methodPolicy.includes(requestMethod)) {
    return rejectedOriginResponse();
  }

  return evaluateOrigin(request, getServerEnv(), true);
}

export function corsPreflight(
  request: Request,
  methods: readonly string[],
): Response {
  const methodPolicy = normalizeMethodPolicy(methods);
  const variationHeaders = preflightVariationHeaders();
  if (
    request.method.toUpperCase() !== "OPTIONS" ||
    !validRequestedMethod(request, methodPolicy) ||
    !validRequestedHeaders(request)
  ) {
    return rejectedOriginResponse(variationHeaders).response;
  }

  const result = evaluateOrigin(
    request,
    getServerEnv(),
    false,
    variationHeaders,
  );

  if (!result.allowed) {
    return result.response;
  }

  result.headers.set(
    "Access-Control-Allow-Methods",
    methodPolicy.join(", "),
  );
  result.headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type",
  );
  result.headers.set(
    "Access-Control-Max-Age",
    String(CORS_PREFLIGHT_MAX_AGE_SECONDS),
  );

  return new Response(null, { status: 204, headers: result.headers });
}

export function decorateCorsResponse(
  response: Response,
  cors: CorsAllowed,
): Response {
  const clone = response.clone();
  const headers = new Headers(clone.headers);

  for (const name of MANAGED_CORS_HEADERS) {
    headers.delete(name);
  }
  for (const [name, value] of cors.headers) {
    if (name.toLowerCase() !== "vary") {
      headers.set(name, value);
    }
  }
  headers.set(
    "Vary",
    mergeVary(headers.get("Vary"), cors.headers.get("Vary")),
  );

  return new Response(clone.body, {
    status: clone.status,
    statusText: clone.statusText,
    headers,
  });
}

function evaluateOrigin(
  request: Request,
  config: CorsConfig,
  allowMissing: boolean,
  variationHeaders = originVariationHeaders(),
): CorsResult {
  const origin = request.headers.get("origin");
  if (origin === null) {
    return allowMissing
      ? { allowed: true, headers: variationHeaders }
      : rejectedOriginResponse(variationHeaders);
  }
  if (!config.corsAllowedOrigins.includes(origin)) {
    return rejectedOriginResponse(variationHeaders);
  }

  return {
    allowed: true,
    headers: allowedOriginHeaders(origin, config, variationHeaders),
  };
}

function allowedOriginHeaders(
  origin: string,
  config: CorsConfig,
  headers: Headers,
): Headers {
  headers.set("Access-Control-Allow-Origin", origin);
  if (origin === config.appOrigin) {
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  return headers;
}

function originVariationHeaders(): Headers {
  return new Headers({ Vary: "Origin" });
}

function preflightVariationHeaders(): Headers {
  return new Headers({
    Vary:
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
  });
}

function rejectedOriginResponse(
  headers = originVariationHeaders(),
): CorsRejected {
  return {
    allowed: false,
    response: Response.json(ORIGIN_NOT_ALLOWED, {
      status: 403,
      headers,
    }),
  };
}

function normalizeMethodPolicy(methods: readonly string[]): string[] {
  if (methods.length === 0) {
    throw new TypeError("Invalid CORS method policy");
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const method of methods) {
    const value = normalizeHttpToken(method);
    if (value === null || !NEXT_ROUTE_METHODS.has(value)) {
      throw new TypeError("Invalid CORS method policy");
    }
    if (!seen.has(value)) {
      seen.add(value);
      normalized.push(value);
    }
    if (value === "GET" && !seen.has("HEAD")) {
      seen.add("HEAD");
      normalized.push("HEAD");
    }
  }
  return normalized;
}

function validRequestedMethod(
  request: Request,
  methodPolicy: readonly string[],
): boolean {
  const value = request.headers.get("Access-Control-Request-Method");
  if (value === null || value.includes(",")) {
    return false;
  }

  const method = normalizeHttpToken(value);
  return method !== null && method !== "*" && methodPolicy.includes(method);
}

function validRequestedHeaders(request: Request): boolean {
  const value = request.headers.get("Access-Control-Request-Headers");
  if (value === null) {
    return true;
  }

  const seen = new Set<string>();
  for (const entry of value.split(",")) {
    const header = entry.trim().toLowerCase();
    if (
      !HTTP_TOKEN_PATTERN.test(header) ||
      !ALLOWED_REQUEST_HEADERS.has(header) ||
      seen.has(header)
    ) {
      return false;
    }
    seen.add(header);
  }
  return true;
}

function normalizeHttpToken(value: unknown): string | null {
  if (typeof value !== "string" || !HTTP_TOKEN_PATTERN.test(value)) {
    return null;
  }
  return value.toUpperCase();
}

function mergeVary(current: string | null, additions: string | null): string {
  const values: string[] = [];
  const seen = new Set<string>();

  for (const value of `${current ?? ""},${additions ?? ""}`.split(",")) {
    const trimmed = value.trim();
    const normalized = trimmed.toLowerCase();
    if (normalized === "*") {
      return "*";
    }
    if (trimmed.length > 0 && !seen.has(normalized)) {
      values.push(trimmed);
      seen.add(normalized);
    }
  }

  return values.join(", ");
}
