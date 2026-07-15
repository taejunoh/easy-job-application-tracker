# Foundation Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quarantine every numbered workspace copy without data loss, regenerate a deterministic local environment, route manual backups through the hardened coordinator, and prove real-Docker interruption cleanup.

**Architecture:** A built-in-only Node CLI opens a callback-scoped opaque run capability, streams FD-bounded deterministic inventories, and atomically moves source copies plus complete generated roots into an external quarantine on the same filesystem. A hash-chained, fsync-backed append-only journal is the recovery authority; immutable digest-named manifest generations and one atomic root pointer make publication crash-safe, while every writer derives and revalidates its path through the live capability. Operations changes remain separate: a documentation contract replaces raw database-URL backup arguments, while a focused PostgreSQL 17 Docker test proves signal cleanup using the existing coordinator and CI service container.

**Tech Stack:** Node.js 22 ESM, Git CLI, Jest/ts-jest, PostgreSQL 17, Docker, GitHub Actions, Markdown operations contracts

---

## File map

- Create `scripts/quarantine-run-capability.mjs`: callback-scoped opaque writer authority, validated run identity, purpose/ID path derivation, and phase-boundary revalidation.
- Modify `scripts/quarantine-path-policy.mjs`: retain closed schemas, normalized relative-path policy, resolve-under-root guards, fixed generated-root allowlist, entry-ID derivation, and same-device checks.
- Modify `scripts/quarantine-inventory.mjs`: bounded-memory file hashing and deterministic streaming JSONL inventories with digest/count/byte summaries.
- Modify `scripts/quarantine-journal.mjs`: mode-`0600` length-framed hash-chain append, fsync, replay, torn-tail handling, and lifecycle validation.
- Modify `scripts/quarantine-manifest.mjs`: pure closed manifest builder, immutable digest-named generations, canonical root-level current pointer, and four-day validation metadata.
- Create `scripts/quarantine-transaction.mjs`: preflight, atomic apply moves, destination verification, crash reconciliation, explicit resume, and reverse-order rollback.
- Create `scripts/quarantine-restore.mjs`: active-tree rollback moves, quarantined-payload restore, restore replay, and conflict preservation.
- Replace `scripts/quarantine-numbered-copies-support.mjs` with a thin compatibility facade exporting the focused modules.
- Create `scripts/quarantine-numbered-copies.mjs`: thin CLI with `inspect`, `apply`, `recover`, `mark-validated`, and `restore` subcommands.
- Replace `__tests__/scripts/quarantine-numbered-copies.test.ts` with behavior-level apply, recovery, restore, and CLI tests.
- Create `__tests__/scripts/quarantine-run-capability.test.ts`, `quarantine-path-policy.test.ts`, `quarantine-inventory.test.ts`, `quarantine-journal.test.ts`, and `quarantine-manifest.test.ts` for focused capability, security, RSS, replay, and publication tests.
- Modify `package.json`: expose `cleanup:quarantine` and `test:backup:docker`.
- Modify `docs/operations/production-runbook.md` and its workflow contract test.
- Create `__tests__/scripts/create-snapshot-backup.docker.integration.test.ts`: real PostgreSQL 17 Docker signal proof.
- Modify `.github/workflows/ci.yml`, `__tests__/ci/workflow-contract.test.ts`, and `README.md`.

### Task 1A: Establish the callback-scoped run capability

**Dependency:** This task runs first. Tasks 1B, 1C, and 1D start only after its commit is available.

**Files:**
- Create: `scripts/quarantine-run-capability.mjs`
- Create: `__tests__/scripts/quarantine-run-capability.test.ts`

- [ ] **Step 1: Write the capability RED suite**

Import these exact exports:

```ts
import {
  deriveRunPath,
  revalidateRunCapability,
  withQuarantineRunCapability,
} from "../../scripts/quarantine-run-capability.mjs";
```

Use this exact public contract:

```ts
type InventoryPhase = "pre" | "moved-pass-1" | "moved-pass-2" | "restore-active";

type RunPurpose =
  | "journal" | "journal-lock" | "journal-tombstone"
  | "manifest-generation" | "manifest-temporary"
  | "current-pointer" | "current-temporary"
  | "inventory" | "inventory-work"
  | "payload" | "rollback" | "conflict" | "divergent-diff";

withQuarantineRunCapability(
  {
    repoRoot: string;
    quarantineRoot: string;
    transactionId: string;
    writersStopped: true;
    fsApi?: object;
  },
  async (capability: object) => unknown,
): Promise<unknown>;

deriveRunPath(
  capability: object,
  request: { purpose: RunPurpose; id?: string; phase?: InventoryPhase },
): string;

revalidateRunCapability(
  capability: object,
  request: { purpose: RunPurpose; id?: string; phase?: InventoryPhase; boundary: "before-mutation" | "after-sync" },
): Promise<void>;
```

Test `writersStopped !== true`, forged `{}` capabilities, callback leakage after
both resolve and reject, invalid purpose/ID/phase combinations, quarantine inside
the repository, root or run symlinks, mode other than `0700`, device mismatch,
and replacement of the root/run with a different `dev` or `ino`. Independently
replace each derived journal, inventory, and manifest parent with a symlink;
both derivation/revalidation must reject and an external sentinel must remain
unchanged. Prove all returned destinations are derived from the approved real
root and one validated transaction ID, never from a caller path.

