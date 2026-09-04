import { configuredExtensionInstallationService } from "@/lib/security/configured-extension-installations";
import { applicationWriteGuard } from "@/lib/security/application-writes";
import { createProtectedRoute } from "@/lib/security/protected-route";
import { InvalidRequestError, readJsonBody } from "@/lib/security/request-body";

export const maxDuration = 30;

const route = createProtectedRoute(["POST"], { writeMethods: ["POST"] });
const FORBIDDEN = { error: "Forbidden", code: "forbidden" } as const;

export const OPTIONS = route.OPTIONS;

export const POST = route.handlerWithPrincipal(async (request, principal) => {
  if (principal.kind !== "session") {
    return Response.json(FORBIDDEN, { status: 403 });
  }
  const body = await readJsonBody(request);
  if (
    Object.keys(body).length !== 1 ||
    typeof body.origin !== "string"
  ) {
    throw new InvalidRequestError();
  }
  try {
    const stopped = applicationWriteGuard();
    if (stopped) return stopped;
    const grant = await configuredExtensionInstallationService()
      .createPairingGrant(body.origin);
    return Response.json(grant, { status: 201 });
  } catch (error) {
    if (error instanceof TypeError) throw new InvalidRequestError();
    throw error;
  }
});
