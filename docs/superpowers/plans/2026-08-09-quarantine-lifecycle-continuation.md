# Quarantine Lifecycle Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish quarantine lifecycle Slice 3 recovery, Slice 4 private-core validation and four-day retention, Slice 5 restore and restore recovery, Slice 6's exact facade and canonical npm CLI, then pass the aggregate verification gate.

**Architecture:** Preserve the existing capability, journal, manifest, inventory, and path-policy authorities. Add one private `scripts/quarantine-lifecycle-core.mjs` boundary before Slice 4; it captures the filesystem source once, validates an existing run, and hands exact state to internal validation/restore callbacks without adding a public API. Keep apply recovery in the runtime, reuse the core for validation and restore, then close the facade and CLI around the original final contracts.

**Tech Stack:** Node.js ESM on Node `>=22.22.2 <23`, Jest 30 with TypeScript/ts-jest tests, Prisma/Next project scripts, Git fixture repositories and child subprocesses, same-device filesystem moves, and real PostgreSQL 17 Docker fixtures where the existing backup gate requires them.

## Global Constraints

- Foundation Cleanup is complete through Task 2 Slice 2; execute tasks in order: Slice 3 recovery, Slice 4 core/validation/retention, Slice 5 restore/recovery, Slice 6 facade/CLI, aggregate gate.
- Preserve the existing capability, journal, manifest, inventory, and path-policy authorities; do not duplicate capability/bootstrap/path-validation/security logic.
- Add only the private internal lifecycle core; it may be imported inside transaction, restore, and runtime implementation bodies but no module may export, re-export, return, or otherwise expose a lifecycle-core binding.
- Preserve the approved public interfaces and final public export set; no new public API, runtime helper, filesystem-context registry, fault helper, or fixture export is allowed.
- Capture the supplied `fsApi`, or the existing default filesystem source when omitted, and freeze that exact source before the first `await`; bind one frozen snapshot to each callback capability.
- Existing-run validation is exact and state-specific: QUARANTINED uses the semantic PREPARED ledger digest/generation; VALIDATED uses the VALIDATED tip's journal-named generation and stored retention metadata.
- No caller-supplied raw path is a mutation destination; every mutation path is derived from the live capability and validated IDs. Never follow symlinks or chmod, delete, replace, or overwrite a foreign replacement.
- Preconditions are mutation-free. A missing current pointer with a valid durable VALIDATED tip is activation-pending and may publish only that exact existing digest after validation; any present malformed, foreign, path-bearing, or mismatched pointer is fatal with no mutation.
- Retention starts only after durable `VALIDATED`; `deleteAfter` is exactly `validatedAt + 96 hours`, `deletionStatus` is `"retained"`, and no task schedules or performs automatic deletion.
- Do not touch, move, or delete the user's untracked numbered or temporary files during implementation; fixture mutations stay inside disposable temporary repositories.
- Use TDD for every task: write focused RED tests, run the exact focused command and record the expected failure, implement the smallest GREEN change, rerun focused plus neighboring suites, and obtain a review gate before the next task.
- Apply and restore crash tests use real child-process `SIGKILL` at every named event, rename, sync, inventory, and lock-cleanup seam; exception injection is supplementary only.
- The public CLI is documented and tested only as `npm run cleanup:quarantine -- ...`; direct `node scripts/quarantine-numbered-copies.mjs ...` is internal harness detail.
- Final aggregate checks include the focused 12-suite command, `npm test -- --runInBand --no-cache`, lint with `--max-warnings=0`, typecheck, build, `git diff --check`, no-touch proof, retention/deletion review, and independent specification/code-quality review.

---

Line numbers below are orientation anchors from the current HEAD. Symbol names, exact interfaces, and schemas are authoritative if earlier edits move lines.

## File map

- Modify `scripts/quarantine-workspace-runtime.mjs:1222-2403` for recovery orchestration, private-core integration, validation, and exact runtime fault seams.
- Modify `scripts/quarantine-transaction.mjs:1-4` to expose the approved transaction surface as Slice 3 and Slice 4 APIs are added.
- Modify `scripts/quarantine-journal.mjs:497-723,1139-1188,1332-1345,1529-1560,1841-2083` only through its existing transition/replay/lock authorities and tests for semantic recovery evidence.
- Modify `scripts/quarantine-run-fs-context.mjs:20-123` so all source capture and bound-adapter lifecycle remains in the one private registry.
- Create `scripts/quarantine-lifecycle-core.mjs` as the private existing-run handoff boundary; it is never a facade or package export.
- Create `scripts/quarantine-restore.mjs` for normal restore and restore recovery; it exports exactly `restoreQuarantine` and `recoverRestore` at the final boundary.
- Modify `scripts/quarantine-numbered-copies-support.mjs:1-380` into the thin compatibility facade only in Task 7.
- Create `scripts/quarantine-numbered-copies.mjs` and modify `package.json`/`package-lock.json` only in Task 8.
- Modify `__tests__/scripts/quarantine-transaction.test.ts:1722-5001`, `__tests__/scripts/quarantine-journal.test.ts`, and create `__tests__/scripts/quarantine-transaction-crash.integration.test.ts` for Slice 3.
- Create `__tests__/fixtures/quarantine/quarantine-lifecycle-child.mjs` as the disposable child used by apply and restore crash suites.
- Create `__tests__/scripts/quarantine-lifecycle-core.test.ts` and extend transaction/core tests for private handoff and mutation-free preconditions.
- Reuse `__tests__/scripts/quarantine-manifest.test.ts:1265-1891` for generation/pointer retry assertions; create `__tests__/scripts/quarantine-restore.test.ts` and `__tests__/scripts/quarantine-restore-crash.integration.test.ts` for Slice 5.
- Modify `__tests__/scripts/quarantine-numbered-copies.test.ts:1-1046` for the exact final facade export set; create `__tests__/scripts/quarantine-cli.test.ts` for spawned npm CLI behavior.

### Task 1: Implement Slice 3 semantic apply recovery

**Files:**

- Modify: `scripts/quarantine-workspace-runtime.mjs:1222-2403` (`prepareWorkspaceCore`, `appendEvent`, `quarantineWorkspace`, and private recovery helpers)
- Modify: `scripts/quarantine-transaction.mjs:1-4` to re-export `recoverQuarantine`
- Modify: `scripts/quarantine-journal.mjs:497-723` (`validateTransition`, replay semantic validation, exact event payload parsers)
- Modify: `__tests__/scripts/quarantine-transaction.test.ts:1722-5001`
- Modify: `__tests__/scripts/quarantine-journal.test.ts:1-4644`

**Interfaces:**

- Consumes: the existing capability-bound `replayJournal`, `withJournalLock`, `appendJournalRecord`, `validateTransition`, `deriveRunPath`, `revalidateRunCapability`, inventory summaries, and the Slice 2 `quarantineWorkspace` result.
- Produces exactly:

```js
export async function recoverQuarantine({
  repoRoot, quarantineRoot, transactionId,
  action, writersStopped, fsApi, faultHook,
}) {}
```

`action` is exactly `"resume"` or `"rollback"`. Successful results are exactly:

```text
{ transactionId, status: "QUARANTINED"|"VALIDATED", action: "resume",
  reconciledEntries }
| { transactionId, status: "ROLLED_BACK", action: "rollback",
    reconciledEntries }
| { transactionId, status: "INCOMPLETE_CONFLICT",
    action: "resume"|"rollback", conflictEntryIds }
```

Journal events retain the closed schemas from the original plan: `PREPARED` payload `{ transactionId, manifestSha256 }`; lifecycle events `MOVING`, `VERIFYING`, `ROLLING_BACK`, and `ROLLED_BACK` with `{}`; `INCOMPLETE_CONFLICT` payload `{ conflictEntryIds }`; `MOVE_INTENT` payload `{ id, expected: InventorySummary }`; `MOVED` payload `{ id, observed: InventorySummary }`; `RECOVERY_REQUIRED` payload `{ entryIds: string[] }`; and `ROLLBACK_INTENT`/`ROLLED_BACK_ENTRY` payload `{ id }`. `entryIds` repeats every durable `MOVE_INTENT` in original forward journal order, including completed IDs, and is empty only before the first intent.

