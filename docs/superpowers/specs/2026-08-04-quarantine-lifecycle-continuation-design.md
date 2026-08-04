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

The core may be imported into internal implementation bodies of
`quarantine-transaction`, `quarantine-restore`, and
`quarantine-workspace-runtime`. No module may export, re-export, return, or
otherwise expose any lifecycle-core binding; the core has no public API. The
original public export sets remain unchanged, and the Slice 3
`recoverQuarantine` and Slice 4 `markQuarantineValidated` interfaces remain
exactly those defined in the original plan.

### Private-core handoff contract

The internal handoff has one ordered, testable sequence:

1. Capture the supplied `fsApi`, or the existing default filesystem source when
   it is omitted, and freeze that exact source before the first `await`.
2. Bind that snapshot to the live callback capability; all later core work
   uses the bound snapshot and cannot select another mutable adapter.
3. Derive the selected transaction and run root only through capability rules,
   never from a caller path string.
4. Validate the live quarantine/run-root identity, repository root and exact
   HEAD, the replayed durable journal tip, and the applicable journal-named
   immutable manifest generation and state.
5. Reject every identity, state, digest, pointer, or adapter mismatch before
   validation or restore mutation.
6. Return only the minimum frozen, validated handoff required by the internal
   caller; no capability, registry, raw path, or mutable adapter escapes.

Any precondition failure leaves journal, manifest pointer, and payload bytes
unchanged. In particular, an interrupted pointer publication is evidence to
validate and reconcile, not permission to publish a replacement during
precondition checking.

Generation provenance is state-specific. For a `QUARANTINED` run, obtain and
validate the baseline digest and generation from the semantic `PREPARED` ledger
record; that immutable manifest is in state `PREPARED`. Do not require a
`QUARANTINED` tip payload or a `QUARANTINED` manifest generation. For an
already durable `VALIDATED` run, the `VALIDATED` journal tip payload names the
authoritative immutable `VALIDATED` generation and digest, including its stored
retention metadata. Restore uses the applicable durable state-specific evidence
for the run it is restoring.

Pointer retry semantics are equally narrow. Preconditions never repair or
replace a pointer. A missing `current` pointer with a valid durable
`VALIDATED` tip and its exact journal-named generation is an
activation-pending, recoverable state; only after all validation succeeds may
activation publish that same existing digest. Any present malformed, foreign,
path-bearing, or mismatched pointer is fatal and causes no mutation. Tests must
distinguish precondition no-mutation from this explicitly allowed
post-validation activation.

Slice 4's tracked deliverables are the new
`scripts/quarantine-lifecycle-core.mjs`, a focused private-core test suite
(the final test filename may be selected by the later writing-plans pass), the
transaction validation integration that consumes the handoff, and staging and
review of all of those changes together. This core is the only existing-run
setup path for validation and restore; Slice 5 completes and verifies restore's
reuse of it.

The private-core RED cases must cover forged or stale run identity, changed
quarantine root or repository HEAD, torn or changed journal, a wrong, missing,
or corrupt journal-named immutable generation, interrupted pointer
publication, missing-pointer activation-pending retry, each fatal present
pointer variant, and `fsApi` identity or method mutation. Every failure case
must prove that no journal, pointer, or payload mutation occurred; the
activation-pending case must separately prove byte preservation before its
allowed post-validation activation.

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

## Superseded plan wording

The historical design and plan remain unchanged records. For implementation
and documentation, however, the old Slice 6 bare `cleanup:quarantine ...`
examples are superseded by these five independently spawned and tested command
forms:

```text
npm run cleanup:quarantine -- inspect --repo-root <abs> --quarantine-root <abs> --expected-branch <name> --expected-head <sha> --expected-count <n>
```

```text
npm run cleanup:quarantine -- apply --repo-root <abs> --quarantine-root <abs> --expected-branch <name> --expected-head <sha> --expected-count <n> --writers-stopped
```

```text
npm run cleanup:quarantine -- recover --repo-root <abs> --quarantine-root <abs> --transaction-id <id> --action <action> --writers-stopped
```

The recover form is spawned independently with `<action>` set to `resume` and
again with it set to `rollback`.

```text
npm run cleanup:quarantine -- mark-validated --repo-root <abs> --quarantine-root <abs> --transaction-id <id> --writers-stopped
```

```text
npm run cleanup:quarantine -- restore --repo-root <abs> --quarantine-root <abs> --transaction-id <id> --writers-stopped
```

The old Slice 4 file/test scope is superseded and expanded by the lifecycle-core
module, focused private-core suite, transaction validation integration, and
their joint staging and review described above. Direct `node` invocation
remains internal/testing detail only.

## Sequence and task boundary

Keep the work reviewable and TDD-driven, with a focused RED test, GREEN
implementation, and review gate for each slice.

1. **Slice 3 — recovery in the runtime.** Finish apply recovery and rollback
   in the existing runtime/transaction implementation. Do not extract the
   lifecycle core here; this slice remains recovery work and preserves its
   approved interface.
2. **Slice 4 — validation and retention.** Add
   `scripts/quarantine-lifecycle-core.mjs`, its focused private-core RED/GREEN
   suite, and the transaction validation integration. Exercise forged/stale
   identity, root/HEAD drift, torn/changed journal, missing/wrong/corrupt
   generation, interrupted pointer publication, and adapter mutation, proving
   no precondition mutation. Establish four-day retention only when the run
   reaches `VALIDATED`, then stage and review all core and integration changes
   together.
3. **Slice 5 — restore and restore recovery.** Reuse that sole existing-run
   setup path and validated handoff for restore, complete the reuse tests, and
   keep restore lifecycle and recovery behavior in the restore/runtime
   implementation while preserving the approved restore interfaces.
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

1. Complete and review Slice 3 apply recovery and rollback in the runtime,
   including its required crash-boundary RED cases.
2. Add `scripts/quarantine-lifecycle-core.mjs`, the focused private-core suite,
   and transaction validation integration; run the exact private-core RED cases
   for state-specific generation provenance, missing-pointer activation-pending
   retry, fatal present-pointer variants, and adapter mutation, then
   stage/review all Slice 4 deliverables together.
3. Reuse the core for Slice 5 restore and restore recovery, including real
   apply/restore interruption tests and conflict/evidence preservation.
4. Complete Slice 6's exact facade export set and closed CLI, with all public
   documentation and tests using the five independently spawned command forms
   listed under Superseded plan wording (including separate recover runs for
   `resume` and `rollback`).
5. Execute the aggregate tests, lint, typecheck, build, security/error review,
   and final scope checks before integration.
