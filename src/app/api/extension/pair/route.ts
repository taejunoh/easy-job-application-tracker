import { getServerEnv } from "@/lib/server-env";
import {
  applicationWritesEnabled,
  applicationWritesStoppedResponse,
} from "@/lib/security/application-writes";
import { privateNoStore } from "@/lib/security/auth-response";
import { configuredExtensionInstallationService } from "@/lib/security/configured-extension-installations";
import { PAIRING_PERSISTENCE_STOPPED } from "@/lib/security/extension-installations";
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

export const maxDuration = 30;

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
  const service = configuredExtensionInstallationService();
  if (!applicationWritesEnabled()) {
    const response = (await service.validatePairingCode(code, origin))
      ? applicationWritesStoppedResponse()
      : privateNoStore(Response.json(UNAUTHORIZED, { status: 401 }));
    return decorateCorsResponse(response, cors);
  }
  const installed = await service.exchangePairingCode(code, origin, {
    beforePersist: applicationWritesEnabled,
  });
  const response = installed === PAIRING_PERSISTENCE_STOPPED
    ? applicationWritesStoppedResponse()
    : installed
      ? Response.json(installed, { status: 201 })
      : Response.json(UNAUTHORIZED, { status: 401 });
  return privateNoStore(decorateCorsResponse(response, cors));
}

export function OPTIONS(request: Request): Response {
  return privateNoStore(corsPreflight(request, ["POST"]));
}
