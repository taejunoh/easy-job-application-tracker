import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("PDF worker deployment trace", () => {
  it("forces the route worker, PDF.js modules, and native canvas assets into output tracing", () => {
    const config = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");

    expect(config).toContain('"/api/parse-resume"');
    expect(config).toContain("src/lib/resume/pdf-parse-worker.mjs");
    expect(config).toContain("node_modules/pdfjs-dist/package.json");
    expect(config).toContain("node_modules/pdfjs-dist/legacy/build/pdf.mjs");
    expect(config).toContain("node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs");
    expect(config).toContain("node_modules/@napi-rs/canvas*/**/*");
  });
});
