import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { analyzeKeywordMatch } from "@/lib/keyword-matcher";
import { createProtectedRoute } from "@/lib/security/protected-route";

const route = createProtectedRoute(["POST"]);

export const OPTIONS = route.OPTIONS;

export const POST = route.handler(async function POST(request: NextRequest) {
  const body = await request.json();
  const { description } = body;

  if (!description || !description.trim()) {
    return NextResponse.json(
      { error: "description is required" },
      { status: 400 }
    );
  }

  const settings = await prisma.settings.findFirst();
  if (!settings?.resumeText) {
    return NextResponse.json(
      { error: "no_resume", message: "No resume text configured in settings" },
      { status: 200 }
    );
  }

  const result = analyzeKeywordMatch(description, settings.resumeText);
  return NextResponse.json(result);
});
