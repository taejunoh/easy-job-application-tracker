import { NextRequest, NextResponse } from "next/server";

import { createProtectedRoute } from "@/lib/security/protected-route";
import { RESUME_PROCESSING_DEADLINE_MS } from "@/lib/resume/constants";
import { createResumeDeadline } from "@/lib/resume/deadline";
import { parsePdfInWorker } from "@/lib/resume/pdf-worker-client";
import {
  ParseResumeError,
  parseResumeFile,
} from "@/lib/resume/parse-resume";
import {
  ResumeUploadError,
  readResumeUpload,
} from "@/lib/resume/upload-policy";

export const runtime = "nodejs";

const route = createProtectedRoute(["POST"]);

export const OPTIONS = route.OPTIONS;

export const POST = route.handler(async function POST(request: NextRequest) {
  const deadlineError = new ParseResumeError("resume_parse_failed");
  const deadline = createResumeDeadline(
    RESUME_PROCESSING_DEADLINE_MS,
    deadlineError,
  );
  try {
    const upload = await readResumeUpload(request, {
      signal: deadline.signal,
    });
    const text = await parseResumeFile(upload, parsePdfInWorker, { deadline });
    return NextResponse.json({ text });
  } catch (error) {
    if (error instanceof ResumeUploadError || error instanceof ParseResumeError) {
      return NextResponse.json(
        { error: publicErrorMessage(error.code), code: error.code },
        { status: error.status },
      );
    }
    throw error;
  } finally {
    deadline.dispose();
  }
});

function publicErrorMessage(
  code: ResumeUploadError["code"] | ParseResumeError["code"],
): string {
  switch (code) {
    case "invalid_request":
      return "Invalid request";
    case "upload_too_large":
      return "Resume upload is too large";
    case "unsupported_resume_type":
      return "Resume type is not supported";
    case "resume_parse_failed":
      return "Resume could not be parsed";
  }
}
