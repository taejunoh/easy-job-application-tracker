# Plan status reconciliation — 2026-10-22

Plan checkboxes in `docs/superpowers/plans/` were not maintained while the plans were executed, so most unchecked items are finished work. This record reconciles every unchecked item against `main` at `438d630` and supersedes the checkbox state as of that commit. Plans are left unchanged.

## Method and totals

Each of the 501 unchecked items in 21 plans was classified from repository evidence (files, tests, commits, merged PRs, Actions history):

- **Done**: the artifact exists on `main`.
- **Superseded**: a later commit or plan replaced the approach.
- **Not done**: no evidence after a real search.
- **Ops-only**: an action on a hosted system or a manual check that the repository cannot prove.
- **Unclear**: partial or ambiguous evidence.

| Plan | Unchecked | Done | Superseded | Not done | Ops-only | Unclear |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2026-07-13-deployment-hardening | 68 | 67 | 0 | 0 | 1 | 0 |
| 2026-07-14-foundation-cleanup | 81 | 74 | 4 | 1 | 2 | 0 |
| 2026-07-14-backup-signal-shutdown-plan | 16 | 15 | 0 | 0 | 1 | 0 |
| 2026-07-14-extension-race-invariants | 1 | 1 | 0 | 0 | 0 | 0 |
| 2026-07-14-chrome-extension-e2e | 23 | 21 | 1 | 0 | 1 | 0 |
| 2026-07-14-chrome-smoke-followup | 29 | 25 | 1 | 0 | 3 | 0 |
| 2026-07-14-operations-hygiene | 24 | 20 | 0 | 1 | 2 | 1 |
| 2026-07-14-production-cutover | 23 | 2 | 0 | 0 | 21 | 0 |
| 2026-07-16-readme-user-guide | 24 | 24 | 0 | 0 | 0 | 0 |
| 2026-08-09-quarantine-lifecycle-continuation | 42 | 41 | 0 | 0 | 0 | 1 |
| 2026-09-03-identity-maintenance-tooling | 18 | 18 | 0 | 0 | 0 | 0 |
| 2026-09-03-quarantine-retention-review | 9 | 0 | 0 | 0 | 9 | 0 |
| 2026-09-03-repository-recovery | 17 | 17 | 0 | 0 | 0 | 0 |
| 2026-09-04-production-rollout-safety-hardening | 43 | 43 | 0 | 0 | 0 | 0 |
| 2026-09-04-production-write-stop-rollout | 55 | 54 | 0 | 0 | 0 | 1 |
| 2026-09-13-focused-journal-ui | 16 | 15 | 0 | 0 | 1 | 0 |
| 2026-10-07-easy-onboarding | 2 | 1 | 0 | 0 | 1 | 0 |
| 2026-10-07-unpatched-dependency-remediation | 1 | 1 | 0 | 0 | 0 | 0 |
| 2026-10-13-readonly-release-security-patches | 9 | 2 | 0 | 0 | 7 | 0 |
| **Total** | **501** | **441** | **6** | **2** | **49** | **3** |

