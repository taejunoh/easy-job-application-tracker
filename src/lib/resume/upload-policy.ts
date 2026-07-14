import "server-only";

import Busboy, { type BusboyFileStream } from "@fastify/busboy";

export const MAX_RESUME_BYTES = 5 * 1024 * 1024;
export const MAX_MULTIPART_BYTES = 6 * 1024 * 1024;

export type ResumeUpload = Readonly<{
  filename: string;
  mimeType: string;
  bytes: Buffer;
}>;

export type ResumeUploadErrorCode = "invalid_request" | "upload_too_large";

export class ResumeUploadError extends Error {
  readonly status: 400 | 413;

  constructor(readonly code: ResumeUploadErrorCode) {
    super(code === "upload_too_large" ? "Resume upload is too large" : "Invalid multipart upload");
    this.name = "ResumeUploadError";
    this.status = code === "upload_too_large" ? 413 : 400;
  }
}

export async function readResumeUpload(request: Request): Promise<ResumeUpload> {
  rejectDeclaredOversize(request.headers.get("content-length"));
  if (request.body === null) throw new ResumeUploadError("invalid_request");

  let parser: ReturnType<typeof Busboy>;
  try {
    const contentType = request.headers.get("content-type");
    if (contentType === null) throw new Error("Missing content type");
    parser = Busboy({
      headers: { "content-type": contentType },
      limits: {
        fields: 0,
        files: 1,
        parts: 1,
        fileSize: MAX_RESUME_BYTES + 1,
        headerPairs: 20,
        headerSize: 8 * 1024,
      },
    });
  } catch {
    throw new ResumeUploadError("invalid_request");
  }

  const reader = request.body.getReader();

  return new Promise<ResumeUpload>((resolve, reject) => {
    let settled = false;
    let totalBytes = 0;
    let fileCount = 0;
    let upload: ResumeUpload | undefined;

    const fail = (error: ResumeUploadError): void => {
      if (settled) return;
      settled = true;
      parser.destroy();
      void reader
        .cancel(error)
        .catch(() => undefined)
        .finally(() => reject(error));
    };

    parser.on(
      "file",
      (
        fieldName: string,
        file: BusboyFileStream,
        filename: string,
        _encoding: string,
        mimeType: string,
      ) => {
        fileCount += 1;
        if (fieldName !== "resume" || fileCount !== 1) {
          file.resume();
          fail(new ResumeUploadError("invalid_request"));
          return;
        }

        const chunks: Buffer[] = [];
        let fileBytes = 0;
        file.on("data", (chunk: Buffer) => {
          fileBytes += chunk.byteLength;
          if (fileBytes > MAX_RESUME_BYTES) {
            fail(new ResumeUploadError("upload_too_large"));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        file.on("limit", () => fail(new ResumeUploadError("upload_too_large")));
        file.on("error", () => fail(new ResumeUploadError("invalid_request")));
        file.on("end", () => {
          if (!settled && !file.truncated && fileBytes <= MAX_RESUME_BYTES) {
            upload = Object.freeze({
              filename,
              mimeType,
              bytes: Buffer.concat(chunks, fileBytes),
            });
          }
        });
      },
    );
    parser.on("field", () => fail(new ResumeUploadError("invalid_request")));
    parser.on("fieldsLimit", () => fail(new ResumeUploadError("invalid_request")));
    parser.on("filesLimit", () => fail(new ResumeUploadError("invalid_request")));
    parser.on("partsLimit", () => fail(new ResumeUploadError("invalid_request")));
    parser.on("error", () => fail(new ResumeUploadError("invalid_request")));
    parser.on("finish", () => {
      if (settled) return;
      if (fileCount !== 1 || upload === undefined) {
        fail(new ResumeUploadError("invalid_request"));
        return;
      }
      settled = true;
      parser.destroy();
      resolve(upload);
    });

    void (async () => {
      try {
        while (!settled) {
          const { done, value } = await reader.read();
          if (done) {
            parser.end();
            return;
          }
          totalBytes += value.byteLength;
          if (totalBytes > MAX_MULTIPART_BYTES) {
            fail(new ResumeUploadError("upload_too_large"));
            return;
          }
          if (!parser.write(Buffer.from(value))) {
            await new Promise<void>((resume) => parser.once("drain", resume));
          }
        }
      } catch {
        fail(new ResumeUploadError("invalid_request"));
      } finally {
        reader.releaseLock();
      }
    })();
  });
}

function rejectDeclaredOversize(contentLength: string | null): void {
  if (/^(?:0|[1-9][0-9]*)$/u.test(contentLength ?? "")) {
    if (BigInt(contentLength as string) > BigInt(MAX_MULTIPART_BYTES)) {
      throw new ResumeUploadError("upload_too_large");
    }
  }
}