- [ ] **Step 2: Run capability RED**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-run-capability.test.ts
```

Expected: FAIL with `Cannot find module '../../scripts/quarantine-run-capability.mjs'`.

- [ ] **Step 3: Implement the opaque capability and exact path table**

Use module-private `WeakSet`/`WeakMap` state and deactivate the object in a
`finally` before callback settlement returns to its caller. Record real root/run
paths plus `dev`, `ino`, and mode from `lstat`/`realpath`; require the repository
and quarantine root to have equal `dev`. Implement a closed table equivalent to:

```js
const PURPOSES = Object.freeze({
  journal: ({ runRoot }) => join(runRoot, "journal.log"),
  "journal-lock": ({ runRoot }) => join(runRoot, "journal.lock"),
  "journal-tombstone": ({ runRoot, id }) => join(runRoot, `journal.lock.tombstone.${id}`),
  "manifest-generation": ({ runRoot, id }) => join(runRoot, "manifests", `${id}.json`),
  "manifest-temporary": ({ runRoot, id }) => join(runRoot, "manifests", `.${id}.tmp`),
  "current-pointer": ({ quarantineRoot }) => join(quarantineRoot, "current"),
  "current-temporary": ({ quarantineRoot, id }) => join(quarantineRoot, `.current.${id}.tmp`),
  inventory: ({ runRoot, id, phase }) => join(runRoot, "inventories", phase, `${id}.jsonl`),
  "inventory-work": ({ runRoot, id }) => join(runRoot, "inventories", "work", `${id}.bin`),
  payload: ({ runRoot, id }) => derivedPayloadFromValidatedId(runRoot, id),
  rollback: ({ runRoot, id }) => join(runRoot, "rollback", "regenerated-before-restore", id),
  conflict: ({ runRoot, id }) => join(runRoot, "conflicts", id),
  "divergent-diff": ({ runRoot, id }) => join(runRoot, "divergent-diffs", `${id}.patch`),
});
```

`derivedPayloadFromValidatedId` maps `copy-NNNN` to
`payload/source-copies/copy-NNNN`, `generated-next` to
`payload/generated/.next`, and `generated-node-modules` to
`payload/generated/node_modules`. Temporary and work IDs are validated opaque
IDs generated by the owning writer; tombstones use the strict journal tombstone
grammar; `restore-active` accepts only a validated restore ID while the other
inventory phases accept only a manifest entry ID. Validate each selected parent
as a mode-`0700` non-symlink directory and realpath-contained under the recorded
root before returning a path and at both mutation boundaries.

- [ ] **Step 4: Run capability GREEN and commit**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-run-capability.test.ts
git diff --check
git add scripts/quarantine-run-capability.mjs __tests__/scripts/quarantine-run-capability.test.ts
git commit -m "feat: bind quarantine writers to run capability"
```

Expected: the capability suite PASSes, `git diff --check` is silent, and the
commit contains only the two listed files.

### Task 1B: Harden journal ownership and terminal cleanup

**Dependency:** Task 1A. This task may run in parallel with Tasks 1C and 1D.
It modifies only the journal source and journal test.

**Files:**
- Modify: `scripts/quarantine-journal.mjs`
- Modify: `__tests__/scripts/quarantine-journal.test.ts`

- [ ] **Step 1: Write journal RED cases for the five reviewed gaps**

Use these exact exports/signatures:

```js
export async function replayJournal({ capability, fsApi, maxBytes = 16 * 1024 * 1024 }) {}
export async function withJournalLock({ capability, fsApi }, callback) {}
export async function appendJournalRecord({ capability, heldLock, event, payload, fsApi, faultHook }) {}
export async function reclaimJournalLock({ capability, writersStopped, fsApi }, callback) {}
export async function cleanupTerminalJournalArtifacts({ capability, writersStopped, fsApi }) {}
export function validateTransition(previousEvent, nextEvent) {}
```

For each terminal tip `ROLLED_BACK`, `RESTORED`, and `INCOMPLETE_CONFLICT`, seed
a stale valid lock/tombstone, call cleanup, and assert exact journal bytes and
tip are unchanged, no event is appended, only validated artifacts are removed,
and the parent is synced. Repeat with `VALIDATED`, a nonterminal tip, a torn
tail, false attestation, malformed artifact, symlink, and lock replacement;
assert every artifact remains byte-for-byte unchanged.

Run ordinary append and recovery append through the same held-lock callback and
test identical checks immediately before mutation, after journal sync, and
before cleanup. Replace the lock at each seam. Before mutation, expect unchanged
journal bytes. After mutation begins, expect:

```ts
expect(error).toMatchObject({
  name: "IndeterminateJournalAppendError",
  expectedSequence: candidate.sequence,
  expectedRecordHash: candidate.recordHash,
});
```

Explicit attested recovery must reconcile the candidate to exactly one record.
No case may delete the foreign replacement. Add real child-process `SIGKILL`
hooks after terminal cleanup lock acquisition and after stale-lock tombstone
rename; replay must remain terminal and cleanup retry must append no event.

