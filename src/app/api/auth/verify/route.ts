import { authenticateApiRequest } from "@/lib/security/auth";
import {
  corsHeaders,
  corsPreflight,
  decorateCorsResponse,
  type CorsAllowed,
} from "@/lib/security/cors";

const UNAUTHORIZED = Object.freeze({
  error: "Authentication required" as const,
  code: "unauthorized" as const,
});

const ORIGIN_NOT_ALLOWED = Object.freeze({
  error: "Origin not allowed" as const,
  code: "origin_not_allowed" as const,
});

export function POST(request: Request): Response {
  const cors = corsHeaders(request, ["POST"]);
  if (!cors.allowed) {
    return cors.response;
  }
  if (request.headers.get("origin") === null) {
    return originError(cors);
  }

  const authentication = request.headers.has("authorization")
    ? authenticateApiRequest(request)
    : undefined;
  if (!authentication?.authenticated || authentication.via !== "bearer") {
    return decorateCorsResponse(
      Response.json(UNAUTHORIZED, { status: 401 }),
      cors,
    );
  }

  return decorateCorsResponse(
    Response.json({ authenticated: true }),
    cors,
  );
}

export function OPTIONS(request: Request): Response {
  return corsPreflight(request, ["POST"]);
}

function originError(cors: CorsAllowed): Response {
  return decorateCorsResponse(
    Response.json(ORIGIN_NOT_ALLOWED, { status: 403 }),
    cors,
  );
}
