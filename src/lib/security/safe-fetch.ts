import "server-only";

import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { types as utilTypes } from "node:util";

import {
  Agent,
  buildConnector,
  errors as undiciErrors,
  fetch as undiciFetch,
} from "undici";

import { isPublicIpAddress } from "./ip-address";

export const MAX_JOB_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;
const REDIRECT_CHAIN_TIMEOUT_MS = 20_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ACCEPTED_MEDIA_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const TIMEOUT_ERROR_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ETIMEDOUT",
]);
const NETWORK_ERROR_CODES = new Set([
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_OVERFLOW",
  "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "EADDRNOTAVAIL",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "EAI_NODATA",
  "EAI_NONAME",
  "EAI_ADDRFAMILY",
  "ERR_TLS_CERT_ALTNAME_FORMAT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
]);
// Exact X509 verification codes documented by Node.js/OpenSSL.
const X509_VERIFICATION_ERROR_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_CRL",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "CERT_SIGNATURE_FAILURE",
  "CRL_SIGNATURE_FAILURE",
  "CERT_NOT_YET_VALID",
  "CERT_HAS_EXPIRED",
  "CRL_NOT_YET_VALID",
  "CRL_HAS_EXPIRED",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERROR_IN_CRL_LAST_UPDATE_FIELD",
  "ERROR_IN_CRL_NEXT_UPDATE_FIELD",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_CHAIN_TOO_LONG",
  "CERT_REVOKED",
  "INVALID_CA",
  "PATH_LENGTH_EXCEEDED",
  "INVALID_PURPOSE",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "HOSTNAME_MISMATCH",
]);
// Remote protocol and alert reasons emitted by Node's bundled OpenSSL.
const REMOTE_TLS_ERROR_CODES = new Set([
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_UNSUPPORTED_PROTOCOL",
  "ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE",
  "ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC",
  "ERR_SSL_SSLV3_ALERT_CERTIFICATE_EXPIRED",
  "ERR_SSL_SSLV3_ALERT_CERTIFICATE_REVOKED",
  "ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN",
  "ERR_SSL_SSLV3_ALERT_DECOMPRESSION_FAILURE",
  "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
  "ERR_SSL_SSLV3_ALERT_ILLEGAL_PARAMETER",
  "ERR_SSL_SSLV3_ALERT_NO_CERTIFICATE",
  "ERR_SSL_SSLV3_ALERT_UNEXPECTED_MESSAGE",
  "ERR_SSL_SSLV3_ALERT_UNSUPPORTED_CERTIFICATE",
  "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED",
  "ERR_SSL_TLSV13_ALERT_MISSING_EXTENSION",
  "ERR_SSL_TLSV1_ALERT_ACCESS_DENIED",
  "ERR_SSL_TLSV1_ALERT_DECODE_ERROR",
  "ERR_SSL_TLSV1_ALERT_DECRYPTION_FAILED",
  "ERR_SSL_TLSV1_ALERT_DECRYPT_ERROR",
  "ERR_SSL_TLSV1_ALERT_EXPORT_RESTRICTION",
  "ERR_SSL_TLSV1_ALERT_INAPPROPRIATE_FALLBACK",
  "ERR_SSL_TLSV1_ALERT_INSUFFICIENT_SECURITY",
  "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR",
  "ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL",
  "ERR_SSL_TLSV1_ALERT_NO_RENEGOTIATION",
  "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
  "ERR_SSL_TLSV1_ALERT_RECORD_OVERFLOW",
  "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA",
  "ERR_SSL_TLSV1_ALERT_UNKNOWN_PSK_IDENTITY",
  "ERR_SSL_TLSV1_ALERT_USER_CANCELLED",
]);

export type SafeFetchErrorCode =
  | "url_not_allowed"
  | "upstream_timeout"
  | "unsupported_upstream_type"
  | "upstream_too_large"
  | "upstream_failed";

const ERROR_DETAILS: Record<
  SafeFetchErrorCode,
  Readonly<{ status: number; message: string }>
