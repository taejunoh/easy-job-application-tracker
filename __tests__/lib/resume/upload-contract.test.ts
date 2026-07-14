import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("resume upload field contract", () => {
  it("uses the resume field in both the Settings UI and multipart parser", () => {
    const page = readFileSync(
      join(process.cwd(), "src/app/settings/page.tsx"),
      "utf8",
    );
    const policy = readFileSync(
      join(process.cwd(), "src/lib/resume/upload-policy.ts"),
      "utf8",
    );

    expect(page).toMatch(
      /formData\.append\((?:RESUME_UPLOAD_FIELD|["']resume["']), file\)/u,
    );
    expect(policy).toMatch(
      /fieldName !== (?:RESUME_UPLOAD_FIELD|["']resume["'])/u,
    );
  });
});
