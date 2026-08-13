import { configuredExtensionInstallationService } from "@/lib/security/configured-extension-installations";
import { createProtectedRoute } from "@/lib/security/protected-route";
import { getServerEnv } from "@/lib/server-env";

const route = createProtectedRoute(["GET"]);
const FORBIDDEN = { error: "Forbidden", code: "forbidden" } as const;

export const OPTIONS = route.OPTIONS;

export const GET = route.handlerWithPrincipal(async (_request, principal) => {
  if (principal.kind !== "session") {
    return Response.json(FORBIDDEN, { status: 403 });
  }
  const installations = await configuredExtensionInstallationService().list();
  const configuredOrigins = getServerEnv().corsAllowedOrigins.filter((origin) =>
    /^chrome-extension:\/\/[a-p]{32}$/u.test(origin),
  );
  return Response.json({ installations, configuredOrigins });
});
