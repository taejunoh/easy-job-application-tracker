import { prisma } from "@/lib/prisma";
import { createProtectedRoute } from "@/lib/security/protected-route";

const route = createProtectedRoute(["GET"], {
  installationMethods: ["GET"],
});

export const OPTIONS = route.OPTIONS;

export const GET = route.handlerWithPrincipal(async (_request, principal) => {
  if (principal.kind !== "installation") {
    return Response.json(
      { error: "Forbidden", code: "forbidden" },
      { status: 403 },
    );
  }
  const settings = await prisma.settings.findFirst({
    select: { linkedinUrl: true, githubUrl: true, resumeText: true },
  });
  return Response.json({
    linkedinUrl: settings?.linkedinUrl ?? "",
    githubUrl: settings?.githubUrl ?? "",
    hasResume: Boolean(settings?.resumeText),
  });
});
