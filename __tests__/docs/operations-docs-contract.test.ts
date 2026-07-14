import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "../..");

describe("production operations documentation contract", () => {
  it("describes both local and hosted storage without the stale local-only claim", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");

    for (const staleText of [
      "stay on your machine",
      "SQLite",
      "better-sqlite3",
      "3001",
      "db push --force-reset",
    ]) {
      expect(readme).not.toContain(staleText);
    }
    expect(readme).toContain("PostgreSQL");
    expect(readme).toContain("Neon");
    expect(readme).toContain("Vercel");
    expect(readme).toContain("docs/operations/production-runbook.md");
  });

  it("provides the complete production runbook", () => {
    const runbook = readFileSync(
      join(root, "docs/operations/production-runbook.md"),
      "utf8",
    );

    for (const requiredText of [
      "DATABASE_URL",
      "ENCRYPTION_SECRET",
      "APP_ACCESS_TOKEN",
      "APP_BASE_URL",
      "CORS_ALLOWED_ORIGINS",
      "Chrome extension pairing",
      "Backup and restore",
      "Migration baseline",
      "Vercel logs",
      "Neon connectivity",
      "PDF worker",
      "RPO: 24 hours",
      "RTO: 30 minutes",
    ]) {
      expect(runbook).toContain(requiredText);
    }
  });

  it("distinguishes Vercel validation from self-hosted Node startup", () => {
    const documents = [
      readFileSync(join(root, "README.md"), "utf8"),
      readFileSync(
        join(root, "docs/operations/production-runbook.md"),
        "utf8",
      ),
    ].map((document) => document.replace(/\s+/gu, " "));

    for (const document of documents) {
      expect(document).toContain("Vercel Next.js preset");
      expect(document).toContain("`npm run build`");
      expect(document).toContain("`next.config.ts`");
      expect(document).toContain("build time");
      expect(document).toContain("`src/instrumentation.ts`");
      expect(document).toContain("request-serving runtime");
      expect(document).toContain("`npm start` pre-listen validation");
      expect(document).toContain("self-hosted Node only");
      expect(document).not.toContain(
        "Vercel Production must use Node 22 and run the checked-in `npm start` contract",
      );
      expect(document).not.toContain(
        "The supported server launch command is `npm start`",
      );
    }
  });

  it("records sanitized cutover and rollback evidence", () => {
    const evidence = readFileSync(
      join(root, "docs/operations/production-cutover-2026-07-14.md"),
      "utf8",
    );

    for (const requiredText of [
      "dpl_CvkRMZ6whKdVtSnRULs1Bc5e4sND",
      "81726516536de42eab9b79d3b0fd386174d1b39f",
      "dpl_4otsKDgmnQYatFYDE1je87MsvuAm",
      "d8d814866cc51d7fbcea9cbe206be33f1fff683d514134358801bf0e351f56ec",
      "153",
      "Status matrix",
    ]) {
      expect(evidence).toContain(requiredText);
    }
    expect(evidence).not.toMatch(/\/Users\/|taejunoh|Bearer\s+\S+/u);
  });
});
