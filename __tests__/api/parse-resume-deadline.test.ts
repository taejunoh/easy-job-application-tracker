import { NextRequest } from "next/server";

import * as parseResumeRoute from "@/app/api/parse-resume/route";
import { parsePdfInWorker } from "@/lib/resume/pdf-worker-client";
import { readResumeUpload } from "@/lib/resume/upload-policy";

jest.mock("@/lib/server-env", () => {
  const actual = jest.requireActual<typeof import("@/lib/server-env")>(
    "@/lib/server-env",
  );
  const config = actual.parseServerEnv(
    {
      DATABASE_URL: "postgresql://user:password@db.example.com:5432/jobtracker",
      ENCRYPTION_SECRET: "encryption-secret-" + "e".repeat(32),
      APP_ACCESS_TOKEN: "access-token-" + "a".repeat(32),
      APP_BASE_URL: "https://jobs.example.com",
      CORS_ALLOWED_ORIGINS: "https://jobs.example.com",
    },
    "production",
  );
  return { ...actual, getServerEnv: () => config };
});

jest.mock("@/lib/resume/upload-policy", () => {
  const actual = jest.requireActual<typeof import("@/lib/resume/upload-policy")>(
    "@/lib/resume/upload-policy",
  );
  return { ...actual, readResumeUpload: jest.fn() };
});

jest.mock("@/lib/resume/pdf-worker-client", () => ({
  parsePdfInWorker: jest.fn(),
}));

jest.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: {},
  getDocument: jest.fn(() => ({
    promise: new Promise(() => undefined),
    destroy: jest.fn(() => new Promise(() => undefined)),
  })),
}));

describe("parse resume route-wide deadline", () => {
  it("shares one route-entry 15 second deadline across upload and PDF parsing", async () => {
    jest.useFakeTimers();
    let uploadSignal: AbortSignal | undefined;
    jest.mocked(readResumeUpload).mockImplementation(
      (_request, options?: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          uploadSignal = options?.signal;
          setTimeout(
            () =>
              resolve({
                filename: "resume.pdf",
                mimeType: "application/pdf",
                bytes: Buffer.from("%PDF-generated"),
              }),
            14_000,
          );
        }),
    );
    jest.mocked(parsePdfInWorker).mockImplementation((_bytes, deadline) => {
      expect(deadline.signal).toBe(uploadSignal);
      expect(deadline.remainingMs()).toBeLessThanOrEqual(1_000);
      return new Promise((_resolve, reject) => {
        deadline.signal.addEventListener(
          "abort",
          () => reject(deadline.signal.reason),
          { once: true },
        );
      });
    });

    try {
      let settled = false;
      const responsePromise = parseResumeRoute.POST(authenticatedRequest());
      void responsePromise.finally(() => {
        settled = true;
      });

      await jest.advanceTimersByTimeAsync(14_000);
      expect(parsePdfInWorker).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(true);

      const response = await responsePromise;
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toEqual({
        error: "Resume could not be parsed",
        code: "resume_parse_failed",
      });
      expect(response.headers.get("Cache-Control")).toContain("no-store");
    } finally {
      jest.useRealTimers();
    }
  });
});

function authenticatedRequest(): NextRequest {
  return new NextRequest("https://jobs.example.com/api/parse-resume", {
    method: "POST",
    headers: {
      Origin: "https://jobs.example.com",
      Authorization: `Bearer ${"access-token-" + "a".repeat(32)}`,
      "Content-Type": "multipart/form-data; boundary=x",
    },
    body: "ignored by upload mock",
  });
}
