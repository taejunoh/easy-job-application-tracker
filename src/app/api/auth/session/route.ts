import { NextResponse } from "next/server";

import { getServerEnv } from "@/lib/server-env";
import { privateNoStore } from "@/lib/security/auth-response";
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
  getSessionCookieOptions,
  verifyBearerToken,
} from "@/lib/security/auth";
import {
  corsHeaders,
  decorateCorsResponse,
  type CorsAllowed,
} from "@/lib/security/cors";
import {
  RequestBodyTooLargeError,
  readBoundedJsonBody,
} from "@/lib/security/request-body";

const UNAUTHORIZED = Object.freeze({
  error: "Authentication required" as const,
  code: "unauthorized" as const,
});

const ORIGIN_NOT_ALLOWED = Object.freeze({
  error: "Origin not allowed" as const,
  code: "origin_not_allowed" as const,
});

const INVALID_REQUEST = Object.freeze({
  error: "Invalid request" as const,
  code: "invalid_request" as const,
});

const REQUEST_TOO_LARGE = Object.freeze({
  error: "Request too large" as const,
  code: "request_too_large" as const,
});

export async function POST(request: Request): Promise<Response> {
  const cors = corsHeaders(request, ["POST"]);
  if (!cors.allowed) {
    return privateNoStore(cors.response);
  }
  if (request.headers.get("origin") !== getServerEnv().appOrigin) {
    return originError(cors);
  }

  let body: unknown;
  try {
    body = await readBoundedJsonBody(request);
  } catch (error) {
    const response =
      error instanceof RequestBodyTooLargeError
        ? Response.json(REQUEST_TOO_LARGE, { status: 413 })
        : Response.json(INVALID_REQUEST, { status: 400 });
    return privateNoStore(
      decorateCorsResponse(response, cors),
    );
  }

  const token = readToken(body);
  if (!verifyBearerToken(token)) {
    return privateNoStore(
      decorateCorsResponse(
        Response.json(UNAUTHORIZED, { status: 401 }),
        cors,
      ),
    );
  }

  const response = NextResponse.json({ authenticated: true });
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: createSessionToken(),
    ...getSessionCookieOptions(),
  });
  return privateNoStore(decorateCorsResponse(response, cors));
}

export async function DELETE(request: Request): Promise<Response> {
  const cors = corsHeaders(request, ["DELETE"]);
  if (!cors.allowed) {
    return privateNoStore(cors.response);
  }
  if (request.headers.get("origin") !== getServerEnv().appOrigin) {
    return originError(cors);
  }

  const response = NextResponse.json({ authenticated: false });
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    ...getSessionCookieOptions(),
    maxAge: 0,
  });
  return privateNoStore(decorateCorsResponse(response, cors));
}

function readToken(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }
  const token = Reflect.get(body, "token");
  return typeof token === "string" ? token : undefined;
}

function originError(cors: CorsAllowed): Response {
  return privateNoStore(
    decorateCorsResponse(
      Response.json(ORIGIN_NOT_ALLOWED, { status: 403 }),
      cors,
    ),
  );
}
