import { authenticateApiRequestAsync } from "@/lib/security/auth";
import { privateNoStore } from "@/lib/security/auth-response";
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

export async function POST(request: Request): Promise<Response> {
  const cors = corsHeaders(request, ["POST"]);
  if (!cors.allowed) {
    return privateNoStore(cors.response);
  }
  if (request.headers.get("origin") === null) {
    return originError(cors);
  }

  const authentication = request.headers.has("authorization")
    ? await authenticateApiRequestAsync(request)
    : undefined;
  if (!authentication?.authenticated || authentication.via !== "installation") {
    return privateNoStore(
      decorateCorsResponse(
        Response.json(UNAUTHORIZED, { status: 401 }),
        cors,
      ),
    );
  }

  return privateNoStore(
    decorateCorsResponse(
      Response.json({
        authenticated: true,
        installationId: authentication.principal.installationId,
      }),
      cors,
    ),
  );
}

export function OPTIONS(request: Request): Response {
  return privateNoStore(corsPreflight(request, ["POST"]));
}

function originError(cors: CorsAllowed): Response {
  return privateNoStore(
    decorateCorsResponse(
      Response.json(ORIGIN_NOT_ALLOWED, { status: 403 }),
      cors,
    ),
  );
}