- [ ] **Step 2: Run journal RED**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-journal.test.ts
```

Expected: FAIL on terminal cleanup because the existing recovery path attempts
an append, and FAIL on ordinary lock replacement because the existing ordinary
appender lacks recovery-equivalent ownership/indeterminate handling.

- [ ] **Step 3: Implement cleanup-only terminal locking and shared append core**

Require every journal/lock/tombstone path through `deriveRunPath(capability, …)`;
remove public raw journal and lock path parameters. Make ordinary append and
recovery call one private core:

```js
async function appendUnderHeldLock({ capability, heldLock, candidate, fsApi }) {
  await assertOwnedLockAtPath(heldLock, "before-mutation");
  let mutationStarted = false;
  try {
    mutationStarted = true;
    await writeAndSyncCandidate(candidate);
    await assertOwnedLockAtPath(heldLock, "after-sync");
    return candidate;
  } catch (error) {
    if (!mutationStarted) throw error;
    throw new IndeterminateJournalAppendError(candidate, error);
  }
}
```

Cleanup-only records the complete terminal tip, validates all artifacts, moves
the stale lock to a derived tombstone, syncs, acquires a new held lock, replays
and compares the same tip, conditionally removes only owned validated artifacts,
and syncs again. It never calls the append core, never truncates, and rejects a
torn tail. Lock cleanup unlinks only after `dev`/`ino` equality; close failure
preserves the primary indeterminate error and attaches supplemental cause data.

- [ ] **Step 4: Run journal GREEN and commit**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-run-capability.test.ts __tests__/scripts/quarantine-journal.test.ts
git diff --check
git add scripts/quarantine-journal.mjs __tests__/scripts/quarantine-journal.test.ts
git commit -m "fix: harden quarantine journal ownership"
```

Expected: both suites PASS, the diff check is silent, and the commit does not
modify capability, manifest, inventory, transaction, restore, facade, or docs.

### Task 1C: Replace mutable manifests with immutable generations

**Dependency:** Task 1A. This task may run in parallel with Tasks 1B and 1D.
It modifies only the manifest source and its dedicated test.

**Files:**
- Modify: `scripts/quarantine-manifest.mjs`
- Create: `__tests__/scripts/quarantine-manifest.test.ts`

- [ ] **Step 1: Write manifest-generation RED tests**

Import and preserve exactly these five APIs:

```js
export function buildValidatedManifest(value) {}
export async function writeManifestGeneration({ capability, manifest, fsApi, faultHook }) {}
export async function activateManifestGeneration({ capability, transactionId, manifestSha256, appendValidated, fsApi, faultHook }) {}
export async function readCurrentManifestPointer({ capability, fsApi, maxBytes = 4096 }) {}
export async function readManifestGeneration({ capability, manifestSha256, fsApi, maxBytes = 4 * 1024 * 1024 }) {}
```

The pointer parser accepts exactly:

```ts
type CurrentManifestPointer = {
  schemaVersion: 1;
  transactionId: string;
  manifestSha256: string;
};
```

Test unknown/missing/path fields, uppercase or malformed digests, an oversized
pointer above 4 KiB, an oversized generation above 4 MiB, canonical-byte digest
mismatch, and an existing digest filename with different bytes. Require pure
`buildValidatedManifest` to enforce the exact source-copy/generated-root union,
cross-field invariants, unique and bytewise-sorted IDs/paths, deterministic
`copy-NNNN` IDs, and both fixed generated roots.

Inject a crash after each boundary: generation temporary-file sync, generation
rename, generation-directory sync, pointer temporary-file sync, pointer rename,
and quarantine-root sync. After each crash, `readCurrentManifestPointer` plus
`readManifestGeneration` must return the old or new complete generation, and
the old generation must remain readable. Assert `appendValidated` is called
exactly once after the generation directory sync and before pointer temporary
write, with `{ manifestSha256 }`. Inject temporary cleanup failure and require
the primary publication error plus cleanup error to be preserved without
deleting an existing generation or pointer.

```ts
expect(publicationError).toBeInstanceOf(AggregateError);
expect((publicationError as AggregateError).errors).toEqual([primaryError, cleanupError]);
```

- [ ] **Step 2: Run manifest RED**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-manifest.test.ts
```

Expected: FAIL because the pre-amendment publisher does not export the five
immutable-generation APIs.

- [ ] **Step 3: Implement immutable write, activation, and validated reads**

Canonicalize the pure builder result, hash those exact bytes, and derive
`manifests/<sha256>.json` through the live capability. Create/sync a mode-`0600`
temporary, rename without replacing a different generation, and sync the
manifest directory. Activation then calls `appendValidated` and publishes the
canonical pointer via a mode-`0600` temporary, rename-over-`current`, and root
sync. Revalidate capability identity before each mutation phase and after its
last sync. Readers derive paths from the validated digest, enforce byte limits
before parsing, compare filename/content digest, and rerun the closed builder.
Delete the pre-amendment mutable generation, checksum-sidecar, ID-only pointer,
and run-local pointer protocol.

- [ ] **Step 4: Run manifest GREEN and commit**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-run-capability.test.ts __tests__/scripts/quarantine-manifest.test.ts
git diff --check
git add scripts/quarantine-manifest.mjs __tests__/scripts/quarantine-manifest.test.ts
git commit -m "feat: publish immutable quarantine manifests"
```