Private helper contracts used by this task are:

```ts
function snapshotRecoveryOptions(input: unknown): Readonly<{
  repoRoot: string; quarantineRoot: string; transactionId: string;
  action: "resume" | "rollback"; writersStopped: true;
  fsApi?: object; faultHook?: (phase: string) => void | Promise<void>;
}>;
function buildApplyLedger(records: readonly JournalRecord[]): ApplyLedger;
function recoverApplyOnCapability(args: { capability: object; options: RecoveryOptions }): Promise<RecoveryResult>;
function resumeApplyFromLedger(args: { capability: object; replay: JournalReplay; ledger: ApplyLedger; faultHook?: FaultHook }): Promise<RecoveryResult>;
function rollbackApplyFromLedger(args: { capability: object; replay: JournalReplay; ledger: ApplyLedger; faultHook?: FaultHook }): Promise<RecoveryResult>;
```

`InternalRunHandoff`, `JournalRecord`, `JournalReplay`, `ApplyLedger`, `FaultHook`, and `RecoveryResult` are private TypeScript-only test descriptions whose property names are the exact JavaScript records specified here; they are not exported runtime types.

- [ ] **Step 1: Write the semantic RED matrix.** Add tests that seed valid journal frames and filesystem fixtures for every source/payload row: source present plus payload absent; source absent plus matching payload; both present; both absent; absent source plus mismatching payload; present mismatching source plus absent payload; and both present with any mismatch. Assert resume/rollback actions, preserved evidence, and exact result shapes. Add PREPARED and MOVING crashes with no intent, durable non-bytewise intent order, all-completed intents, idempotent QUARANTINED resume, QUARANTINED rollback rejection, duplicate/out-of-order semantic events, torn frame, wrong digest, changed journal tip, changed root/run identity, stale lock, changed evidence, and fatal evidence loss.

```ts
it("builds RECOVERY_REQUIRED from the complete durable intent ledger", async () => {
  seedJournal([
    ["PREPARED", { transactionId: "tx-0001", manifestSha256: preparedDigest }],
    ["MOVING", {}],
    ["MOVE_INTENT", { id: "copy-0002", expected: summary("b") }],
    ["MOVED", { id: "copy-0002", observed: summary("b") }],
    ["MOVE_INTENT", { id: "copy-0001", expected: summary("a") }],
  ]);
  const result = await recoverQuarantine({ ...fixtureOptions, transactionId: "tx-0001", action: "resume", writersStopped: true });
  expect(recoveryRequiredPayload()).toEqual({ entryIds: ["copy-0002", "copy-0001"] });
  expect(result).toMatchObject({ transactionId: "tx-0001", action: "resume" });
});
```

Add journal RED assertions that valid individual frames still fail semantic replay when the intent ledger is duplicated, reordered by a completion event, or paired with a changed digest/tip. Assert no filesystem or journal mutation and no foreign replacement deletion.

- [ ] **Step 2: Run the Slice 3 semantic RED suites.**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-transaction.test.ts __tests__/scripts/quarantine-journal.test.ts
```

Expected: FAIL because `quarantine-transaction.mjs` does not export `recoverQuarantine`, semantic recovery results are absent, and the existing replay/transition path does not yet enforce the complete forward intent ledger.

- [ ] **Step 3: Implement replay-before-mutation and reverse rollback.** Add a private recovery path in `quarantine-workspace-runtime.mjs` that enters one live capability, replays the journal before touching the filesystem, appends `RECOVERY_REQUIRED` only through the existing held-lock append authority, and derives resume work from durable completion events while rollback walks the complete durable intent ledger in reverse order. Reuse the existing source/payload identity and inventory helpers; do not sort IDs. For each row, preserve both sides on conflict, move only the authorized side, reject missing evidence as `ERR_INTEGRITY`, reject a foreign/stale lock or changed tip before mutation, and map `IndeterminateJournalAppendError` to the existing sanitized error. A durable QUARANTINED resume returns the existing terminal result without mutation; rollback from QUARANTINED rejects and directs the operator to restore.

```js
export async function recoverQuarantine(input) {
  const options = snapshotRecoveryOptions(input); // closed object, action resume|rollback, writersStopped === true
  return withQuarantineRunCapability({
    repoRoot: options.repoRoot,
    quarantineRoot: options.quarantineRoot,
    transactionId: options.transactionId,
    writersStopped: options.writersStopped,
    fsApi: options.fsApi,
  }, async (capability) =>
    recoverApplyOnCapability({ capability, options }));
}
```

Keep `recoverQuarantine` in the transaction module's approved export surface; keep all ledger helpers private. Task 3 replaces only the existing-run setup around this callback with the shared lifecycle core.

- [ ] **Step 4: Run the semantic GREEN and neighboring tests.**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-transaction.test.ts __tests__/scripts/quarantine-journal.test.ts __tests__/scripts/quarantine-run-capability.test.ts
```

Expected: PASS for every matrix row, exact three result unions, no overwrite/delete of foreign evidence, no mutation on torn/wrong-digest/root-swap/stale-lock/tip-change/integrity failures, and unchanged existing capability/journal export assertions.

- [ ] **Step 5: Review, stage, and commit Slice 3 semantic recovery.** Obtain a specification review and code-quality review with Critical 0 / Important 0 / Minor 0. Then run:

```bash
git diff --check
git add scripts/quarantine-workspace-runtime.mjs scripts/quarantine-transaction.mjs scripts/quarantine-journal.mjs __tests__/scripts/quarantine-transaction.test.ts __tests__/scripts/quarantine-journal.test.ts
git commit -m "feat: recover interrupted quarantine moves"
```

### Task 2: Prove the real Slice 3 apply SIGKILL matrix

**Files:**

- Create: `__tests__/fixtures/quarantine/quarantine-lifecycle-child.mjs`
- Create: `__tests__/scripts/quarantine-transaction-crash.integration.test.ts`
- Modify: `scripts/quarantine-workspace-runtime.mjs:1290-2350` to expose the approved apply/recovery fault phases internally
- Modify: `__tests__/scripts/quarantine-transaction.test.ts:1722-5001` for shared fixture helpers and EXDEV assertions

**Interfaces:**

- Consumes: Task 1's `recoverQuarantine` and the existing `quarantineWorkspace` signature/result.
- Produces: a disposable child runner that accepts a JSON request and kills itself with `SIGKILL` at one exact phase; no production export or package API changes.
- Apply phases under test are exactly `after-prepared-generation`, `after-event:PREPARED`, `after-event:MOVING`, `after-event:VERIFYING`, `after-event:QUARANTINED`, `before-lock-cleanup`, `after-event:MOVE_INTENT:${entryId}`, `after-rename:${entryId}`, `after-payload-sync:${entryId}`, `after-destination-parent-sync:${entryId}`, `after-source-parent-sync:${entryId}`, `after-inventory:moved-pass-1:${entryId}`, `after-event:MOVED:${entryId}`, and `after-inventory:moved-pass-2:${entryId}`. Recovery adds `after-event:RECOVERY_REQUIRED`, `after-event:ROLLING_BACK`, `after-event:ROLLED_BACK`, `after-event:INCOMPLETE_CONFLICT`, `after-event:ROLLBACK_INTENT:${entryId}`, `after-rollback-rename:${entryId}`, `after-rollback-payload-sync:${entryId}`, `after-rollback-destination-parent-sync:${entryId}`, `after-rollback-source-parent-sync:${entryId}`, and `after-event:ROLLED_BACK_ENTRY:${entryId}`.