> = {
  url_not_allowed: { status: 422, message: "URL is not allowed" },
  upstream_timeout: { status: 504, message: "Upstream request timed out" },
  unsupported_upstream_type: {
    status: 415,
    message: "Upstream content type is not supported",
  },
  upstream_too_large: {
    status: 413,
    message: "Upstream response is too large",
  },
  upstream_failed: { status: 422, message: "Failed to fetch upstream URL" },
};

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;
  readonly status: number;

  constructor(code: SafeFetchErrorCode) {
    const details = ERROR_DETAILS[code];
    super(details.message);
    this.name = "SafeFetchError";
    this.code = code;
    this.status = details.status;
  }
}

export class SafeFetchTransportError extends Error {
  readonly kind: "network" | "timeout";

  constructor(kind: "network" | "timeout") {
    super(
      kind === "timeout"
        ? "Upstream transport timed out"
        : "Upstream transport failed",
    );
    this.name = "SafeFetchTransportError";
    this.kind = kind;
  }
}

export interface SafeFetchTransportRequest {
  readonly url: URL;
  readonly lookup: LookupFunction;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly headers: Headers;
}

export interface SafeFetchTransportResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
  dispose(): Promise<void>;
}

export interface SafeFetchDependencies {
  resolve(hostname: string): Promise<readonly LookupAddress[]>;
  transport(
    request: SafeFetchTransportRequest,
  ): Promise<SafeFetchTransportResponse>;
  now(): number;
  setTimeout(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface SafeFetchResult {
  readonly html: string;
  readonly finalUrl: string;
}

interface LookupAddress {
  readonly address: string;
  readonly family: number;
}

interface HopResult {
  readonly html?: string;
  readonly redirect?: URL;
}

const defaultDependencies: SafeFetchDependencies = {
  async resolve(hostname) {
    try {
      return await lookup(hostname, { all: true });
    } catch (error) {
      const kind = classifyTransportFailure(error);
      if (kind) throw new SafeFetchTransportError(kind);
      throw error;
    }
  },
  transport: createUndiciTransport(undiciFetch),
  now: monotonicNow,
  setTimeout,
  clearTimeout,
};

export const safeFetchJobUrl = createSafeFetchJobUrl(defaultDependencies);

export function monotonicNow(): number {
  return performance.now();
}

export function createSafeFetchJobUrl(dependencies: SafeFetchDependencies) {
  return async function fetchJobUrl(rawUrl: string): Promise<SafeFetchResult> {
    const chainStartedAt = dependencies.now();
    let currentUrl = validateJobUrl(rawUrl);
    let redirectsFollowed = 0;

    while (true) {
      const chainRemaining =
        REDIRECT_CHAIN_TIMEOUT_MS - (dependencies.now() - chainStartedAt);
      const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, chainRemaining);
      if (timeoutMs <= 0) throw new SafeFetchError("upstream_timeout");

      let hop: HopResult;
      try {
        hop = await withDeadline(dependencies, timeoutMs, (signal) =>
          fetchHop(currentUrl, timeoutMs, signal, dependencies),
        );
      } catch (error) {
        if (error instanceof SafeFetchError) throw error;
        if (error instanceof SafeFetchTransportError) {
          throw new SafeFetchError(
            error.kind === "timeout" ? "upstream_timeout" : "upstream_failed",
          );
        }
        throw error;
      }

      if (hop.redirect) {
        if (redirectsFollowed >= MAX_REDIRECTS) {
          throw new SafeFetchError("url_not_allowed");
        }
        redirectsFollowed += 1;
        currentUrl = hop.redirect;
        continue;
      }

      return { html: hop.html ?? "", finalUrl: currentUrl.href };
    }
  };
}

export function validateJobUrl(rawUrl: string): URL {
  if (rawUrl.includes("#")) {
    throw new SafeFetchError("url_not_allowed");
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeFetchError("url_not_allowed");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError("url_not_allowed");
  }
  if (url.username || url.password || url.hash) {
    throw new SafeFetchError("url_not_allowed");
  }
  if (url.port) {
    throw new SafeFetchError("url_not_allowed");
  }

  const hostname = canonicalLookupHostname(url.hostname);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    !hostname
  ) {
    throw new SafeFetchError("url_not_allowed");
  }

