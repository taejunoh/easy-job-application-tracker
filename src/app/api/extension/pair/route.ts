import { getServerEnv } from "@/lib/server-env";
import { privateNoStore } from "@/lib/security/auth-response";
import { configuredExtensionInstallationService } from "@/lib/security/configured-extension-installations";
import {
  corsHeaders,
  corsPreflight,
  decorateCorsResponse,
} from "@/lib/security/cors";
import { readJsonBody } from "@/lib/security/request-body";

const UNAUTHORIZED = {
  error: "Authentication required",
  code: "unauthorized",
} as const;

export async function POST(request: Request): Promise<Response> {
  const cors = corsHeaders(request, ["POST"]);
  if (!cors.allowed) return privateNoStore(cors.response);
  const origin = request.headers.get("origin");
  if (
    origin === null ||
    !/^chrome-extension:\/\/[a-p]{32}$/u.test(origin) ||
    !getServerEnv().corsAllowedOrigins.includes(origin)
  ) {
    return privateNoStore(
      decorateCorsResponse(Response.json(UNAUTHORIZED, { status: 401 }), cors),
    );
  }

  let code: unknown;
  try {
    const body = await readJsonBody(request);
    code = Object.keys(body).length === 1 ? body.code : undefined;
  } catch {
    code = undefined;
  }
  const installed = await configuredExtensionInstallationService()
    .exchangePairingCode(code, origin);
  const response = installed
    ? Response.json(installed, { status: 201 })
    : Response.json(UNAUTHORIZED, { status: 401 });
  return privateNoStore(decorateCorsResponse(response, cors));
}

export function OPTIONS(request: Request): Response {
  return privateNoStore(corsPreflight(request, ["POST"]));
}
