# Hosted Production Rollout Implementation Plan

> **Historical plan record:** The retained task structure and evidence gates are
> descriptive only. Current executable ordering is defined by the authoritative
> production operations runbook below.

**Historical objective:** The rollout integrated verified repository changes,
created a fresh encrypted backup, completed production identity maintenance
under a continuous writer stop, and verified application and extension
behavior before service resumed.

**Historical architecture:** GitHub Actions retained database credentials and
performed backup/migration/backfill. Vercel was unpaused for builds and
promotions and paused only across prepare/apply, where the platform
`503 DEPLOYMENT_PAUSED` protected the database mutation window. The historical
record confirmed no build or promotion while paused occurred.

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

The retained state/evidence summary is: after database apply, the rollout is
`PAUSED_AFTER_APPLY`; failed or ambiguous evidence enters `HOLD_PAUSED`, where
there is no build, deploy, alias assignment, or promotion. Approved evidence
resumes the exact recorded `identity=1,writes=0` Ready deployment as
`UNPAUSED_READONLY` for read-only and authenticated negative probes. A regression
requires an exact Ready candidate ID and reviewed SHA or returns to
`HOLD_PAUSED`. The private ledger retains exact owned IDs until bounded cleanup
is verified and cleanup may remove only those IDs.

---

### Historical task 1: reviewed pull-request integration

**Files:** No new files; consume the committed repository-recovery and maintenance-tooling changes.

- **Historical step 1 evidence — branch verification before publication**

The historical verification required a clean branch, no secret/generated files,
and only the approved program commits. The authoritative runbook owns the
current executable checks.

- **Historical step 2 evidence — reviewed branch publication and pull request**

The historical plan published the reviewed branch and opened a pull request
with its recovery and identity-rollout scope. The authoritative runbook defined
any current repository integration commands.

- **Historical step 3 evidence — required pull-request checks**

The historical gate required `verify`, `backup-interruption`, and
`extension-e2e` to succeed. If a check failed, the recorded response was to
inspect only the demonstrated defect, rerun affected local gates, and wait for
the updated result.

- **Historical step 4 evidence — merge after required checks**

The historical plan merged only after checks passed, recorded the integrated
commit as `ROLLOUT_SHA`, and required the corresponding main-branch CI result
to pass before any operations workflow. No different commit was deployed.

### Historical task 2: hosted backup evidence

**Historical evidence:** Evidence was created only outside the repository in a
mode-0700 temporary directory.

- **Historical step 1 evidence — backup from the exact main commit**

The historical plan dispatched the backup from `main`, captured a numeric
`BACKUP_RUN_ID`, verified its head SHA equaled `ROLLOUT_SHA`, and waited for
success. The authoritative runbook owns the current workflow-dispatch and
observation commands.

- **Historical step 2 evidence — private artifact inspection**

The historical inspection used a private mode-0700 directory and downloaded only
the recorded backup artifact. It required exactly:

```text
jobtracker.dump.age
jobtracker.dump.age.sha256
backup-manifest.json
```

The recorded verification checked the encrypted checksum, required
`restoreValidated=true`, `format=PostgreSQL custom`, 64 lowercase hexadecimal
SHA-256 fields, and no connection string or private Application fields in the
manifest.

- **Historical step 3 evidence — private recovery-key rehearsal**

The historical recovery-key rehearsal required mode `0600` on:

```text
/Users/taejunoh/Library/Application Support/easy-job-application-tracker/secrets/backup.agekey
```

The historical rehearsal decrypted into the private directory, verified the
plaintext hash against `dumpSha256`, restored into a disposable PostgreSQL 17
Docker database, computed the deterministic database fingerprint, compared it
with the manifest, and unconditionally removed the plaintext dump and
disposable container. A missing or incorrectly permissioned key was recorded
as a recovery-evidence gap and stopped the rollout.

### Historical task 3: Vercel project identity and read-only candidate evidence

**Historical file note:** `.vercel/project.json` was local ignored state and was
never staged.

Historical correction: the prior paused-build sequence was **SUPERSEDED and
unsuccessful**. It was not rollout evidence, was not recreated, and supplied no
deployment IDs.

- **Historical step 1 evidence — project link and identity verification**

The authoritative runbook's Vercel project-link and identity evidence confirmed
that the project owned `easy-job-application-tracker.vercel.app`; a differing
team, project, or domain stopped the rollout.

For evidence terminology, the historical staged Production candidate used the
runbook's staged deployment flow and had to reach `Ready` with the exact
intended Git SHA and no canonical alias before promotion.

- **Historical step 2 evidence — `identity=0,writes=1` Ready canonical support deployment**

The historical evidence required a Ready deployment serving the canonical alias
with both gate values `identity=0,writes=1`; absent or reversed values stopped
the rollout.

- **Historical step 3 evidence — private pre-promotion fixtures**

Before the historical Stage 1 promotion, supported authenticated flows created
one disposable Application, one installed extension credential, and a second
unconsumed pairing grant. Their URL, IDs, tokens, pairing codes, and
request/response bodies remained only in a private mode-0700 operator
workspace, not in logs, artifacts, Actions output, shell history, PR/comments,
or docs.

- **Historical step 4 evidence — staged read-only candidate and unpaused promotion**

