const MAX_RESUME_BYTES = 5 * 1024 * 1024;
const MAX_PDF_PAGES = 100;
const MAX_RESUME_CODE_POINTS = 1_000_000;
const MAX_RESUME_PROCESSING_DEADLINE_MS = 15_000;

export const RESUME_FILE_ACCEPT = ".txt,.pdf,text/plain,application/pdf";

class ResumeFileError extends Error {}

export async function readResumeFile(file) {
  const name = file.name.toLowerCase();
  const isPdf = name.endsWith(".pdf");
  if (!isPdf && !name.endsWith(".txt")) {
    throw new ResumeFileError("Choose a TXT or PDF file.");
  }
  if (file.size > MAX_RESUME_BYTES) {
    throw new ResumeFileError("Choose a file no larger than 5 MB.");
  }

  const text = (await (isPdf ? readPdf(file) : readText(file))).trim();
  if (!text) {
    throw new ResumeFileError(
      isPdf ? "This PDF has no selectable text. Paste your resume text or choose a TXT file." : "This TXT file is empty.",
    );
  }
  return requireValidLength(text);
}

function requireValidLength(text) {
  if (text.length > MAX_RESUME_CODE_POINTS && Array.from(text).length > MAX_RESUME_CODE_POINTS) {
    throw new ResumeFileError(`Resume text must be ${MAX_RESUME_CODE_POINTS.toLocaleString("en-US")} characters or fewer.`);
  }
  return text;
}

async function readText(file) {
  try {
    const data = await file.arrayBuffer();
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new ResumeFileError("Choose a UTF-8 TXT file or paste your resume text.");
  }
}

async function readPdf(file) {
  let task;
  let timeout;
  try {
    const [pdf, worker, data] = await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
      file.arrayBuffer(),
    ]);
    pdf.GlobalWorkerOptions.workerSrc = worker.default;
    const assets = new URL(`${import.meta.env.BASE_URL}pdf-assets/`, document.baseURI);
    task = pdf.getDocument({
      data,
      cMapUrl: new URL("cmaps/", assets).href,
      cMapPacked: true,
      iccUrl: new URL("iccs/", assets).href,
      standardFontDataUrl: new URL("standard_fonts/", assets).href,
      wasmUrl: new URL("wasm/", assets).href,
      enableXfa: false,
    });

    return await Promise.race([
      extractPdfText(task),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new ResumeFileError("PDF extraction timed out. Paste your resume text or choose a TXT file."));
        }, MAX_RESUME_PROCESSING_DEADLINE_MS);
      }),
    ]);
  } catch (error) {
    if (error instanceof ResumeFileError) throw error;
    if (error?.name === "PasswordException") {
      throw new ResumeFileError("Choose an unlocked PDF or paste your resume text.");
    }
    throw new ResumeFileError("Couldn't read this PDF. Paste your resume text or choose a TXT file.");
  } finally {
    clearTimeout(timeout);
    if (task) void task.destroy().catch(() => undefined);
  }
}

async function extractPdfText(task) {
  const document = await task.promise;
  if (document.numPages > MAX_PDF_PAGES) {
    throw new ResumeFileError(`Choose a PDF with ${MAX_PDF_PAGES} pages or fewer.`);
  }

  const parts = [];
  let characters = 0;
  for (let number = 1; number <= document.numPages; number += 1) {
    const page = await document.getPage(number);
    const reader = page.streamTextContent().getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        for (const item of chunk.value.items) {
          if (!("str" in item)) continue;
          const part = item.str + (item.hasEOL ? "\n" : " ");
          characters += Array.from(part).length;
          if (characters > MAX_RESUME_CODE_POINTS) {
            throw new ResumeFileError("Resume text must be 1,000,000 characters or fewer.");
          }
          parts.push(part);
        }
      }
      parts.push("\n");
      characters += 1;
    } finally {
      reader.releaseLock();
    }
  }
  return parts.join("");
}