Expected: both suites PASS, all crash-matrix assertions return only complete
generations, and the commit contains only the two listed files.

### Task 1D: Bound inventory and durability traversal

**Dependency:** Task 1A. This task may run in parallel with Tasks 1B and 1C.
It modifies only the inventory source and inventory test.

**Files:**
- Modify: `scripts/quarantine-inventory.mjs`
- Modify: `__tests__/scripts/quarantine-inventory.test.ts`

- [ ] **Step 1: Write iterative traversal RED tests**

Use these exact exports/signatures:

```js
export async function hashFileStream(absolutePath, { fsApi, onHandleCount } = {}) {}
export function parseInventoryRecord(value) {}
export function parseInventorySummary(value) {}
export async function writeInventoryJsonl({ capability, root, entryId, phase, fsApi, limits, metrics }) {}
export async function compareInventorySummary(expected, observed) {}
export async function fsyncTree({ capability, root, entryId, purpose, fsApi, limits, metrics }) {}
```

`parseInventoryRecord` accepts either exact root-file metadata with no `path`,
or exact relative descendant metadata whose NFC POSIX path rejects empty,
absolute, backslash, NUL, duplicate separator, `.`, and `..` components.
`writeInventoryJsonl` derives its output from capability + validated entry or
restore ID + phase; it accepts no caller-selected output. `fsyncTree` accepts no
caller destination path.

Use a virtual filesystem 10,000 directories deep and assert no recursion error,
`metrics.maxOpenDirectoryHandles <= 1`, and
`metrics.maxTraversalAndHashHandles <= 2`. Force more than 32 sorted chunks and
assert `metrics.maxMergeReaders <= 32`. Verify iterative durability order:

```ts
expect(syncOrder).toEqual([
  "file:root/a/b/data.bin",
  "directory:root/a/b",
  "directory:root/a",
  "directory:root",
]);
```

Build a real 40,000-entry fixture, run a child with `node --expose-gc`, and
require peak RSS below `160 * 1024 * 1024`, identical JSONL/digest across two
passes, chunk flush at 4,096 records or 8 MiB, frontier spill at 1,024 records
or 8 MiB, and merge fan-in at most 32. Inject payload `readFile` to throw and
prove file bodies use `createReadStream`. Add root-symlink and inner-symlink
tests proving targets are never opened, hashed, traversed, or synced.

- [ ] **Step 2: Run inventory RED**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-inventory.test.ts
```

Expected: FAIL on the 10,000-deep fixture with stack/open-handle assertions and
FAIL because the pre-amendment writer lacks live-capability output derivation.

- [ ] **Step 3: Implement bounded iterative inventory and post-order fsync**

Read one directory, close it, and enqueue only a bounded frontier. Spill
overflow to a capability-derived mode-`0600` work file. Produce deterministic
bytewise order with 4,096-record/8-MiB sorted chunks and multi-pass k-way merge
of at most 32 readers. Keep no more than one directory handle, or two total
while hashing one regular file. Stream final JSONL once with backpressure and
incremental SHA-256. Implement `fsyncTree` with iterative post-order frames,
opening and closing a directory only at its sync point. Use `lstat`/`readlink`
and never follow a symlink. Revalidate the capability-derived inventory/work
parents before mutation and after final file/parent sync.

- [ ] **Step 4: Run inventory GREEN and commit**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-run-capability.test.ts __tests__/scripts/quarantine-inventory.test.ts
git diff --check
git add scripts/quarantine-inventory.mjs __tests__/scripts/quarantine-inventory.test.ts
git commit -m "feat: bound quarantine inventory traversal"
```

Expected: both suites PASS, the 40,000-entry worker reports RSS below 160 MiB,
all handle counters remain within bounds, and the commit contains only the two
listed files.

### Task 1E: Integrate and review the hardened primitives

**Dependency DAG:** Task 1A first; Tasks 1B, 1C, and 1D in parallel after 1A
with non-overlapping source/test files; Task 1E after all three. Worker agents
must not edit this plan, the design spec, transaction/restore/facade files, or
each other's files.

**Files:**
- Verify: `scripts/quarantine-run-capability.mjs`
- Verify: `scripts/quarantine-journal.mjs`
- Verify: `scripts/quarantine-manifest.mjs`
- Verify: `scripts/quarantine-inventory.mjs`
- Verify: their four dedicated test files and the existing path-policy and behavior suites

- [ ] **Step 1: Run the complete focused primitive gate**

```bash
npm test -- --runInBand \
  __tests__/scripts/quarantine-run-capability.test.ts \
  __tests__/scripts/quarantine-path-policy.test.ts \
  __tests__/scripts/quarantine-journal.test.ts \
  __tests__/scripts/quarantine-manifest.test.ts \
  __tests__/scripts/quarantine-inventory.test.ts \
  __tests__/scripts/quarantine-numbered-copies.test.ts
```

