import { sanitizeReturnPath } from "@/lib/return-path";

export interface ClientLocation {
  pathname: string;
  search: string;
  hash: string;
}

export type ClientApi = <T>(
  input: string,
  init?: RequestInit,
) => Promise<T>;

interface ClientApiDependencies {
  fetchImpl?: typeof fetch;
  getLocation?: () => ClientLocation;
}

interface ErrorPayload {
  error?: unknown;
  message?: unknown;
  code?: unknown;
}

let sessionRedirectPending = false;

export class ClientApiError extends Error {
  readonly name = "ClientApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function buildConnectPath(location: ClientLocation): string {
  const candidate = `${location.pathname}${location.search}${location.hash}`;
  const returnPath = sanitizeReturnPath(candidate) ?? "/";
  return `/connect?next=${encodeURIComponent(returnPath)}`;
}

export function resetClientApiSessionRedirect(): void {
  sessionRedirectPending = false;
}

export function createClientApi(
  navigate: (href: string) => void,
  dependencies: ClientApiDependencies = {},
): ClientApi {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const getLocation = dependencies.getLocation ?? browserLocation;

  return async function clientApi<T>(
    input: string,
    init?: RequestInit,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } catch {
      throw new ClientApiError(
        0,
        "network_error",
        "JobTracker could not be reached.",
      );
    }

    if (!response.ok) {
      if (response.status === 401 && !sessionRedirectPending) {
        sessionRedirectPending = true;
        navigate(buildConnectPath(getLocation()));
      }

      const payload = await readErrorPayload(response);
      const code =
        typeof payload.code === "string"
          ? payload.code
          : response.status === 401
            ? "unauthorized"
            : "request_failed";
      const message =
        typeof payload.error === "string"
          ? payload.error
          : typeof payload.message === "string"
            ? payload.message
            : `Request failed (${response.status}).`;
      throw new ClientApiError(response.status, code, message);
    }

    if (response.status === 204) return undefined as T;

    try {
      return (await response.json()) as T;
    } catch {
      throw new ClientApiError(
        response.status,
        "invalid_response",
        "JobTracker returned an invalid response.",
      );
    }
  };
}

async function readErrorPayload(response: Response): Promise<ErrorPayload> {
  try {
    const payload: unknown = await response.json();
    if (typeof payload === "object" && payload !== null) {
      return payload as ErrorPayload;
    }
  } catch {
    // A stable fallback below covers non-JSON error responses.
  }
  return {};
}

function browserLocation(): ClientLocation {
  if (typeof window === "undefined") {
    return { pathname: "/", search: "", hash: "" };
  }
  return {
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  };
}
