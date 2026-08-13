import { configuredExtensionInstallationService } from "@/lib/security/configured-extension-installations";
import { createProtectedRoute } from "@/lib/security/protected-route";

const route = createProtectedRoute(["POST"], {
  installationMethods: ["POST"],
});

export const OPTIONS = route.OPTIONS;

export const POST = route.handlerWithPrincipal(async (_request, principal) => {
  if (principal.kind !== "installation") {
    return Response.json(
      { error: "Forbidden", code: "forbidden" },
      { status: 403 },
    );
  }
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
