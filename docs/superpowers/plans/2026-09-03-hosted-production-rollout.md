# Hosted Production Rollout Implementation Plan

> **Historical plan record:** The retained task structure and evidence gates are
> descriptive only; it does not assert that any Production action occurred,
> completed, or was confirmed. Each step states what the plan required, what evidence was required
> to show, or what would have happened if executed; current executable ordering
> is defined by the [production operations runbook](../../operations/production-runbook.md#application-identity-maintenance-rollout).

**Historical objective:** The plan required integrating verified repository
changes, creating a fresh encrypted backup, completing production identity
maintenance under a continuous writer stop, and verifying application and
extension behavior before service could resume.

**Historical architecture:** The planned architecture assigned GitHub Actions
the retained database credentials for backup/migration/backfill. Vercel would
have been unpaused for builds and promotions and paused only across
prepare/apply, where the platform `503 DEPLOYMENT_PAUSED` was required to
protect the database mutation window. The success criterion required evidence
showing no build or promotion while paused.

**Historical tooling context:** Git/GitHub CLI, GitHub Actions, Vercel CLI
50.40.0 and dashboard, PostgreSQL 17, age, Docker, and the Chrome extension.

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

The planned state/evidence model required that after database apply, the
rollout enter `PAUSED_AFTER_APPLY`; failed or ambiguous evidence would enter
`HOLD_PAUSED`, where there would be no build, deploy, alias assignment, or
promotion. Approved evidence would be required before resuming the exact
recorded `identity=1,writes=0` Ready deployment as `UNPAUSED_READONLY` for
read-only and authenticated negative probes. A regression would require an
exact Ready candidate ID and reviewed SHA or would return to `HOLD_PAUSED`. The
private ledger would retain exact owned IDs until bounded cleanup was verified,
and cleanup may remove only those IDs.

---

### Historical task 1: reviewed pull-request integration

**Files:** No new files; consume the committed repository-recovery and maintenance-tooling changes.

- **Historical step 1 evidence — branch verification before publication**

The historical verification required a clean branch, no secret/generated files,
and only the approved program commits. The authoritative runbook owns the
current executable checks.

- **Historical step 2 evidence — reviewed branch publication and pull request**

The plan required publishing the reviewed branch and opening a pull request
with its recovery and identity-rollout scope. The authoritative runbook defined
any current repository integration commands.

- **Historical step 3 evidence — required pull-request checks**

The historical gate required `verify`, `backup-interruption`, and
`extension-e2e` to succeed. If a check failed, the required response was to
inspect only the demonstrated defect, rerun affected local gates, and wait for
the updated result.

- **Historical step 4 evidence — merge after required checks**

The plan required merging only after checks passed, recording the integrated
commit as `ROLLOUT_SHA`, and requiring the corresponding main-branch CI result
to pass before any operations workflow. The success criterion allowed no
different commit to be deployed.

### Historical task 2: hosted backup evidence

**Historical evidence:** The plan required evidence to be created only outside
the repository in a mode-0700 temporary directory.

- **Historical step 1 evidence — backup from the exact main commit**

The plan required dispatching the backup from `main`, capturing a numeric
`BACKUP_RUN_ID`, verifying its head SHA equaled `ROLLOUT_SHA`, and observing
success. The authoritative runbook owns the current workflow-dispatch and
observation commands.

- **Historical step 2 evidence — private artifact inspection**

The plan required a private mode-0700 inspection directory and download of only
the designated backup artifact. The required artifact set was exactly:

```text
jobtracker.dump.age
jobtracker.dump.age.sha256
backup-manifest.json
```

Evidence was required to show the encrypted checksum, `restoreValidated=true`,
`format=PostgreSQL custom`, 64 lowercase hexadecimal SHA-256 fields, and no
connection string or private Application fields in the manifest.

- **Historical step 3 evidence — private recovery-key rehearsal**

The plan required a recovery-key rehearsal and mode `0600` on:

```text
/Users/taejunoh/Library/Application Support/easy-job-application-tracker/secrets/backup.agekey
```

The rehearsal would have decrypted into the private directory, verified the
plaintext hash against `dumpSha256`, restored into a disposable PostgreSQL 17
Docker database, computed the deterministic database fingerprint, compared it
with the manifest, and unconditionally removed the plaintext dump and
disposable container. A missing or incorrectly permissioned key would have been
treated as a recovery-evidence gap and would have stopped the rollout.

### Historical task 3: Vercel project identity and read-only candidate evidence

**Historical file note:** The plan required `.vercel/project.json` to remain
local ignored state and never be staged.

Historical correction: the plan treated the prior paused-build sequence as
**SUPERSEDED and unsuccessful** and required that it not be used as rollout
evidence, recreated, or treated as supplying deployment IDs.

- **Historical step 1 evidence — project link and identity verification**

The authoritative runbook's Vercel project-link and identity evidence was
required to show that the project owned
`easy-job-application-tracker.vercel.app`; a differing team, project, or domain
would have stopped the rollout.

For evidence terminology, the planned staged Production candidate used the
runbook's staged deployment flow and acceptance required it to reach `Ready`
with the exact intended Git SHA and no canonical alias before promotion.

- **Historical step 2 evidence — `identity=0,writes=1` Ready canonical support deployment**

The historical evidence required a Ready deployment serving the canonical alias
with both gate values `identity=0,writes=1`; absent or reversed values would
have stopped the rollout.

- **Historical step 3 evidence — private pre-promotion fixtures**

Before the planned Stage 1 promotion, supported authenticated flows were
required to create one disposable Application, one installed extension
credential, and a second unconsumed pairing grant. Their URL, IDs, tokens,
pairing codes, and request/response bodies were required to remain only in a
private mode-0700 operator
workspace, not in logs, artifacts, Actions output, shell history, PR/comments,
or docs.

- **Historical step 4 evidence — staged read-only candidate and unpaused promotion**

Candidate evidence was required to record `Ready`, the exact intended Git SHA,
no canonical alias, its staged deployment ID, and an unpaused promotion time.
The historical drain requirement was at least `2 × maxDuration` (at least 60
seconds when modules had 30-second maximum duration). The authenticated
negative probe and exact fixtures were required to prove all eight persistent
mutations returned `503` with `writes_stopped`: Application POST/PATCH/DELETE,
Settings PUT, pairing creation, valid pair exchange, installation deletion,
and self-revoke. They were also required to prove Settings GET did not create a
row and installation-authenticated reads did not touch
`lastUsedAt/updatedAt`. Only sanitized counts/hashes would have been compared
before and after and retained as results.

### Historical task 4: provider pause and prepare/apply identity evidence

**Historical evidence:** The plan required GitHub artifacts and private
operator evidence only; no repository changes.

- **Historical step 1 evidence — provider pause after the read-only negative probe**

The provider-pause evidence was required to come from the authenticated Vercel
dashboard for team `taejunohs-projects` and project
`easy-job-application-tracker`; exact project-name confirmation was required,
followed by canonical `503 DEPLOYMENT_PAUSED` evidence.

The actual platform `503 DEPLOYMENT_PAUSED` was required before prepare/apply.
The target state required every Application writer to remain stopped
continuously; evidence was required to show no build or promotion while
paused, with prepare, private review, and apply as the only permitted
operations. An unreliable pause would have stopped the rollout.

- **Historical step 2 evidence — prepare under writer-stop attestation**

The plan required the prepare dispatch to use the writer-stop attestation and a
numeric `PREPARE_RUN_ID`; its head SHA had to equal `ROLLOUT_SHA` and the run
had to complete successfully. The authoritative runbook owns the current
workflow-dispatch and observation commands.

- **Historical step 3 evidence — private dry-run review**

The plan required the evidence review to use artifact
`application-identity-prepare-$PREPARE_RUN_ID` in a mode-0700 directory outside
the repository. It required schema version 1, mode `dry-run`, equal
before/after counts, state totals summing to that count, a true unique-index
result, opaque 64-hex row identifiers only, and no URL/title/company/body or
connection values; the report was required to be privately approved before
apply.

- **Historical step 4 evidence — apply with writers continuously stopped**

The plan required the apply dispatch to use only the approved numeric prepare
identifier and the same writer-stop attestation. Its numeric `APPLY_RUN_ID` had
to have the same head SHA and complete successfully. The apply artifact's
invariant projection and opaque row plan had to match the approved prepare
report exactly. The success criterion required evidence that the paused
interval contained no build, redeploy, or promotion.

### Historical task 5: read-only resumption and final-write evidence requirements

**Files:** No repository changes.

- **Historical step 1 evidence — offline identity-apply approval while paused**

The plan required approved evidence to include migration status, an empty
schema diff, matching row counts/totals, `uniqueIndexVerified=true`, and the
exact `ROLLOUT_SHA`; evidence was required to show no build or promotion while
paused.

- **Historical step 2 evidence — read-only deployment resumption requirements**

The plan required resuming Vercel only after apply evidence approval. The
recorded same `identity=1,writes=0` deployment was required to serve after the
platform pause cleared, without redeploying, building, or promoting.

- **Historical step 3 evidence — staged final write-enabled candidate and unpaused promotion**

The plan required final candidate evidence to record `Ready`, the exact
intended Git SHA, no canonical alias, and the new/staged deployment ID. The
success criterion was that promotion occurred only while unpaused. The intended final staged
`identity=1,writes=1` Production candidate/promotion had no allowance for a
paused build or promotion.

### Historical task 6: smoke, cleanup, and last external-writer resumption

**Historical evidence:** The plan required no repository changes and required
any smoke-created records to be removed through supported paths.

- **Historical step 1 evidence — automated authenticated health**

The plan required monitor evidence to record success from `ROLLOUT_SHA`, its
run identifier, and a sanitized result only.

- **Historical step 2 evidence — authenticated smoke and negative checks**

With ordinary, automated, and background writers still stopped, the plan
required smoke to use only one explicitly authorized bounded actor/session. The
exact fixtures from Task 3 were required to show all eight persistent
mutations remained rejected while the read-only deployment was active; the
final write-enabled deployment would then cover authenticated UI
create/read/delete smoke with immediate cleanup. The extension
pairing/exchange/create/read smoke, exact disposable-installation revocations,
and revoked-credential `401` responses were required to be recorded as
sanitized counts/hashes, statuses, and the negative-probe run ID.

- **Historical step 3 evidence — bounded cleanup**

The plan required bounded cleanup evidence to cover deletion of the disposable
Application, single consumption of the still-unconsumed pairing grant,
revocation of both disposable installations, and verification of bounded
cleanup. Only sanitized statuses/counts/hashes would have been retained, with
none of the URLs, IDs, tokens, pairing codes, request/response bodies, or
private Application data exposed. The rollout invariant required writers to
remain stopped continuously until every post-resume smoke pass succeeded.

- **Historical step 4 evidence — final hosted state and last writer resumption**

The plan required the final historical record to contain the Git SHA; old/new/staged/canonical
deployment IDs; promotion time; drain start/end; Production monitor and
negative-probe run IDs; backup, prepare, and apply workflow run IDs; safe
artifact names and digests; pause/resume evidence; and sanitized cleanup
status. Future IDs were required to remain blank until observed. Acceptance
required evidence to show that external writers are resumed last, after every
smoke and cleanup check succeeded. If DB apply occurred, the rollback
target would be the recorded Ready `identity=1,writes=0` deployment; the plan
permitted rollback/promotion only while unpaused and never targeted
identity-unaware code.
