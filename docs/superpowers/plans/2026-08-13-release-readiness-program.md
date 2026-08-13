# Release Readiness Program Implementation Plan

> Execute continuously without intermediate owner approval. For each task: RED test, minimal implementation, focused GREEN, specification review, quality review, commit. Preserve unrelated user files.

**Goal:** Complete the seven release-readiness items defined in `docs/superpowers/specs/2026-08-13-release-readiness-program-design.md`, operate the live quarantine safely, pass the aggregate gate, merge locally to `main`, and push `origin/main`.

**Baseline:** `f0e3874e7d5acb0af289c552fc574cea27287a27`

**Implementation worktree:** `.worktrees/release-readiness-program`
**Runtime:** Node 22.22.2, npm 10.x, PostgreSQL 17

## Task 1 — Extend quarantine discovery and durable schemas for temp residues

**Files:**

- Modify `scripts/quarantine-path-policy.mjs`
- Modify `scripts/quarantine-workspace-runtime.mjs`
- Modify `scripts/quarantine-manifest.mjs`
- Modify `scripts/quarantine-journal.mjs`
- Modify `scripts/quarantine-run-capability.mjs`
- Modify `scripts/quarantine-lifecycle-internal.mjs`
- Modify `scripts/quarantine-restore-internal.mjs`
- Modify `scripts/quarantine-restore-ledger.mjs`
- Modify `scripts/quarantine-numbered-copies.mjs`
- Modify relevant quarantine fixture/harness files
- Modify quarantine path, journal, manifest, transaction, recovery, restore, crash, facade, and CLI suites

1. Add RED tests for exact `.BC.T_[A-Za-z0-9]{6}` acceptance only when zero-byte, mode-0600, regular, non-symlink, untracked, NFC-safe, and parent/root identities remain bound.
2. Add RED tests for near-miss names, nonzero content, wrong mode, symlink/FIFO/directory, swapped parent/file, extra unexpected residue, and adapter faults.
3. Preserve exact v1 readers and add explicit v2 `temp-0001` IDs, entry
   keys/hash vector, branch/repository identity, and validation fields. Prove v1
   hash vectors remain stable, old binaries fail closed on v2, and cross-version
   records cannot smuggle path-bearing fields.
4. Add parser/runtime RED cases for operator transaction ID grammar,
   unknown/duplicate flags, same-ID precommit retry, ownership recognition, and
   different-ID collision. Implement discovery and public `tempResidues` count.
   Keep `expected-count` as total Git-status frames.
5. Extend apply, crash recovery, validation preconditions, restore, and restore recovery. Cover every physical A/R/P state and no-overwrite behavior for temp entries.
6. Run the complete quarantine focused matrix and static export checks.
7. Commit `feat: quarantine verified temporary residues`.

## Task 2 — Separate regenerated-root validation from restoration evidence

**Files:**

- Modify `scripts/quarantine-workspace-runtime.mjs`
- Modify `scripts/quarantine-lifecycle-internal.mjs`
- Modify `scripts/quarantine-inventory*.mjs`
- Modify manifest/journal only if the evidence schema requires a versioned field
- Modify validation, restore, inventory, crash, and lifecycle core tests

1. RED: two independently regenerated but byte-different-from-original roots must validate when both post-regeneration captures match; original payload inventories remain unchanged.
2. RED: first/second regenerated capture mismatch, numbered/temp residue, root replacement, ancestor swap, unsupported endpoint, missing root, or identity drift must fail before `VALIDATED` and preserve journal/pointer/payload.
3. Implement unique validation-attempt IDs, four immutable inventory files,
   manifest-bound summaries, safe retry/cleanup, and branch/root/ancestor binding
   while retaining immutable pre-move summaries for restore.
4. Prove restore still validates and restores original generated payload by original identities/inventories.
5. Run all quarantine suites twice where crash/fault timing is involved.
6. Commit `fix: validate stable regenerated quarantine roots`.

## Task 3 — Prove the 76-record operation on an exact disposable clone

1. Create a disposable repository fixture containing exact byte/mode copies of
   the 37 numbered files and 39 zero-byte temp residues plus generated roots.
   Build it at runtime outside Git under a mode-0700 directory, never add residue
   bytes to history, and remove it through fixture-owned cleanup after evidence.
2. Run the real canonical CLI inspect/apply/regenerate/mark-validated sequence
   and verify the live acceptance shape without touching the original checkout.
