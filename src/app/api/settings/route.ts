import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";
import { createProtectedRoute } from "@/lib/security/protected-route";
import { readJsonBody } from "@/lib/security/request-body";

const route = createProtectedRoute(["GET", "PUT"]);

export const OPTIONS = route.OPTIONS;

export const GET = route.handler(async function GET(request: NextRequest) {
  let settings = await prisma.settings.findFirst();

  if (!settings) {
    settings = await prisma.settings.create({ data: {} });
  }

  const { searchParams } = new URL(request.url);
  const includeResume = searchParams.get("includeResume") === "true";

  const response: Record<string, unknown> = {
    llmProvider: settings.llmProvider,
    hasApiKey: settings.apiKey !== "",
    linkedinUrl: settings.linkedinUrl,
    githubUrl: settings.githubUrl,
  };

  if (includeResume) {
    response.resumeText = settings.resumeText;
  }

  return NextResponse.json(response);
});

export const PUT = route.handler(async function PUT(request: NextRequest) {
  const body = await readJsonBody(request);

  const data: Record<string, string> = {};
  if (body.llmProvider !== undefined) data.llmProvider = body.llmProvider;
  if (body.apiKey !== undefined) {
    data.apiKey = body.apiKey ? encrypt(body.apiKey) : "";
  }
  if (body.linkedinUrl !== undefined) data.linkedinUrl = body.linkedinUrl;
  if (body.githubUrl !== undefined) data.githubUrl = body.githubUrl;
  if (body.resumeText !== undefined) data.resumeText = body.resumeText;

  let settings = await prisma.settings.findFirst();

  if (!settings) {
    settings = await prisma.settings.create({
      data: { ...data, id: "singleton" },
    });
  } else {
    settings = await prisma.settings.update({
      where: { id: settings.id },
      data,
    });
  }

  return NextResponse.json({
    llmProvider: settings.llmProvider,
    hasApiKey: settings.apiKey !== "",
    linkedinUrl: settings.linkedinUrl,
    githubUrl: settings.githubUrl,
    resumeText: settings.resumeText,
  });
});
