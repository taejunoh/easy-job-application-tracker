import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";
import { createProtectedRoute } from "@/lib/security/protected-route";
import { applicationWriteGuard } from "@/lib/security/application-writes";
import {
  InvalidRequestError,
  MAX_SETTINGS_BODY_BYTES,
  RequestBodyTooLargeError,
  readBoundedJsonBody,
} from "@/lib/security/request-body";
import { MAX_RESUME_CODE_POINTS } from "@/lib/resume/constants";

export const maxDuration = 30;

const route = createProtectedRoute(["GET", "PUT"], {
  writeMethods: ["PUT"],
});

export const OPTIONS = route.OPTIONS;

export const GET = route.handler(async function GET(request: NextRequest) {
  const settings = await prisma.settings.findFirst();

  const { searchParams } = new URL(request.url);
  const includeResume = searchParams.get("includeResume") === "true";

  const response: Record<string, unknown> = {
    llmProvider: settings?.llmProvider ?? "openai",
    hasApiKey: Boolean(settings?.apiKey),
    linkedinUrl: settings?.linkedinUrl ?? "",
    githubUrl: settings?.githubUrl ?? "",
  };

  if (includeResume) {
    response.resumeText = settings?.resumeText ?? "";
  }

  return NextResponse.json(response);
});

export const PUT = route.handler(async function PUT(request: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await readBoundedJsonBody(request, MAX_SETTINGS_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json(
        { error: "Request too large", code: "request_too_large" },
        { status: 413 },
      );
    }
    throw new InvalidRequestError();
  }
  if (
    typeof rawBody !== "object" ||
    rawBody === null ||
    Array.isArray(rawBody)
  ) {
    throw new InvalidRequestError();
  }
  const body = rawBody as Record<string, unknown>;

  const data: Record<string, string> = {};
  if (body.llmProvider !== undefined) {
    if (typeof body.llmProvider !== "string") throw new InvalidRequestError();
    data.llmProvider = body.llmProvider;
  }
  if (body.apiKey !== undefined) {
    if (typeof body.apiKey !== "string") throw new InvalidRequestError();
    data.apiKey = body.apiKey ? encrypt(body.apiKey) : "";
  }
  if (body.linkedinUrl !== undefined) {
    if (typeof body.linkedinUrl !== "string") throw new InvalidRequestError();
    data.linkedinUrl = body.linkedinUrl;
  }
  if (body.githubUrl !== undefined) {
    if (typeof body.githubUrl !== "string") throw new InvalidRequestError();
    data.githubUrl = body.githubUrl;
  }
  if (body.resumeText !== undefined) {
    if (
      typeof body.resumeText !== "string" ||
      exceedsCodePointLimit(body.resumeText, MAX_RESUME_CODE_POINTS)
    ) {
      throw new InvalidRequestError();
    }
    data.resumeText = body.resumeText;
  }

  const stopped = applicationWriteGuard();
  if (stopped) return stopped;
  const settings = await prisma.settings.upsert({
    where: { id: "singleton" },
    create: { ...data, id: "singleton" },
    update: data,
  });

  return NextResponse.json({
    llmProvider: settings.llmProvider,
    hasApiKey: settings.apiKey !== "",
    linkedinUrl: settings.linkedinUrl,
    githubUrl: settings.githubUrl,
    resumeText: settings.resumeText,
  });
});

function exceedsCodePointLimit(value: string, limit: number): boolean {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if ((value.codePointAt(index) as number) > 0xffff) index += 1;
    count += 1;
    if (count > limit) return true;
  }
  return false;
}
