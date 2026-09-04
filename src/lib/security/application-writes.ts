import "server-only";

import { getServerEnv } from "../server-env";

export const WRITES_STOPPED = Object.freeze({
  error: "Application writes are temporarily disabled" as const,
  code: "writes_stopped" as const,
  retryable: true as const,
});

export function applicationWritesEnabled(): boolean {
  return getServerEnv().applicationWritesEnabled;
}

export function applicationWriteGuard(): Response | null {
  return applicationWritesEnabled() ? null : applicationWritesStoppedResponse();
}

export function applicationWritesStoppedResponse(): Response {
  return Response.json(WRITES_STOPPED, {
    status: 503,
    headers: {
      "Cache-Control": "private, no-store",
      Pragma: "no-cache",
      "Retry-After": "60",
    },
  });
}