  if (isIP(hostname) !== 0 && !isPublicIpAddress(hostname)) {
    throw new SafeFetchError("url_not_allowed");
  }

  return url;
}

export function createPinnedLookup(
  expectedHostname: string,
  addresses: readonly LookupAddress[],
): LookupFunction {
  const expected = canonicalLookupHostname(expectedHostname);
  const captured = addresses.map(({ address, family }) => ({ address, family }));

  return (hostname, options, callback) => {
    if (canonicalLookupHostname(hostname) !== expected) {
      callback(lookupError("ENOTFOUND"), "", 0);
      return;
    }

    const matching = options.family
      ? captured.filter(({ family }) => family === options.family)
      : captured;
    if (matching.length === 0) {
      callback(lookupError("EAI_ADDRFAMILY"), "", 0);
      return;
    }

    if (options.all) {
      callback(
        null,
        matching.map(({ address, family }) => ({ address, family })),
      );
      return;
    }

    callback(null, matching[0].address, matching[0].family);
  };
}

export function createPinnedConnector(
  expectedHostname: string,
  lookupFunction: LookupFunction,
  timeoutMs: number,
  connectorBuilder: typeof buildConnector = buildConnector,
): ReturnType<typeof buildConnector> {
  const expected = canonicalLookupHostname(expectedHostname);
  const connector = connectorBuilder({
    lookup: lookupFunction,
    timeout: Math.max(1, Math.ceil(timeoutMs)),
    maxCachedSessions: 0,
  });

  return (options, callback) => {
    if (canonicalLookupHostname(options.hostname) !== expected) {
      callback(lookupError("ENOTFOUND"), null);
      return;
    }

    connector(
      options.protocol === "https:" && isIP(expected) === 0
        ? { ...options, servername: expected }
        : options,
      callback,
    );
  };
}

async function fetchHop(
  url: URL,
  timeoutMs: number,
  signal: AbortSignal,
  dependencies: SafeFetchDependencies,
): Promise<HopResult> {
  const hostname = normalizeHostname(url.hostname);
  const addresses = await resolveAndValidate(hostname, dependencies);
  const response = await dependencies.transport({
    url,
    lookup: createPinnedLookup(hostname, addresses),
    signal,
    timeoutMs,
    headers: safeUpstreamHeaders(),
  });

  try {
    if (REDIRECT_STATUSES.has(response.status)) {
      await cancelBody(response.body);
      const location = response.headers.get("location");
      if (!location) throw new SafeFetchError("url_not_allowed");
      try {
        return { redirect: validateJobUrl(new URL(location, url).href) };
      } catch (error) {
        if (error instanceof SafeFetchError) throw error;
        throw new SafeFetchError("url_not_allowed");
      }
    }

    if (response.status < 200 || response.status >= 300) {
      await cancelBody(response.body);
      throw new SafeFetchError("upstream_failed");
    }

    const mediaType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (!mediaType || !ACCEPTED_MEDIA_TYPES.has(mediaType)) {
      await cancelBody(response.body);
      throw new SafeFetchError("unsupported_upstream_type");
    }

    rejectDeclaredOversize(response.headers.get("content-length"));
    return { html: await readBoundedBody(response.body, signal) };
  } finally {
    await response.dispose();
  }
}

async function resolveAndValidate(
  hostname: string,
  dependencies: SafeFetchDependencies,
): Promise<readonly LookupAddress[]> {
  const literalFamily = isIP(hostname);
  const addresses =
    literalFamily === 0
      ? await dependencies.resolve(hostname)
      : [{ address: hostname, family: literalFamily }];

  if (addresses.length === 0) {
    throw new SafeFetchError("url_not_allowed");
  }

  for (const { address, family } of addresses) {
    if (
      (family !== 4 && family !== 6) ||
      isIP(address) !== family ||
      !isPublicIpAddress(address)
    ) {
      throw new SafeFetchError("url_not_allowed");
    }
  }

  return addresses.map(({ address, family }) => ({ address, family }));
}

