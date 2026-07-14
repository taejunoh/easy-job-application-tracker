import "server-only";

import { getServerEnv } from "../server-env";

export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 600;

export type CorsMethod =
  | "GET"
  | "HEAD"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS";

export type CorsConfig = Readonly<{
  appOrigin: string;
  corsAllowedOrigins: readonly string[];
}>;

export type CorsOptions = Readonly<{
  config?: CorsConfig;
}>;

export type CorsAllowed = Readonly<{
  allowed: true;
  headers: Headers;
}>;

export type CorsRejected = Readonly<{
  allowed: false;
  response: Response;
}>;

export type CorsResult = CorsAllowed | CorsRejected;

const SUPPORTED_METHODS = new Set<CorsMethod>([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

const ORIGIN_NOT_ALLOWED = Object.freeze({
  error: "Origin not allowed" as const,
  code: "origin_not_allowed" as const,
});

export function corsHeaders(
  request: Request,
  _methods: readonly CorsMethod[],
  options: CorsOptions = {},
): CorsResult {
  const config = options.config ?? getServerEnv();
  const origin = request.headers.get("origin");

  if (origin === null) {
    return { allowed: true, headers: originVariationHeaders() };
  }
  if (!config.corsAllowedOrigins.includes(origin)) {
    return rejectedOriginResponse();
  }

  return { allowed: true, headers: allowedOriginHeaders(origin, config) };
}

export function corsPreflight(
  request: Request,
  methods: readonly CorsMethod[],
  options: CorsOptions = {},
): Response {
  const normalizedMethods = normalizeMethods(methods);
  const result = corsHeaders(request, methods, options);

  if (!result.allowed) {
    return result.response;
  }
  if (request.headers.get("origin") === null) {
    return rejectedOriginResponse().response;
  }

  result.headers.set(
    "Access-Control-Allow-Methods",
    normalizedMethods.join(", "),
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
  for (const [name, value] of cors.headers) {
    if (name.toLowerCase() !== "vary") {
      response.headers.set(name, value);
    }
  }
  response.headers.set(
    "Vary",
    mergeVary(response.headers.get("Vary"), cors.headers.get("Vary")),
  );
  return response;
}

function allowedOriginHeaders(origin: string, config: CorsConfig): Headers {
  const headers = originVariationHeaders();
  headers.set("Access-Control-Allow-Origin", origin);
  if (origin === config.appOrigin) {
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  return headers;
}

function originVariationHeaders(): Headers {
  return new Headers({ Vary: "Origin" });
}

function rejectedOriginResponse(): CorsRejected {
  return {
    allowed: false,
    response: Response.json(ORIGIN_NOT_ALLOWED, {
      status: 403,
      headers: originVariationHeaders(),
    }),
  };
}

function normalizeMethods(methods: readonly CorsMethod[]): CorsMethod[] {
  const normalized: CorsMethod[] = [];
  const seen = new Set<CorsMethod>();

  for (const method of methods) {
    if (!SUPPORTED_METHODS.has(method)) {
      throw new TypeError(`Unsupported CORS method: ${method}`);
    }
    if (!seen.has(method)) {
      seen.add(method);
      normalized.push(method);
    }
  }
  return normalized;
}

function mergeVary(current: string | null, additions: string | null): string {
  const values: string[] = [];
  const seen = new Set<string>();

  for (const value of `${current ?? ""},${additions ?? ""}`.split(",")) {
    const trimmed = value.trim();
    const normalized = trimmed.toLowerCase();
    if (trimmed.length > 0 && !seen.has(normalized)) {
      values.push(trimmed);
      seen.add(normalized);
    }
  }

  return values.join(", ");
}