Expected: every listed suite PASSes. Any failure blocks Task 2 and returns to
the owning Task 1A-1D RED/GREEN loop before review.

- [ ] **Step 2: Run the full repository gate**

```bash
npm test -- --runInBand --no-cache
git diff --check
```

Expected: full Jest PASSes and `git diff --check` is silent. Record exact suite,
test, skipped-test, duration, and peak-RSS evidence without printing file bodies.

- [ ] **Step 3: Obtain independent specification and quality reviews**

Give both reviewers the approved design, commits from Tasks 1A-1D, focused/full
test output, and the five RED matrices: capability/symlink, terminal/SIGKILL,
ordinary lock replacement, immutable manifest crash, and bounded traversal.
The specification reviewer maps every design requirement to code and tests; the
quality reviewer independently probes path replacement, journal uncertainty,
manifest interruption, deep traversal, and RSS. Task 2 and all mutation of the
original checkout remain blocked until both reports contain exactly zero
Critical and zero Important findings. Fixes repeat the affected RED/GREEN suite,
both reviews, the focused gate, full Jest, and `git diff --check`.

### Task 2: Replace transaction orchestration, restore, and CLI; then quarantine

**Files:**
- Create: `scripts/quarantine-transaction.mjs`
- Create: `scripts/quarantine-restore.mjs`
- Replace: `scripts/quarantine-numbered-copies-support.mjs`
- Create: `scripts/quarantine-numbered-copies.mjs`
- Replace: `__tests__/scripts/quarantine-numbered-copies.test.ts`
- Modify: `package.json`
- Operate on: `/Users/taejunoh/Desktop/LFG/easy-job-application-tracker`

- [ ] **Step 1: Rewrite behavior tests for preflight and atomic apply**

Each test creates and commits its own temporary Git repository. Import
`inspectWorkspace` and `quarantineWorkspace` from the support facade. Require
branch, HEAD, count, clean-index, writer-attestation, two-stable-pass,
outside-repository, non-symlink-root, same-device, and absent-destination gates.
The happy path includes two source copies plus `node_modules` and `.next`:

```ts
const result = await quarantineWorkspace({
  repoRoot: fixture.root,
  quarantineRoot: fixture.quarantineRoot,
  expectedBranch: "main",
  expectedHead: fixture.head,
  expectedCount: 2,
  writersStopped: true,
  now: new Date("2026-07-14T12:00:00.000Z"),
});
expect(result.status).toBe("QUARANTINED");
expect(result.movedEntries).toBe(4);
expect(await pathExists(join(fixture.root, "src/example 2.ts"))).toBe(false);
expect(await pathExists(join(fixture.root, "node_modules"))).toBe(false);
expect(await pathExists(join(fixture.root, ".next"))).toBe(false);
```

Inject `rename` throwing `EXDEV` and require a fatal result, no copy call, no
source removal, and durable recovery state.