- [ ] **Step 1: Write the SIGKILL child and RED integration matrix.** Create the child with a closed JSON request and a phase hook:

```js
const request = JSON.parse(process.env.QUARANTINE_CHILD_REQUEST);
const faultHook = async (phase) => {
  if (phase === request.killAt) process.kill(process.pid, "SIGKILL");
};
const api = await import(new URL("../../../scripts/quarantine-transaction.mjs", import.meta.url));
await api[request.operation]({ ...request.options, faultHook });
```

Spawn that child once for every manifest-publication, journal-event, rename, payload-sync, destination-parent-sync, source-parent-sync, inventory-publication, and lock-cleanup seam. Assert exit by `SIGKILL`, capture the flushed transaction ID for apply, then run both `resume` and `rollback` from fresh fixtures. Assert `RECOVERY_REQUIRED.entryIds` keeps forward journal order, including all-completed intents; PREPARED/MOVING no-intent uses `[]`; a 4,097th intent is rejected before mutation; a valid non-bytewise order is never sorted.

```ts
const child = spawn(process.execPath, [fixturePath], { env: { ...process.env, QUARANTINE_CHILD_REQUEST: JSON.stringify(request) } });
const result = await collectChild(child);
expect(result.signal).toBe("SIGKILL");
expect(await resumeOrRollback(request.options, action)).toMatchObject(expected);
assertNoOverwriteOrForeignDeletion(fixture);
```

Add an `EXDEV` fixture by injecting rename `EXDEV`; assert no copy, unlink, or fallback call and frozen `ERR_EXDEV` when source identity and destination absence remain unchanged.

- [ ] **Step 2: Run RED.**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-transaction-crash.integration.test.ts
```

Expected: FAIL because the child fixture and crash suite do not exist and no recovery implementation yet satisfies every named seam.

- [ ] **Step 3: Wire exact fault phases to the existing runtime boundaries.** Keep hooks after the durable event or sync they name. Ensure `after-event:QUARANTINED` and `before-lock-cleanup` run inside the final journal primitive only after append mutation begins, while ordinary event hooks run after the append primitive returns. Ensure rollback hooks are distinct for rename, payload sync, destination-parent sync, and source-parent sync. Do not add a new filesystem adapter or path authority.

- [ ] **Step 4: Run the crash GREEN matrix and focused neighboring suites.**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-transaction-crash.integration.test.ts __tests__/scripts/quarantine-transaction.test.ts __tests__/scripts/quarantine-journal.test.ts
```

Expected: PASS for every actual SIGKILL seam, resume/rollback result union, no-overwrite conflict row, `EXDEV` no-copy assertion, and lock/tip evidence preservation.

- [ ] **Step 5: Review and commit the apply crash proof.** Obtain independent review of crash phase coverage and filesystem evidence, then run:

```bash
git diff --check
git add __tests__/fixtures/quarantine/quarantine-lifecycle-child.mjs __tests__/scripts/quarantine-transaction-crash.integration.test.ts scripts/quarantine-workspace-runtime.mjs scripts/quarantine-transaction.mjs __tests__/scripts/quarantine-transaction.test.ts
git commit -m "test: prove apply SIGKILL recovery"
```

### Task 3: Add the private existing-run lifecycle core

**Files:**

- Create: `scripts/quarantine-lifecycle-core.mjs`
- Create: `__tests__/scripts/quarantine-lifecycle-core.test.ts`
- Modify: `scripts/quarantine-run-fs-context.mjs:20-123` so source capture, frozen method/receiver snapshot, identity assertion, and invalidation remain the sole filesystem-context authority
- Modify: `scripts/quarantine-workspace-runtime.mjs:1250-1287,2369-2403` to call the private core for existing-run operations
- Modify: `scripts/quarantine-transaction.mjs:1-4` only for internal import wiring, never for a new public export
- Modify: `__tests__/scripts/quarantine-transaction.test.ts:1722-5001` for validation of internal handoff consumption

**Interfaces:**

- Consumes: `withQuarantineRunCapability`, `getRunFsContext`, `bindRunFsContext`, `invalidateRunFsContext`, `replayJournal`, `readManifestGeneration`, `readCurrentManifestPointer`, `deriveRunPath`, and the exact public operation options.
- Produces one private, non-exported function with this exact callback contract:

```js
async function withExistingQuarantineRun(
  { repoRoot, quarantineRoot, transactionId, writersStopped, fsApi },
  callback,
) {}
```

The closed options object contains exactly those five keys, with `fsApi` optional and `writersStopped` required to be literal `true`. `callback` is invoked once with a frozen internal handoff whose exact keys are:

```text
{
  capability,
  repoRoot,
  quarantineRoot,
  runRoot,
  transactionId,
  head,
  journalTip,
  manifestGeneration,
  fsApi
}
```

The handoff exists only during the internal callback; it is not returned by the public operation, exported, serialized, or stored after callback settlement. `journalTip` contains exact `sequence`, `recordHash`, `event`, `state`, and closed `payload`. `manifestGeneration` contains only the validated journal-named digest, state, and closed manifest value needed by the internal caller. `fsApi` is the bound frozen adapter, not a caller-mutated source.

The private helper signatures are fixed for implementation and tests:

```ts
function snapshotExistingRunOptions(input: unknown): ExistingRunOptions;
function captureFsSource(source?: object): FrozenFsSource;
function validateExistingRun(args: { capability: object; fsApi: object } & ExistingRunOptions): Promise<{
  repoRoot: string; quarantineRoot: string; runRoot: string; transactionId: string;
  head: string; journalTip: JournalTip; manifestGeneration: ManifestGeneration;
}>;
```

`ExistingRunOptions` is the five-key closed record defined above; `FrozenFsSource` is the existing 14-method source contract; `JournalTip` and `ManifestGeneration` are the frozen records in the handoff. These names are private descriptions only and are not runtime exports.

- [ ] **Step 1: Write private-core RED tests before implementation.** Assert the exact handoff key set/prototypes/descriptors/frozen state and callback-only lifetime. Cover supplied adapter capture and omitted default adapter capture before the first await; adapter identity mutation and method replacement after capture; forged capability; stale run identity; changed quarantine root or repository HEAD; torn or changed journal; wrong, missing, or corrupt journal-named generation; interrupted pointer publication; symlink/foreign replacement; and no journal, pointer, or payload mutation on every precondition failure.

```ts
it("captures the supplied adapter before the first await and preserves evidence on stale input", async () => {
  const source = instrumentedFsApi();
  const bytesBefore = readEvidenceBytes();
  await expect(withCore({ ...existingRunOptions, fsApi: source }, async (handoff) => {
    expect(Object.keys(handoff).sort()).toEqual([
      "capability", "fsApi", "head", "journalTip", "manifestGeneration",
      "quarantineRoot", "repoRoot", "runRoot", "transactionId",
    ]);
    return handoff.fsApi;
  })).resolves.toBeDefined();
  await expect(withCore({ ...existingRunOptions, fsApi: instrumentedFsApi() }, async () => {
    throw new Error("callback must not run for stale evidence");
  })).rejects.toThrow();
  expect(readEvidenceBytes()).toEqual(bytesBefore);
});
```

Add state-specific tests: QUARANTINED obtains baseline digest/generation from PREPARED and requires manifest state PREPARED; it does not require a QUARANTINED tip payload or QUARANTINED generation. VALIDATED obtains the digest/generation and stored retention metadata from the VALIDATED tip. Add pointer tests that distinguish missing activation-pending from present malformed, foreign, path-bearing, or mismatched fatal pointers.

