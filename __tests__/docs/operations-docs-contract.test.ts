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

  it("keeps Application identity writes closed by default", () => {
    const envExample = readFileSync(join(root, ".env.example"), "utf8");

    expect(envExample.match(/^APPLICATION_IDENTITY_WRITES_ENABLED="0"$/gmu)).toEqual([
      'APPLICATION_IDENTITY_WRITES_ENABLED="0"',
    ]);
    expect(envExample.match(/^APPLICATION_WRITES_ENABLED="0"$/gmu)).toEqual([
      'APPLICATION_WRITES_ENABLED="0"',
    ]);
    expect(envExample).toMatch(
      /APPLICATION_IDENTITY_WRITES_ENABLED="0"\nAPPLICATION_WRITES_ENABLED="0"/u,
    );
  });

  it("documents the closed application-write gate", () => {
    const documents = [
      readFileSync(join(root, "README.md"), "utf8"),
      readFileSync(join(root, "docs/operations/production-runbook.md"), "utf8"),
    ].map((document) => document.replace(/\s+/gu, " "));

    for (const document of documents) {
      expect(document).toContain("APPLICATION_WRITES_ENABLED");
      expect(document).toMatch(/server-only/iu);
      expect(document).toMatch(/accepts only [^\n]*0[^\n]*1/iu);
      expect(document).toMatch(/missing[^\n]*defaults?[^\n]*closed/iu);
      expect(document).toMatch(/invalid[^\n]*(?:blank|whitespace|true)/iu);
      expect(document).toMatch(/Production[^\n]*set[^\n]*explicit/iu);
    }
    const readme = documents[0];
    expect(readme).toMatch(/normal local\/CI[^\n]*["`]1["`]/iu);
    expect(readme).toMatch(/maintenance[^\n]*["`]0["`]/iu);
    expect(readme).toMatch(/identity[^\n]*distinct|distinction[^\n]*identity/iu);
  });

  it("requires the staged two-gate hosted rollout and rejects the paused-build path", () => {
    const documents = [
      readFileSync(join(root, "README.md"), "utf8"),
      readFileSync(join(root, "docs/operations/production-runbook.md"), "utf8"),
      readFileSync(
        join(root, "docs/superpowers/plans/2026-09-03-hosted-production-rollout.md"),
        "utf8",
      ),
    ].map((document) => document.replace(/\s+/gu, " "));

    for (const document of documents) {
      for (const requiredText of [
        "identity=0,writes=1",
        "identity=1,writes=0",
        "identity=1,writes=1",
        "Ready",
        "exact intended Git SHA",
        "no canonical alias",
        "2 × maxDuration",
        "at least 60 seconds",
        "authenticated negative probe",
        "503 DEPLOYMENT_PAUSED",
        "prepare",
        "review",
        "apply",
        "recorded same",
        "without redeploying",
        "smoke",
        "cleanup",
        "rollback target",
        "writes_stopped",
      ]) {
        expect(document).toContain(requiredText);
      }
      expect(document).toMatch(/external writers (?:are|were) resumed last|resume external writers last/iu);
      expect(document).toMatch(/no build or promotion (?:while paused|occurred while paused)/iu);
      expect(document).toMatch(
        /promote(?: the)? (?:candidate|it) while unpaused|promote only while unpaused|promotion occurred only while unpaused/iu,
      );
      expect(document).not.toMatch(
        /(?:build|deploy|deployment|promotion)[^.]{0,100}(?:while|remains) Vercel (?:was|remains) paused/iu,
      );
    }

    const runbook = documents[1];
    expect(runbook).toContain("vercel --prod --skip-domain");
    expect(runbook).toContain(
      '{ "error": "Application writes are temporarily disabled", "code": "writes_stopped", "retryable": true }',
    );
    for (const header of [
      "Cache-Control: private, no-store",
      "Pragma: no-cache",
      "Retry-After: 60",
    ]) {
      expect(runbook).toContain(header);
    }
    for (const mutation of [
      "Application POST/PATCH/DELETE",
      "Settings PUT",
      "pairing creation",
      "valid pair exchange",
      "installation deletion",
      "self-revoke",
      "Settings GET does not create a row",
      "lastUsedAt/updatedAt",
    ]) {
      expect(runbook).toContain(mutation);
    }
    expect(runbook).toMatch(/mode-0700|mode `0700`/iu);
    expect(runbook).toMatch(/sanitized counts\/hashes/iu);
    expect(runbook).toMatch(/if (?:DB|the database) apply occurred[^.]{0,140}identity-unaware/iu);
    const plan = readFileSync(
      join(root, "docs/superpowers/plans/2026-09-03-hosted-production-rollout.md"),
      "utf8",
    );
    expect(plan).toMatch(/SUPERSEDED[^.]{0,100}(?:unsuccessful|unsuccessfully)/iu);
  });

  it("documents the maintenance-gated Application identity rollout", () => {
    const runbook = readFileSync(
      join(root, "docs/operations/production-runbook.md"),
      "utf8",
    ).replace(/\s+/gu, " ");
    for (const requiredText of [
      'APPLICATION_IDENTITY_WRITES_ENABLED="0"',
      "stop every Application writer",
      "Backup and restore",
      "rowCountBefore",
      "rowCountAfter",
      "uniqueIndexVerified",
      'APPLICATION_IDENTITY_WRITES_ENABLED="1"',
      "resume Application writers",
    ]) {
      expect(runbook).toContain(requiredText);
    }
    expect(runbook).toContain("scratch restore");
    expect(runbook).toContain("mode `0600`");
    expect(runbook).toMatch(/do not enable identity writes/iu);
  });

  it("publishes the guarded Production identity maintenance operator workflow", () => {
    const documents = [
      readFileSync(join(root, "README.md"), "utf8"),
      readFileSync(
        join(root, "docs/operations/production-runbook.md"),
        "utf8",
      ),
    ].map((document) => document.replace(/\s+/gu, " "));
    const prepareDispatch =
      "gh workflow run production-identity-maintenance.yml --ref main -f phase=prepare -f writers_stopped=true";
    const applyDispatch =
      'gh workflow run production-identity-maintenance.yml --ref main -f phase=apply -f writers_stopped=true -f prepare_run_id="$PREPARE_RUN_ID"';

    for (const document of documents) {
      expect(document).toContain("Production identity maintenance");
      expect(document).toContain("writers_stopped=true");
      expect(document).toContain("prepare_run_id");
      expect(document).toMatch(
        /writers (?:remain|remained) stopped continuously|keep writers stopped continuously/iu,
      );
      expect(document).toMatch(
        /failure[^.]{0,160}writers remain stopped|failure[^.]{0,160}keep writers stopped/iu,
      );
      expect(document).toMatch(
        /do not (?:run|use)[^.]{0,160}(?:prisma db push|prisma db reset|destructive)/iu,
      );
    }
    const runbook = documents[1];
    expect(runbook).toContain(prepareDispatch);
    expect(runbook).toContain(applyDispatch);
  });

  it("keeps identity maintenance in the exact safe operator sequence", () => {
    const runbook = readFileSync(
      join(root, "docs/operations/production-runbook.md"),
      "utf8",
    ).replace(/\s+/gu, " ");
    for (const requiredText of [
      "verified backup prerequisite",
      "APPLICATION_IDENTITY_WRITES_ENABLED",
      "APPLICATION_WRITES_ENABLED",
      "pause Vercel",
      "production-identity-maintenance.yml",
      "rowCountBefore",
      "rowCountAfter",
      "uniqueIndexVerified",
      "APPLICATION_IDENTITY_WRITES_ENABLED",
      "resume Application writers",
    ]) {
      expect(runbook).toContain(requiredText);
    }
    expect(runbook).toContain("scratch restore");
    expect(runbook).toContain("mode-`0700`");
    expect(runbook).toMatch(/do not enable identity writes/iu);
  });

  it("requires the hosted identity rollout to stay paused until every smoke check passes", () => {
    const runbook = readFileSync(
      join(root, "docs/operations/production-runbook.md"),
      "utf8",
    );
    const sectionStart = runbook.indexOf(
      "## Application identity maintenance rollout",
    );
    const sectionEnd = runbook.indexOf("## Backup and restore", sectionStart);
    expect(sectionStart).not.toBe(-1);
    expect(sectionEnd).toBeGreaterThan(sectionStart);
    const section = runbook.slice(sectionStart, sectionEnd).replace(/\s+/gu, " ");
    const prepareDispatch =
      "gh workflow run production-identity-maintenance.yml --ref main -f phase=prepare -f writers_stopped=true";
    const applyDispatch =
      'gh workflow run production-identity-maintenance.yml --ref main -f phase=apply -f writers_stopped=true -f prepare_run_id="$PREPARE_RUN_ID"';
    const orderedRequirements = [
      "verified backup prerequisite",
      "identity=0,writes=1",
      "identity=1,writes=0",
      "promote the candidate while unpaused",
      "2 × maxDuration",
      "authenticated negative probe",
      "pause Vercel",
      "503 DEPLOYMENT_PAUSED",
      "no build or promotion while paused",
      prepareDispatch,
      "capture numeric PREPARE_RUN_ID",
      "headSha equals TARGET_SHA",
      'gh run watch "$PREPARE_RUN_ID" --exit-status',
      'gh run download "$PREPARE_RUN_ID" --repo "$GITHUB_REPOSITORY" --name "application-identity-prepare-$PREPARE_RUN_ID"',
      'node scripts/compare-application-identity-reports.mjs --expected "$PREPARE_REPORT" --actual "$PREPARE_REPORT" --actual-mode dry-run',
      "review the prepare report",
      applyDispatch,
      "capture numeric APPLY_RUN_ID",
      "verify apply run headSha equals TARGET_SHA",
      'gh run watch "$APPLY_RUN_ID" --exit-status',
      'gh run download "$APPLY_RUN_ID" --repo "$GITHUB_REPOSITORY" --name "application-identity-apply-$APPLY_RUN_ID"',
      'node scripts/compare-application-identity-reports.mjs --expected "$PREPARE_REPORT" --actual "$APPLY_REPORT" --actual-mode apply',
      "compare the approved prepare report with the apply report",
      "resume Vercel Production",
      "resume the recorded same",
      "without redeploying",
      "identity=1,writes=1",
      "vercel --prod --skip-domain",
      "no canonical alias",
      "production monitor",
      "authenticated UI create/read/delete cleanup",
      "extension pairing/exchange/create",
      "revoke the ExtensionInstallation",
      "replay rejection and 401",
      "resume Application writers LAST",
    ];
    let prior = -1;
    for (const requirement of orderedRequirements) {
      const next = section.toLowerCase().indexOf(requirement.toLowerCase(), prior + 1);
      expect(next).toBeGreaterThan(prior);
      prior = next;
    }
    expect(section).toMatch(
      /writers remain stopped continuously until every post-resume smoke pass succeeds/iu,
    );
    expect(section).not.toMatch(
      /npm run backfill:application-identities[^.]{0,160}(?:DRY_RUN_REPORT|APPLY_REPORT)/iu,
    );
    expect(section).not.toMatch(
      /authenticated checks[^.]{0,100}(?:while|with) Vercel remains paused/iu,
    );
  });

  it("keeps the README concise and free of an unbound apply run ID", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");

    expect(readme).toMatch(/capture\s+and\s+wait\s+for\s+numeric\s+`?PREPARE_RUN_ID`?/iu);
    expect(readme).not.toContain(
      'gh workflow run production-identity-maintenance.yml --ref main -f phase=apply -f writers_stopped=true -f prepare_run_id="$PREPARE_RUN_ID"',
    );
  });

  it("constrains post-resume smoke writes and preserves hosted state on abort", () => {
    const runbook = readFileSync(
      join(root, "docs/operations/production-runbook.md"),
      "utf8",
    );
    const sectionStart = runbook.indexOf(
      "## Application identity maintenance rollout",
    );
    const sectionEnd = runbook.indexOf("## Backup and restore", sectionStart);
    expect(sectionStart).not.toBe(-1);
    expect(sectionEnd).toBeGreaterThan(sectionStart);
    const section = runbook.slice(sectionStart, sectionEnd).replace(/\s+/gu, " ");
    const orderedRequirements = [
      "resume Vercel Production",
      "ordinary, automated, and background Application writers remain stopped",
      "only one explicitly authorized bounded smoke actor/session at a time",
      "unique smoke rows",
      "immediate cleanup",
      "general Application writer resume is last",
    ];
    let prior = -1;
    for (const requirement of orderedRequirements) {
      const next = section.toLowerCase().indexOf(requirement.toLowerCase(), prior + 1);
      expect(next).toBeGreaterThan(prior);
      prior = next;
    }

    const abortStart = section.indexOf("Abort behavior");
    expect(abortStart).not.toBe(-1);
    const abort = section.slice(abortStart);
    expect(abort).toMatch(
      /preserve the actual current gate and deployment state/iu,
    );
    expect(abort).toMatch(
      /do not change either[^.]{0,120}absent a reviewed hosted rollback/iu,
    );
    expect(abort).not.toMatch(/keep the gate at `?0`?/iu);
  });

  it("anchors both hosted workflow phases to the fetched main commit", () => {
    const runbook = readFileSync(
      join(root, "docs/operations/production-runbook.md"),
      "utf8",
    );
    const sectionStart = runbook.indexOf(
      "## Application identity maintenance rollout",
    );
    const sectionEnd = runbook.indexOf("## Backup and restore", sectionStart);
    expect(sectionStart).not.toBe(-1);
    expect(sectionEnd).toBeGreaterThan(sectionStart);
    const section = runbook.slice(sectionStart, sectionEnd).replace(/\s+/gu, " ");

    expect(section).toContain("git fetch origin main --prune");
    expect(section).toMatch(/TARGET_SHA=.*git rev-parse origin\/main/iu);
    expect(section).toContain(
      "both manual workflow dispatches below use `--ref main`",
    );
    expect(section).not.toMatch(/TARGET_SHA=.*git rev-parse HEAD/iu);

    for (const phase of ["PREPARE", "APPLY"]) {
      const captureStart = section.indexOf(`${phase}_RUN_ID=""`);
      const captureEnd = section.indexOf(`${phase}_METADATA`, captureStart);
      expect(captureStart).not.toBe(-1);
      expect(captureEnd).toBeGreaterThan(captureStart);
      const capture = section.slice(captureStart, captureEnd);
      expect(capture).toContain(
        "gh run list --workflow production-identity-maintenance.yml --branch main",
      );
      expect(capture).toContain("headSha");
      expect(capture).toContain("$TARGET_SHA");
    }
  });

  it("links the hosted rollout to an executable revoke and replay smoke lifecycle", () => {
    const runbook = readFileSync(
      join(root, "docs/operations/production-runbook.md"),
      "utf8",
    );
    const smokeRunbook = readFileSync(
      join(root, "docs/operations/chrome-extension-smoke.md"),
      "utf8",
    );
    const sectionStart = runbook.indexOf(
      "## Application identity maintenance rollout",
    );
    const sectionEnd = runbook.indexOf("## Backup and restore", sectionStart);
    const section = runbook.slice(sectionStart, sectionEnd).replace(/\s+/gu, " ");
    const smokeStart = smokeRunbook.indexOf("## Production system Chrome smoke");
    const smoke = smokeRunbook.slice(smokeStart).replace(/\s+/gu, " ");

    expect(section).toContain(
      "chrome-extension-smoke.md#revocation-and-consumed-code-replay-lifecycle",
    );
    for (const requirement of [
      "keep the paired popup/session available",
      "revoke the exact smoke installation",
      "server-side",
      "authenticated request",
      "401",
      "local credential cleanup",
      "disconnected and credential-free",
      "original extension popup",
      "extension origin exactly equals the original approved origin",
      "already-consumed one-time code",
      "Do not expose or log the code",
      "unique smoke row",
      "unique smoke installation",
    ]) {
      expect(smoke.toLowerCase()).toContain(requirement.toLowerCase());
    }
    expect(smoke).toMatch(/authenticated[^.]{0,120}Settings/iu);

    const orderedRequirements = [
      "keep the paired popup/session available",
      "revoke the exact smoke installation",
      "authenticated request",
      "401",
      "local credential cleanup",
      "disconnected and credential-free",
      "original extension popup",
      "extension origin exactly equals the original approved origin",
      "already-consumed one-time code",
      "unique smoke row",
      "unique smoke installation",
    ];
    let prior = -1;
    for (const requirement of orderedRequirements) {
      const next = smoke.toLowerCase().indexOf(requirement.toLowerCase(), prior + 1);
      expect(next).toBeGreaterThan(prior);
      prior = next;
    }
    expect(smoke).not.toMatch(/separate fresh installation\/profile\/context/iu);
    expect(smoke).toMatch(
      /do not reinstall\/load another copy[^.]{0,160}(?:changes|change) the extension ID/iu,
    );
    expect(smoke).toMatch(
      /second context[^.]{0,220}exact same extension origin[^.]{0,220}origin mismatch is invalid evidence/iu,
    );
    expect(smoke).toMatch(/do not expose or log the (?:exact )?code/iu);
    expect(smoke).toMatch(/do not use \*{0,2}Disconnect\*{0,2} as proof/iu);
  });

  it("capitalizes the identity-write abort instruction", () => {
    const runbook = readFileSync(
      join(root, "docs/operations/production-runbook.md"),
      "utf8",
    );

    expect(runbook).not.toContain("continuously; do not enable identity writes");
    expect(runbook).toContain("continuously. Do not enable identity writes");
  });

  it("keeps the rollout design aligned with the authoritative hosted runbook", () => {
    const design = readFileSync(
      join(
        root,
        "docs/superpowers/specs/2026-09-03-production-recovery-and-identity-rollout-design.md",
      ),
      "utf8",
    );
    const phaseStart = design.indexOf("## Phase 4: Production identity maintenance workflow");
    const phaseEnd = design.indexOf("## Phase 5: Extension and documentation closure", phaseStart);
    expect(phaseStart).not.toBe(-1);
    expect(phaseEnd).toBeGreaterThan(phaseStart);
    const phase = design.slice(phaseStart, phaseEnd).replace(/\s+/gu, " ");

    expect(design).toMatch(/SUPERSEDED/iu);
    expect(design).toContain(
      "2026-09-04-production-write-stop-rollout-design.md",
    );
    expect(phase).toContain(
      "This is a design-level summary, not the executable operator procedure.",
    );
    expect(phase).toContain("production operations runbook");
    expect(phase).toContain("is authoritative for the exact hosted commands and order");
    const orderedRequirements = [
      "identity=0,writes=1",
      "identity=1,writes=0",
      "vercel --prod --skip-domain",
      "Ready",
      "exact intended Git SHA",
      "no canonical alias",
      "promote the candidate while unpaused",
      "2 × maxDuration",
      "authenticated negative probe",
      "pause Vercel",
      "503 DEPLOYMENT_PAUSED",
      "prepare",
      "review",
      "apply",
      "no build or promotion while paused",
      "resume the recorded same",
      "without redeploying",
      "identity=1,writes=1",
      "promote only while unpaused",
      "production monitor",
      "smoke",
      "one explicitly authorized bounded smoke actor/session at a time",
      "Complete bounded cleanup",
      "external writers are resumed last",
    ];
    let prior = -1;
    for (const requirement of orderedRequirements) {
      const next = phase.toLowerCase().indexOf(requirement.toLowerCase(), prior + 1);
      expect(next).toBeGreaterThan(prior);
      prior = next;
    }
    expect(phase).toMatch(
      /ordinary, automated, and background(?: Application)? writers remain stopped/iu,
    );
    expect(phase).toMatch(/preserve the actual current gate and deployment state/iu);
    expect(phase).toMatch(
      /do not force[^.]{0,160}(?:gate|APPLICATION_IDENTITY_WRITES_ENABLED)[^.]{0,160}absent a reviewed hosted rollback/iu,
    );
    expect(phase).not.toMatch(
      /pause Vercel Production[^.]{0,120}(?:first|before)[^.]{0,100}stop ordinary/iu,
    );
    expect(phase).not.toMatch(
      /keep Vercel Production paused continuously through[^.]{0,220}(?:gate|deployment)[^.]{0,120}Ready/iu,
    );
    expect(phase).not.toMatch(
      /(?:build|deploy|deployment|promotion)[^.]{0,120}(?:while|remains) Vercel (?:was|remains) paused/iu,
    );
    expect(phase).not.toMatch(/keep the write gate at `?0`?/iu);
    expect(phase).not.toMatch(/resume the Vercel project only after every check passes/iu);

    const errorStart = design.indexOf("## Error handling and rollback");
    const errorEnd = design.indexOf("## Success criteria", errorStart);
    expect(errorStart).not.toBe(-1);
    expect(errorEnd).toBeGreaterThan(errorStart);
    const errors = design.slice(errorStart, errorEnd).replace(/\s+/gu, " ");
    expect(errors).not.toMatch(/production service available only if identity verification itself passed/iu);
    expect(errors).toMatch(
      /extension smoke failure[^.]{0,240}keep all ordinary, automated, background, and Application writers stopped[^.]{0,240}pause Vercel again before any further hosted change[^.]{0,240}preserve the actual current gate and deployment state/iu,
    );
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