Most ops-only items are recorded in `docs/operations/production-cutover-2026-07-14.md` or PR bodies (#1, #2, #12). Plans with no unchecked items (`extension-permission-cleanup-finalization`, `release-readiness-program`, `hosted-production-rollout`, `security-patchable-dependencies`) are not listed.

## Open items

1. **Production monitor alert drill — not done** (operations-hygiene Task 6 Step 3). The drill (temporarily invalid monitor token, manual run, confirm failure and notification, restore) never ran: all 14 manual `production-monitor.yml` runs succeeded. Unit tests cover the 401 path, and scheduled runs did fail around 2026-08-19/20, but whether anyone was notified is unrecorded. Requires an operator because it changes a production secret.
2. **Quarantine retention review — attempted 2026-10-22, blocked by design.** See the next section. Payload deletion still requires a separate lifecycle design and explicit destructive approval.
3. **Private credential workspace cleanup after the 2026-10-13 release — unrecorded** (readonly-release Task 3 Step 5). PR #12 records restoring the auto-assign setting but not removing the owned credential workspace. An operator should confirm it no longer exists locally.

## Quarantine retention review result (read-only)

- **Discovery:** the plan's search pattern (`*/manifests/current.json`) does not match the implemented layout, where the pointer is `<quarantine root>/current` and manifests are `<run root>/manifests/<sha256>.json` (`scripts/quarantine-run-capability.mjs`). Searching by the implemented layout (no permission errors) found one root, `~/Developer/LFG/.easy-job-application-tracker-quarantine` (mode 0700, 2.9 GB), with four `operator-20260813-*` runs and one pointer.
- **Pointer and manifest:** the pointer has exactly `schemaVersion`, `transactionId`, `manifestSha256`; it selects `operator-20260813-e15555b2837f9920483c937e78755c54`, manifest `78dcc7cbdea808cd1bf2890c545dec0c06466cb6c5586c631cde872e522d95df`, whose SHA-256 matches. Manifest: schema 2, `repositoryRoot` is the primary checkout, `state` `VALIDATED`, 78 entries, `validatedAt` 2026-08-14T01:57:23.238Z, `deleteAfter` 2026-08-18T01:57:23.238Z (exactly 96 hours), `deletionStatus` `retained`, `deletionRequiresConfirmation` true.
- **Canonical reconcile:** `cleanup:quarantine reconcile --writers-stopped` failed closed with `ERR_INTEGRITY` ("journal, manifest, and repository provenance conflict"). It requires the repository's current HEAD and device ID to equal the manifest's. Branch, inode and root match, but HEAD moved from `46c8ec0` (an ancestor of `main`) to `438d630`, and the volume device ID changed. Reconciliation therefore cannot pass against today's checkout; this is the gate working as designed, not evidence corruption.
- **No mutation:** pointer, all manifest and journal hashes, and metadata for the root to depth 3 (145 lines) were identical before and after; no lock or temp file appeared. No `apply`, `recover`, `mark-validated`, `restore`, or deletion was run.

## Decisions recorded

- **Foundation-cleanup Task 2 Step B (rewrite unsafe history behind a safety reference): closed as won't-do.** All six targeted commits are published on `main` through PR #5, the unsafe code is gone from the current tree, and rewriting published history would be destructive.
- **Production identity backfill and write resume remain deferred** by the PR #12 decision (Production stays at identity writes 0 and application writes 0); the single identity-maintenance run (33855523112) failed before upload and was not retried.
- **Superseded approaches:** manual backups use `PGSERVICEFILE`/`PGPASSFILE` with `pg_dump --dbname=service=production_backup` instead of the coordinator route (`ed9da08`); local extension E2E uses a disposable database on local PostgreSQL 17 instead of a Docker wrapper (`9e62d0a`, `aea59a9`); chrome-smoke Task 5 Step 4 targets a Desktop checkout that is no longer a Git repository.

## Resolved since the plans were written

- Local extension E2E with writes enabled (write-stop Task 9 Step 3): PR #16 pinned the write gate for the local wrapper. Local runs on 2026-10-21 failed 3/3 before the fix at pairing-grant creation and passed 3 of 4 after it (the one failure had no debug output and did not recur).
- Uncommitted CI edits left on the primary checkout (readonly-release follow-up): identical changes were already on `main`; the checkout is clean.

## Minor notes

- `2026-09-13-focused-journal-ui.md` cites commits `c19ea5d`, `3846e82`, `b7cf38f`, which exist only on the unmerged `codex/fix-promoted-stage1-resume` branch; the same work is on `main` as `4eeceb0`, `d73a494`, `a00538f` (PR #12).
- `handover.md` (operations-hygiene Task 3 Step 2) is gitignored and absent, so it cannot be verified; the README part is done (`d0e9d88`).
- The post-merge manual Chrome check (chrome-smoke-followup Task 6) is unrecorded; the installed unpacked extension matches `main` byte-for-byte and the fixes have unit tests.
- Vercel Node 22.x pinning (production-cutover Task 4 Step 1) is unrecorded but effectively enforced by `engines.node` in `package.json`.
