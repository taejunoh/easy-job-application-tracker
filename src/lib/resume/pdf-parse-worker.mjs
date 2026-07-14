import { parentPort, workerData } from "node:worker_threads";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const FAILURE = Object.freeze({ ok: false, code: "resume_parse_failed" });

let loadingTask;
let document;

try {
  const { bytes, maxPages, maxCodePoints } = readWorkerData(workerData);
  loadingTask = getDocument({
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
    stopAtErrors: true,
    maxImageSize: 16 * 1024 * 1024,
    canvasMaxAreaInBytes: 64 * 1024 * 1024,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    enableXfa: false,
  });
  document = await loadingTask.promise;
  if (!Number.isInteger(document.numPages) || document.numPages > maxPages) {
    throw new Error("page limit");
  }

  const pages = [];
  let codePoints = 0;
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const fragments = content.items.map((item) =>
      typeof item === "object" &&
      item !== null &&
      typeof item.str === "string"
        ? item.str
        : "",
    );
    for (const fragment of fragments) {
      codePoints += countCodePoints(fragment);
      if (codePoints > maxCodePoints) throw new Error("text limit");
    }
    if (fragments.length > 1) {
      codePoints += fragments.length - 1;
    }
    if (pageNumber > 1) codePoints += 1;
    if (codePoints > maxCodePoints) throw new Error("text limit");
    pages.push(fragments.join(" "));
  }

  parentPort.postMessage({ ok: true, text: pages.join("\n").trim() });
} catch {
  parentPort?.postMessage(FAILURE);
} finally {
  try {
    const cleanup = document?.destroy() ?? loadingTask?.destroy();
    void Promise.resolve(cleanup).catch(() => undefined);
  } catch {
    // The parent owns hard termination and stable error handling.
  }
}

function readWorkerData(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    !(value.bytes instanceof ArrayBuffer) ||
    value.bytes.byteLength > 5 * 1024 * 1024 ||
    !Number.isInteger(value.maxPages) ||
    value.maxPages < 1 ||
    value.maxPages > 100 ||
    !Number.isInteger(value.maxCodePoints) ||
    value.maxCodePoints < 1 ||
    value.maxCodePoints > 500_000 ||
    parentPort === null
  ) {
    throw new Error("invalid worker data");
  }
  return value;
}

function countCodePoints(value) {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.codePointAt(index) > 0xffff) index += 1;
    count += 1;
  }
  return count;
}