- [ ] **Step 2: Run the private-core RED suite.**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-lifecycle-core.test.ts
```

Expected: FAIL because `scripts/quarantine-lifecycle-core.mjs` is absent and the existing runtime still owns source capture/hand-off setup.

- [ ] **Step 3: Move source capture into the existing fs-context authority and implement the private core.** In `quarantine-run-fs-context.mjs`, make the supplied source or `DEFAULT_SOURCE` snapshot occur before any filesystem await, evaluate each of the 14 method getters once, freeze the source and adapter, bind the exact source object to the live capability, and invalidate it before callback settlement on both success and failure. In `quarantine-lifecycle-core.mjs`, create the capability, derive the lexical transaction/run root only through capability rules, replay the journal, validate live run/root/repository identity and exact HEAD, then validate the state-specific generation and pointer evidence. Reject all mismatches before invoking the callback; return only the frozen internal handoff above. Do not reimplement path containment, bootstrap, or security checks.

```js
async function withExistingQuarantineRun(options, callback) {
  const input = snapshotExistingRunOptions(options); // no await
  const source = captureFsSource(input.fsApi); // supplied or default, frozen before await
  return withQuarantineRunCapability({ ...input, fsApi: source }, async (capability) => {
    const fsApi = getRunFsContext(capability, source);
    const handoff = await validateExistingRun({ capability, fsApi, ...input });
    return callback(Object.freeze({ ...handoff, capability, fsApi }));
  });
}
```

The function is internal to the implementation modules; do not export it from `quarantine-lifecycle-core.mjs` or any public module.

- [ ] **Step 4: Run GREEN and verify no new public exports.**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-lifecycle-core.test.ts __tests__/scripts/quarantine-run-capability.test.ts __tests__/scripts/quarantine-transaction.test.ts __tests__/scripts/quarantine-journal.test.ts __tests__/scripts/quarantine-manifest.test.ts
```

Expected: PASS with source/method mutation rejected, exact state-specific provenance, pointer precondition mutation-free, callback invalidation, and unchanged public export assertions. `Object.keys(await import("../../scripts/quarantine-lifecycle-core.mjs"))` is asserted as an empty array by the private-core test.

- [ ] **Step 5: Review and commit the private-core refactor.** Review that source capture was moved, not duplicated, and that no lifecycle-core binding escapes. Then run:

```bash
git diff --check
git add scripts/quarantine-lifecycle-core.mjs scripts/quarantine-run-fs-context.mjs scripts/quarantine-workspace-runtime.mjs scripts/quarantine-transaction.mjs __tests__/scripts/quarantine-lifecycle-core.test.ts __tests__/scripts/quarantine-transaction.test.ts
git commit -m "refactor: add private quarantine lifecycle core"
```

### Task 4: Implement Slice 4 validation, retention, and pointer retry

**Files:**

- Modify: `scripts/quarantine-workspace-runtime.mjs:1222-2403` to call the private core and implement validation orchestration
- Modify: `scripts/quarantine-transaction.mjs:1-4` to export `markQuarantineValidated`
- Modify: `scripts/quarantine-manifest.mjs:589-974` only through immutable generation/pointer authorities
- Modify: `__tests__/scripts/quarantine-transaction.test.ts:1722-5001`
- Modify: `__tests__/scripts/quarantine-lifecycle-core.test.ts`
- Modify: `__tests__/scripts/quarantine-manifest.test.ts:1265-1891`

**Interfaces:**

- Consumes: Task 3's private `withExistingQuarantineRun`, `writeInventoryJsonl`, `compareInventorySummary`, `buildValidatedManifest`, `writeManifestGeneration`, `activateManifestGeneration`, `readCurrentManifestPointer`, `readManifestGeneration`, and the QUARANTINED/VALIDATED journal states.
- Produces exactly:

```js
export async function markQuarantineValidated({
  repoRoot, quarantineRoot, transactionId, validatedAt,
  writersStopped, fsApi, faultHook,
}) {}
```

Successful result is exactly:

```js
{
  transactionId,
  status: "VALIDATED",
  manifestSha256,
  validatedAt,
  deleteAfter,
  deletionRequiresConfirmation: true,
}
```

Validation fault phases are exactly `after-inventory:validation-pass-1:${generatedEntryId}`, `after-inventory:validation-pass-2:${generatedEntryId}`, `after-validated-generation`, `after-event:VALIDATED`, `after-pointer-temporary-sync`, `after-pointer-rename`, `after-pointer-root-sync`, and `before-lock-cleanup`.

Private helper signatures are:

```ts
function requireQuarantinedOrValidated(tip: JournalTip): "QUARANTINED" | "VALIDATED";
function pickExistingRunOptions(input: ValidationOptions): ExistingRunOptions;
function writeAndCompareValidationPasses(handoff: InternalRunHandoff, faultHook?: FaultHook): Promise<Readonly<Record<"generated-next" | "generated-node-modules", InventorySummary>>>;
function obtainValidatedGeneration(args: { handoff: InternalRunHandoff; state: "QUARANTINED" | "VALIDATED"; summaries: ValidationSummaries; validatedAt: string }): Promise<ValidatedGeneration>;
function appendValidatedIfNeeded(handoff: InternalRunHandoff, digest: string, faultHook?: FaultHook): Promise<void>;
function activateOnlyAfterValidation(handoff: InternalRunHandoff, digest: string, faultHook?: FaultHook): Promise<"published" | "already-present">;
function freezeValidatedResult(generation: ValidatedGeneration): ValidatedResult;
```

`ValidationSummaries`, `ValidatedGeneration`, and `ValidatedResult` are the exact closed records already described by the manifest/result contracts; they are not public TypeScript exports.

- [ ] **Step 1: Write validation RED tests.** Seed a QUARANTINED run whose PREPARED ledger names the baseline generation, regenerate `.next` and `node_modules`, and assert clean Git status, matching repository root and exact HEAD, no source numbered copies, two independent validation inventories per generated ID, matching summaries, and no numbered basename in either JSONL stream. Add failures for changed HEAD/root, tracked/staged/unexpected untracked residue, missing generated root, inventory drift, stale foreign lock, another transaction, wrong PREPARED generation, and a path-bearing current pointer; capture journal/pointer/payload bytes before each failure and assert unchanged.

```ts
it("publishes one VALIDATED generation with exact four-day retention", async () => {
  const result = await markQuarantineValidated({ ...validatedOptions, validatedAt: "2026-08-09T12:00:00.000Z", writersStopped: true });
  expect(result).toEqual({
    transactionId: "tx-0001",
    status: "VALIDATED",
    manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    validatedAt: "2026-08-09T12:00:00.000Z",
    deleteAfter: "2026-08-13T12:00:00.000Z",
    deletionRequiresConfirmation: true,
  });
  const generation = await readManifestGeneration({ capability: fixtureCapability, manifestSha256: result.manifestSha256 });
  expect(generation.deletionStatus).toBe("retained");
});
```

Add VALIDATED retry with a different supplied `validatedAt`: require the journal tip digest and stored timestamps, no second digest, and exact result reuse. Add SIGKILL/retry cases after VALIDATED append and before pointer publication. A missing current pointer plus valid durable VALIDATED tip and exact generation is activation-pending; after all validation it may publish only the same digest. A present malformed, foreign, path-bearing, or mismatched pointer is fatal with byte-preserving failure. Test precondition no-mutation separately from allowed post-validation activation.

