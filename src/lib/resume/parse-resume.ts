import "server-only";

import type { ResumeUpload } from "./upload-policy";

export const MAX_PDF_PAGES = 100;
export const MAX_RESUME_CODE_POINTS = 500_000;
export const RESUME_PARSE_DEADLINE_MS = 15_000;

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

export type PdfDocument = {
  numPages: number;
  getPage(pageNumber: number): Promise<{
    getTextContent(): Promise<{ items: unknown[] }>;
  }>;
  destroy(): Promise<void>;
};

export type PdfLoadingTask = {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
};

export type PdfLoader = (bytes: Uint8Array) => PdfLoadingTask;

type ParseOptions = Readonly<{ deadlineMs?: number }>;

export async function parseResumeFile(
  upload: ResumeUpload,
  loadPdf: PdfLoader,
  options: ParseOptions = {},
): Promise<string> {
  const deadlineMs = options.deadlineMs ?? RESUME_PARSE_DEADLINE_MS;
  const type = classifyUpload(upload);

  if (type === "text") {
    const startedAt = Date.now();
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(upload.bytes);
      if (
        text.includes("\0") ||
        countCodePoints(text) > MAX_RESUME_CODE_POINTS ||
        Date.now() - startedAt >= deadlineMs
      ) {
        throw new ParseResumeError("resume_parse_failed");
      }
      return text.trim();
    } catch (error) {
      if (error instanceof ParseResumeError) throw error;
      throw new ParseResumeError("resume_parse_failed");
    }
  }

  return parsePdf(upload.bytes, loadPdf, deadlineMs);
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

async function parsePdf(
  bytes: Buffer,
  loadPdf: PdfLoader,
  deadlineMs: number,
): Promise<string> {
  let loadingTask: PdfLoadingTask | undefined;
  let document: PdfDocument | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    loadingTask = loadPdf(new Uint8Array(bytes));
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new ParseResumeError("resume_parse_failed")),
        deadlineMs,
      );
    });
    document = await Promise.race([loadingTask.promise, deadline]);
    if (document.numPages > MAX_PDF_PAGES) {
      throw new ParseResumeError("resume_parse_failed");
    }

    const pages: string[] = [];
    let codePoints = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await Promise.race([document.getPage(pageNumber), deadline]);
      const content = await Promise.race([page.getTextContent(), deadline]);
      const pageText = content.items
        .map((item) =>
          typeof item === "object" &&
          item !== null &&
          "str" in item &&
          typeof item.str === "string"
            ? item.str
            : "",
        )
        .join(" ");
      codePoints += countCodePoints(pageText);
      if (pageNumber > 1) codePoints += 1;
      if (codePoints > MAX_RESUME_CODE_POINTS) {
        throw new ParseResumeError("resume_parse_failed");
      }
      pages.push(pageText);
    }
    return pages.join("\n").trim();
  } catch (error) {
    if (error instanceof ParseResumeError) throw error;
    throw new ParseResumeError("resume_parse_failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      if (document !== undefined) await document.destroy();
      else if (loadingTask !== undefined) await loadingTask.destroy();
    } catch {
      // Cleanup failures must not change the stable parsing result.
    }
  }
}

function countCodePoints(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if ((value.codePointAt(index) as number) > 0xffff) index += 1;
    count += 1;
  }
  return count;
}