3. Exercise resume, rollback, and restore for that exact 78-entry manifest;
   Task 9 and the aggregate gate add reconcile to the same runtime fixture.
4. Preserve the original checkout unchanged until final Task 10.

## Task 4 — Remediate dependency advisories

**Files:**

- Modify `package.json`, `package-lock.json`
- Modify `docs/operations/npm-audit-exceptions.json`
- Modify dependency audit evidence documentation
- Modify `scripts/check-audit.mjs` and its tests if report separation is needed
- Modify version/CI contract tests

1. Snapshot full and production-only audit JSON.
2. RED version contracts for exact Next 16.3.0, Prisma 7.9.1, Undici 7.29.0, and PostCSS 8.5.26 in both package and lockfile.
3. Upgrade exact direct dependencies and regenerate lockfile under Node 22.22.2.
4. Remove resolved exceptions; add no high/critical exception. Update review dates only for live, justified moderate/low exceptions.
5. Make policy output distinguish full and production graphs without weakening the full blocking gate.
6. Run audit, version, install, Prisma, build, test, and extension E2E gates.
7. Commit `fix: remediate dependency security advisories`.

## Task 5 — Add real PostgreSQL 17 interruption proof and harden backup operations

**Files:**

- Add `__tests__/scripts/create-snapshot-backup.docker.integration.test.ts`
- Modify `package.json`
- Modify `.github/workflows/ci.yml`
- Modify `.github/workflows/production-backup.yml`
- Modify `scripts/create-snapshot-backup.mjs` only for defects exposed by real Docker
- Modify `scripts/fingerprint-database.mjs`
- Modify workflow/backup tests
- Modify `docs/operations/production-runbook.md`

1. RED CI/workflow contracts for a pinned PostgreSQL 17 Docker integration job, PG17 dump and restore version checks, and unconditional partial cleanup.
2. Implement digest-pinned PG17 source/tool containers and block `pg_dump` with
   Application ACCESS EXCLUSIVE lock; never depend on host PostgreSQL clients.
3. Test SIGINT and SIGTERM invariants: exit code, no processes/connections/locks, no credentials/control/partial outputs, and secret-free logs/metadata.
4. Fix coordinator behavior only where the real test demonstrates a defect.
5. Replace raw `pg_dump "$DATABASE_URL"` instructions with mode-0600 service/pass files or the repository wrapper.
6. Add all program tables to database fingerprint parity.
7. Run fake and real integration suites plus workflow contracts.
8. Commit `test: prove PostgreSQL 17 backup interruption cleanup`.

## Task 6 — Implement the closed Application request contract

**Files:**

- Add `src/lib/applications/contract.ts`
- Add `__tests__/lib/applications/contract.test.ts`
- Modify application collection/detail routes
- Modify `src/components/ApplicationDetail.tsx`
- Modify request-body helper only where bounded parsing is shared
- Modify protected/deployment API tests

1. RED pure parser tables for accepted/normalized and every rejected field/type/enum/date/URL/query/sort/size boundary.
2. Implement closed null-prototype or immutable normalized results and stable public errors.
3. Wire GET/POST/PATCH so invalid input never invokes Prisma.
4. Add the detail-form serializer so nullable empty fields and empty job type
   are sent as null; preserve authentication/CORS ordering and existing 404
   semantics.
5. Run contract, protected route, deployment integration, lint, and typecheck.
6. Commit `feat: validate application API inputs`.

## Task 7 — Add canonical identity, migration, backfill, and atomic create

**Files:**

- Add `src/lib/applications/identity.ts`
- Add identity tests
- Modify `prisma/schema.prisma`
- Add additive Prisma migration
- Add `scripts/backfill-application-identities.mjs` and tests
- Modify application POST route and clients
- Modify database/fingerprint/integration tests

1. RED canonicalization tables for tracking removal, meaningful parameter preservation, ordering, default ports, fragments/credentials, Unicode/NFC, and digest-collision fail-closed behavior.
2. Add nullable identity/backfill fields and unique/index constraints; generate Prisma client and verify migration SQL is additive.
3. RED real PostgreSQL concurrency test with 20 identical POSTs.
4. Implement the raw insert with application UUID, one bound timestamp for all
   required timestamps/defaults, explicit DTO mapping, canonical collision 409,
   and one bounded delete-race retry. Return one 201 and nineteen 200 responses
   without mutation.
