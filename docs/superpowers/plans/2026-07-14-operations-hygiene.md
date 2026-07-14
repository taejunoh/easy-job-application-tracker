# Operations and Repository Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add recoverability and uptime signals, align runtime versions, remove stale guidance and warnings, and remediate dependency findings without unsafe version regressions.

**Architecture:** Use encrypted nightly logical backups with restore validation, an authenticated scheduled `/api/stats` monitor instead of a new public health endpoint, pinned Node/runtime configuration, and selective dependency updates guarded by existing and new contract tests.

**Tech Stack:** GitHub Actions, PostgreSQL, age encryption, Node.js 22, Jest, ESLint, npm audit, Vercel, Neon.

---

### Task 1: Pin Node 22 across development and CI

**Files:**
- Create: `.nvmrc`
- Create: `.node-version`
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Add a failing runtime contract test**

Extend `__tests__/ci/workflow-contract.test.ts` to read `.nvmrc`, `.node-version`, `package.json`, and CI YAML, expecting `22.22.2` and `engines.node` equal to `>=22.22.2 <23`. Run the test and observe missing-file failure.

- [ ] **Step 2: Add the pins**

Write `22.22.2` to both version files and add:

```json
"engines": {
  "node": ">=22.22.2 <23"
}
```

- [ ] **Step 3: Verify on Node 22**

Run `npm ci`, the contract test, and `npm run build` under Node 22.22.2. Commit as `chore: pin Node 22 runtime`.

### Task 2: Remove lint warnings

**Files:**
- Modify: `__tests__/lib/extract/llm-provider.test.ts`
- Modify: `extension/content.js`
- Modify: `scripts/screenshots.mjs`

- [ ] **Step 1: Capture the warning baseline**

Run `npm run lint` and record the four current warnings.

- [ ] **Step 2: Apply mechanical cleanup**

Remove the unused `LLMProvider` import, delete unused `_debug`, and change both unused `catch (err)` bindings to `catch`.

- [ ] **Step 3: Verify**

Run `npm run lint`, `npm run check:extension`, `node --check scripts/screenshots.mjs`, and the provider Jest test. Expected: zero warnings/errors. Commit as `chore: clear lint warnings`.

### Task 3: Update operational documentation

**Files:**
- Modify: `handover.md`
- Modify: `README.md`
- Create: `docs/operations/production-runbook.md`

- [ ] **Step 1: Define stale-content checks**

Run searches for `SQLite`, `better-sqlite3`, port `3001`, `db push --force-reset`, and unconditional “data stays on your machine.” Preserve the failing output as the red evidence.

- [ ] **Step 2: Rewrite the handover and README wording**

Document PostgreSQL/Neon, five required environment variables, authenticated web and extension pairing, migration baseline rules, startup validation, CI destructive guards, backup/restore, port 3000, and local-versus-hosted data ownership.

- [ ] **Step 3: Add the production runbook**

Include deployment inspection, authenticated stats checks, Vercel 5xx logs, Neon connectivity, PDF worker symptoms, backup download/decrypt/restore rehearsal, RPO 24h, RTO 30m, and escalation/rollback order.

- [ ] **Step 4: Verify and commit**

Repeat stale-content searches, validate every command against package scripts, run `git diff --check`, and commit as `docs: refresh production operations guidance`.

### Task 4: Upgrade dependencies selectively

**Files:**
- Modify: `__tests__/lib/extract/llm-provider.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `docs/security/dependency-audit-2026-07-14.md`

- [ ] **Step 1: Add the Anthropic contract test and observe RED if behavior differs**

Assert that the provider calls `messages.create` with the configured model, a text user message, and expected token limit, then extracts the first text block and rejects a non-text response. Run only this test before changing dependencies.

- [ ] **Step 2: Upgrade supported direct packages**

Upgrade Anthropic SDK to at least `0.91.1`, keep all Prisma packages aligned on the same 7.x release, and update root PostCSS to a fixed release. Use non-force lockfile remediation only; never accept npm's Prisma 6.x or Next 9.x downgrade proposals.

- [ ] **Step 3: Run package-specific verification**

Run provider tests, `prisma validate`, `prisma generate`, `prisma migrate status`, schema diff, full tests, typecheck, and build.

- [ ] **Step 4: Document remaining advisories**

Run `npm audit --json` and `npm audit --omit=dev --json`. Document upstream-pinned Next/Prisma findings, affected paths, runtime reachability, and follow-up version conditions. Require high/critical count zero.

- [ ] **Step 5: Commit**

Commit as `chore: update supported dependencies` after `npm ci` reproduces the lockfile cleanly.

### Task 5: Add encrypted nightly backup with restore validation

**Files:**
- Create: `.github/workflows/production-backup.yml`
- Modify: `__tests__/ci/workflow-contract.test.ts`
- Modify: `docs/operations/production-runbook.md`

- [ ] **Step 1: Write the failing workflow contract**

Require a daily cron, PostgreSQL 17 scratch service, `pg_dump -Fc`, `pg_restore --exit-on-error`, source/restore count comparison, age public-key encryption, plaintext deletion, pinned artifact upload, 30-day retention, and no pull-request trigger. Run the contract test and observe the missing-workflow failure.

- [ ] **Step 2: Implement the workflow**

Use repository secret `PRODUCTION_DATABASE_URL` and repository variable `BACKUP_AGE_RECIPIENT`. Upload only `*.dump.age`, checksum, and a sanitized manifest with `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02`.

- [ ] **Step 3: Generate and store the recovery key**

Generate an age identity locally under `~/Library/Application Support/easy-job-application-tracker/secrets/backup.agekey` with mode `0600`; place only its public recipient in GitHub. Add the production database URL through `gh secret set` using stdin.

- [ ] **Step 4: Test manually**

Dispatch the workflow, download the encrypted artifact, decrypt locally, restore to a scratch PostgreSQL database, and compare counts/fingerprint. Commit as `ci: add encrypted production backups`.

### Task 6: Add an authenticated uptime monitor

**Files:**
- Create: `.github/workflows/production-monitor.yml`
- Modify: `__tests__/ci/workflow-contract.test.ts`
- Modify: `docs/operations/production-runbook.md`

- [ ] **Step 1: Write the failing monitor contract**

Require hourly and manual triggers, a five-minute timeout, canonical origin from repository variable `PRODUCTION_APP_URL`, bearer token from secret `PRODUCTION_APP_ACCESS_TOKEN`, `/api/stats` status 200, JSON shape checks, and no response-body logging.

- [ ] **Step 2: Implement and configure**

Create the workflow with bounded curl timeouts and masked headers. Set the URL variable and token secret via `gh variable set` and `gh secret set` using stdin.

- [ ] **Step 3: Verify alert behavior safely**

Dispatch once with the correct token and require success. Temporarily replace the repository secret with a known invalid value, dispatch and require failure, then restore the correct value and require success. Commit as `ci: monitor authenticated production health`.

### Task 7: Run the complete repository gate

**Files:**
- Verify all modified files

- [ ] **Step 1: Run all local gates**

```bash
npm ci
npm run check:extension
npm run test:ci -- --silent
npm run lint
npm run typecheck
npm run build
npm run check:startup-env
npx prisma validate
npx prisma generate
npx prisma migrate status
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
npm audit --omit=dev
```

- [ ] **Step 2: Verify repository state**

Run `git diff --check`, secret scanning, and `git status --short`. Require no generated artifacts or secret files.
