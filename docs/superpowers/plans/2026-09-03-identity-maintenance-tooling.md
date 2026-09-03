# Identity Maintenance Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fail-closed manual GitHub workflow that runs the existing identity migration and backfill while writers remain stopped and proves apply evidence matches an approved dry run.

**Architecture:** A repository script compares privacy-safe reports without database access. A manual two-phase workflow uses the existing production DB secret: `prepare` deploys additive migrations and creates a dry-run artifact; `apply` validates the approved prepare run, rechecks the current dry-run, performs the backfill, and compares the apply report before any writer resumes.

**Tech Stack:** GitHub Actions workflow dispatch, Node.js 22.22.2, Prisma 7.9.1, PostgreSQL, Jest, YAML contract tests.

---

### Task 1: Add the report comparison boundary

**Files:**
- Create: `scripts/compare-application-identity-reports.mjs`
- Create: `__tests__/scripts/compare-application-identity-reports.test.ts`

- [ ] **Step 1: Write failing behavior tests**

The production break these tests catch is accepting a different row plan or count between approved dry run and apply. Run the real CLI against mode-0600 temporary JSON files. Cover:

```ts
it.each(["dry-run", "apply"])("accepts an identical %s report", async (actualMode) => {
  const expected = report("dry-run");
  const actual = report(actualMode);
  expect(await runComparator(expected, actual, actualMode)).toMatchObject({
    code: 0,
    stdout: "Application identity reports match.\n",
    stderr: "",
  });
});

it.each([
  ["row count", { rowCountAfter: 5 }],
  ["state totals", { stateTotals: { canonical: 1, legacy_duplicate: 0, legacy_unresolved: 3 } }],
  ["unique index", { uniqueIndexVerified: false }],
  ["row assignments", { rows: [{ rowIdHash: "b".repeat(64), state: "canonical" }] }],
])("rejects changed %s", async (_name, change) => {
  expect(await runComparator(report("dry-run"), { ...report("apply"), ...change }, "apply"))
    .toMatchObject({ code: 1, stdout: "", stderr: "Application identity report comparison failed.\n" });
});
```

Also reject missing files, malformed JSON, wrong schema version, an expected report whose mode is not `dry-run`, an actual mode not equal to the required CLI argument, extra raw-content keys, duplicate flags, relative paths, and an unknown flag.

- [ ] **Step 2: Verify RED**

```bash
npm test -- --runInBand __tests__/scripts/compare-application-identity-reports.test.ts
```

Expected: FAIL because the comparator does not exist.

- [ ] **Step 3: Implement the minimal comparator**

Create a CLI accepting exactly:

```text
node scripts/compare-application-identity-reports.mjs \
  --expected /absolute/dry-run.json \
  --actual /absolute/current.json \
  --actual-mode dry-run|apply
```

Parse both files, validate the exact privacy-safe report shape already emitted by `createPrivacySafeReport`, and compare this literal projection:

```js
function invariant(report) {
  return {
    schemaVersion: report.schemaVersion,
    rowCountBefore: report.rowCountBefore,
    rowCountAfter: report.rowCountAfter,
    stateTotals: report.stateTotals,
    uniqueIndexVerified: report.uniqueIndexVerified,
    rows: report.rows,
  };
}
```

Require expected mode `dry-run`, actual mode equal to `--actual-mode`, equal canonical JSON projections, equal before/after row counts within each report, totals summing to the row count, `uniqueIndexVerified === true`, and only known report/row keys. Print no report content on failure.

- [ ] **Step 4: Run GREEN and commit**

```bash
npm test -- --runInBand __tests__/scripts/compare-application-identity-reports.test.ts __tests__/scripts/backfill-application-identities.test.ts
git add scripts/compare-application-identity-reports.mjs __tests__/scripts/compare-application-identity-reports.test.ts
git commit -m "feat: compare identity rollout evidence"
```

### Task 2: Specify the workflow contract first

**Files:**
- Create: `__tests__/ci/production-identity-maintenance-workflow-contract.test.ts`

