import "server-only";

import { MAX_RESUME_CODE_POINTS } from "./constants";
import type { ResumeDeadline } from "./deadline";
import type { ResumeUpload } from "./upload-policy";

export type ParseResumeErrorCode =
  | "unsupported_resume_type"
  | "resume_parse_failed";

export class ParseResumeError extends Error {
  readonly status: 415 | 422;

  constructor(readonly code: ParseResumeErrorCode) {
    super(
      code === "unsupported_resume_type"
        ? "Resume type is not supported"
        : "Resume could not be parsed",
    );
    this.name = "ParseResumeError";
    this.status = code === "unsupported_resume_type" ? 415 : 422;
  }
}

export type PdfTextParser = (
  bytes: Buffer,
  deadline: ResumeDeadline,
) => Promise<string>;

type ParseOptions = Readonly<{ deadline: ResumeDeadline }>;

export async function parseResumeFile(
  upload: ResumeUpload,
  parsePdf: PdfTextParser,
  options: ParseOptions,
): Promise<string> {
  options.deadline.signal.throwIfAborted();
  const type = classifyUpload(upload);

  if (type === "text") {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(upload.bytes);
      if (
        text.includes("\0") ||
        exceedsCodePointLimit(text, MAX_RESUME_CODE_POINTS)
      ) {
        throw new ParseResumeError("resume_parse_failed");
      }
      options.deadline.signal.throwIfAborted();
      return text.trim();
    } catch (error) {
      if (error instanceof ParseResumeError) throw error;
      if (
        options.deadline.signal.aborted &&
        options.deadline.signal.reason instanceof ParseResumeError
      ) {
        throw options.deadline.signal.reason;
      }
      throw new ParseResumeError("resume_parse_failed");
    }
  }

  try {
    const text = await parsePdf(upload.bytes, options.deadline);
    if (exceedsCodePointLimit(text, MAX_RESUME_CODE_POINTS)) {
      throw new ParseResumeError("resume_parse_failed");
    }
    return text.trim();
  } catch (error) {
    if (error instanceof ParseResumeError) throw error;
    if (
      options.deadline.signal.aborted &&
      options.deadline.signal.reason instanceof ParseResumeError
    ) {
      throw options.deadline.signal.reason;
    }
    throw new ParseResumeError("resume_parse_failed");
  }
}

function classifyUpload(upload: ResumeUpload): "pdf" | "text" {
  const filename = upload.filename.toLowerCase();
  const hasPdfSignature = upload.bytes.subarray(0, 5).equals(Buffer.from("%PDF-"));
  if (
    filename.endsWith(".pdf") &&
    upload.mimeType === "application/pdf" &&
    hasPdfSignature
  ) {
    return "pdf";
  }
  if (
    filename.endsWith(".txt") &&
    upload.mimeType === "text/plain" &&
    !hasPdfSignature
  ) {
    return "text";
  }
  throw new ParseResumeError("unsupported_resume_type");
}

function exceedsCodePointLimit(value: string, limit: number): boolean {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if ((value.codePointAt(index) as number) > 0xffff) index += 1;
    count += 1;
    if (count > limit) return true;
  }
  return false;
}
