# Backup Signal Shutdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure interrupted production backups terminate all local and Docker-side dump work and clean every owned resource before exiting 130/143.

**Architecture:** Add a run-scoped first-signal controller to the coordinator and pass it through child execution. Direct children run in isolated process groups; Docker dumps use a random pidfile plus explicit remote termination. Existing `catch`/`finally` blocks remain the single owners of credential, output, transaction, and client cleanup.

**Tech Stack:** Node.js 22 ESM, `node:child_process`, PostgreSQL 17, Jest integration tests, fake Docker CLI.

---

### Task 1: Direct interruption regression

**Files:**
- Modify: `__tests__/scripts/create-snapshot-backup.integration.test.ts`

- [ ] Add a real-process direct-mode test that synchronizes on a ready file, sends `SIGTERM`, and asserts exit 143.
- [ ] Assert the dump child/process group and coordinator PostgreSQL session are gone.
- [ ] Assert the 0600 host credential and all dump/fingerprint partial outputs are removed and output contains no secret.
- [ ] Run `RUN_BACKUP_INTEGRATION=1 npm test -- --runInBand __tests__/scripts/create-snapshot-backup.integration.test.ts` and confirm the new test fails because the current coordinator exits before cleanup.

### Task 2: Docker interruption regression

**Files:**
- Modify: `__tests__/scripts/create-snapshot-backup.integration.test.ts`

- [ ] Extend the fake Docker helper to model a blocking remote `pg_dump`, random pidfile, and explicit TERM/KILL cleanup commands.
- [ ] Add a `SIGINT` test that asserts exit 130, remote process closure, Docker CLI closure, host/container credential and pidfile deletion, partial-output deletion, and sanitized captures.
- [ ] Run the focused integration test and confirm this test fails because killing the coordinator does not explicitly terminate Docker-side work or clean resources.

### Task 3: Coordinated shutdown implementation

**Files:**
- Modify: `scripts/create-snapshot-backup.mjs`
- Modify: `__tests__/ci/production-backup-workflow-contract.test.ts`

- [ ] Implement a first-signal controller with idempotent listener install/removal, active-child registration, bounded TERM-to-KILL escalation, and status 130/143.
- [ ] Spawn direct dump work in an isolated process group and await child closure before cleanup continues.
- [ ] Add a random Docker pidfile and container-side trap/wrapper, plus explicit remote termination that contains only non-secret identifiers and paths.
- [ ] Keep credential/output/transaction/client cleanup in their existing `finally` owners and make repeated cleanup safe.
- [ ] Run the focused contract and integration tests until all cases pass.

### Task 4: Review and verification

**Files:**
- Review all modified files from Tasks 1-3.

- [ ] Perform independent spec compliance review, then code-quality review, and resolve every finding.
- [ ] Run `npm run test:ci -- --silent`, `npm run lint`, `npm run typecheck`, `npm run build`, and `npm run check:audit`.
- [ ] Run the production read-only backup/restore/fingerprint rehearsal and verify credentials, scratch database, and temporary files are removed.
- [ ] Scan the diff for production URI/password exposure, run `git diff --check`, and commit the verified implementation.
