# Hosted Production Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the verified repository changes, create a fresh encrypted backup, execute the production identity maintenance phases under a continuous writer stop, and verify application and extension behavior before resuming service.

**Architecture:** GitHub Actions retains database credentials and performs backup/migration/backfill. Vercel is unpaused for builds and promotions. Vercel is paused only across prepare/apply, where the platform `503 DEPLOYMENT_PAUSED` protects the database mutation window. There is no build or promotion while paused.

**Tech Stack:** Git/GitHub CLI, GitHub Actions, Vercel CLI 50.40.0 and dashboard, PostgreSQL 17, age, Docker, Chrome extension.

> **Historical/superseded implementation plan.** This document preserves the
> earlier hosted rollout record and design-level evidence requirements. It is
> not executable operator guidance; the [production operations
> runbook](../../operations/production-runbook.md#application-identity-maintenance-rollout)
> is the sole source of executable commands and ordering.

The Settings singleton is created only on the first successful PUT /api/settings;
an authenticated GET /api/settings is read-only and does not create the row. See
the [production operations runbook](../../operations/production-runbook.md#application-identity-maintenance-rollout)
for the authoritative candidate, rollback, fixture-ledger, and cleanup procedure.

### Rollout state and evidence summary

The retained state/evidence summary is: after database apply, the rollout is
`PAUSED_AFTER_APPLY`; failed or ambiguous evidence enters `HOLD_PAUSED`, where
there is no build, deploy, alias assignment, or promotion. Approved evidence
resumes the exact recorded `identity=1,writes=0` Ready deployment as
`UNPAUSED_READONLY` for read-only and authenticated negative probes. A regression
requires an exact Ready candidate ID and reviewed SHA or returns to
`HOLD_PAUSED`. The private ledger retains exact owned IDs until bounded cleanup
is verified and cleanup may remove only those IDs.

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

### Task 3: Link Vercel and promote the read-only candidate

**Files:** `.vercel/project.json` is local ignored state and must never be staged.

Historical correction: the prior paused-build sequence is **SUPERSEDED and
unsuccessful**. It is not rollout evidence. Do not recreate that sequence or
invent deployment IDs.

- [ ] **Step 1: Link the known project and verify identity**

The authoritative runbook's Vercel project-link and identity checks must confirm
that the project owns `easy-job-application-tracker.vercel.app`; stop if the
team, project, or domain differs.

For evidence terminology, the staged Production candidate is built through the
runbook's `vercel --prod --skip-domain` procedure and must reach `Ready` with
the exact intended Git SHA and no canonical alias before promotion.

- [ ] **Step 2: Establish the `identity=0,writes=1` Ready canonical support deployment**

Require a Ready deployment serving the canonical alias with both gate values
`identity=0,writes=1`. Do not proceed if either value is absent or enabled in
the wrong direction.

- [ ] **Step 3: Create private pre-promotion fixtures**

Before Stage 1 promotion, use supported authenticated flows to create one
disposable Application, one installed extension credential, and a second
unconsumed pairing grant. Keep their URL, IDs, tokens, pairing codes, and
request/response bodies only in a private mode-0700 operator workspace. Do not
put them in logs, artifacts, Actions output, shell history, PR/comments, or
docs.

- [ ] **Step 4: Stage and promote the read-only candidate while unpaused**

Inspect the candidate before promotion: require `Ready`, the exact intended
Git SHA, and no canonical alias. Record its staged deployment ID, promote it
while unpaused, and record the promotion time. Start a bounded drain and wait
at least `2 × maxDuration` (at least 60 seconds when modules have a 30-second
maximum duration). Pass the authenticated negative probe, then use the exact
fixtures to prove all eight persistent mutations return `503` with
`writes_stopped`: Application POST/PATCH/DELETE, Settings PUT, pairing
creation, valid pair exchange, installation deletion, and self-revoke. Also
prove Settings GET does not create a row and installation-authenticated reads
do not touch `lastUsedAt/updatedAt`. Compare only sanitized counts/hashes
before and after and record sanitized results.

### Task 4: Pause only for prepare/apply identity maintenance

**Files:** GitHub artifacts and private operator evidence only; no repository changes.

- [ ] **Step 1: Pause Vercel after the read-only negative probe**

Using the authenticated Vercel dashboard, select team `taejunohs-projects`, project `easy-job-application-tracker`, Settings → General → Pause Project, type the exact project name, and confirm. Verify the canonical production URL returns `503 DEPLOYMENT_PAUSED`.

Require the actual platform `503 DEPLOYMENT_PAUSED` before any prepare/apply.
Stop every Application writer and keep writers stopped continuously. There is no
build or promotion while paused; prepare, private review, and apply are the only
operations permitted during this pause. Do not continue if the project cannot
be paused.

- [ ] **Step 2: Run prepare under the writer-stop attestation**

```bash
gh workflow run production-identity-maintenance.yml \
  --ref main \
  -f phase=prepare \
  -f writers_stopped=true
gh run list --workflow production-identity-maintenance.yml --event workflow_dispatch --limit 1
```

Capture numeric `PREPARE_RUN_ID`, require `headSha == ROLLOUT_SHA`, and wait
with `gh run watch "$PREPARE_RUN_ID" --exit-status`.

- [ ] **Step 3: Review the private dry-run evidence**

Download artifact `application-identity-prepare-$PREPARE_RUN_ID` into a mode-0700 directory outside the repository. Require schema version 1, mode `dry-run`, equal before/after counts, state totals summing to that count, a true unique-index result, opaque 64-hex row identifiers only, and no URL/title/company/body/connection values. Review it privately and approve it before apply.

- [ ] **Step 4: Run apply without resuming writers**

```bash
gh workflow run production-identity-maintenance.yml \
  --ref main \
  -f phase=apply \
  -f writers_stopped=true \
  -f prepare_run_id="$PREPARE_RUN_ID"
gh run list --workflow production-identity-maintenance.yml --event workflow_dispatch --limit 1
```

Capture numeric `APPLY_RUN_ID`, require the same head SHA, and wait for success.
Download `application-identity-apply-$APPLY_RUN_ID`; require its invariant
projection and opaque row plan to match the approved prepare report exactly.
Never build, redeploy, or promote while paused.

### Task 5: Resume the recorded read-only deployment and stage final writes

**Files:** No repository changes.

- [ ] **Step 1: Approve the offline identity apply evidence while paused**

```bash
node scripts/compare-application-identity-reports.mjs \
  --expected "$PREPARE_REPORT" \
  --actual "$APPLY_REPORT" \
  --actual-mode apply
```

Require migration status, an empty schema diff, matching row counts/totals,
`uniqueIndexVerified=true`, and the exact `ROLLOUT_SHA`. Do not build or
promote while paused.

- [ ] **Step 2: Resume the recorded same read-only deployment**

Resume Vercel only after the apply evidence is approved. Confirm the recorded
same `identity=1,writes=0` deployment is serving and the platform pause is
cleared; resume that same deployment without redeploying, building, or
promoting.

- [ ] **Step 3: Stage and promote the final write-enabled candidate while unpaused**

Inspect the candidate before promotion: require `Ready`, the exact intended
Git SHA, and no canonical alias. Record the new/staged deployment ID and
promote only while unpaused. This is the final staged
`identity=1,writes=1` Production candidate/promotion; no paused build or
promotion is allowed.

### Task 6: Smoke, clean up, and resume external writers last

**Files:** No repository changes; remove smoke-created records through the supported UI/API.

- [ ] **Step 1: Run automated authenticated health**

```bash
gh workflow run production-monitor.yml --ref main
gh run list --workflow production-monitor.yml --event workflow_dispatch --limit 1
```

Wait for the run and require success from `ROLLOUT_SHA`. Record the monitor
run ID and sanitized result only.

- [ ] **Step 2: Run the required authenticated smoke and negative checks**

With ordinary, automated, and background writers still stopped, allow only one
explicitly authorized bounded smoke actor/session. Use the exact fixtures from
Task 3 to confirm all eight persistent mutations remain rejected while the
read-only deployment was active, then use the final write-enabled deployment
for authenticated UI create/read/delete smoke with immediate cleanup. Run the
extension pairing/exchange/create/read smoke, revoke the exact disposable
installations, and require revoked credentials to return `401`. Record only
sanitized counts/hashes, statuses, and the negative-probe run ID.

- [ ] **Step 3: Complete bounded cleanup**

Delete the disposable Application, consume the still-unconsumed pairing grant
exactly once, revoke both disposable installations, and verify bounded cleanup.
Record only sanitized statuses/counts/hashes. Do not expose URLs, IDs, tokens,
pairing codes, request/response bodies, or private Application data.

- [ ] **Step 4: Record final hosted state and resume external writers last**

Capture the Git SHA; old/new/staged/canonical deployment IDs; promotion time;
drain start/end; Production monitor and negative-probe run IDs; backup,
prepare, and apply workflow run IDs; safe artifact names and digests;
pause/resume evidence; and sanitized cleanup status. Future IDs remain blank
until observed. Finally, resume external writers last, after every smoke and cleanup
check succeeds; external writers are resumed last. If DB apply occurred, the rollback target is the recorded Ready
`identity=1,writes=0` deployment; rollback/promotion is permitted only while
unpaused and must never target identity-unaware code.
