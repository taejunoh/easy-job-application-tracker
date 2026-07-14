import {
  MAX_RESUME_CODE_POINTS,
} from "@/lib/resume/constants";
import { createResumeDeadline } from "@/lib/resume/deadline";
import type { ResumeDeadline } from "@/lib/resume/deadline";
import {
  ParseResumeError,
  parseResumeFile,
  type PdfTextParser,
} from "@/lib/resume/parse-resume";
import type { ResumeUpload } from "@/lib/resume/upload-policy";

describe("resume file parsing policy", () => {
  it("decodes valid UTF-8 plain text", async () => {
    await expect(parse(textUpload("Résumé 😀"))).resolves.toBe("Résumé 😀");
  });

  it.each([
    ["PDF extension with text MIME", upload("resume.pdf", "text/plain", "%PDF-x")],
    ["PDF MIME with text extension", upload("resume.txt", "application/pdf", "%PDF-x")],
    ["PDF metadata without signature", upload("resume.pdf", "application/pdf", "hello")],
    ["text metadata with PDF signature", upload("resume.txt", "text/plain", "%PDF-x")],
    ["unsupported extension", upload("resume.doc", "text/plain", "hello")],
    ["unsupported MIME", upload("resume.txt", "application/octet-stream", "hello")],
  ])("rejects %s with 415", async (_name, file) => {
    await expect(parse(file)).rejects.toMatchObject({
      name: "ParseResumeError",
      code: "unsupported_resume_type",
      status: 415,
    });
  });

  it.each([
    ["invalid UTF-8", Buffer.from([0xc3, 0x28])],
    ["a NUL byte", Buffer.from("hello\0world")],
  ])("rejects text containing %s", async (_name, bytes) => {
    await expect(
      parse({ filename: "resume.txt", mimeType: "text/plain", bytes }),
    ).rejects.toMatchObject({ code: "resume_parse_failed", status: 422 });
  });

  it("allows exactly 500,000 Unicode code points", async () => {
    const text = `${"a".repeat(MAX_RESUME_CODE_POINTS - 1)}😀`;

    const result = await parse(textUpload(text));

    expect(Array.from(result)).toHaveLength(MAX_RESUME_CODE_POINTS);
  });

  it("rejects 500,001 Unicode code points", async () => {
    const text = `${"a".repeat(MAX_RESUME_CODE_POINTS)}😀`;

    await expect(parse(textUpload(text))).rejects.toMatchObject({
      code: "resume_parse_failed",
      status: 422,
    });
  });

  it("passes PDF bytes and the same deadline to the isolated parser", async () => {
    const deadline = createResumeDeadline(15_000, parseFailure());
    const parser = jest.fn(
      async (_bytes: Buffer, receivedDeadline: ResumeDeadline) => {
        expect(receivedDeadline).toBe(deadline);
        return "pdf text";
      },
    );

    try {
      await expect(
        parseResumeFile(pdfUpload(), parser, { deadline }),
      ).resolves.toBe("pdf text");
      expect(parser).toHaveBeenCalledWith(pdfUpload().bytes, deadline);
    } finally {
      deadline.dispose();
    }
  });

  it("maps isolated parser details to the stable 422 error", async () => {
    const parser: PdfTextParser = jest
      .fn(async () => "")
      .mockRejectedValue(new Error("private parser detail"));

    const error = await parse(pdfUpload(), parser).catch(
      (reason: unknown) => reason,
    );

    expect(error).toMatchObject({
      name: "ParseResumeError",
      code: "resume_parse_failed",
      status: 422,
    });
    expect(String(error)).not.toContain("private parser detail");
  });

  it("honors a deadline that expired during upload before parsing text", async () => {
    const reason = parseFailure();
    const controller = new AbortController();
    controller.abort(reason);
    const deadline = {
      expiresAt: 0,
      signal: controller.signal,
      remainingMs: () => 0,
      dispose: () => undefined,
    };

    await expect(
      parseResumeFile(textUpload("hello"), unusedPdfParser, { deadline }),
    ).rejects.toBe(reason);
  });

  it("exposes only stable error metadata", () => {
    expect(parseFailure()).toMatchObject({
      name: "ParseResumeError",
      code: "resume_parse_failed",
      status: 422,
    });
  });
});

const unusedPdfParser: PdfTextParser = async () => {
  throw new Error("PDF parser should not be called");
};

async function parse(
  file: ResumeUpload,
  parser: PdfTextParser = unusedPdfParser,
): Promise<string> {
  const deadline = createResumeDeadline(15_000, parseFailure());
  try {
    return await parseResumeFile(file, parser, { deadline });
  } finally {
    deadline.dispose();
  }
}

function parseFailure(): ParseResumeError {
  return new ParseResumeError("resume_parse_failed");
}

function upload(filename: string, mimeType: string, contents: string): ResumeUpload {
  return { filename, mimeType, bytes: Buffer.from(contents) };
}

function textUpload(contents: string): ResumeUpload {
  return upload("resume.txt", "text/plain", contents);
}

function pdfUpload(): ResumeUpload {
  return upload("resume.pdf", "application/pdf", "%PDF-1.7");
}
