import { EventEmitter } from "node:events";
import type { WorkerOptions } from "node:worker_threads";

import { createResumeDeadline } from "@/lib/resume/deadline";
import {
  parsePdfInWorker,
  type PdfWorkerHandle,
} from "@/lib/resume/pdf-worker-client";

describe("PDF worker client", () => {
  it("transfers one exact ArrayBuffer and accepts a bounded structured result", async () => {
    const worker = fakeWorker();
    const createWorker = jest.fn(
      (filename: string, options: WorkerOptions) => {
        void filename;
        void options;
        return worker;
      },
    );
    const deadline = createResumeDeadline(15_000, new Error("deadline"));
    const bytes = Buffer.from("%PDF-small");

    try {
      const parsing = parsePdfInWorker(bytes, deadline, { createWorker });
      worker.emit("message", { ok: true, text: "Résumé 😀" });

      await expect(parsing).resolves.toBe("Résumé 😀");
      expect(createWorker).toHaveBeenCalledTimes(1);
      const options = createWorker.mock.calls[0][1] as WorkerOptions;
      expect(options.workerData).toMatchObject({
        maxPages: 100,
        maxCodePoints: 500_000,
      });
      expect(options.workerData.bytes).toBeInstanceOf(ArrayBuffer);
      expect(options.workerData.bytes.byteLength).toBe(bytes.byteLength);
      expect(options.transferList).toEqual([options.workerData.bytes]);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    } finally {
      deadline.dispose();
    }
  });

  it("rejects immediately on deadline without awaiting terminate", async () => {
    jest.useFakeTimers();
    const reason = new Error("deadline");
    const deadline = createResumeDeadline(15_000, reason);
    const worker = fakeWorker();
    worker.terminate.mockReturnValue(new Promise<number>(() => undefined));

    try {
      const parsing = parsePdfInWorker(Buffer.from("%PDF-busy"), deadline, {
        createWorker: () => worker,
      });
      const rejection = expect(parsing).rejects.toBe(reason);

      await jest.advanceTimersByTimeAsync(15_000);

      await rejection;
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    } finally {
      deadline.dispose();
      jest.useRealTimers();
    }
  });

  it("absorbs a late worker error after success until termination completes", async () => {
    const deadline = createResumeDeadline(15_000, new Error("deadline"));
    const worker = fakeWorker();
    const termination = deferred<number>();
    worker.terminate.mockReturnValue(termination.promise);

    try {
      const parsing = parsePdfInWorker(Buffer.from("%PDF-success"), deadline, {
        createWorker: () => worker,
      });
      worker.emit("message", { ok: true, text: "parsed" });

      await expect(parsing).resolves.toBe("parsed");
      expect(worker.listenerCount("error")).toBe(1);
      expect(() => worker.emit("error", new Error("late success error"))).not.toThrow();

      termination.resolve(0);
      await termination.promise;
      await Promise.resolve();
      expect(worker.listenerCount("error")).toBe(0);
    } finally {
      deadline.dispose();
    }
  });

  it("absorbs a late worker error after failure until termination completes", async () => {
    const deadline = createResumeDeadline(15_000, new Error("deadline"));
    const worker = fakeWorker();
    const termination = deferred<number>();
    worker.terminate.mockReturnValue(termination.promise);

    try {
      const parsing = parsePdfInWorker(Buffer.from("%PDF-failure"), deadline, {
        createWorker: () => worker,
      });
      worker.emit("exit", 9);

      await expect(parsing).rejects.toThrow("resume_parse_failed");
      expect(worker.listenerCount("error")).toBe(1);
      expect(() => worker.emit("error", new Error("late failure error"))).not.toThrow();

      termination.resolve(0);
      await termination.promise;
      await Promise.resolve();
      expect(worker.listenerCount("error")).toBe(0);
    } finally {
      deadline.dispose();
    }
  });

  it.each([
    ["worker error", (worker: FakeWorker) => worker.emit("error", new Error("private detail"))],
    ["early exit", (worker: FakeWorker) => worker.emit("exit", 9)],
    ["malformed message", (worker: FakeWorker) => worker.emit("message", { text: "missing ok" })],
  ])("maps %s to a non-leaking stable failure", async (_name, fail) => {
    const deadline = createResumeDeadline(15_000, new Error("deadline"));
    const worker = fakeWorker();

    try {
      const parsing = parsePdfInWorker(Buffer.from("%PDF-bad"), deadline, {
        createWorker: () => worker,
      });
      fail(worker);

      const error = await parsing.catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("resume_parse_failed");
      expect(String(error)).not.toContain("private detail");
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    } finally {
      deadline.dispose();
    }
  });

  it("rejects a worker result above 500,000 Unicode code points", async () => {
    const deadline = createResumeDeadline(15_000, new Error("deadline"));
    const worker = fakeWorker();

    try {
      const parsing = parsePdfInWorker(Buffer.from("%PDF-large"), deadline, {
        createWorker: () => worker,
      });
      worker.emit("message", {
        ok: true,
        text: `${"a".repeat(500_000)}😀`,
      });

      await expect(parsing).rejects.toThrow("resume_parse_failed");
    } finally {
      deadline.dispose();
    }
  });

  it("refuses to transfer PDF bytes above the 5 MiB upload bound", () => {
    const deadline = createResumeDeadline(15_000, new Error("deadline"));
    const createWorker = jest.fn(() => fakeWorker());

    try {
      expect(() =>
        parsePdfInWorker(Buffer.alloc(5 * 1024 * 1024 + 1), deadline, {
          createWorker,
        }),
      ).toThrow("resume_parse_failed");
      expect(createWorker).not.toHaveBeenCalled();
    } finally {
      deadline.dispose();
    }
  });
});

type FakeWorker = PdfWorkerHandle & EventEmitter & {
  terminate: jest.Mock<Promise<number>, []>;
};

function fakeWorker(): FakeWorker {
  const worker = new EventEmitter() as FakeWorker;
  worker.terminate = jest.fn().mockResolvedValue(0);
  return worker;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}
