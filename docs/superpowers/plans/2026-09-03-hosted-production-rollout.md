# Hosted Production Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the verified repository changes, create a fresh encrypted backup, execute the production identity maintenance phases under a continuous writer stop, and verify application and extension behavior before resuming service.

**Architecture:** GitHub Actions retains database credentials and performs backup/migration/backfill. Vercel is explicitly paused across dry run, apply, gate update, and preparation of the replacement production deployment. The project resumes only when the gate-enabled deployment is ready and all offline evidence is approved.

**Tech Stack:** Git/GitHub CLI, GitHub Actions, Vercel CLI 50.40.0 and dashboard, PostgreSQL 17, age, Docker, Chrome extension.

---

### Task 1: Integrate through a reviewed pull request

**Files:** No new files; consume the committed repository-recovery and maintenance-tooling changes.

- [ ] **Step 1: Verify the branch before publishing**

```bash
git status --short --branch
git diff main...HEAD --check
git log --oneline --decorate main..HEAD
```

Expected: clean branch, no secret/generated files, and only the approved program commits.

- [ ] **Step 2: Push the branch and open a PR**

```bash
git push -u origin codex/production-recovery-2026-09-03
gh pr create \
  --base main \
  --head codex/production-recovery-2026-09-03 \
  --title "Restore production backup and identity rollout" \
  --body "Repairs the Docker pg_dump start race, clears dependency audit failures, adds guarded identity maintenance tooling, and aligns operator documentation."
```

- [ ] **Step 3: Require all PR checks**

```bash
gh pr checks --watch
```

Expected: `verify`, `backup-interruption`, and `extension-e2e` succeed. If any check fails, inspect its log, fix only the demonstrated defect on the branch, rerun local affected gates, push, and wait again.

- [ ] **Step 4: Merge without bypassing checks**

```bash
gh pr merge --merge --delete-branch
git switch main
git pull --ff-only origin main
```

Record `git rev-parse HEAD` as `ROLLOUT_SHA`; do not deploy a different commit.
Locate the new `main` push run with
`gh run list --workflow ci.yml --branch main --limit 1`, verify its head SHA is
`ROLLOUT_SHA`, and wait for that numeric run ID with `gh run watch --exit-status`
before dispatching an operations workflow.

### Task 2: Prove the hosted backup path

**Files:** Create evidence only outside the repository in a mode-0700 temporary directory.

- [ ] **Step 1: Dispatch from the exact main commit**

```bash
gh workflow run production-backup.yml --ref main
gh run list --workflow production-backup.yml --event workflow_dispatch --limit 1
```

Capture the numeric run ID shown by the second command as `BACKUP_RUN_ID` and verify its head SHA equals `ROLLOUT_SHA` with:

```bash
gh run view "$BACKUP_RUN_ID" --json headSha,status,conclusion,url
gh run watch "$BACKUP_RUN_ID" --exit-status
```

- [ ] **Step 2: Inspect the artifact without exposing secrets**

Create a private directory with `mktemp -d`, immediately `chmod 700` it, and download only `production-backup-$BACKUP_RUN_ID` using `gh run download`. Require exactly:

```text
jobtracker.dump.age
jobtracker.dump.age.sha256
backup-manifest.json
```

Run the encrypted checksum check from inside the private directory and validate with `jq` that `restoreValidated` is `true`, `format` is `PostgreSQL custom`, both SHA-256 fields are 64 lowercase hex characters, and the manifest contains no connection string or private Application fields.

- [ ] **Step 3: Perform the private recovery-key rehearsal when the documented key exists**

Require mode `0600` on:

```text
/Users/taejunoh/Library/Application Support/easy-job-application-tracker/secrets/backup.agekey
```

Decrypt to the private directory, verify the plaintext hash equals `dumpSha256`, restore into a disposable PostgreSQL 17 Docker database, run `TZ=UTC node scripts/fingerprint-database.mjs`, and compare the result with the manifest fingerprint. Remove the plaintext dump and disposable container in an unconditional cleanup. If the key is absent or has the wrong mode, stop the rollout and report the recovery-evidence gap.

### Task 3: Link and pin the Vercel project closed

**Files:** `.vercel/project.json` is local ignored state and must never be staged.

- [ ] **Step 1: Link the known project and verify identity**

```bash
vercel link --yes --team taejunohs-projects --project easy-job-application-tracker
vercel project inspect easy-job-application-tracker --scope taejunohs-projects
vercel env ls production
```

Expected: the project owns `easy-job-application-tracker.vercel.app`. Stop if the team, project, or domain differs.

- [ ] **Step 2: Explicitly set the identity gate closed and deploy `ROLLOUT_SHA`**

