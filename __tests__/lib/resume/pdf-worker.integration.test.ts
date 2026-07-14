import { join } from "node:path";

import { createResumeDeadline } from "@/lib/resume/deadline";
import { parsePdfInWorker } from "@/lib/resume/pdf-worker-client";

describe("real PDF worker isolation", () => {
  it("extracts text from a generated minimal PDF", async () => {
    const deadline = createResumeDeadline(5_000, new Error("deadline"));

    try {
      await expect(
        parsePdfInWorker(generatedPdf(["Hello Resume"]), deadline),
      ).resolves.toBe("Hello Resume");
    } finally {
      deadline.dispose();
    }
  });

  it("accepts exactly 100 PDF pages", async () => {
    const deadline = createResumeDeadline(5_000, new Error("deadline"));

    try {
      const text = await parsePdfInWorker(
        generatedPdf(Array.from({ length: 100 }, (_, index) => `page-${index + 1}`)),
        deadline,
      );

      expect(text.split("\n")).toHaveLength(100);
    } finally {
      deadline.dispose();
    }
  });

  it("rejects 101 PDF pages", async () => {
    const deadline = createResumeDeadline(5_000, new Error("deadline"));

    try {
      await expect(
        parsePdfInWorker(
          generatedPdf(Array.from({ length: 101 }, () => "page")),
          deadline,
        ),
      ).rejects.toThrow("resume_parse_failed");
    } finally {
      deadline.dispose();
    }
  });

  it("accepts exactly 500,000 extracted PDF code points", async () => {
    const deadline = createResumeDeadline(5_000, new Error("deadline"));

    try {
      const text = await parsePdfInWorker(
        generatedPdf(["a".repeat(500_000)]),
        deadline,
      );

      expect(text).toHaveLength(500_000);
    } finally {
      deadline.dispose();
    }
  });

  it("rejects 500,001 extracted PDF code points", async () => {
    const deadline = createResumeDeadline(5_000, new Error("deadline"));

    try {
      await expect(
        parsePdfInWorker(generatedPdf(["a".repeat(500_001)]), deadline),
      ).rejects.toThrow("resume_parse_failed");
    } finally {
      deadline.dispose();
    }
  });

  it("terminates a synchronous busy worker at the shared deadline", async () => {
    const reason = new Error("deadline");
    const deadline = createResumeDeadline(50, reason);

    try {
      const parsing = callWithWorkerPath(
        Buffer.from("%PDF-busy"),
        deadline,
        fixturePath("busy-worker.mjs"),
      );

      await expect(parsing).rejects.toBe(reason);
    } finally {
      deadline.dispose();
    }
  });

  it.each(["error-worker.mjs", "exit-worker.mjs"])(
    "sanitizes an actual %s failure",
    async (fixture) => {
      const deadline = createResumeDeadline(5_000, new Error("deadline"));

      try {
        const error = await callWithWorkerPath(
          Buffer.from("%PDF-failure"),
          deadline,
          fixturePath(fixture),
        ).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toContain("resume_parse_failed");
        expect(String(error)).not.toContain("private worker detail");
      } finally {
        deadline.dispose();
      }
    },
  );

  it("returns a result without waiting for worker cleanup", async () => {
    const deadline = createResumeDeadline(5_000, new Error("deadline"));

    try {
      await expect(
        callWithWorkerPath(
          Buffer.from("%PDF-cleanup"),
          deadline,
          fixturePath("hanging-cleanup-worker.mjs"),
        ),
      ).resolves.toBe("finished before cleanup");
    } finally {
      deadline.dispose();
    }
  });
});

function callWithWorkerPath(
  bytes: Buffer,
  deadline: ReturnType<typeof createResumeDeadline>,
  workerPath: string,
): Promise<string> {
  return (
    parsePdfInWorker as unknown as (
      bytes: Buffer,
      deadline: ReturnType<typeof createResumeDeadline>,
      options: { workerPath: string },
    ) => Promise<string>
  )(bytes, deadline, { workerPath });
}

function fixturePath(filename: string): string {
  return join(process.cwd(), "__tests__/fixtures/resume", filename);
}

function generatedPdf(pageTexts: string[]): Buffer {
  const fontObjectNumber = 3 + pageTexts.length * 2;
  const pageObjectNumbers = pageTexts.map((_text, index) => 3 + index * 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjectNumbers
      .map((number) => `${number} 0 R`)
      .join(" ")}] /Count ${pageTexts.length} >>`,
  ];
  for (const [index, text] of pageTexts.entries()) {
    const contentObjectNumber = 4 + index * 2;
    const pageWidth = Math.max(612, text.length * 2);
    const content = `BT /F1 1 Tf 0 720 Td (${escapePdfString(text)}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} 792] /Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    );
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += `${offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
    .join("\n")}\n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function escapePdfString(value: string): string {
  return value.replace(/[\\()]/gu, (character) => `\\${character}`);
}