- [ ] **Step 2: Run validation and manifest RED suites.**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-transaction.test.ts __tests__/scripts/quarantine-lifecycle-core.test.ts __tests__/scripts/quarantine-manifest.test.ts
```

Expected: FAIL because `markQuarantineValidated` is not exported by the transaction module and the current legacy validation does not publish the journal-named immutable generation/pointer with state-specific retry semantics.

- [ ] **Step 3: Implement two-pass validation and retained generation publication.** Inside `withExistingQuarantineRun`, replay exact state evidence, write `validation-pass-1` and `validation-pass-2` JSONL independently for `generated-next` and `generated-node-modules`, compare summaries, and reject numbered basenames/unexpected residue before any VALIDATED append. On QUARANTINED, build the closed VALIDATED manifest with `deleteAfter = validatedAt + 96 hours`, `deletionStatus: "retained"`, and `deletionRequiresConfirmation: true`; write the immutable generation, append `{ manifestSha256 }` as VALIDATED, then perform pointer activation. On an already VALIDATED run, ignore supplied `validatedAt`, validate the tip-named generation and stored metadata, and activate only the same existing digest when `current` is missing. Never repair a pointer during preconditions and never delete quarantine content.

```js
export async function markQuarantineValidated(input) {
  return withExistingQuarantineRun(pickExistingRunOptions(input), async (handoff) => {
    const state = requireQuarantinedOrValidated(handoff.journalTip);
    const summaries = await writeAndCompareValidationPasses(handoff, input.faultHook);
    const generation = await obtainValidatedGeneration({ handoff, state, summaries, validatedAt: input.validatedAt });
    await appendValidatedIfNeeded(handoff, generation.manifestSha256, input.faultHook);
    await activateOnlyAfterValidation(handoff, generation.manifestSha256, input.faultHook);
    return freezeValidatedResult(generation);
  });
}
```

- [ ] **Step 4: Run GREEN, retention, and pointer retry checks.**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-transaction.test.ts __tests__/scripts/quarantine-lifecycle-core.test.ts __tests__/scripts/quarantine-manifest.test.ts __tests__/scripts/quarantine-journal.test.ts
```

Expected: PASS for first publication, VALIDATED retry timestamp reuse, missing-pointer activation-pending retry, fatal present-pointer variants, all no-mutation assertions, exact 96-hour deadline, retained metadata, and no deletion path.

- [ ] **Step 5: Review and commit Slice 4.** Obtain specification/code-quality review covering generation provenance and pointer retry semantics, then run:

```bash
git diff --check
git add scripts/quarantine-workspace-runtime.mjs scripts/quarantine-transaction.mjs scripts/quarantine-manifest.mjs __tests__/scripts/quarantine-transaction.test.ts __tests__/scripts/quarantine-lifecycle-core.test.ts __tests__/scripts/quarantine-manifest.test.ts
git commit -m "feat: validate quarantined workspaces"
```

### Task 5: Implement normal Slice 5 restore

**Files:**

- Create: `scripts/quarantine-restore.mjs`
- Modify: `scripts/quarantine-workspace-runtime.mjs:2369-2403` only for private shared-core/runtime wiring
- Modify: `__tests__/scripts/quarantine-restore.test.ts`
- Modify: `__tests__/scripts/quarantine-lifecycle-core.test.ts` for restore handoff reuse

**Interfaces:**

- Consumes: Task 3's private core and Task 4's QUARANTINED/VALIDATED generation, manifest, journal, inventory, and pointer evidence.
- Produces exactly:

```js
export async function restoreQuarantine({
  repoRoot, quarantineRoot, transactionId, writersStopped, fsApi, faultHook,
}) {}
```

Result:

```js
{ transactionId, restoreId, status: "RESTORED", restoredEntries }
```

`restoreId` is derived privately by this exact function and vector:

```js
function deriveRestoreId(transactionId) {
  const digest = createHash("sha256")
    .update(Buffer.from(
      `easy-job-application-tracker\0restore-id\0${transactionId}`,
      "utf8",
    ))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return ["restore-", hex.slice(0, 8), "-", hex.slice(8, 12), "-", hex.slice(12, 16), "-", hex.slice(16, 20), "-", hex.slice(20)].join("");
}
```

The fixed vector is `tx-0001 -> restore-c3624475-87d7-4886-b0bf-68a5061663d2`; bare UUIDs are rejected in every result, event, capability request, rollback path, and fsync option.

Private helper signatures are:

```ts
function deriveRestoreId(transactionId: string): string;
function pickExistingRunOptions(input: RestoreOptions): ExistingRunOptions;
function captureActiveGenerated(handoff: InternalRunHandoff, restoreId: string, faultHook?: FaultHook): Promise<ActiveGenerated>;
function appendRestorePrepared(handoff: InternalRunHandoff, restoreId: string, activeGenerated: ActiveGenerated, faultHook?: FaultHook): Promise<void>;
function appendRestoreStarted(handoff: InternalRunHandoff, faultHook?: FaultHook): Promise<void>;
function restoreEntry(args: { handoff: InternalRunHandoff; restoreId: string; entry: ManifestEntry; faultHook?: FaultHook }): Promise<void>;
function appendRestored(handoff: InternalRunHandoff, faultHook?: FaultHook): Promise<void>;
```

`ActiveGenerated` is the fixed two-record `{ id, inventory: InventorySummary | null }[]` payload; `ManifestEntry` is the closed manifest union from the original design. Both descriptions are private and are not new public APIs.

Restore journal payloads stay exact: `RESTORE_PREPARED` is `{ restoreId, activeGenerated }`; `RESTORING`, `RESTORED`, and `RESTORE_ROLLING_BACK` are `{}`; `RESTORE_INTENT`, `RESTORE_ROLLBACK_INTENT`, `RESTORED_ENTRY`, and `RESTORE_ROLLED_BACK_ENTRY` are `{ id }`; `RESTORE_ABORTED_TO_QUARANTINED` and `RESTORE_ABORTED_TO_VALIDATED` are `{}`; and `INCOMPLETE_CONFLICT` is `{ conflictEntryIds }`.

- [ ] **Step 1: Write restore RED tests and exact vector test.** Assert the fixed vector and prefixed grammar. Parameterize all four presence combinations for `.next` and `node_modules`; existing active roots write and fsync exactly one `restore-active` inventory, absent roots write no JSONL and are rechecked immediately before `RESTORE_PREPARED`. Assert dense bytewise-sorted `activeGenerated` records with the two fixed IDs and exact summary-or-null. Recreate an absent root or remove an inventoried root at the final presence seam and assert no `RESTORE_PREPARED`/`RESTORING` mutation.

```ts
expect(deriveRestoreIdForFixture("tx-0001")).toBe("restore-c3624475-87d7-4886-b0bf-68a5061663d2");
await expect(restoreQuarantine({ ...restoreOptions, writersStopped: true })).resolves.toMatchObject({
  transactionId: "tx-0001",
  restoreId: "restore-c3624475-87d7-4886-b0bf-68a5061663d2",
  status: "RESTORED",
});
```

Assert source-copy P-to-A moves and generated A-to-R followed by P-to-A moves, each with payload/tree sync, destination-parent sync, and source-parent sync in order, with no overwrite or unlink of active concurrent evidence. Assert exact hooks `after-event:RESTORE_PREPARED`, `after-event:RESTORING`, `after-inventory:restore-active:${generatedEntryId}`, `after-event:RESTORE_INTENT:${entryId}`, `after-active-to-rollback-rename:${generatedEntryId}`, `after-rollback-tree-sync:${generatedEntryId}`, `after-rollback-destination-parent-sync:${generatedEntryId}`, `after-rollback-source-parent-sync:${generatedEntryId}`, `after-payload-to-active-rename:${entryId}`, `after-restored-payload-sync:${entryId}`, `after-restore-destination-parent-sync:${entryId}`, `after-restore-source-parent-sync:${entryId}`, `after-event:RESTORED_ENTRY:${entryId}`, `after-event:RESTORED`, and `before-lock-cleanup`.

