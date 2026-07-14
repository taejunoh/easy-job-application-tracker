import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "../..");

describe("deployment verification contract", () => {
  const packageJson = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };

  it("provides deterministic typecheck, test, and extension checks", () => {
    expect(packageJson.scripts).toMatchObject({
      typecheck: "next typegen && tsc --noEmit",
      "test:ci": "jest --runInBand",
    });
    expect(packageJson.scripts?.["check:extension"]).toContain(
      "node --check extension/background.js",
    );
    expect(packageJson.scripts?.["check:extension"]).toContain(
      "extension/manifest.json",
    );
  });

  it("runs the full Node 22 and PostgreSQL deployment gate", () => {
    const workflow = readFileSync(
      join(root, ".github/workflows/ci.yml"),
      "utf8",
    );

    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("cancel-in-progress: true");
    expect(workflow).toContain("timeout-minutes: 25");
    expect(workflow).toContain("image: postgres:16-alpine");
    expect(workflow).toMatch(/node-version:\s*["']?22["']?/u);
    expect(workflow).toContain("run: npm ci");
    expect(workflow).toContain("run: npx prisma generate");
    expect(workflow).toContain("run: npx prisma validate");
    expect(workflow).toContain("run: npx prisma migrate deploy");
    expect(workflow).toContain("run: npx prisma migrate status");
    expect(workflow).toContain("npx prisma migrate diff");
    expect(workflow).toContain("run: npm run check:extension");
    expect(workflow).toContain("run: npm run test:ci");
    expect(workflow).toContain("run: npm run lint");
    expect(workflow).toContain("run: npm run typecheck");
    expect(workflow).toContain("run: npm run build");
    expect(workflow).not.toMatch(/^\s*NODE_ENV:/mu);
    expect(workflow).not.toContain("secrets.");
  });
});
