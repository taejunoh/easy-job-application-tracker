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
    ).replace(/\s+/gu, " ");

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
      "one-time pairing code",
      "Never paste `APP_ACCESS_TOKEN` into the extension",
    ]) {
      expect(runbook).toContain(requiredText);
    }
  });

  it("documents the maintenance-gated Application identity rollout in exact order", () => {
    const runbook = readFileSync(
      join(root, "docs/operations/production-runbook.md"),
      "utf8",
    ).replace(/\s+/gu, " ");
    const requiredSteps = [
      'APPLICATION_IDENTITY_WRITES_ENABLED="0"',
      "stop every Application writer",
      "Backup and restore",
      "npm run backfill:application-identities -- --report",
      "npm run backfill:application-identities -- --apply --writers-stopped --report",
      "rowCountBefore",
      "rowCountAfter",
      "uniqueIndexVerified",
      'APPLICATION_IDENTITY_WRITES_ENABLED="1"',
      "resume Application writers",
    ];
    let prior = -1;
    for (const text of requiredSteps) {
      const next = runbook.indexOf(text, prior + 1);
      expect(next).toBeGreaterThan(prior);
      prior = next;
    }
    expect(runbook).toContain("scratch restore");
    expect(runbook).toContain("mode `0600`");
    expect(runbook).toContain("do not enable identity writes");
  });

  it("publishes the complete quarantine operator workflow", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const runbook = readFileSync(
      join(root, "docs/operations/quarantine-runbook.md"),
      "utf8",
    );
    const normalized = runbook.replace(/\s+/gu, " ");

    expect(readme).toContain("docs/operations/quarantine-runbook.md");
    for (const requiredText of [
      "$REPO_ROOT",
      "$QUARANTINE_ROOT",
      "npm run cleanup:quarantine -- inspect",
      "npm run cleanup:quarantine -- apply",
      "npm run cleanup:quarantine -- reconcile",
      "npm run cleanup:quarantine -- recover",
      "npm run cleanup:quarantine -- mark-validated",
      "npm run cleanup:quarantine -- restore",
      "--writers-stopped",
      "schemaVersion",
      "ERR_INTEGRITY",
      "deleteAfter",
      "earliest review time",
      "flushed STARTING",
      "sole durable input",
      "git clean",
      "manual payload movement",
      "journal editing",
      "retention auto-delete",
      "No purge command",
    ]) {
      expect(normalized).toContain(requiredText);
    }
    expect(normalized).toContain(
      'any failure | `{"ok":false,"command":"...","schemaVersion":2,"code":"ERR_...","message":"..."}`',
    );

    for (const state of [
      "PREPARED",
      "MOVING",
      "VERIFYING",
      "ROLLING_BACK",
      "QUARANTINED",
      "VALIDATED",
      "RESTORE_PREPARED",
      "RESTORING",
      "RESTORE_ROLLING_BACK",
      "RESTORED",
      "ROLLED_BACK",
      "RECOVERY_REQUIRED",
      "INCOMPLETE_CONFLICT",
    ]) {
      expect(normalized).toContain(state);
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

  it("documents the isolated bundled-Chromium extension E2E contract", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const smokeRunbook = readFileSync(
      join(root, "docs/operations/chrome-extension-smoke.md"),
      "utf8",
    );
    const normalizedSmokeRunbook = smokeRunbook.replace(/\s+/gu, " ");
    const productionChromeHeading = "## Production system Chrome smoke";
    const productionChromeSectionStart = normalizedSmokeRunbook.indexOf(
      productionChromeHeading,
    );

    expect(productionChromeSectionStart).not.toBe(-1);
    const normalizedProductionChromeSmokeRunbook = normalizedSmokeRunbook.slice(
      productionChromeSectionStart,
    );

    for (const requiredText of [
      "npm run test:extension:e2e:local",
      "npm run test:extension:e2e",
      "PostgreSQL 17",
      "jobtracker_extension_e2e_test",
      "bundled Chromium",
      "docs/operations/chrome-extension-smoke.md",
    ]) {
      expect(readme).toContain(requiredText);
    }

    for (const requiredText of [
      "actual Chrome action popup",
      "https://jobs.lever.co/*",
      "removes every inherited optional host pattern",
      "chrome.developerPrivate.addHostPermission",
      "chrome.developerPrivate.openDevTools",
      "isolated temporary profile",
      "exact loopback",
      "MV3 service worker",
      "stop and restart",
      "no HAR or trace",
      "full extension reload",
      "system Chrome",
      "https://easy-job-application-tracker.vercel.app",
      "gihbagcjnmkhkekjkbfjhcbddnamaiap",
      "activeTab",
      "invalid pairing code",
      "one-time pairing code",
      "Settings → Chrome extension installations",
      "unique marker",
      "permission cleanup",
      "credential cleanup",
    ]) {
      expect(normalizedSmokeRunbook).toContain(requiredText);
    }

    for (const requiredText of [
      "The visible pairing-code input is cleared after successful pairing by design",
      "confirm no cleanup warning is shown in the popup connection-status area",
      "Reload the extension in `chrome://extensions`, return to the job tab, and click the JobTracker toolbar icon",
      "The reopened popup after reload must remain disconnected; confirm that it does",
      "The system-Chrome evidence below was observed in Chrome 150 (the verified version); do not generalize browser UI or Site access behavior to other versions without re-verification",
      "The exact runtime-requested origin may remain listed under Site access after removal in Chrome 150 (the verified version); its toggle must be off",
      "Mere list presence does not mean host access remains granted",
    ]) {
      expect(normalizedProductionChromeSmokeRunbook).toContain(requiredText);
    }
    expect(normalizedProductionChromeSmokeRunbook).not.toContain(
      "production access credential available",
    );
  });
});