- [ ] **Step 2: Run apply tests to verify RED**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-numbered-copies.test.ts
```

Expected: FAIL because the old facade does not implement the approved atomic
move contract and the focused transaction module is missing.

- [ ] **Step 3: Implement inspect and atomic apply minimally**

Create `scripts/quarantine-transaction.mjs` exporting:

```js
export async function inspectWorkspace(options) {}
export async function quarantineWorkspace(options) {}
export async function recoverQuarantine({ repoRoot, quarantineRoot, transactionId, action, writersStopped, fsApi }) {}
```

Discovery uses `git status --porcelain=v1 -z --untracked-files=all`, argument
arrays, and two identical NUL-safe passes. Every mutating/recovery entry point
opens `withQuarantineRunCapability` and passes the callback-scoped capability to
journal, inventory, manifest, payload, conflict, and rollback writers; no
transaction API accepts or derives authority from a caller-selected run path.
`quarantineWorkspace` builds and durably writes the initial immutable manifest
generation, writes `PREPARED`, then for every entry performs `MOVE_INTENT ->
recheck -> rename -> iterative payload fsync -> destination-parent fsync ->
source-parent fsync -> capability-derived destination inventory -> MOVED`.
Persisting the destination directory first avoids a deliberate neither-name
durability window. After all entries, perform two independent destination
passes, assert all sources absent and no numbered residue, append `QUARANTINED`,
and write the verified but unactivated immutable generation. The later
`mark-validated` operation, only after clean regeneration succeeds, builds and
writes the validation-timestamp generation and calls
`activateManifestGeneration`; its `VALIDATED` append occurs before the canonical
root-level pointer replacement. No phase writes a mutable generation or
run-local pointer.

- [ ] **Step 4: Add replay, mutation, and concurrency RED tests**

Parameterize a subprocess fault hook after every durable boundary and terminate
the worker with `SIGKILL`. For each run, invoke explicit recovery and assert the
filesystem/journal matrix:

```ts
it.each(["resume", "rollback"])("recovers every crash boundary via %s", async (action) => {
  const recovered = await recoverKilledFixture({ action });
  expect(recovered.lostPaths).toEqual([]);
  expect(recovered.overwrittenPaths).toEqual([]);
  expect(["QUARANTINED", "ROLLED_BACK", "INCOMPLETE_CONFLICT"]).toContain(recovered.status);
});
```

Separately recreate a source after its move, mutate only the moved destination,
mutate both sides, and remove both sides. Require the approved reconciliation
matrix, reverse-order rollback, preservation under `conflicts/`, and refusal of
new apply/restore while a journal is nonterminal.

- [ ] **Step 5: Implement explicit resume and rollback, then verify GREEN**

Replay the journal before any filesystem action. Reconcile source/destination
existence and summaries exactly as the design specifies. Resume only verified
moves; rollback in reverse durable order. Never delete or overwrite a recreated
source. Use `INCOMPLETE_CONFLICT` for preserved two-sided evidence and fatal-stop
when both sides are absent. Run:

```bash
npm test -- --runInBand __tests__/scripts/quarantine-numbered-copies.test.ts
```

Expected: all apply, crash, mutation, concurrency, and `EXDEV` cases PASS.

- [ ] **Step 6: Commit atomic transaction replacement**

```bash
git diff --check
git add scripts/quarantine-transaction.mjs __tests__/scripts/quarantine-numbered-copies.test.ts
git commit -m "feat: replace quarantine with atomic journaled moves"
```

- [ ] **Step 7: Add restore crash-matrix RED tests**

After a successful apply, create regenerated `node_modules` and `.next`, then
terminate restore after each journal append, active-tree rename, payload fsync,
destination-parent fsync, source-parent fsync, and original-tree rename. Require
that explicit recovery leaves
every tree in exactly one durable location. Test source-copy recreation and
generated-root conflicts without overwrites. On success require active originals
restored, regenerated trees under the derived rollback path, quarantine payload
consumed, and journal state `RESTORED`.

- [ ] **Step 8: Implement restore atomic moves and verify GREEN**

Create `scripts/quarantine-restore.mjs` exporting:

```js
export async function restoreQuarantine({ repoRoot, quarantineRoot, transactionId, writersStopped, fsApi }) {}
export async function recoverRestore({ repoRoot, quarantineRoot, transactionId, action, writersStopped, fsApi }) {}
```

Both supported functions open a live run capability. Append `RESTORE_PREPARED`;
write the active generated-tree inventory
to its capability-derived inventory path; atomically move the tree to the
capability-derived rollback destination; iteratively fsync and journal that
move; then atomically move the original payload into the active location. Never
unlink an active tree. Reuse journal replay and the conflict matrix. Run the
behavior suite and require all restore crash cases PASS.

- [ ] **Step 9: Replace the facade and add spawned-CLI RED tests**

Make `quarantine-numbered-copies-support.mjs` export only the approved public
functions from the seven focused modules, including the run-capability module.
Test these exact CLI forms:

```text
npm run cleanup:quarantine -- inspect --repo-root <abs> --quarantine-root <abs> --expected-branch <name> --expected-head <sha> --expected-count <n>
npm run cleanup:quarantine -- apply --repo-root <abs> --quarantine-root <abs> --expected-branch <name> --expected-head <sha> --expected-count <n> --writers-stopped
npm run cleanup:quarantine -- recover --repo-root <abs> --quarantine-root <abs> --transaction-id <id> --action resume|rollback --writers-stopped
npm run cleanup:quarantine -- mark-validated --repo-root <abs> --quarantine-root <abs> --transaction-id <id> --writers-stopped
npm run cleanup:quarantine -- restore --repo-root <abs> --quarantine-root <abs> --transaction-id <id> --writers-stopped
```

Require missing attestation, relative roots, unknown flags, unknown commands,
nonterminal conflicts, and path-bearing pointer attacks to exit nonzero without
printing file bodies. Output only counts, state, transaction identifier,
validation time, and deletion deadline.

- [ ] **Step 10: Implement the CLI and package script, then verify GREEN**

Create the thin argument parser in `scripts/quarantine-numbered-copies.mjs` and
add:

```json
"cleanup:quarantine": "node scripts/quarantine-numbered-copies.mjs"
```

Run:

```bash
npm test -- --runInBand __tests__/scripts/quarantine-run-capability.test.ts __tests__/scripts/quarantine-path-policy.test.ts __tests__/scripts/quarantine-inventory.test.ts __tests__/scripts/quarantine-journal.test.ts __tests__/scripts/quarantine-manifest.test.ts __tests__/scripts/quarantine-numbered-copies.test.ts
git diff --check
```

Expected: all focused suites PASS and the diff check is silent.

- [ ] **Step 11: Commit restore, facade, and CLI**

```bash
git add scripts/quarantine-restore.mjs scripts/quarantine-numbered-copies-support.mjs scripts/quarantine-numbered-copies.mjs package.json package-lock.json __tests__/scripts/quarantine-numbered-copies.test.ts
git commit -m "feat: add recoverable quarantine restore CLI"
```

- [ ] **Step 12: Obtain independent security and code-quality review**

Give reviewers the design, commits from Tasks 1-2, and the six required test
matrices: path attacks, journal replay/SIGKILL, concurrency mutation, same-device
and `EXDEV`, restore interruption, and RSS. Do not operate on the original
checkout until both reviewers report no critical or important findings and the
focused tests plus full Jest pass.

- [ ] **Step 13: Replace the obsolete commit history only after review**

Do not reset or rebase while developing the replacement. After the reviewed
implementation is green, create a safety tag or backup branch, then use an
interactive rebase to rewrite `848e440` as the new behavior-test history and
drop or squash-replace the unsafe implementation commits `30f16a2`, `a087008`,
`abc82a5`, `7375de5`, and `2c27ecc`. Preserve the original design/plan commits
and this amendment. Re-run every focused suite, full Jest, and `git diff --check`
against the rewritten branch before merge.

- [ ] **Step 14: Inspect the original checkout without mutation**

Stop all writers first. Run from the feature worktree while the original
checkout remains on `main`:

```bash
TARGET=/Users/taejunoh/Desktop/LFG/easy-job-application-tracker
QUARANTINE="$HOME/Library/Application Support/easy-job-application-tracker/quarantine"
EXPECTED_HEAD="$(git -C "$TARGET" rev-parse HEAD)"
node scripts/quarantine-numbered-copies.mjs inspect \
  --repo-root "$TARGET" --quarantine-root "$QUARANTINE" \
  --expected-branch main --expected-head "$EXPECTED_HEAD" --expected-count 65
