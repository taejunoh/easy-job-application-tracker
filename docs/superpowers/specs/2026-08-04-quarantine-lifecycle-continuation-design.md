# Quarantine Lifecycle Continuation Design

## Status and precedence

Foundation Cleanup is complete through Task 2, Slice 2 (atomic journaled
apply). The remaining work is Slice 3 recovery, Slice 4 validation and
four-day retention, Slice 5 restore and restore recovery, Slice 6 facade and
closed CLI, and the aggregate gate.

This continuation spec amends ambiguities in the original Foundation Cleanup
design and implementation plan. It takes precedence over those documents only
for the two decisions recorded here: the narrow internal lifecycle-core
boundary and the canonical CLI invocation. All other original requirements,
interfaces, security rules, sequencing constraints, and review gates remain
authoritative.

## Decision 1: narrow internal lifecycle core

Before Slice 4 needs shared existing-run handling, introduce one narrow,
internal-only module, preferably `scripts/quarantine-lifecycle-core.mjs`.
Validation and restore both reuse this module. Its responsibility is limited to
the capability-bound lifecycle setup for an already existing run, one captured
and frozen `fsApi` snapshot for each callback capability, and the validated
handoff of the exact run state needed by the caller: repository root, run/root
identity, exact HEAD, journal tip, manifest generation, and generation/state
metadata.

The core is a coordination boundary, not a second implementation of the
quarantine security model. It must use the existing capability, bootstrap,
path-validation, identity, and security authorities rather than duplicating
their logic. Existing-run validation must be exact and populated: it validates
the selected run's recorded identity and state, journal, generation, and
repository/HEAD evidence. It must not silently perform a generic bootstrap or
accept an empty or merely well-shaped run as a substitute for the requested
state.

The module is imported only by internal implementation call sites. It is never
re-exported from `quarantine-transaction`, `quarantine-workspace-runtime`, the
compatibility facade, or the CLI. The original public export sets remain
unchanged, and the Slice 3 `recoverQuarantine` and Slice 4
`markQuarantineValidated` interfaces remain exactly those defined in the
original plan. No new public API is introduced by this amendment.

## Decision 2: canonical CLI invocation

The public, documented form is exactly:

```text
npm run cleanup:quarantine -- <command> ...
```

The package script remains:

```json
"cleanup:quarantine": "node scripts/quarantine-numbered-copies.mjs"
```

Direct `node scripts/quarantine-numbered-copies.mjs ...` invocation is an
internal or testing detail only. It must not appear as the user-facing guide,
API, or canonical CLI contract. User documentation, examples, and canonical
CLI tests use the npm form, including the `--` separator.

## Sequence and task boundary

Keep the work reviewable and TDD-driven, with a focused RED test, GREEN
implementation, and review gate for each slice.

1. **Slice 3 — recovery in the runtime.** Finish apply recovery and rollback
   in the existing runtime/transaction implementation. Do not extract the
   lifecycle core here; this slice remains recovery work and preserves its
   approved interface.
2. **Slice 4 — validation and retention.** Introduce the narrow lifecycle-core
   boundary immediately before validation requires it. Extract only the shared
   existing-run setup and handoff, add focused tests for the core, and reuse it
   for validation. Establish four-day retention only when the run reaches
   `VALIDATED`.
3. **Slice 5 — restore and restore recovery.** Reuse the same core and its
   validated handoff for restore. Keep restore lifecycle and recovery behavior
   in the restore/runtime implementation and preserve the approved restore
   interfaces.
4. **Slice 6 — facade and closed CLI.** Close the compatibility facade and
   CLI around the already reviewed implementations, preserve the exact public
   export set, and document/test the canonical npm invocation.
5. **Aggregate gate.** Run the complete focused and full suites, static checks,
   build, and independent review before any final integration or original
   checkout operation.

## Security and error invariants

- Existing-run operations validate the exact populated run identity and state;
  generic bootstrap is not a recovery or validation fallback.
- No caller-supplied raw path is accepted as a mutation destination. Paths are
  derived from the live capability, fixed purpose/ID rules, and validated run
  state.
- Mutation code never follows symlinks. A root, run, parent, or target
  replacement is rejected by identity and containment checks; foreign
  replacements are never chmodded, deleted, or overwritten.
- The callback capability has one captured, frozen filesystem snapshot. No
  callback may create or switch among multiple mutable `fsApi` snapshots, and
  private registries, fault helpers, and lifecycle-core internals are not
  public exports.
- Retention begins only after durable `VALIDATED` publication. The four-day
  deadline is metadata for retained evidence; no command schedules or performs
  automatic deletion.
- Errors preserve evidence and fail closed at identity, state, journal, or
  generation mismatches. Indeterminate append and conflict results retain the
  original and replacement evidence for explicit recovery.

## Verification and testing contract

Each slice has focused RED/GREEN tests and a review checkpoint before the next
slice. The verification contract includes:

- exact, bytewise-sorted public export-set assertions, including assertions
  that the lifecycle core, filesystem-context registry, runtime internals, and
  fault helpers are not exported;
- real child-process `SIGKILL` recovery coverage for both apply and restore,
  across durable event, rename, sync, and cleanup seams;
- canonical CLI tests that spawn `npm run cleanup:quarantine -- ...`; direct
  `node` invocation is permitted only inside an internal harness where the
  npm wrapper is not the subject under test;
- full tests plus lint, typecheck, build, `git diff --check`, and independent
  review at the aggregate gate. The aggregate review must include path,
  symlink, identity, journal/generation, concurrency, and retention evidence.

## Non-goals

This continuation does not authorize:

- automatic deletion or any deletion workflow;
- starting the 96-hour retention clock before durable `VALIDATED`;
- touching, moving, or deleting the user's untracked numbered or temporary
  files while implementing the continuation;
- a broad refactor, a second lifecycle architecture, or any new public API;
- changing the original Slice 3/Slice 4 interfaces, public export contracts,
  or other requirements not expressly amended above.

## Five-stage decomposition for a later writing-plans pass

1. Complete and review Slice 3 apply recovery and rollback in the runtime.
2. Add and test the narrow internal lifecycle core, then use it to implement
   and verify Slice 4 validation and post-`VALIDATED` retention metadata.
3. Reuse the core for Slice 5 restore and restore recovery, including real
   interruption tests and conflict/evidence preservation.
4. Complete Slice 6's exact facade export set and closed CLI, with all public
   documentation and tests using `npm run cleanup:quarantine -- ...`.
5. Execute the aggregate tests, lint, typecheck, build, security/error review,
   and final scope checks before integration.