- [ ] **Step 2: Run restore RED.**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-restore.test.ts
```

Expected: FAIL because `scripts/quarantine-restore.mjs` and its `restoreQuarantine` implementation/test do not exist.

- [ ] **Step 3: Implement normal restore through the private core.** Validate the exact durable QUARANTINED or VALIDATED evidence, derive the deterministic prefixed restore ID, create only capability-derived rollback entries, write the fixed inventories, append `RESTORE_PREPARED` and `RESTORING`, then process entries in manifest order with the required sync order. Preserve regenerated rollback content after successful restore; never overwrite or delete an active concurrent replacement.

```js
export async function restoreQuarantine(input) {
  const restoreId = deriveRestoreId(input.transactionId);
  return withExistingQuarantineRun(pickExistingRunOptions(input), async (handoff) => {
    const activeGenerated = await captureActiveGenerated(handoff, restoreId, input.faultHook);
    await appendRestorePrepared(handoff, restoreId, activeGenerated, input.faultHook);
    await appendRestoreStarted(handoff, input.faultHook);
    for (const entry of restoreOrder(handoff.manifestGeneration)) {
      await restoreEntry({ handoff, restoreId, entry, faultHook: input.faultHook });
    }
    await appendRestored(handoff, input.faultHook);
    return Object.freeze({ transactionId: input.transactionId, restoreId, status: "RESTORED", restoredEntries: restoreOrder(handoff.manifestGeneration).length });
  });
}
```

- [ ] **Step 4: Run GREEN and shared-core reuse checks.**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-restore.test.ts __tests__/scripts/quarantine-lifecycle-core.test.ts __tests__/scripts/quarantine-transaction.test.ts __tests__/scripts/quarantine-journal.test.ts
```

Expected: PASS for vector, presence matrix, final TOCTOU checks, fixed inventory/payload paths, sync ordering, exact restore events/hooks, no-overwrite behavior, and no public lifecycle-core export.

- [ ] **Step 5: Review and commit normal restore.** Obtain a restore specification/code-quality review, then run:

```bash
git diff --check
git add scripts/quarantine-restore.mjs scripts/quarantine-workspace-runtime.mjs __tests__/scripts/quarantine-restore.test.ts __tests__/scripts/quarantine-lifecycle-core.test.ts
git commit -m "feat: restore quarantined workspaces"
```

### Task 6: Implement restore recovery and real SIGKILL restore proof

**Files:**

- Modify: `scripts/quarantine-restore.mjs`
- Modify: `__tests__/fixtures/quarantine/quarantine-lifecycle-child.mjs`
- Create: `__tests__/scripts/quarantine-restore-crash.integration.test.ts`
- Modify: `__tests__/scripts/quarantine-restore.test.ts`

**Interfaces:**

- Consumes: Task 5's restore ledger and private core; the shared child fixture from Task 2.
- Produces exactly:

```js
export async function recoverRestore({
  repoRoot, quarantineRoot, transactionId,
  action, writersStopped, fsApi, faultHook,
}) {}
```

`action` is exactly `"resume"` or `"rollback"`. Results are exactly:

```text
{ transactionId, restoreId, status: "RESTORED", action: "resume",
  reconciledEntries }
| { transactionId, restoreId, status: "QUARANTINED"|"VALIDATED",
    action: "rollback", reconciledEntries, restoreAborted: true }
| { transactionId, restoreId, status: "INCOMPLETE_CONFLICT",
    action: "resume"|"rollback", conflictEntryIds }
```

Recovery event phases are exactly `after-event:RECOVERY_REQUIRED`, `after-event:RESTORE_ROLLING_BACK`, `after-event:RESTORE_ABORTED_TO_QUARANTINED`, `after-event:RESTORE_ABORTED_TO_VALIDATED`, `after-event:INCOMPLETE_CONFLICT`, `after-event:RESTORE_ROLLBACK_INTENT:${entryId}`, and `after-event:RESTORE_ROLLED_BACK_ENTRY:${entryId}`, in addition to the normal restore phases listed in Task 5.

- [ ] **Step 1: Write the A/R/P RED table and crash matrix.** In `quarantine-restore.test.ts`, persist canonical original `O`, regenerated `G`, active `A`, rollback `R`, and payload `P` roles and parameterize every valid row:

| A | R | P | Resume | Rollback |
|---|---|---|---|---|
| G | - | O | archive A to R, restore P to A | no move, abort |
| - | G | O | restore P to A | move R to A, abort |
| O | G | - | record complete | move A to P, then R to A, abort |
| - | - | O | restore P to A when active was absent | no move, abort |
| O | - | - | record complete when active was absent | move A to P, abort |

Add `O === G`, distinct concurrent inodes, mismatching content, unauthorized locations, missing O/G evidence, mutated payload/rollback, and both-side mutation. Assert conflicts preserve every location, missing evidence is fatal with no mutation, and completed RESTORED cannot be undone. Spawn the shared child with `killAt` after every restore append, active rename, rollback-tree sync, payload rename, payload sync, both parent syncs, and lock cleanup; use exact phase names `after-original-active-to-payload-rename:${entryId}`, `after-original-payload-sync:${entryId}`, `after-original-payload-parent-sync:${entryId}`, `after-original-active-parent-sync:${entryId}`, `after-regenerated-rollback-to-active-rename:${generatedEntryId}`, `after-regenerated-active-tree-sync:${generatedEntryId}`, `after-regenerated-active-parent-sync:${generatedEntryId}`, `after-regenerated-rollback-parent-sync:${generatedEntryId}`, `after-payload-to-active-rename:${entryId}`, `after-restored-payload-sync:${entryId}`, `after-restore-destination-parent-sync:${entryId}`, and `after-restore-source-parent-sync:${entryId}`.

Private helper signatures are:

```ts
function buildRestoreLedger(records: readonly JournalRecord[]): RestoreLedger;
function pickExistingRunOptions(input: RestoreRecoveryOptions): ExistingRunOptions;
function resumeRestore(args: { handoff: InternalRunHandoff; replay: JournalReplay; ledger: RestoreLedger; restoreId: string; faultHook?: FaultHook }): Promise<RestoreRecoveryResult>;
function rollbackRestore(args: { handoff: InternalRunHandoff; replay: JournalReplay; ledger: RestoreLedger; restoreId: string; faultHook?: FaultHook }): Promise<RestoreRecoveryResult>;
```

`RestoreLedger` preserves durable `RESTORE_INTENT` order; `RestoreRecoveryResult` is exactly one of the three result unions in this task. These are private records only.

```ts
expect(await recoverRestore({ ...restoreOptions, action: "resume", writersStopped: true }))
  .toMatchObject({ transactionId: "tx-0001", restoreId: expectedRestoreId, status: "RESTORED", action: "resume" });
expect(await recoverRestore({ ...restoreOptions, action: "rollback", writersStopped: true }))
  .toMatchObject({ status: "QUARANTINED", action: "rollback", restoreAborted: true });
```

- [ ] **Step 2: Run restore recovery RED.**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-restore.test.ts __tests__/scripts/quarantine-restore-crash.integration.test.ts
```

Expected: FAIL because `recoverRestore` and the restore crash integration suite are absent and no A/R/P replay can yet return the exact prior state.

- [ ] **Step 3: Implement forward resume and reverse rollback.** Replay before mutation, preserve `RESTORE_INTENT` order, and process rollback in reverse durable order. For generated entries rollback moves active original A to payload P, then regenerated R to active A; append the abort event matching the state immediately before `RESTORE_PREPARED`. Use the exact `RESTORE_ROLLING_BACK`, `RESTORE_ROLLBACK_INTENT`, `RESTORE_ROLLED_BACK_ENTRY`, `RESTORE_ABORTED_TO_QUARANTINED`, and `RESTORE_ABORTED_TO_VALIDATED` schemas. Treat `O === G` by persisted role, phase, authorized path, and inode, never by digest multiplicity.

```js
export async function recoverRestore(input) {
  const restoreId = deriveRestoreId(input.transactionId);
  return withExistingQuarantineRun(pickExistingRunOptions(input), async (handoff) => {
    const replay = await replayJournal({ capability: handoff.capability });
    const ledger = buildRestoreLedger(replay.records); // original durable order
    return input.action === "resume"
      ? resumeRestore({ handoff, replay, ledger, restoreId, faultHook: input.faultHook })
      : rollbackRestore({ handoff, replay, ledger, restoreId, faultHook: input.faultHook });
  });
}
```

- [ ] **Step 4: Run the full restore crash GREEN suite.**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-restore.test.ts __tests__/scripts/quarantine-restore-crash.integration.test.ts __tests__/scripts/quarantine-transaction-crash.integration.test.ts __tests__/scripts/quarantine-journal.test.ts
```

