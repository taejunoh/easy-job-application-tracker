# Production Recovery and Identity Rollout Design

> **SUPERSEDED for the hosted identity operator sequence.** The paused-build
> sequence in this historical design is not executable guidance. Use the
> [2026-09-04 production write-stop rollout design](2026-09-04-production-write-stop-rollout-design.md)
> and the [authoritative production operations runbook](../../operations/production-runbook.md#application-identity-maintenance-rollout)
> for the approved staged two-gate procedure. Historical backup, audit, and
> source-control evidence below is retained as recorded and is not rewritten.

## Goal

Restore trustworthy production backups and a green CI gate, then complete the
existing-database Application identity rollout without exposing credentials or
resuming writers before verification. Finish with extension pairing/revocation
smoke coverage, environment-documentation alignment, and a read-only quarantine
retention review.

## Current evidence

- The working tree starts from `main` at `75a985e85bc0`.
- The Production monitor is healthy, including scheduled run `33791755041` on
  2026-09-03.
- Encrypted production backup run `33742225091` failed with PostgreSQL `25P03`
  after approximately five minutes. Every scheduled backup from 2026-08-14
  through 2026-09-03 failed; the last successful scheduled backup was
  2026-08-13.
- Commit `ed9da08` introduced a Docker wrapper that starts a child, lets the
  child self-stop with `SIGSTOP`, and immediately sends `SIGCONT` from the
  parent without observing the stopped state. `SIGCONT` can arrive before
  `SIGSTOP`, leaving `pg_dump` stopped forever. A 20-iteration reproduction of
  the exact signal sequence left the child in state `T` every time.
- Once source fingerprinting finishes, the coordinator must retain the exported
  snapshot while the stopped dump never progresses. The database then ends the
  idle transaction at its five-minute limit. The timeout is therefore a
  downstream symptom, not the defect to suppress.
- `npm run check:audit` currently reports six high and one moderate finding;
  the production-only audit reports five high findings. All production findings
  are transitive Prisma tooling dependencies. A clean-room lockfile experiment
  verified that five exact overrides clear both audit views and still allow
  `npm ci`.
- `README.md` and the production runbook document
  `APPLICATION_IDENTITY_WRITES_ENABLED`, while `.env.example` omits it.

## Chosen approach

Use a staged, surgical recovery. Preserve the existing same-snapshot backup
guarantee and interruption cleanup, but remove the lost-signal design. Remediate
audits with exact transitive versions rather than a forced Prisma downgrade or
policy exception. Do not start production identity mutation until the updated
code is green and a fresh encrypted backup has completed its built-in scratch
restore and fingerprint comparison.

Rejected alternatives:

1. Rolling back the full backup hardening series would recover the older start
   path but also discard reviewed signal and cleanup protections.
2. Disabling `idle_in_transaction_session_timeout` or sending keepalives would
   conceal the stopped dump and extend snapshot retention until the workflow
   timeout.
3. Recording audit exceptions or running `npm audit fix --force` would violate
   the repository policy; the latter proposes an incompatible Prisma downgrade.

## Implementation-plan decomposition

This document is the program-level design. Execution is split into four
independently verifiable plans so operational gates cannot be bypassed by work
on a later subsystem:

1. Repository recovery: backup regression, dependency overrides, and local/CI
   verification.
2. Identity maintenance tooling: manual workflow, contract tests, and operator
   documentation.
3. Hosted rollout: fresh backup, migration/backfill, Vercel gate transition,
   and production application/extension smoke checks.
4. Quarantine review: locate and validate retained evidence without mutation.

Plans 2 and 4 may be prepared independently, but plan 3 cannot execute until
plans 1 and 2 have passed their gates.

## Phase 1: Backup process repair

The Docker dump wrapper will remain a single stable process. It writes its own
PID, waits for the existing start file while checking the cancellation file,
and then replaces itself with `pg_dump` using `exec`. The PID therefore remains
valid before and after the exec boundary, and the existing stop wrapper can
terminate either the waiting shell or the running dump. There is no child
self-stop and no `STOP/CONT` handshake.

The exported snapshot, source fingerprint, credential service file, partial
output handling, termination supervisor, and remote cleanup contract remain
unchanged. The database idle timeout remains enabled.

A real PostgreSQL 17 Docker test must first demonstrate the current failure by
requiring a bounded normal backup completion. The test will then prove that the
fixed wrapper reaches and completes `pg_dump`, produces the dump and source
fingerprint, restores the dump, and obtains an identical fingerprint. Existing
SIGINT/SIGTERM interruption tests continue to prove cleanup and secret hygiene.

## Phase 2: CI dependency remediation

Add these exact `overrides` and regenerate only the lockfile resolution needed
for them:

| Package | Version | Finding scope |
| --- | --- | --- |
| `deepmerge-ts` | `8.0.2` | Prisma, production audit |
| `mysql2` | `3.24.3` | Prisma, production audit |
| `fast-uri` | `3.1.6` | Prisma streams, production audit |
| `browserslist` | `4.28.8` | Jest/Babel, development audit |
| `@humanfs/node` | `0.16.8` | ESLint, development audit |

Do not change the direct Prisma major version and do not add audit exceptions.
Validation includes clean `npm ci`, both audit views through
`npm run check:audit`, Prisma generation and validation, repository tests,
lint, typecheck, build, extension checks, and the Docker backup suite.

## Phase 3: Source-control and hosted validation gate

Work is performed on `codex/production-recovery-2026-09-03` with focused
commits. After local verification, push the branch and integrate it into
`main`. Require the `CI`, `backup-interruption`, and `extension-e2e` jobs to
pass on the exact integrated commit.

Dispatch `Encrypted production backup` manually only from that `main` commit.
The workflow itself must complete source dump validation, empty scratch restore,
and deterministic fingerprint comparison before encryption and artifact upload.
Record the run URL and artifact identity. If the workflow fails or the artifact
is absent, identity rollout does not begin.

## Phase 4: Production identity maintenance workflow

Add a manually dispatched, non-scheduled workflow that uses the existing
`PRODUCTION_DATABASE_URL` secret without printing or exporting it. It supports
two explicit phases:

1. `prepare`: require a typed writer-stop attestation, apply checked-in additive
   migrations, verify migration status and an empty schema diff, and produce a
   privacy-safe dry-run backfill report.
2. `apply`: require the same typed writer-stop attestation plus the approved
   `prepare` run identity, retrieve its privacy-safe report, apply the
   deterministic backfill with `--writers-stopped`, verify migration status,
   schema diff, row counts, state totals, and the unique identity index, and
   require the apply report invariants to match the approved dry run.

The workflow will use concurrency control so two identity operations cannot run
at once. It will have read-only repository permissions, bounded timeouts, exact
Node/PostgreSQL tooling, and cleanup steps for temporary reports. No database
URL, application rows, URLs, titles, companies, notes, resume content, or API
keys may enter logs or artifacts.

This is a design-level summary, not the executable operator procedure. The
[production operations runbook](../../operations/production-runbook.md#application-identity-maintenance-rollout)
is authoritative for the exact hosted commands and order; this design must
remain aligned with it.

The Settings singleton is created only on the first successful PUT /api/settings;
an authenticated GET /api/settings is read-only and does not create the row. The
runbook linked above owns the executable candidate, rollback, fixture-ledger,
and cleanup procedure.

The hosted operator sequence from this historical design is superseded. For
reference, the approved sequence is:

1. Start with an `identity=0,writes=1` Ready canonical support deployment.
2. Stage an `identity=1,writes=0` Ready Production candidate with
   `vercel --prod --skip-domain` while unpaused. Inspect `Ready`, the exact
   intended Git SHA, and no canonical alias; promote the candidate while
   unpaused. Drain for at least `2 × maxDuration` (at least 60 seconds for
   30-second modules) and pass an authenticated negative probe.
3. Pause Vercel and require the actual `503 DEPLOYMENT_PAUSED`. Prepare,
   privately review, and apply only while paused. There is no build or
   promotion while paused.
4. Resume the recorded same `identity=1,writes=0` deployment without
   redeploying, building, or promoting. Stage the final
   `identity=1,writes=1` Production candidate with `--skip-domain`, then
   promote only while unpaused.
5. After final promotion, run the production monitor and smoke; ordinary,
   automated, and background Application writers remain stopped, and only one
   explicitly authorized bounded smoke actor/session at a time may run.
   Complete bounded cleanup; external writers are resumed last. The old paused-build attempt is
   **SUPERSEDED and unsuccessful**, not evidence.

On any failure, preserve the actual current gate and deployment state and keep
writers stopped; do not treat the historical paused-build sequence as a
fallback.

If Vercel cannot be paused reliably, the apply phase stops. If any migration,
backfill, index, row-count, or smoke assertion fails, leave writers stopped and
preserve the actual current gate and deployment state. Do not force the gate to
`0` absent a reviewed hosted rollback. Recovery uses the newly verified backup
in an isolated target; no destructive reset, `db push`, or ad-hoc production
repair is allowed.

## Phase 5: Extension and documentation closure

After identity activation, exercise the real production pairing lifecycle
without exposing the root access token: create a one-time pairing grant for the
approved installed extension origin, exchange it once, confirm authenticated
extension access, revoke the installation, and confirm the revoked credential
is rejected. Clean up any test installation/grant produced by the smoke run.

Add `APPLICATION_IDENTITY_WRITES_ENABLED="0"` to `.env.example` so a copied
environment starts closed. Keep README and runbook language aligned with the
actual maintenance workflow and record the verified hosted run sequence without
secrets.

## Phase 6: Quarantine retention review

Locate the previously validated external quarantine root and run only the
documented read-only inspection/reconciliation checks needed to confirm its
manifest, journal, payload, validation state, and `retain_and_review` outcome.
The elapsed `deleteAfter` timestamp is a review boundary, not deletion
authorization. This program does not delete, move, rewrite, or restore quarantine
payloads.

If the external root cannot be located or its expected identifiers cannot be
verified, report that as an evidence gap and make no mutation.

## Error handling and rollback

- Backup startup failure: remove owned partial files and container credentials,
  terminate owned processes, and keep the last verified artifact untouched.
- CI audit failure: stop; do not add an exception or force a downgrade.
- Hosted backup failure: stop before any production identity mutation.
- Identity prepare, apply, or pre-resume deployment failure: preserve the actual
  current gate and deployment state, keep writers stopped, and do not force the
  gate to `0` absent a reviewed hosted rollback. Rehearse recovery against an
  isolated restore before deciding whether production restoration is necessary.
- Post-resume smoke failure: keep writers stopped and pause Vercel again before
  any further hosted change; preserve the actual current gate and deployment
  state while following the reviewed rollback procedure.
- Extension smoke failure: keep all ordinary, automated, background, and
  Application writers stopped; pause Vercel again before any further hosted
  change, preserve the actual current gate and deployment state, and follow the
  reviewed rollback procedure. Do not force the gate to `0` absent a reviewed
  hosted rollback.
- Quarantine discrepancy: preserve all evidence and stop without mutation.

## Success criteria

- The new Docker normal-completion regression fails on the old wrapper and
  passes on the repaired wrapper; interruption cleanup tests still pass.
- Full and production npm audit counts contain no high or critical findings.
- All local verification commands and all required GitHub jobs pass on the
  integrated commit.
- A fresh encrypted production backup is uploaded only after successful scratch
  restore and fingerprint equality.
- Identity migrations and backfill reports satisfy the runbook invariants; the
  final staged Production candidate and promotion have
  `identity=1,writes=1`, authenticated application checks pass, and external
  writers are resumed last.
- Production extension pairing, one-time exchange, authenticated access,
  revocation, and rejection after revocation are observed.
- `.env.example`, README, and the runbook describe the same closed-by-default
  gate and operational sequence.
- Quarantine evidence remains intact and its review result is recorded without
  deletion.