```bash
test "$(git rev-parse HEAD)" = "$ROLLOUT_SHA"
vercel env add APPLICATION_IDENTITY_WRITES_ENABLED production --value "0" --yes --force
vercel --prod --yes
```

Inspect the returned deployment and require Ready state plus the canonical alias. Dispatch `production-monitor.yml` and require success before pausing.

### Task 4: Maintain a continuous production writer stop

**Files:** GitHub artifacts and private operator evidence only; no repository changes.

- [ ] **Step 1: Pause the Vercel project**

Using the authenticated Vercel dashboard, select team `taejunohs-projects`, project `easy-job-application-tracker`, Settings → General → Pause Project, type the exact project name, and confirm. Verify the canonical production URL returns `503 DEPLOYMENT_PAUSED`.

Do not continue if the project cannot be paused. Do not resume until Task 6.

- [ ] **Step 2: Run prepare under the writer-stop attestation**

```bash
gh workflow run production-identity-maintenance.yml \
  --ref main \
  -f phase=prepare \
  -f writers_stopped=true
gh run list --workflow production-identity-maintenance.yml --event workflow_dispatch --limit 1
```

Capture `PREPARE_RUN_ID`, require `headSha == ROLLOUT_SHA`, and wait with `gh run watch "$PREPARE_RUN_ID" --exit-status`.

- [ ] **Step 3: Review the private dry-run evidence**

Download artifact `application-identity-prepare-$PREPARE_RUN_ID` into a mode-0700 directory outside the repository. Require schema version 1, mode `dry-run`, equal before/after counts, state totals summing to that count, a true unique-index result, opaque 64-hex row identifiers only, and no URL/title/company/body/connection values.

- [ ] **Step 4: Run apply without resuming writers**

```bash
gh workflow run production-identity-maintenance.yml \
  --ref main \
  -f phase=apply \
  -f writers_stopped=true \
  -f prepare_run_id="$PREPARE_RUN_ID"
gh run list --workflow production-identity-maintenance.yml --event workflow_dispatch --limit 1
```

Capture `APPLY_RUN_ID`, require the same head SHA, and wait for success. Download `application-identity-apply-$APPLY_RUN_ID`; require its invariant projection and opaque row plan to match the approved prepare report exactly.

### Task 5: Prepare the gate-enabled deployment while paused

**Files:** No repository changes.

- [ ] **Step 1: Set the production gate and build the same commit**

```bash
test "$(git rev-parse HEAD)" = "$ROLLOUT_SHA"
vercel env add APPLICATION_IDENTITY_WRITES_ENABLED production --value "1" --yes --force
vercel --prod --yes
```

Require the new deployment to reach Ready and become the production assignment while the project still returns `503 DEPLOYMENT_PAUSED`. If Vercel refuses deployment while paused, leave the project paused and stop; do not briefly resume the gate-0 deployment.

- [ ] **Step 2: Reconfirm offline evidence**

Require: exact `ROLLOUT_SHA`; green GitHub CI; successful verified backup; successful prepare/apply runs; matching reports; Ready gate-1 deployment; and no writer-resume action yet.

### Task 6: Resume and run production smoke checks

**Files:** No repository changes; remove smoke-created records through the supported UI/API.

- [ ] **Step 1: Resume the Vercel project**

In the same dashboard Pause Project section, select Resume Project. Poll the canonical URL until it no longer returns `DEPLOYMENT_PAUSED` and the deployment inspected in Task 5 is serving.

- [ ] **Step 2: Run automated authenticated health**

```bash
gh workflow run production-monitor.yml --ref main
gh run list --workflow production-monitor.yml --event workflow_dispatch --limit 1
```

Wait for the run and require success from `ROLLOUT_SHA`.

- [ ] **Step 3: Run authenticated Application create/read cleanup**

Use the existing authenticated browser session at the canonical origin. Create one uniquely titled smoke Application with a valid `https://example.test/...` URL, confirm it appears and reads successfully, then delete only that exact smoke record through the supported UI. If creation returns an existing record, use a new unique URL and do not delete pre-existing data.

- [ ] **Step 4: Run the production extension lifecycle**

From Settings, create a one-time pairing code for the exact installed Chrome extension origin. Pair the extension once, verify authenticated read/create behavior using a uniquely identified smoke record, revoke that installation from Settings, and require the revoked extension credential to receive `401`. Delete only the extension-created smoke record through the authenticated web UI. Confirm the one-time code cannot be replayed and no root token was stored in extension storage.

- [ ] **Step 5: Record final hosted state**

Capture the main SHA and URLs/IDs for CI, backup, prepare, apply, deployment, and final monitor. Record only counts, hashes, statuses, and sanitized artifact names. Do not copy tokens, database URLs, pairing codes, resume content, or Application fields into the repository.