The candidate evidence recorded `Ready`, the exact intended Git SHA, no
canonical alias, its staged deployment ID, and an unpaused promotion time. The
historical drain lasted at least `2 × maxDuration` (at least 60 seconds when
modules had 30-second maximum duration). The authenticated negative probe and
exact fixtures then proved all eight persistent mutations returned `503` with
`writes_stopped`: Application POST/PATCH/DELETE, Settings PUT, pairing
creation, valid pair exchange, installation deletion, and self-revoke. It also
proved Settings GET did not create a row and installation-authenticated reads
did not touch `lastUsedAt/updatedAt`. Only sanitized counts/hashes were
compared before and after and retained as results.

### Historical task 4: provider pause and prepare/apply identity evidence

**Historical evidence:** GitHub artifacts and private operator evidence only;
no repository changes.

- **Historical step 1 evidence — provider pause after the read-only negative probe**

The historical provider-pause evidence came from the authenticated Vercel
dashboard for team `taejunohs-projects` and project
`easy-job-application-tracker`; exact project-name confirmation was required,
followed by canonical `503 DEPLOYMENT_PAUSED` evidence.

The actual platform `503 DEPLOYMENT_PAUSED` was required before prepare/apply.
The historical state kept every Application writer stopped continuously; no
build or promotion occurred while paused, and prepare, private review, and
apply were the only permitted operations. An unreliable pause stopped the
rollout.

- **Historical step 2 evidence — prepare under writer-stop attestation**

The historical prepare dispatch required the writer-stop attestation and a
numeric `PREPARE_RUN_ID`; its head SHA had to equal `ROLLOUT_SHA` and the run
had to complete successfully. The authoritative runbook owns the current
workflow-dispatch and observation commands.

- **Historical step 3 evidence — private dry-run review**

The historical evidence review used artifact
`application-identity-prepare-$PREPARE_RUN_ID` in a mode-0700 directory outside
the repository. It required schema version 1, mode `dry-run`, equal
before/after counts, state totals summing to that count, a true unique-index
result, opaque 64-hex row identifiers only, and no URL/title/company/body or
connection values; the report was privately approved before apply.

- **Historical step 4 evidence — apply with writers continuously stopped**

The historical apply dispatch used only the approved numeric prepare identifier
and the same writer-stop attestation. Its numeric `APPLY_RUN_ID` had to have the
same head SHA and complete successfully. The apply artifact's invariant
projection and opaque row plan had to match the approved prepare report exactly.
The paused interval contained no build, redeploy, or promotion.

### Historical task 5: recorded read-only resumption and final-write evidence

**Files:** No repository changes.

- **Historical step 1 evidence — approved offline identity apply while paused**

The approved evidence included migration status, an empty schema diff, matching
row counts/totals, `uniqueIndexVerified=true`, and the exact `ROLLOUT_SHA`; no
build or promotion occurred while paused.

- **Historical step 2 evidence — resumed recorded read-only deployment**

The historical transition resumed Vercel only after apply evidence approval.
The recorded same `identity=1,writes=0` deployment had to serve after the
platform pause cleared, without redeploying, building, or promoting.

- **Historical step 3 evidence — staged final write-enabled candidate and unpaused promotion**

The final candidate evidence recorded `Ready`, the exact intended Git SHA, no
canonical alias, and the new/staged deployment ID; promotion occurred only
while unpaused. This was the final staged
`identity=1,writes=1` Production candidate/promotion; no paused build or
promotion is allowed.

### Historical task 6: smoke, cleanup, and last external-writer resumption

**Historical evidence:** No repository changes; smoke-created records were
removed through supported paths.

- **Historical step 1 evidence — automated authenticated health**

The monitor evidence recorded success from `ROLLOUT_SHA`, its run identifier,
and a sanitized result only.

- **Historical step 2 evidence — authenticated smoke and negative checks**

With ordinary, automated, and background writers still stopped, the historical
smoke used only one explicitly authorized bounded actor/session. The exact
fixtures from Task 3 showed all eight persistent mutations remained rejected
while the read-only deployment was active; the final write-enabled deployment
then covered authenticated UI create/read/delete smoke with immediate cleanup.
The extension pairing/exchange/create/read smoke, exact disposable-installation
revocations, and revoked-credential `401` responses were recorded as sanitized
counts/hashes, statuses, and the negative-probe run ID.

- **Historical step 3 evidence — bounded cleanup**

The bounded cleanup evidence covered deletion of the disposable Application,
single consumption of the still-unconsumed pairing grant, revocation of both
disposable installations, and verification of bounded cleanup. The historical
record retained only sanitized statuses/counts/hashes and exposed none of the
URLs, IDs, tokens, pairing codes, request/response bodies, or private
Application data. The rollout invariant recorded that writers remain stopped
continuously until every post-resume smoke pass succeeds.

- **Historical step 4 evidence — final hosted state and last writer resumption**

The final historical record contained the Git SHA; old/new/staged/canonical
deployment IDs; promotion time; drain start/end; Production monitor and
negative-probe run IDs; backup, prepare, and apply workflow run IDs; safe
artifact names and digests; pause/resume evidence; and sanitized cleanup
status. Future IDs remained blank until observed. The evidence recorded that
external writers are resumed last, after every smoke and cleanup check
succeeded. If DB apply occurred, the rollback target was the recorded Ready
`identity=1,writes=0` deployment; rollback/promotion was permitted only while
unpaused and never targeted identity-unaware code.
