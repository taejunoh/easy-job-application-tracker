import "server-only";

import Busboy, { type BusboyFileStream } from "@fastify/busboy";

import {
  MAX_MULTIPART_BYTES,
  MAX_RESUME_BYTES,
  RESUME_UPLOAD_FIELD,
} from "./constants";

export { MAX_MULTIPART_BYTES, MAX_RESUME_BYTES } from "./constants";

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

type ResumeUploadOptions = Readonly<{
  signal?: AbortSignal;
  createParser?: typeof Busboy;
}>;

export async function readResumeUpload(
  request: Request,
  options: ResumeUploadOptions = {},
): Promise<ResumeUpload> {
  rejectDeclaredOversize(request.headers.get("content-length"));
  if (request.body === null) throw new ResumeUploadError("invalid_request");

  let parser: ReturnType<typeof Busboy>;
  try {
    const contentType = request.headers.get("content-type");
    if (contentType === null) throw new Error("Missing content type");
    parser = (options.createParser ?? Busboy)({
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

    const settledController = new AbortController();
    const onAbort = (): void => {
      fail(
        options.signal?.reason instanceof Error
          ? options.signal.reason
          : new ResumeUploadError("invalid_request"),
      );
    };
    const finishSettling = (): void => {
      options.signal?.removeEventListener("abort", onAbort);
      settledController.abort();
    };
    const destroyParser = (): void => {
      try {
        parser.destroy();
      } catch {
        // Cleanup must not alter the response.
      }
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      finishSettling();
      reject(error);
      destroyParser();
      void reader.cancel(error).catch(() => undefined);
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

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
        if (fieldName !== RESUME_UPLOAD_FIELD || fileCount !== 1) {
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
      finishSettling();
      destroyParser();
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
            await waitForDrainOrSettle(parser, settledController.signal);
          }
        }
      } catch {
        fail(new ResumeUploadError("invalid_request"));
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // A noncooperative pending read may retain the lock after settlement.
        }
      }
    })();
  });
}

function waitForDrainOrSettle(
  parser: ReturnType<typeof Busboy>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const finish = (): void => {
      parser.removeListener("drain", finish);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    parser.once("drain", finish);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function rejectDeclaredOversize(contentLength: string | null): void {
  if (/^(?:0|[1-9][0-9]*)$/u.test(contentLength ?? "")) {
    if (BigInt(contentLength as string) > BigInt(MAX_MULTIPART_BYTES)) {
      throw new ResumeUploadError("upload_too_large");
    }
  }
}