- [ ] **Step 1: Add the failing parsed-YAML contract**

Parse `.github/workflows/production-identity-maintenance.yml` with `yaml` and assert:

```ts
expect(workflow.on).toEqual({
  workflow_dispatch: {
    inputs: {
      phase: {
        description: "Identity maintenance phase",
        required: true,
        type: "choice",
        options: ["prepare", "apply"],
      },
      writers_stopped: {
        description: "Attest that every Application writer is stopped",
        required: true,
        type: "boolean",
        default: false,
      },
      prepare_run_id: {
        description: "Approved prepare workflow run ID; required for apply",
        required: false,
        type: "string",
        default: "",
      },
    },
  },
});
expect(workflow.permissions).toEqual({ actions: "read", contents: "read" });
expect(workflow.concurrency).toEqual({
  group: "production-identity-maintenance",
  "cancel-in-progress": false,
});
```

Assert Node `22.22.2`, pinned checkout/setup/upload actions, `npm ci`, Prisma migration deploy/status/diff, `DATABASE_URL: ${{ secrets.PRODUCTION_DATABASE_URL }}`, branch and attestation guards, prepare artifact retention of seven days, apply-run metadata validation, both pre-apply and post-apply comparisons, and `if: always()` cleanup. Assert there is no schedule/push/pull_request trigger, database URL echo, `prisma db push/reset`, SQL delete/drop, or unencrypted raw Application data artifact.

- [ ] **Step 2: Verify RED**

```bash
npm test -- --runInBand __tests__/ci/production-identity-maintenance-workflow-contract.test.ts
```

Expected: FAIL because the workflow is absent.

- [ ] **Step 3: Commit the RED contract**

```bash
git add __tests__/ci/production-identity-maintenance-workflow-contract.test.ts
git commit -m "test: specify production identity maintenance"
```

### Task 3: Implement the fail-closed manual workflow

**Files:**
- Create: `.github/workflows/production-identity-maintenance.yml`
- Test: `__tests__/ci/production-identity-maintenance-workflow-contract.test.ts`

- [ ] **Step 1: Create the workflow skeleton**

Use this top-level contract:

```yaml
name: Production identity maintenance

on:
  workflow_dispatch:
    inputs:
      phase:
        description: Identity maintenance phase
        required: true
        type: choice
        options: [prepare, apply]
      writers_stopped:
        description: Attest that every Application writer is stopped
        required: true
        type: boolean
        default: false
      prepare_run_id:
        description: Approved prepare workflow run ID; required for apply
        required: false
        type: string
        default: ""

permissions:
  actions: read
  contents: read

concurrency:
  group: production-identity-maintenance
  cancel-in-progress: false
```

Add one `maintain` job on `ubuntu-latest`, `timeout-minutes: 15`, with `DATABASE_URL` from `secrets.PRODUCTION_DATABASE_URL`. Pin action SHAs to the same reviewed checkout/setup-node/upload-artifact SHAs used by production backup.

- [ ] **Step 2: Add exact fail-closed guards**

The first shell step receives `PHASE`, `WRITERS_STOPPED`, `PREPARE_RUN_ID`, `CURRENT_REF`, and validates:

```bash
set -euo pipefail
test "$CURRENT_REF" = "refs/heads/main"
test "$WRITERS_STOPPED" = "true"
case "$PHASE" in
  prepare) test -z "$PREPARE_RUN_ID" ;;
  apply) [[ "$PREPARE_RUN_ID" =~ ^[1-9][0-9]*$ ]] ;;
  *) exit 1 ;;
esac
```

- [ ] **Step 3: Add migration and prepare behavior**

After `npm ci`, run:

```bash
npx prisma migrate deploy
npx prisma migrate status
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
```

For `prepare`, set `umask 077`, run the existing backfill without `--apply`, validate the report by comparing it to itself in `dry-run` mode, and upload only that report as `application-identity-prepare-${{ github.run_id }}` with seven-day retention.