5. Deploy additive schema with legacy writes still active, then enter a
   documented maintenance writer stop. Implement dry-run-first backfill with deterministic winners, intact
   duplicate rows, unresolved legacy rows, CHECK-constrained states, self-FK
   `ON DELETE RESTRICT`, idempotent reruns, and privacy-safe mode-0600 JSON
   report. Enable identity-aware POST only after verification, then resume writers.
6. Update manual URL UI and extension request behavior for required URL and `result:"existing"`.
7. Prove row-count preservation, unique active identities, backup fingerprint parity, and rollback compatibility.
8. Commit `feat: add atomic application identity`.

## Task 8 — Replace the extension root token with installation credentials

**Files:**

- Modify Prisma schema and add migration
- Add installation authentication module
- Modify protected route/auth modules
- Add pairing, verify, self-revoke, management, and minimal profile API routes
- Modify settings UI
- Modify extension popup/background/manifest as required
- Modify auth, route, extension unit/E2E, migration, and backup tests

1. RED model and crypto tests: 256-bit secrets, domain-separated HMAC, timing-safe verify, no plaintext persistence, exact token grammar.
2. RED API tests: one-time/expired/replayed/wrong-origin pair codes; two distinct installations; origin binding; revoke/expiry/deletion isolation; scope denial; root bearer rejection from extension origins.
3. Add additive pairing and installation tables and indexes; redesign E2E to
   discover two isolated extension origins before app startup and configure both.
4. Make authentication async and principal-aware while preserving all existing web/session/root-monitor behavior.
5. Implement management UI and minimal scoped endpoints.
6. RED extension state-machine tests for pairing, legacy purge, storage failure,
   revoke-first disconnect, offline local-secret purge plus
   `remoteRevocationUnconfirmed`, stale generation, 401, and host permission cleanup.
7. Implement extension changes without widening permissions.
8. Run two-installation Chromium E2E and backup/restore fingerprint tests.
9. Commit `feat: scope extension installation credentials`.

## Task 9 — Add lifecycle reconciliation and operator documentation

**Files:**

- Modify quarantine CLI and read-only state authority
- Modify CLI/lifecycle tests
- Add `docs/operations/quarantine-runbook.md`
- Modify `README.md`
- Modify docs contract tests
- Annotate completed lifecycle design/plan documents

1. RED `reconcile` tests across every normal/intermediate/terminal apply and
   restore state plus tampered evidence.
2. Implement a separate read-only authority with required writer-stopped
   coherent-snapshot attestation, no lock reclaim, cleanup, or journal mutation,
   and exact versioned `complete`/`nextAction` mapping.
3. Add README safety summary and complete runbook with commands, flags, JSONL, exit codes, writer attestation, recovery decision tree, retention meaning, and prohibited actions.
4. Mark historical lifecycle documents complete without erasing original evidence.
5. Run CLI, docs-contract, facade, recovery, and restore suites.
6. Commit `docs: publish quarantine operator workflow`.

## Task 10 — Aggregate gate, final merge, live quarantine, and push

**Original checkout:** `/Users/taejunoh/Developer/LFG/easy-job-application-tracker`

1. Ensure no stale Jest, Next, Prisma, Docker, or backup process from this worktree.
2. Run fresh install/generation, audits, migration checks, focused slice suites, full Jest no-cache, Docker backup integration, extension E2E, lint zero warnings, typecheck, production build, extension syntax, and diff checks.
3. Independently review specification compliance and code quality; fix every Critical/Important issue and rerun affected gates.
4. Fetch origin, verify fast-forward ancestry/push authentication, and compare
   NUL-delimited changed tracked paths with all 76 untracked paths; intersection
   must be empty.
5. Fast-forward `codex/release-readiness-program` into local `main`; record the final
   immutable HEAD and rerun the audit gate before touching user files.
6. Recheck the fixed HEAD, no tracked changes, exactly 76 untracked records, 37
   numbered paths, and 39 temp paths; recompute rather than assert baseline
   identical/divergent counts. On original `main`, create the external
   mode-0700 same-device root, inspect expected count 76, apply with stopped
   writers using an operator-generated transaction ID already persisted in a
   mode-0600 external operator log, regenerate, run required gates, and
   mark that transaction VALIDATED.
7. Prove original status contains no untracked residues, manifest contains 78
   entries, retained payload and inventories are intact, deadline is exactly 96
   hours, and no automatic deletion exists. Do not change HEAD afterward.
8. Push the same fixed `main` HEAD to `origin/main` and verify synchronization.
9. Report commits, exact gate counts, transaction/deadline, retained payload
   location, and the intentionally time-gated final deletion review.