Expected: PASS for every actual SIGKILL seam, all A/R/P rows including `O === G`, no-intent empty recovery IDs, non-bytewise ledger order, conflict preservation, exact restore ID/result/event/path/fsync strings, resume to RESTORED, and rollback to the exact prior QUARANTINED or VALIDATED state.

- [ ] **Step 5: Review and commit restore recovery.** Obtain an independent restore-recovery review covering every persisted location matrix and crash seam, then run:

```bash
git diff --check
git add scripts/quarantine-restore.mjs __tests__/fixtures/quarantine/quarantine-lifecycle-child.mjs __tests__/scripts/quarantine-restore-crash.integration.test.ts __tests__/scripts/quarantine-restore.test.ts
git commit -m "feat: recover interrupted quarantine restores"
```

### Task 7: Close the compatibility facade

**Files:**

- Modify: `scripts/quarantine-numbered-copies-support.mjs:1-380` into imports/re-exports only
- Modify: `__tests__/scripts/quarantine-numbered-copies.test.ts:1-1046`

**Interfaces:**

- Consumes exactly the seven public modules: `quarantine-run-capability.mjs`, `quarantine-path-policy.mjs`, `quarantine-journal.mjs`, `quarantine-manifest.mjs`, `quarantine-inventory.mjs`, `quarantine-transaction.mjs`, and `quarantine-restore.mjs`.
- Produces exactly these 33 bytewise-sorted facade exports and no others:

```text
GENERATED_ROOTS
IndeterminateJournalAppendError
activateManifestGeneration
appendJournalRecord
assertPathUnderRoot
assertSameDevice
buildValidatedManifest
canonicalPathForNumberedCopy
cleanupTerminalJournalArtifacts
compareInventorySummary
derivePayloadPath
deriveRunPath
fsyncTree
hashFileStream
inspectWorkspace
markQuarantineValidated
parseInventoryRecord
parseInventorySummary
parseManifestEntry
quarantineWorkspace
readCurrentManifestPointer
readManifestGeneration
reclaimJournalLock
recoverQuarantine
recoverRestore
replayJournal
restoreQuarantine
revalidateRunCapability
validateTransition
withJournalLock
withQuarantineRunCapability
writeInventoryJsonl
writeManifestGeneration
```

Forbidden facade exports are `withExistingQuarantineRun`, every lifecycle-core binding, `quarantine-run-fs-context` registry function, workspace-runtime helper, fault helper, fixture, and `prepareQuarantineWorkspace`.

- [ ] **Step 1: Write exact facade RED assertions.** Replace legacy implementation assumptions with this sentinel:

```ts
const expected = [
  "GENERATED_ROOTS", "IndeterminateJournalAppendError", "activateManifestGeneration",
  "appendJournalRecord", "assertPathUnderRoot", "assertSameDevice", "buildValidatedManifest",
  "canonicalPathForNumberedCopy", "cleanupTerminalJournalArtifacts", "compareInventorySummary",
  "derivePayloadPath", "deriveRunPath", "fsyncTree", "hashFileStream", "inspectWorkspace",
  "markQuarantineValidated", "parseInventoryRecord", "parseInventorySummary", "parseManifestEntry",
  "quarantineWorkspace", "readCurrentManifestPointer", "readManifestGeneration", "reclaimJournalLock",
  "recoverQuarantine", "recoverRestore", "replayJournal", "restoreQuarantine", "revalidateRunCapability",
  "validateTransition", "withJournalLock", "withQuarantineRunCapability", "writeInventoryJsonl", "writeManifestGeneration",
].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
const facade = await import(facadeUrl);
expect(Object.keys(facade).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))).toEqual(expected);
expect(Object.keys(facade)).not.toContain("withExistingQuarantineRun");
expect(Object.keys(facade)).not.toContain("prepareQuarantineWorkspace");
expect(Object.keys(facade)).not.toContain("getRunFsContext");
```

Keep the useful legacy numbered-path and classification sentinels, but remove tests for archive free space, copy-verify-remove, mutable manifest sidecars, run-local current, deletion staging, timestamp run names, and old body-serialization assumptions.

- [ ] **Step 2: Run facade RED.**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-numbered-copies.test.ts
```

Expected: FAIL because the legacy facade still contains the old implementation and does not expose the exact final 33-name set.

- [ ] **Step 3: Replace the facade with explicit exports.** Import only the approved names from the seven public modules and export one explicit ESM list. Do not wildcard-export the runtime, lifecycle core, filesystem context, fault helpers, or fixtures.

- [ ] **Step 4: Run GREEN and verify exact public boundaries.**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-numbered-copies.test.ts __tests__/scripts/quarantine-lifecycle-core.test.ts __tests__/scripts/quarantine-transaction.test.ts __tests__/scripts/quarantine-restore.test.ts
```

Expected: PASS with exactly 33 exports bytewise-sorted and all forbidden internal names absent.

- [ ] **Step 5: Review and commit the facade.** Obtain a public-boundary review, then run:

```bash
git diff --check
git add scripts/quarantine-numbered-copies-support.mjs __tests__/scripts/quarantine-numbered-copies.test.ts
git commit -m "refactor: close quarantine compatibility facade"
```

### Task 8: Expose the closed canonical npm CLI

**Files:**

- Create: `scripts/quarantine-numbered-copies.mjs`
- Create: `__tests__/scripts/quarantine-cli.test.ts`
- Modify: `package.json` and `package-lock.json`
- Modify: `__tests__/scripts/quarantine-numbered-copies.test.ts` only for final CLI/facade contract coexistence

**Interfaces:**

- Consumes the exact facade exports from Task 7 and the closed operation option/result contracts from Tasks 1, 4, 5, and 6.
- Produces package script exactly:

```json
"cleanup:quarantine": "node scripts/quarantine-numbered-copies.mjs"
```

- Public commands are spawned and documented separately as:

```text
npm run cleanup:quarantine -- inspect --repo-root <abs> --quarantine-root <abs> --expected-branch <name> --expected-head <sha> --expected-count <n>
```

```text
npm run cleanup:quarantine -- apply --repo-root <abs> --quarantine-root <abs> --expected-branch <name> --expected-head <sha> --expected-count <n> --writers-stopped
```

```text
npm run cleanup:quarantine -- recover --repo-root <abs> --quarantine-root <abs> --transaction-id <id> --action resume --writers-stopped
```

```text
npm run cleanup:quarantine -- recover --repo-root <abs> --quarantine-root <abs> --transaction-id <id> --action rollback --writers-stopped
```

```text
npm run cleanup:quarantine -- mark-validated --repo-root <abs> --quarantine-root <abs> --transaction-id <id> --writers-stopped
```

```text
npm run cleanup:quarantine -- restore --repo-root <abs> --quarantine-root <abs> --transaction-id <id> --writers-stopped
```

Successful JSONL records are exactly the original plan's closed shapes: inspect `{ ok: true, command: "inspect", status: "INSPECTED", sourceCopies, generatedRoots: 2, identicalCopies, divergentCopies }`; apply STARTING `{ ok: true, command: "apply", status: "STARTING", transactionId }` before layout mutation followed by apply completion `{ ok: true, command: "apply", status: "QUARANTINED", transactionId, movedEntries, manifestSha256 }`; recover wraps one non-conflict recovery result; mark-validated returns `{ ok: true, command: "mark-validated", status: "VALIDATED", transactionId, manifestSha256, validatedAt, deleteAfter, deletionRequiresConfirmation: true }`; restore returns `{ ok: true, command: "restore", status: "RESTORED", transactionId, restoreId, restoredEntries }`.