async function withDeadline<T>(
  dependencies: SafeFetchDependencies,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = dependencies.setTimeout(() => {
      const error = new SafeFetchError("upstream_timeout");
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) dependencies.clearTimeout(timer);
  }
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): Promise<string> {
  if (!body) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        const kind = classifyTransportFailure(error, signal);
        if (kind) throw new SafeFetchTransportError(kind);
        throw error;
      }
      const { done, value } = result;
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_JOB_PAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new SafeFetchError("upstream_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function rejectDeclaredOversize(contentLength: string | null): void {
  if (/^(?:0|[1-9][0-9]*)$/u.test(contentLength ?? "")) {
    if (BigInt(contentLength as string) > BigInt(MAX_JOB_PAGE_BYTES)) {
      throw new SafeFetchError("upstream_too_large");
    }
  }
}

async function cancelBody(body: ReadableStream<Uint8Array> | null) {
  await body?.cancel().catch(() => undefined);
}

function safeUpstreamHeaders(): Headers {
  return new Headers({
    Accept: "text/html, application/xhtml+xml",
    "User-Agent": "JobTracker/1.0 (+server-side job extraction)",
  });
}

export function createUndiciTransport(fetchImplementation: typeof undiciFetch) {
  return async function transport(
    request: SafeFetchTransportRequest,
  ): Promise<SafeFetchTransportResponse> {
    const timeoutMs = Math.max(1, Math.ceil(request.timeoutMs));
    const connector = createPinnedConnector(
      normalizeHostname(request.url.hostname),
      request.lookup,
      timeoutMs,
    );
    const dispatcher = new Agent({
      connect: connector,
      connections: 1,
      maxOrigins: 1,
      pipelining: 1,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });

    try {
      const upstream = await fetchImplementation(request.url, {
        method: "GET",
        headers: Object.fromEntries(request.headers.entries()),
        credentials: "omit",
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal: request.signal,
        dispatcher,
      });
      const headers = new Headers();
      upstream.headers.forEach((value, name) => headers.append(name, value));
      return {
        status: upstream.status,
        headers,
        // undici.fetch exposes decoded body bytes after Content-Encoding.
        body: upstream.body as unknown as ReadableStream<Uint8Array> | null,
        async dispose() {
          await dispatcher.destroy().catch(() => undefined);
        },
      };
    } catch (error) {
      await dispatcher.destroy().catch(() => undefined);
      const kind = classifyTransportFailure(error, request.signal);
      if (kind) throw new SafeFetchTransportError(kind);
      throw error;
    }
  };
}

function classifyTransportFailure(
  error: unknown,
  signal?: AbortSignal,
): "network" | "timeout" | null {
  if (signal?.aborted) return "timeout";

  let current = error;
  for (let depth = 0; depth < 4 && isErrorObject(current); depth += 1) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string" && TIMEOUT_ERROR_CODES.has(code)) {
      return "timeout";
    }
    if (isKnownNetworkFailure(current, code)) return "network";
    current = (current as Error & { cause?: unknown }).cause;
  }
  return null;
}

function isErrorObject(value: unknown): value is Error {
  return value instanceof Error || utilTypes.isNativeError(value);
}

function isKnownNetworkFailure(error: Error, code: unknown): boolean {
  if (
    error instanceof undiciErrors.SocketError ||
    error instanceof undiciErrors.HeadersOverflowError ||
    error instanceof undiciErrors.ResponseContentLengthMismatchError ||
    error instanceof undiciErrors.HTTPParserError
  ) {
    return true;
  }

  return (
    typeof code === "string" &&
    (NETWORK_ERROR_CODES.has(code) ||
      X509_VERIFICATION_ERROR_CODES.has(code) ||
      REMOTE_TLS_ERROR_CODES.has(code) ||
      code.startsWith("HPE_"))
  );
}

function normalizeHostname(hostname: string): string {
  const withoutBrackets =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return withoutBrackets.toLowerCase();
}

function canonicalLookupHostname(hostname: string): string {
  return normalizeHostname(hostname).replace(/\.+$/u, "");
}

function lookupError(code: string): NodeJS.ErrnoException {
  const error = new Error(
    "Pinned DNS lookup rejected hostname",
  ) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}
