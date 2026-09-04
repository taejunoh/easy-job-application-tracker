import { configuredExtensionInstallationService } from "@/lib/security/configured-extension-installations";
import { applicationWriteGuard } from "@/lib/security/application-writes";
import { createProtectedRoute } from "@/lib/security/protected-route";

export const maxDuration = 30;

const route = createProtectedRoute(["DELETE"], { writeMethods: ["DELETE"] });
const FORBIDDEN = { error: "Forbidden", code: "forbidden" } as const;
const NOT_FOUND = { error: "Installation not found", code: "not_found" } as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const OPTIONS = route.OPTIONS;

export const DELETE = route.handlerWithPrincipal(
  async (_request, principal, { params }: { params: Promise<{ id: string }> }) => {
    if (principal.kind !== "session") {
      return Response.json(FORBIDDEN, { status: 403 });
    }
    const { id } = await params;
    if (!UUID_PATTERN.test(id)) {
      return Response.json(NOT_FOUND, { status: 404 });
    }
    const stopped = applicationWriteGuard();
    if (stopped) return stopped;
    const revoked = await configuredExtensionInstallationService().revoke(id);
    return revoked
      ? Response.json({ revoked: true })
      : Response.json(NOT_FOUND, { status: 404 });
  },
);