Failure stderr is exactly `{ ok: false, command: ErrorCommand, code, message }`, with `ErrorCommand` one of `"inspect"`, `"apply"`, `"recover"`, `"mark-validated"`, `"restore"`, or `null`; exit mapping is usage/preflight `2`, recovery/conflict/integrity/EXDEV `3`, indeterminate append `4`, and sanitized internal `1`. Unknown/malformed command tokens serialize as `command: null` and raw bytes never appear. Redact paths, URLs, credentials, stacks, bodies, diffs, authorization values, production responses, and conflict IDs. Direct node invocation appears only in an internal harness test.

Private CLI helper signatures are:

```ts
function parseArgv(argv: readonly string[]): ParsedCommand | CliFailure;
function dispatch(command: ParsedCommand): Promise<Readonly<Record<string, unknown>>>;
function emitFailure(command: ErrorCommand, error: QuarantineError): void;
function exitCodeFor(code: string): 1 | 2 | 3 | 4;
```

`ParsedCommand`, `CliFailure`, and `ErrorCommand` are closed private descriptions whose values are the exact command/error contracts above; none is exported.

- [ ] **Step 1: Write spawned npm CLI RED tests.** Spawn `npm run cleanup:quarantine -- ...` separately for all six code blocks above (the two recover actions are separate tests). Assert exact stdout/stderr JSONL, one trailing newline for success, empty stdout on errors unless apply already emitted STARTING, exit mapping, duplicate/unknown flags, relative/malformed roots, missing attestation, bare UUID rejection, conflict conversion to `ERR_CONFLICT` without IDs, and absence of every sensitive/raw token.

```ts
const run = (args: string[]) => spawnSync("npm", ["run", "cleanup:quarantine", "--", ...args], { encoding: "utf8" });
const inspect = run(["inspect", "--repo-root", repoRoot, "--quarantine-root", quarantineRoot, "--expected-branch", branch, "--expected-head", head, "--expected-count", "2"]);
expect(JSON.parse(inspect.stdout)).toEqual(expect.objectContaining({ ok: true, command: "inspect", status: "INSPECTED" }));
expect(inspect.stderr).toBe("");
```

- [ ] **Step 2: Run CLI RED.**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-cli.test.ts
```

Expected: FAIL because `scripts/quarantine-numbered-copies.mjs` and the package `cleanup:quarantine` script do not exist.

- [ ] **Step 3: Implement the closed parser/dispatcher.** Snapshot argv before async work, recognize only the five canonical command tokens, reject unknown flags and non-absolute roots, require `--writers-stopped` for apply/recover/mark-validated/restore, generate apply transaction ID and flush STARTING before layout mutation, dispatch recover to apply or restore recovery, and serialize only fixed public records/errors. The CLI may import the facade but never the lifecycle core or runtime internals.

```js
const COMMANDS = new Set(["inspect", "apply", "recover", "mark-validated", "restore"]);
function emitFailure(command, error) {
  process.stderr.write(`${JSON.stringify({ ok: false, command, code: error.code, message: error.message })}\n`);
  process.exitCode = exitCodeFor(error.code);
}
```

- [ ] **Step 4: Run GREEN and package-script checks.**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-cli.test.ts __tests__/scripts/quarantine-numbered-copies.test.ts __tests__/scripts/quarantine-transaction.test.ts __tests__/scripts/quarantine-restore.test.ts
```

Expected: PASS for each separate npm command form, exact JSONL/exit mapping, sanitized failures, STARTING-before-mutation, direct-node-only harness coverage, and exact facade exports.

- [ ] **Step 5: Review and commit the closed CLI.** Obtain CLI contract review, then run:

```bash
git diff --check
git add scripts/quarantine-numbered-copies.mjs package.json package-lock.json __tests__/scripts/quarantine-cli.test.ts __tests__/scripts/quarantine-numbered-copies.test.ts
git commit -m "feat: expose quarantine cleanup CLI"
```

### Task 9: Run the aggregate verification gate

**Files:**

- Verify only all Task 1-8 files and their committed changes.
- No docs/checklist update is expected or authorized in this task; the continuation spec and this plan are already the approved documentation artifacts.

**Interfaces:**

- Consumes the exact public seven-module/33-export surface, all Slice 3-6 operation signatures/results, and every focused test suite created above.
- Produces no code or documentation commit; produces recorded verification and review evidence only.

- [ ] **Step 1: Run the focused 12-suite gate.** The command must include capability, path policy, journal, manifest, inventory, lifecycle core, transaction, transaction crash, restore, restore crash, CLI, and facade tests:

```bash
npm test -- --runInBand \
  __tests__/scripts/quarantine-run-capability.test.ts \
  __tests__/scripts/quarantine-path-policy.test.ts \
  __tests__/scripts/quarantine-journal.test.ts \
  __tests__/scripts/quarantine-manifest.test.ts \
  __tests__/scripts/quarantine-inventory.test.ts \
  __tests__/scripts/quarantine-lifecycle-core.test.ts \
  __tests__/scripts/quarantine-transaction.test.ts \
  __tests__/scripts/quarantine-transaction-crash.integration.test.ts \
  __tests__/scripts/quarantine-restore.test.ts \
  __tests__/scripts/quarantine-restore-crash.integration.test.ts \
  __tests__/scripts/quarantine-cli.test.ts \
  __tests__/scripts/quarantine-numbered-copies.test.ts
```

Expected: PASS with actual apply and restore SIGKILL evidence, state-specific generation/pointer retry evidence, all path/symlink/identity/conflict matrices, exact exports, and no foreign replacement mutation.

- [ ] **Step 2: Run project-wide static and build gates.**

```bash
npm test -- --runInBand --no-cache
npm run lint -- --max-warnings=0
npm run typecheck
npm run build
git diff --check
```

Expected: all commands exit 0; lint reports zero warnings; build succeeds without modifying the plan's scope.

- [ ] **Step 3: Prove no-touch and no-deletion invariants.** In a disposable fixture, snapshot every user-provided untracked numbered/temp path before and after running all focused suites; assert byte-for-byte identity, inode identity where paths remain, and no new deletion/move. Search the implementation diff for `rm`, `unlink`, `rmdir`, or deletion scheduling and prove each occurrence is limited to owned quarantine evidence cleanup under an explicit terminal/recovery authority; assert no path starts a retention timer before durable VALIDATED and no automatic deletion job exists.

```bash
git diff --name-only HEAD~8..HEAD
rg -n "deleteAfter|setTimeout|setInterval|cron|rm\(|unlink\(|rmdir\(" scripts __tests__/scripts
git diff --check
```

Expected: only the nine task commit scopes are present, no retention scheduler/deletion path exists, and user fixture bytes remain unchanged.

- [ ] **Step 4: Obtain independent specification and code-quality reviews.** Review each task at its commit boundary, then review the complete branch against both `docs/superpowers/specs/2026-08-04-quarantine-lifecycle-continuation-design.md` and `docs/superpowers/specs/2026-07-14-foundation-cleanup-design.md` section by section. Require Critical 0 / Important 0 / Minor 0. Re-run the focused and full gates after every correction; do not create a ninth-task implementation commit.

- [ ] **Step 5: Final plan/worktree self-check and commit.** Scan this plan for unresolved markers, unfinished wording, vague validation/error-handling language, undefined interfaces, malformed code fences, and checkbox syntax errors; verify exact public names, result property names, event payloads, restore vector, fault phases, and command forms against the approved sources. Confirm only the assigned plan file is staged, then commit this plan:

```bash
rg -n -i "unfinished|later|not specified|undefined|vague" docs/superpowers/plans/2026-08-09-quarantine-lifecycle-continuation.md
git diff --check
git add docs/superpowers/plans/2026-08-09-quarantine-lifecycle-continuation.md
git commit -m "docs: plan quarantine lifecycle continuation"
```