- [ ] **Step 4: Add apply provenance and comparison behavior**

For `apply`, use `GH_TOKEN: ${{ github.token }}` and validate the approved run before download:

```bash
metadata="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$PREPARE_RUN_ID")"
test "$(jq -r .conclusion <<<"$metadata")" = "success"
test "$(jq -r .event <<<"$metadata")" = "workflow_dispatch"
test "$(jq -r .head_branch <<<"$metadata")" = "main"
test "$(jq -r .head_sha <<<"$metadata")" = "$GITHUB_SHA"
test "$(jq -r .path <<<"$metadata")" = ".github/workflows/production-identity-maintenance.yml"
gh run download "$PREPARE_RUN_ID" \
  --repo "$GITHUB_REPOSITORY" \
  --name "application-identity-prepare-$PREPARE_RUN_ID" \
  --dir "$RUNNER_TEMP/approved"
```

Create a new current dry run, compare it to the approved report with `--actual-mode dry-run`, apply with `--apply --writers-stopped`, then compare the apply report with `--actual-mode apply`. Upload only the apply report as `application-identity-apply-${{ github.run_id }}`.

- [ ] **Step 5: Add unconditional cleanup**

Remove approved, current-dry-run, and apply report paths under `$RUNNER_TEMP` in a final `if: always()` step. Do not print their contents.

- [ ] **Step 6: Run GREEN and commit**

```bash
npm test -- --runInBand __tests__/ci/production-identity-maintenance-workflow-contract.test.ts __tests__/scripts/compare-application-identity-reports.test.ts
git add .github/workflows/production-identity-maintenance.yml __tests__/ci/production-identity-maintenance-workflow-contract.test.ts
git commit -m "ci: add guarded identity maintenance workflow"
```

### Task 4: Align operator documentation

**Files:**
- Modify: `docs/operations/production-runbook.md`
- Modify: `README.md`
- Modify: `__tests__/docs/operations-docs-contract.test.ts`

- [ ] **Step 1: Add failing docs-contract expectations**

Require both phase dispatch commands and continuous writer stop:

```ts
expect(runbook).toContain("Production identity maintenance");
expect(runbook).toContain("prepare_run_id");
expect(runbook).toContain("writers remain stopped");
expect(runbook).toContain("gh workflow run production-identity-maintenance.yml");
```

- [ ] **Step 2: Verify RED**

```bash
npm test -- --runInBand __tests__/docs/operations-docs-contract.test.ts
```

- [ ] **Step 3: Document the exact operator sequence**

Document: verified backup prerequisite; gate `0`; Vercel pause; `prepare` dispatch with `writers_stopped=true`; report download/review; `apply` dispatch with the numeric prepare run ID; apply report review; gate `1`; same-commit deploy; authenticated checks; resume. State that any failure leaves writers stopped and forbids destructive Prisma commands.

- [ ] **Step 4: Run GREEN and commit**

```bash
npm test -- --runInBand __tests__/docs/operations-docs-contract.test.ts __tests__/ci/production-identity-maintenance-workflow-contract.test.ts
git add README.md docs/operations/production-runbook.md __tests__/docs/operations-docs-contract.test.ts
git commit -m "docs: publish identity maintenance workflow"
```

### Task 5: Verify maintenance tooling

**Files:** None unless a focused failure exposes an in-scope defect.

- [ ] **Step 1: Run focused and full gates**

```bash
npm ci
npm run check:audit
npx prisma generate
npx prisma validate
npm test -- --runInBand __tests__/scripts/backfill-application-identities.test.ts __tests__/api/deployment.integration.test.ts __tests__/scripts/compare-application-identity-reports.test.ts __tests__/ci/production-identity-maintenance-workflow-contract.test.ts __tests__/docs/operations-docs-contract.test.ts
npm run test:ci
npm run lint -- --max-warnings=0
npm run typecheck
npm run build
git diff --check
```

Expected: all commands exit zero and no report, credential, `.env`, or Vercel link file is staged.
