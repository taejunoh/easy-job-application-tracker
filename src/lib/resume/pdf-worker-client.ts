import "server-only";

import { join } from "node:path";
import {
  Worker,
  type WorkerOptions,
} from "node:worker_threads";

import {
  MAX_PDF_PAGES,
  MAX_RESUME_BYTES,
  MAX_RESUME_CODE_POINTS,
} from "./constants";
import type { ResumeDeadline } from "./deadline";

export type PdfWorkerHandle = {
  on(event: "message", listener: (value: unknown) => void): PdfWorkerHandle;
  on(event: "error", listener: (error: Error) => void): PdfWorkerHandle;
  on(event: "exit", listener: (code: number) => void): PdfWorkerHandle;
  removeListener(event: string, listener: (...args: never[]) => void): PdfWorkerHandle;
  terminate(): Promise<number>;
};

type PdfWorkerFactory = (
  filename: string,
  options: WorkerOptions,
) => PdfWorkerHandle;

type PdfWorkerOptions = Readonly<{
  createWorker?: PdfWorkerFactory;
  workerPath?: string;
}>;

export function parsePdfInWorker(
  bytes: Buffer,
  deadline: ResumeDeadline,
  options: PdfWorkerOptions = {},
): Promise<string> {
  deadline.signal.throwIfAborted();
  if (bytes.byteLength > MAX_RESUME_BYTES) throw stableWorkerError();

  const transferableBytes = new Uint8Array(bytes.byteLength);
  transferableBytes.set(bytes);
  const arrayBuffer = transferableBytes.buffer;
  const createWorker = options.createWorker ?? defaultWorkerFactory;
  const worker = createWorker(
    options.workerPath ??
      join(process.cwd(), "src/lib/resume/pdf-parse-worker.mjs"),
    {
      workerData: {
        bytes: arrayBuffer,
        maxPages: MAX_PDF_PAGES,
        maxCodePoints: MAX_RESUME_CODE_POINTS,
      },
      transferList: [arrayBuffer],
      // These constrain V8 heap/stack only. Native PDF/canvas allocations can
      // still raise process RSS, so production memory monitoring remains required.
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
      env: {
        NODE_ENV: process.env.NODE_ENV,
      },
      name: "resume-pdf-parser",
    },
  );

  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const onLateError = (): void => {
      // Worker termination can emit after the request result has settled.
    };
    const removeLateErrorListener = (): void => {
      worker.removeListener(
        "error",
        onLateError as (...args: never[]) => void,
      );
    };
    const terminate = (): void => {
      try {
        void worker.terminate().then(
          removeLateErrorListener,
          removeLateErrorListener,
        );
      } catch {
        // Keep the safe listener if synchronous termination failed.
      }
    };
    const cleanup = (): void => {
      deadline.signal.removeEventListener("abort", onAbort);
      worker.removeListener("message", onMessage as (...args: never[]) => void);
      worker.on("error", onLateError);
      worker.removeListener("error", onError as (...args: never[]) => void);
      worker.removeListener("exit", onExit as (...args: never[]) => void);
      terminate();
    };
    const settleFailure = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      settleFailure(
        deadline.signal.reason instanceof Error
          ? deadline.signal.reason
          : stableWorkerError(),
      );
    };
    const onMessage = (message: unknown): void => {
      if (
        typeof message !== "object" ||
        message === null ||
        Reflect.get(message, "ok") !== true ||
        typeof Reflect.get(message, "text") !== "string"
      ) {
        settleFailure(stableWorkerError());
        return;
      }
      const text = Reflect.get(message, "text") as string;
      if (exceedsCodePointLimit(text, MAX_RESUME_CODE_POINTS)) {
        settleFailure(stableWorkerError());
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      resolve(text);
    };
    const onError = (): void => settleFailure(stableWorkerError());
    const onExit = (): void => settleFailure(stableWorkerError());

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    deadline.signal.addEventListener("abort", onAbort, { once: true });
    if (deadline.signal.aborted) onAbort();
  });
}

function defaultWorkerFactory(
  filename: string,
  options: WorkerOptions,
): PdfWorkerHandle {
  return new Worker(filename, options) as PdfWorkerHandle;
}

function stableWorkerError(): Error {
  return new Error("resume_parse_failed");
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