```

Require exactly 65 total, 61 identical, and 4 divergent; require repository and
quarantine `dev` values to match. Stop if any count, branch, HEAD, quiescence, or
device gate differs.

- [ ] **Step 15: Apply and verify the external quarantine**

Run `apply` with the same arguments, same `EXPECTED_HEAD`, and
`--writers-stopped`. Record the returned validated transaction ID privately.
Resolve its audit data only through the capability and immutable pointer APIs. Replay the
journal, verify modes `0700`/`0600`, require state `QUARANTINED`, two matching
post-move inventory passes, absent sources, and four divergent classifications
without printing any diff contents.

- [ ] **Step 16: Regenerate and validate the original checkout**

```bash
npm ci
npm ls --depth=0
npm run check:audit
npm run lint -- --max-warnings=0
npm run typecheck
npm test -- --runInBand --no-cache
npm run check:extension
npm run build
```

Run in `$TARGET`. Require no numbered entries in source, regenerated
`node_modules`, or `.next`, and require clean Git status. On failure preserve
the quarantine, stop, and report the exact gate before considering explicit
`recover --rollback` or `restore`.

- [ ] **Step 17: Mark validation and establish retention**

Run `mark-validated --repo-root "$TARGET" --quarantine-root "$QUARANTINE" \
--transaction-id "$TRANSACTION_ID" --writers-stopped`. Require a replayable
`VALIDATED` state, `deleteAfter` exactly four full UTC days after `validatedAt`,
and `deletionRequiresConfirmation: true`. Create a reminder for final review and
explicit deletion confirmation; never schedule or perform automatic deletion.

### Task 3: Route manual backups through the coordinator

**Files:**
- Modify: `__tests__/ci/production-backup-workflow-contract.test.ts`
- Modify: `docs/operations/production-runbook.md:156-169`

- [ ] **Step 1: Add a failing documentation contract**

```ts
it("routes manual backups through the sanitized coordinator", () => {
  const runbook = readFileSync(
    join(root, "docs/operations/production-runbook.md"), "utf8",
  );
  const normalized = runbook.replace(/\s+/gu, " ");
  expect(runbook).not.toMatch(/pg_dump\s+["']?\$DATABASE_URL/gu);
  expect(runbook).not.toMatch(/--dbname(?:=|\s+)["']?\$DATABASE_URL/gu);
  expect(normalized).toContain(
    'node scripts/create-snapshot-backup.mjs "$BACKUP_FILE" "$SOURCE_FINGERPRINT"',
  );
  expect(normalized).toContain(
    "DATABASE_URL must already be present in the approved secret-management environment",
  );
});
```

- [ ] **Step 2: Verify RED and commit the test**

```bash
npm test -- --runInBand __tests__/ci/production-backup-workflow-contract.test.ts
git add __tests__/ci/production-backup-workflow-contract.test.ts
git commit -m "test: reject raw database URL backup commands"
```

- [ ] **Step 3: Replace the runbook command**

State that `DATABASE_URL` is supplied by approved secret management and must not
be pasted into the command line. Document:

```bash
umask 077
BACKUP_FILE="/approved/private/path/jobtracker.dump"
SOURCE_FINGERPRINT="/approved/private/path/jobtracker-fingerprint.json"
BACKUP_TOC="/approved/private/path/jobtracker.toc"
BACKUP_CHECKSUM="/approved/private/path/jobtracker.dump.sha256"
node scripts/create-snapshot-backup.mjs "$BACKUP_FILE" "$SOURCE_FINGERPRINT"
pg_restore --list "$BACKUP_FILE" > "$BACKUP_TOC"
shasum -a 256 "$BACKUP_FILE" > "$BACKUP_CHECKSUM"
shasum -a 256 -c "$BACKUP_CHECKSUM"
```

- [ ] **Step 4: Verify GREEN and commit**

```bash
npm test -- --runInBand __tests__/ci/production-backup-workflow-contract.test.ts
git diff --check
git add docs/operations/production-runbook.md
git commit -m "docs: secure the manual backup path"
```

### Task 4: Prove PostgreSQL 17 Docker signal cleanup

**Files:**
- Create: `__tests__/scripts/create-snapshot-backup.docker.integration.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `__tests__/ci/workflow-contract.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write the gated real-Docker test**

Use `RUN_BACKUP_DOCKER_INTEGRATION=1`; otherwise skip. When requested, missing
`DATABASE_URL`, container ID, Docker, or PostgreSQL 17 is a failure, never a
skip. Test both `["SIGINT", 130]` and `["SIGTERM", 143]`.

Use `assertDatabaseTestSafety`, a disposable DB client, and an ACCESS EXCLUSIVE
lock on a test-only `backup_signal_gate` table to hold the real container-side
`pg_dump`. Wait for the coordinator PID file and `/proc/<pid>/comm=pg_dump`,
signal the coordinator, then require:

- exact 130/143 exit with empty stdout/stderr;
- captured PID gone and no command line containing
  `--dbname=service=jobtracker_backup_`;
- no container service/PID/start/cancel file;
- no local credential, dump, partial dump, fingerprint, or partial fingerprint.

All Docker calls use argument arrays and bounded waits. Release the lock, drop
the gate table, and remove unique test residue in `finally`; cleanup must not
hide a failed absence assertion.

- [ ] **Step 2: Add scripts and workflow contract RED**

Add:

```json
"test:backup:docker": "RUN_BACKUP_DOCKER_INTEGRATION=1 jest --runInBand __tests__/scripts/create-snapshot-backup.docker.integration.test.ts"
```

Change the workflow contract to require:

```yaml
image: postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193
- name: Prove real Docker backup interruption cleanup
  env:
    RUN_BACKUP_DOCKER_INTEGRATION: "1"
    PG_DUMP_DOCKER_CONTAINER: ${{ job.services.postgres.id }}
  run: npm run test:backup:docker
```

Run the workflow contract before editing CI and verify RED.

- [ ] **Step 3: Update CI and documentation**

Pin the verify service to the exact PostgreSQL 17 digest above. Add the focused
Docker step after full Jest. Document `npm run test:backup:docker` in README as
disposable-only and never Production.

- [ ] **Step 4: Verify and commit**

```bash
npm test -- --runInBand __tests__/ci/workflow-contract.test.ts __tests__/scripts/create-snapshot-backup.docker.integration.test.ts
npm run lint -- --max-warnings=0
git diff --check
git add __tests__/scripts/create-snapshot-backup.docker.integration.test.ts package.json package-lock.json .github/workflows/ci.yml __tests__/ci/workflow-contract.test.ts README.md
git commit -m "test: prove real Docker backup signal cleanup"
```

Local default Jest may skip the real-Docker suite. Mandatory GREEN evidence
comes from branch CI using its PostgreSQL 17 service container.

### Task 5: Verify, review, publish, and merge

**Files:**
- Verify all Task 1-4 changes.
- Publish: `codex/foundation-cleanup`
- Merge into: `main`

- [ ] **Step 1: Run focused and full local gates**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-path-policy.test.ts __tests__/scripts/quarantine-inventory.test.ts __tests__/scripts/quarantine-journal.test.ts __tests__/scripts/quarantine-numbered-copies.test.ts __tests__/ci/production-backup-workflow-contract.test.ts __tests__/ci/workflow-contract.test.ts __tests__/scripts/create-snapshot-backup.integration.test.ts
npm ls --depth=0
npm run check:audit
npm run lint -- --max-warnings=0
npm run typecheck
npm test -- --runInBand --no-cache
npm run check:extension
npm run build
npm run test:extension:e2e:local
git diff --check origin/main...HEAD
```

Require every command to pass and the disposable extension E2E DB to be absent.

- [ ] **Step 2: Obtain independent reviews**

After each implementation task, obtain spec approval followed by code-quality
approval. Then perform a final read-only review of `origin/main...HEAD`. Fix
every Critical or Important issue and rerun affected gates.

- [ ] **Step 3: Push, open PR, and require CI**

```bash
git push -u origin codex/foundation-cleanup
gh pr create --base main --head codex/foundation-cleanup --title "Harden workspace cleanup and backup verification"
gh pr checks --watch
```

Require verify—including the real-Docker step—extension E2E, and Vercel checks.
If real Docker reproduces an orphan, stop before merge for a separately approved
runner redesign.

- [ ] **Step 4: Merge and synchronize**

```bash
gh pr merge --merge --delete-branch
git -C /Users/taejunoh/Desktop/LFG/easy-job-application-tracker fetch origin
git -C /Users/taejunoh/Desktop/LFG/easy-job-application-tracker merge --ff-only origin/main
```

Remove only the agent-created linked worktree and merged local branch. Preserve
the external quarantine.

- [ ] **Step 5: Continue while the four-day retention clock runs**

Confirm manifest status/checksum and the reminder. The clean checkout can begin
extension stabilization while the quarantine stays read-only. At the deadline,
show the manifest summary and four divergent classifications and request
explicit deletion confirmation. Never delete automatically.
