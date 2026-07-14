import {
  MAX_PDF_PAGES,
  MAX_RESUME_CODE_POINTS,
  ParseResumeError,
  parseResumeFile,
  type PdfLoadingTask,
} from "@/lib/resume/parse-resume";
import type { ResumeUpload } from "@/lib/resume/upload-policy";

describe("resume file parsing policy", () => {
  it("decodes valid UTF-8 plain text", async () => {
    await expect(
      parseResumeFile(textUpload("Résumé 😀"), unusedPdfLoader),
    ).resolves.toBe("Résumé 😀");
  });

  it.each([
    ["PDF extension with text MIME", upload("resume.pdf", "text/plain", "%PDF-x")],
    ["PDF MIME with text extension", upload("resume.txt", "application/pdf", "%PDF-x")],
    ["PDF metadata without signature", upload("resume.pdf", "application/pdf", "hello")],
    ["text metadata with PDF signature", upload("resume.txt", "text/plain", "%PDF-x")],
    ["unsupported extension", upload("resume.doc", "text/plain", "hello")],
    ["unsupported MIME", upload("resume.txt", "application/octet-stream", "hello")],
  ])("rejects %s with 415", async (_name, file) => {
    await expect(parseResumeFile(file, unusedPdfLoader)).rejects.toMatchObject({
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
      parseResumeFile(
        { filename: "resume.txt", mimeType: "text/plain", bytes },
        unusedPdfLoader,
      ),
    ).rejects.toMatchObject({ code: "resume_parse_failed", status: 422 });
  });

  it("allows exactly 500,000 Unicode code points", async () => {
    const text = `${"a".repeat(MAX_RESUME_CODE_POINTS - 1)}😀`;

    const result = await parseResumeFile(textUpload(text), unusedPdfLoader);

    expect(Array.from(result)).toHaveLength(MAX_RESUME_CODE_POINTS);
  });

  it("rejects 500,001 Unicode code points", async () => {
    const text = `${"a".repeat(MAX_RESUME_CODE_POINTS)}😀`;

    await expect(
      parseResumeFile(textUpload(text), unusedPdfLoader),
    ).rejects.toMatchObject({ code: "resume_parse_failed", status: 422 });
  });

  it("extracts 100 PDF pages and destroys the document", async () => {
    const document = fakeDocument(MAX_PDF_PAGES);
    const loadingTask = resolvedLoadingTask(document);

    const result = await parseResumeFile(pdfUpload(), () => loadingTask);

    expect(result.split("\n")).toHaveLength(MAX_PDF_PAGES);
    expect(document.destroy).toHaveBeenCalledTimes(1);
  });

  it("rejects 101 PDF pages and destroys the document before reading pages", async () => {
    const document = fakeDocument(MAX_PDF_PAGES + 1);

    await expect(
      parseResumeFile(pdfUpload(), () => resolvedLoadingTask(document)),
    ).rejects.toMatchObject({ code: "resume_parse_failed", status: 422 });
    expect(document.getPage).not.toHaveBeenCalled();
    expect(document.destroy).toHaveBeenCalledTimes(1);
  });

  it("maps corrupt PDF loading to 422 and destroys the loading task", async () => {
    const loadingTask: PdfLoadingTask = {
      promise: Promise.reject(new Error("corrupt details")),
      destroy: jest.fn().mockResolvedValue(undefined),
    };

    await expect(parseResumeFile(pdfUpload(), () => loadingTask)).rejects.toEqual(
      expect.objectContaining({ code: "resume_parse_failed", status: 422 }),
    );
    expect(loadingTask.destroy).toHaveBeenCalledTimes(1);
  });

  it("enforces a deadline while PDF loading is pending and destroys the task", async () => {
    jest.useFakeTimers();
    const loadingTask: PdfLoadingTask = {
      promise: new Promise(() => undefined),
      destroy: jest.fn().mockResolvedValue(undefined),
    };

    try {
      const parsing = parseResumeFile(pdfUpload(), () => loadingTask, {
        deadlineMs: 15_000,
      });
      const rejection = expect(parsing).rejects.toMatchObject({
        code: "resume_parse_failed",
        status: 422,
      });
      await jest.advanceTimersByTimeAsync(15_001);

      await rejection;
      expect(loadingTask.destroy).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("destroys the PDF document when page extraction fails", async () => {
    const document = fakeDocument(1);
    document.getPage.mockRejectedValueOnce(new Error("page failure"));

    await expect(
      parseResumeFile(pdfUpload(), () => resolvedLoadingTask(document)),
    ).rejects.toMatchObject({ code: "resume_parse_failed", status: 422 });
    expect(document.destroy).toHaveBeenCalledTimes(1);
  });

  it("exposes only stable error metadata", () => {
    expect(new ParseResumeError("resume_parse_failed")).toMatchObject({
      name: "ParseResumeError",
      code: "resume_parse_failed",
      status: 422,
    });
  });
});

const unusedPdfLoader = () => {
  throw new Error("PDF loader should not be called");
};

function upload(filename: string, mimeType: string, contents: string): ResumeUpload {
  return { filename, mimeType, bytes: Buffer.from(contents) };
}

function textUpload(contents: string): ResumeUpload {
  return upload("resume.txt", "text/plain", contents);
}

function pdfUpload(): ResumeUpload {
  return upload("resume.pdf", "application/pdf", "%PDF-1.7");
}

function fakeDocument(numPages: number) {
  return {
    numPages,
    getPage: jest.fn(async (pageNumber: number) => ({
      getTextContent: jest.fn().mockResolvedValue({
        items: [{ str: `page ${pageNumber}` }],
      }),
    })),
    destroy: jest.fn().mockResolvedValue(undefined),
  };
}

function resolvedLoadingTask(
  document: ReturnType<typeof fakeDocument>,
): PdfLoadingTask {
  return {
    promise: Promise.resolve(document),
    destroy: jest.fn().mockResolvedValue(undefined),
  };
}
