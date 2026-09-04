import { configuredExtensionInstallationService } from "@/lib/security/configured-extension-installations";
import { applicationWriteGuard } from "@/lib/security/application-writes";
import { createProtectedRoute } from "@/lib/security/protected-route";

export const maxDuration = 30;

const route = createProtectedRoute(["POST"], {
  installationMethods: ["POST"],
  writeMethods: ["POST"],
});

export const OPTIONS = route.OPTIONS;

export const POST = route.handlerWithPrincipal(async (_request, principal) => {
  if (principal.kind !== "installation") {
    return Response.json(
      { error: "Forbidden", code: "forbidden" },
      { status: 403 },
    );
  }
  const stopped = applicationWriteGuard();
  if (stopped) return stopped;
  const revoked = await configuredExtensionInstallationService().revoke(
    principal.installationId,
  );
  return revoked
    ? Response.json({ revoked: true })
    : Response.json(
        { error: "Authentication required", code: "unauthorized" },
        { status: 401 },
      );
});
