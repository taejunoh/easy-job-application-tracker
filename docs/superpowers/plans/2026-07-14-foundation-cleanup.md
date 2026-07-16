# Foundation Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quarantine every numbered workspace copy without data loss, regenerate a deterministic local environment, route manual backups through the hardened coordinator, and prove real-Docker interruption cleanup.

**Architecture:** A built-in-only Node CLI opens a callback-scoped opaque run capability, streams FD-bounded deterministic inventories, and atomically moves source copies plus complete generated roots into an external quarantine on the same filesystem. A hash-chained, fsync-backed append-only journal is the recovery authority; immutable digest-named manifest generations and one atomic root pointer make publication crash-safe, while every writer derives and revalidates its path through the live capability. Operations changes remain separate: a documentation contract replaces raw database-URL backup arguments, while a focused PostgreSQL 17 Docker test proves signal cleanup using the existing coordinator and CI service container.

**Tech Stack:** Node.js 22 ESM, Git CLI, Jest/ts-jest, PostgreSQL 17, Docker, GitHub Actions, Markdown operations contracts

---

## File map

- Create `scripts/quarantine-run-capability.mjs`: callback-scoped opaque writer authority, validated run identity, purpose/ID path derivation, and phase-boundary revalidation.
- Create `scripts/quarantine-run-fs-context.mjs`: private WeakMap binding from a live run capability to its one captured, frozen filesystem adapter; never re-export it from the compatibility facade.
- Modify `scripts/quarantine-path-policy.mjs`: retain closed schemas, normalized relative-path policy, resolve-under-root guards, fixed generated-root allowlist, entry-ID derivation, and same-device checks.
- Modify `scripts/quarantine-inventory.mjs`: bounded-memory file hashing and deterministic streaming JSONL inventories with digest/count/byte summaries.
- Modify `scripts/quarantine-journal.mjs`: mode-`0600` length-framed hash-chain append, fsync, replay, torn-tail handling, and lifecycle validation.
- Modify `scripts/quarantine-manifest.mjs`: pure closed manifest builder, immutable digest-named generations, canonical root-level current pointer, and four-day validation metadata.
- Create `scripts/quarantine-workspace-runtime.mjs`: private closed option parsing, Git discovery, fixed-layout bootstrap, one captured filesystem source, semantic ledger replay, and durable move helpers shared by transaction and restore.
- Create `scripts/quarantine-transaction.mjs`: preflight, atomic apply moves, destination verification, crash reconciliation, explicit resume, and reverse-order rollback.
- Create `scripts/quarantine-restore.mjs`: active-tree rollback moves, quarantined-payload restore, restore replay, and conflict preservation.
- Replace `scripts/quarantine-numbered-copies-support.mjs` with a thin compatibility facade exporting the focused modules.
- Create `scripts/quarantine-numbered-copies.mjs`: thin CLI with `inspect`, `apply`, `recover`, `mark-validated`, and `restore` subcommands.
- Replace `__tests__/scripts/quarantine-numbered-copies.test.ts` with focused compatibility sentinels; split transaction, apply-crash, restore, restore-crash, and spawned-CLI behavior into their own suites.
- Create `__tests__/scripts/quarantine-transaction.test.ts`, `quarantine-transaction-crash.integration.test.ts`, `quarantine-restore.test.ts`, `quarantine-restore-crash.integration.test.ts`, and `quarantine-cli.test.ts` plus child workers under `__tests__/fixtures/quarantine/`.
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

Use this exact Task 1A baseline contract. Task 2 Slice 0 later extends its
closed phase/purpose union without changing the module export set:

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
inventory phases accept only a manifest entry ID. This is the Task 1A baseline;
Task 2 Slice 0 normatively changes `restore-active` to the two generated entry
IDs and adds the validation phases plus `rollback-entry`. Validate each selected
parent as a mode-`0700` non-symlink directory and realpath-contained under the
recorded root before returning a path and at both mutation boundaries.

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

Inject a crash after each boundary: generation temporary-file sync,
deterministic generation hard-link publication, generation-directory sync,
pointer temporary-file sync, pointer rename, and quarantine-root sync. After
each crash, `readCurrentManifestPointer` plus `readManifestGeneration` must
return the old or new complete generation, and the old generation must remain
readable. Assert `appendValidated` is called exactly once after the generation
directory sync and before pointer temporary write, with `{ manifestSha256 }`.
Inject temporary cleanup failure and require the primary publication error plus
cleanup error to be preserved without deleting an existing generation or
pointer. After generation hard-link publication begins, inject post-link and
post-sync identity/mode failures and require the owned generation temporary to
remain as reconciliation evidence.

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
temporary, publish the digest-named generation with a deterministic
same-filesystem hard link that never replaces an existing generation, and sync
the manifest directory. After hard-link publication begins, preserve the owned
temporary on any post-link or post-sync identity/mode failure. Activation then
calls `appendValidated` and publishes the canonical pointer via a mode-`0600`
temporary, rename-over-`current`, and root sync. Revalidate capability identity
before each mutation phase and after its last sync. Readers derive paths from
the validated digest, enforce byte limits before parsing, compare
filename/content digest, and rerun the closed builder. Delete the pre-amendment
mutable generation, checksum-sidecar, ID-only pointer, and run-local pointer
protocol.

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

### Task 1F: Bind every primitive writer to one filesystem context

**Mandatory gate:** This amendment runs after Task 1E and before Task 2. A prior
Task 1E review does not waive it. Use one implementer sequentially for Slices
A-E because every later slice depends on the binding introduced in Slice A.
Task 2 and mutation of the original checkout remain blocked until the final
gate reports zero Critical, zero Important, and zero Minor findings.

**Files:**
- Create: `scripts/quarantine-run-fs-context.mjs`
- Modify: `scripts/quarantine-run-capability.mjs`
- Modify: `scripts/quarantine-inventory.mjs`
- Modify: `scripts/quarantine-journal.mjs`
- Modify: `scripts/quarantine-manifest.mjs`
- Modify: their four dedicated test files

#### Slice A: Bind and invalidate the run filesystem context

- [ ] **Step A1: Write the binding RED tests**

In `quarantine-run-capability.test.ts`, use a complete adapter with instrumented
getters for `lstat`, `realpath`, `mkdir`, `open`, `readdir`, `rm`, `rename`,
`unlink`, `link`, `opendir`, `readlink`, `createReadStream`, `lstatSync`, and
`realpathSync`. Require each method implementation and its receiver to be
captured once during capability creation. Replace source methods during the
callback and require derivation/revalidation to keep using the captured view.
Require both resolved and rejected callbacks to invalidate the binding, and
assert the run-capability module still has exactly its existing three exports.

- [ ] **Step A2: Run RED**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-run-capability.test.ts
```

Expected: FAIL because filesystem state is currently private to the capability
module and cannot be shared with primitive writers.

- [ ] **Step A3: Implement the private WeakMap binding**

Create `quarantine-run-fs-context.mjs` with no imports from quarantine modules.
Normalize the complete method set once, capture each implementation with its
source receiver, freeze the adapter, and bind it to the opaque capability in a
module-private `WeakMap`. A writer lookup returns the same adapter object every
time. An omitted writer `fsApi` selects it; a present value is accepted only
when it is the exact source object used at capability creation. Invalidate and
remove the binding in the capability callback's `finally` before settlement.
Do not add or remove an export from any existing public primitive module.

- [ ] **Step A4: Verify and commit**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-run-capability.test.ts
git diff --check
git add scripts/quarantine-run-fs-context.mjs scripts/quarantine-run-capability.mjs __tests__/scripts/quarantine-run-capability.test.ts
git commit -m "fix: bind quarantine filesystem context"
```

#### Slice B: Remove the inventory split view

- [ ] **Step B1: Write inventory RED tests**

Bind adapter A at capability creation. Require `writeInventoryJsonl` and
`fsyncTree` to use A for traversal, streams, work files, publication, and
cleanup when their `fsApi` field is omitted. Passing a distinct equal-looking
adapter B must fail before output or work mutation and must call no B method.
Replacing A's source methods after binding must not change the captured view.
Move every inventory fault adapter to capability creation. Keep standalone
`hashFileStream` behavior and the inventory module's existing six exports.

- [ ] **Step B2: Run RED**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-run-capability.test.ts __tests__/scripts/quarantine-inventory.test.ts
```

Expected: FAIL because the inventory writers currently normalize their own
optional adapters.

- [ ] **Step B3: Implement bound inventory I/O**

Resolve the capability-bound adapter once at each capability-bearing public
entry point and pass it through every private helper. Use a private hashing core
for writer-internal file hashes so it does not normalize the bound adapter
again. Retain the public capability-free `hashFileStream` adapter option only
for standalone use.

- [ ] **Step B4: Verify and commit**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-run-capability.test.ts __tests__/scripts/quarantine-inventory.test.ts
git diff --check
git add scripts/quarantine-inventory.mjs __tests__/scripts/quarantine-inventory.test.ts
git commit -m "fix: bind inventory IO to run capability"
```

#### Slice C: Close journal inputs and bind journal I/O

- [ ] **Step C1: Write journal adapter and option RED tests**

Require exact closed plain-object snapshots before the first await for these
option records: `replayJournal`, `withJournalLock`, `appendJournalRecord`,
`reclaimJournalLock`, and `cleanupTerminalJournalArtifacts`. Reject unknown
string or symbol keys and missing required own keys; evaluate each accepted
getter exactly once. Bind adapter A at capability creation, require all journal
and lock operations to use it, and reject a distinct adapter B before mutation.
The held-lock state and every append must reference the same frozen adapter.

- [ ] **Step C2: Run RED**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-run-capability.test.ts __tests__/scripts/quarantine-journal.test.ts
```

Expected: FAIL because the public functions currently destructure open option
records and select per-call adapters.

- [ ] **Step C3: Implement snapshots and bound journal lookup**

Change the five public functions to snapshot exact allowed and required keys
synchronously, then resolve the capability binding. Keep `fsApi` as an optional
source-identity assertion only. Route recovery and terminal cleanup through
private cores rather than re-entering a public API with a normalized adapter.
Preserve the journal module's complete existing export set.

- [ ] **Step C4: Verify and commit**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-run-capability.test.ts __tests__/scripts/quarantine-journal.test.ts
git diff --check
git add scripts/quarantine-journal.mjs __tests__/scripts/quarantine-journal.test.ts
git commit -m "fix: close journal writer inputs"
```

#### Slice D: Revalidate durable journal phases and exact modes

- [ ] **Step D1: Write durability and mode RED tests**

Require journal, live lock, stale lock, and tombstone reads to reject every mode
other than exact `0600`, including special bits, without changing evidence.
Require newly opened journal and lock files to be changed to and verified at
`0600` through handle and path identities. Instrument sync ordering so append
`after-sync` occurs only after the journal parent sync. Require a torn-tail
truncate phase and every stale-lock rename or owned-artifact removal to have
matching capability checks before mutation and after parent sync. At each
identity-change seam, require failure without deleting an unproved artifact.

- [ ] **Step D2: Run RED**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-journal.test.ts
```

Expected: FAIL because append currently revalidates before its last parent
sync, cleanup removals lack complete phase boundaries, and journal artifacts are
not uniformly checked for exact mode `0600`.

- [ ] **Step D3: Implement the journal phase order**

Use this order for an append mutation: held-lock check, capability
`before-mutation`, journal mutation, file sync, parent sync, capability
`after-sync`, then journal and held-lock identity/mode checks. Revalidate a
durable torn-tail truncation before continuing. Prevalidate every cleanup
artifact, then wrap each rename/removal in its own before-mutation, parent-sync,
and after-sync boundary. Preserve primary, cleanup, and indeterminate error
semantics and never remove a foreign replacement.

- [ ] **Step D4: Verify and commit**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-run-capability.test.ts __tests__/scripts/quarantine-journal.test.ts
git diff --check
git add scripts/quarantine-journal.mjs __tests__/scripts/quarantine-journal.test.ts
git commit -m "fix: revalidate durable journal phases"
```

#### Slice E: Verify manifest targets after their last sync

- [ ] **Step E1: Write manifest binding and identity RED tests**

Require adapter A bound at capability creation to serve every manifest read,
temporary, generation, pointer, and cleanup operation; reject adapter B before
mutation. After generation-directory sync, require a newly linked generation
to retain the temporary identity and exact mode `0600`, or an adopted generation
to retain its bounded-read identity and mode. During activation retain and
recheck the selected generation identity across its directory sync before
`appendValidated`. After pointer rename and quarantine-root sync, require
`current` to retain the pointer temporary identity and exact mode `0600`.
Identity or mode changes fail closed with available evidence preserved; a
post-link or post-sync generation failure must leave the owned generation
temporary intact. Assert the manifest module still exposes exactly its existing
five exports.

- [ ] **Step E2: Run RED**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-run-capability.test.ts __tests__/scripts/quarantine-manifest.test.ts
```

Expected: FAIL because manifest APIs normalize per-call adapters and current
post-sync checks validate parents but not every published target identity.

- [ ] **Step E3: Implement bound manifest I/O and retained identities**

Resolve the capability adapter at each public entry. Add a private bounded
generation snapshot returning its validated manifest, path, and identity; the
public reader still returns only the manifest. Carry the linked or adopted
generation identity through parent sync and carry the pointer temporary
identity through root sync. Revalidate capability containment and exact target
identity/mode before advancing or returning. After generation hard-link
publication begins, do not clean up the owned temporary when post-link or
post-sync identity/mode verification fails. Preserve existing primary-before-
cleanup error ordering for cleanup attempts that remain eligible; “aggregate
cleanup behavior” means only that error ordering and does not authorize removal
of required publication evidence. Keep all five public exports unchanged.

- [ ] **Step E4: Verify and commit**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-run-capability.test.ts __tests__/scripts/quarantine-manifest.test.ts
git diff --check
git add scripts/quarantine-manifest.mjs __tests__/scripts/quarantine-manifest.test.ts
git commit -m "fix: verify durable manifest identities"
```

- [ ] **Final mandatory primitive gate and independent review**

```bash
npm test -- --runInBand \
  __tests__/scripts/quarantine-run-capability.test.ts \
  __tests__/scripts/quarantine-path-policy.test.ts \
  __tests__/scripts/quarantine-journal.test.ts \
  __tests__/scripts/quarantine-manifest.test.ts \
  __tests__/scripts/quarantine-inventory.test.ts \
  __tests__/scripts/quarantine-numbered-copies.test.ts
npm test -- --runInBand --no-cache
git diff --check
```

Give the amended design, Slices A-E commits, exact focused/full output, adapter
binding evidence, journal phase-order evidence, and manifest post-sync identity
evidence to independent specification and quality reviewers. Repeat the owning
RED/GREEN slice and both reviews for every finding. Task 2 may begin only when
all commands pass and the final aggregate report contains exactly Critical 0,
Important 0, and Minor 0.

### Task 2: Compose recoverable transactions, restore, and CLI; then quarantine

**Mandatory gate:** Task 1F must already have focused/full GREEN evidence and
independent `Critical 0 / Important 0 / Minor 0` reviews. Every Task 2 slice
uses temporary Git repositories only. The original checkout remains read-only
until Slices 0-6, the aggregate gate, history rewrite verification, and both
final reviews pass.

**Files:**
- Modify: `scripts/quarantine-run-capability.mjs`
- Modify: `scripts/quarantine-inventory.mjs`
- Modify: `scripts/quarantine-journal.mjs`
- Create: `scripts/quarantine-workspace-runtime.mjs`
- Create: `scripts/quarantine-transaction.mjs`
- Create: `scripts/quarantine-restore.mjs`
- Replace: `scripts/quarantine-numbered-copies-support.mjs`
- Create: `scripts/quarantine-numbered-copies.mjs`
- Modify: `package.json`
- Replace: `__tests__/scripts/quarantine-numbered-copies.test.ts`
- Create: `__tests__/scripts/quarantine-transaction.test.ts`
- Create: `__tests__/scripts/quarantine-transaction-crash.integration.test.ts`
- Create: `__tests__/scripts/quarantine-restore.test.ts`
- Create: `__tests__/scripts/quarantine-restore-crash.integration.test.ts`
- Create: `__tests__/scripts/quarantine-cli.test.ts`
- Create: focused child-worker fixtures under `__tests__/fixtures/quarantine/`
- Operate only after the final gate on:
  `/Users/taejunoh/Desktop/LFG/easy-job-application-tracker`

Every slice ends with its focused GREEN command, `git diff --check`, one
implementation commit, specification review, then quality review. A slice is
not complete until its review report says exactly Critical 0, Important 0, and
Minor 0; every finding returns to that slice's RED/GREEN cycle.

#### Slice 0: Close the orchestration gaps in the Task 1F primitives

**Interfaces:**
- Preserve every current Task 1F export and filesystem-binding rule.
- Add no export to the run-capability, inventory, or journal modules.
- `restore-active` accepts only `generated-next` and
  `generated-node-modules`; it produces
  `inventories/restore-active/<generated-entry-id>.jsonl` only when that active
  root exists and produces no JSONL for an absent root.
- Add `validation-pass-1` and `validation-pass-2` for those same IDs.
- Add run purpose `{ purpose: "rollback-entry", id: restoreId,
  phase: generatedEntryId }`, deriving only `.next` or `node_modules` under
  `rollback/regenerated-before-restore/<restore-id>/`. `restoreId` is exactly
  `restore-<lowercase-v4-shaped-uuid>` and matches
  `/^restore-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u`;
  a bare UUID is rejected.
- Extend `fsyncTree` with the exact rollback-entry shape from the design.
- Add the exact restore-rollback events and `settleDurableTip` result from the
  design; all unknown keys and illegal transitions remain fatal.
- Permit `RECOVERY_REQUIRED { entryIds: [] }` only for an apply or restore with
  no durable relevant entry intent; add the exact first-intent rollback/abort
  transitions from the design. Every post-intent recovery array remains
  non-empty and equals all durable intent IDs in their original forward journal
  order, including IDs with durable completion events. The array is unique,
  dense, capped at 4,096, and has no independent bytewise-sort requirement;
  conflict IDs alone retain bytewise-sorted order.
- Change `RESTORE_PREPARED` from `{}` to the design's exact
  `{ restoreId, activeGenerated }` payload, with fixed generated IDs and each
  durable pre-restore inventory summary or exact null absence. Both IDs are
  always present in fixed bytewise-sorted order; null is the first durable
  absence record.

- [ ] **Step 0.1: Write the primitive RED tests**

In the capability and inventory suites, require the three new inventory phases,
reject source-copy/restore IDs for them, reject every invalid rollback
purpose/ID/phase combination, and prove symlink, mode, containment, adapter,
10,000-depth, handle, and RSS bounds remain unchanged. In the journal suite,
require exact restore rollback/abort transitions and require zero-append stale
recovery to succeed only for an exact non-torn current tip:

Use one shared canonical example
`restore-123e4567-e89b-42d3-a456-426614174000` across journal, capability,
rollback-path, and fsync tests. Require `RESTORE_PREPARED` to accept it and
reject the bare suffix, uppercase, wrong version/variant, double prefix, and
arbitrary restore strings before append.

```js
return {
  settleDurableTip: {
    sequence: replayed.records.at(-1).sequence,
    recordHash: replayed.records.at(-1).recordHash,
    event: replayed.records.at(-1).event,
    state: replayed.state,
  },
};
```

Test all four allowed event/state pairs from the design. Changing any field,
adding a key, using a pair outside the allowlist, changing the tip between
replays, supplying a torn tail, omitting `writersStopped`, or removing/replacing
the owned stale lock/tombstone must preserve every artifact byte-for-byte.
For terminal `ROLLED_BACK`, `RESTORED`, and `INCOMPLETE_CONFLICT` tips, test only
the existing cleanup-only API and explicitly reject every settlement variant.
Also test PREPARED/MOVING and RESTORE_PREPARED/RESTORING crashes before the
first entry intent: empty recovery IDs may resume, roll back, or abort without
inventing an entry event. The same empty array after one durable intent is fatal.
For apply and restore, append intents in a valid non-bytewise ID order and
require `RECOVERY_REQUIRED.entryIds` to repeat that exact forward journal order;
reject the same IDs reordered bytewise. Include durable completed-entry IDs,
exercise all-completed resume and rollback lifecycles, accept exactly 4,096
intent IDs, and reject a 4,097th intent or recovery ID without changing the tip.
Require `RESTORE_PREPARED` to reject swapped IDs, sparse/custom arrays, unknown
keys, a value other than exact null or a closed `InventorySummary`, a non-null
summary without its matching already-durable restore-active inventory, and any
digest/count/byte mismatch. Require the dense two-record array in fixed
bytewise-sorted ID order and accept exact null without an inventory backing
record. These primitive journal tests do not inspect the live repository active
root, infer whether null is truthful, or own recreation/removal seam tests;
Slice 5 restore/runtime tests own those checks.

- [ ] **Step 0.2: Verify RED**

```bash
npm test -- --runInBand \
  __tests__/scripts/quarantine-run-capability.test.ts \
  __tests__/scripts/quarantine-inventory.test.ts \
  __tests__/scripts/quarantine-journal.test.ts
```

Expected: FAIL only on the new purpose, phase, restore-ID grammar,
full-intent-ledger ordering, transition, and settlement cases.

- [ ] **Step 0.3: Implement the closed extensions and verify GREEN**

Keep the existing capability and bound-adapter lookups. `rollback-entry`
validates the exact prefixed `RestoreId` plus a fixed generated ID before
derivation. Change the journal restore-ID parser to the same prefixed grammar;
do not accept both forms. Split `RECOVERY_REQUIRED` parsing from conflict-array
parsing: recovery IDs are dense, unique, capped at 4,096, and semantically equal
the full forward intent ledger, while conflict IDs remain bytewise sorted. The
selected restore parent must already be a mode-`0700` non-symlink directory.
The journal accepts zero durable appends only after the callback's exact
`settleDurableTip` matches one allowed unchanged replayed tip under the fresh
held lock and all owned stale evidence remains proven. Implement direct
no-intent recovery paths without weakening the non-empty full-intent-ledger
contract after the first intent.

```bash
npm test -- --runInBand \
  __tests__/scripts/quarantine-run-capability.test.ts \
  __tests__/scripts/quarantine-inventory.test.ts \
  __tests__/scripts/quarantine-journal.test.ts
git diff --check
git add scripts/quarantine-run-capability.mjs scripts/quarantine-inventory.mjs \
  scripts/quarantine-journal.mjs __tests__/scripts/quarantine-run-capability.test.ts \
  __tests__/scripts/quarantine-inventory.test.ts __tests__/scripts/quarantine-journal.test.ts
git commit -m "fix: support recoverable transaction orchestration"
```

- [ ] **Step 0.4: Obtain Slice 0 specification and quality approval**

Require exact path/schema/state coverage, no weakened Task 1F invariant, and
Critical 0 / Important 0 / Minor 0.

#### Slice 1: Add closed discovery and idempotent private layout bootstrap

**Interfaces:**

```js
export async function inspectWorkspace({
  repoRoot, quarantineRoot, expectedBranch, expectedHead, expectedCount, fsApi,
}) {}

// Runtime-only: imported by transaction orchestration and focused internal tests.
// It is not a facade or package export.
export async function prepareQuarantineWorkspace({
  repoRoot, quarantineRoot, expectedBranch, expectedHead, expectedCount,
  transactionId, createdAt, writersStopped, fsApi, faultHook,
}) {}
```

Both accept closed plain-object options snapshotted before their first await.
Optional fields may be omitted but no unknown string or symbol key is accepted.
`inspectWorkspace` accepts no writer attestation or fault hook and returns
exactly the public `INSPECTED` result from the design. Slice 1's public
transaction module exports only `inspectWorkspace`.

`prepareQuarantineWorkspace` requires canonical UTC `createdAt`, a validated
transaction ID, and literal `writersStopped === true`. Its only reachable hook
phase is `after-layout-sync`. It returns the exact frozen internal
`LAYOUT_READY` handoff from the design: validated real roots, Git identity,
bytewise-sorted runtime entry plans, and the captured filesystem source. It
does not return `QUARANTINED`, write a journal/manifest/inventory, or move a
source. Slice 2 adds the public `quarantineWorkspace` only when that function can
complete and return the final durable result.

Assert the full internal handoff schema, not only selected values. The top-level
null-prototype record has exactly the design's ten keys and frozen enumerable
data descriptors. `entries` is a frozen dense real array with no holes or
custom keys; its indices are enumerable frozen data descriptors and its length
is a non-enumerable frozen data descriptor. Every source/generated entry and
nested identity is a frozen null-prototype exact-key record with non-writable,
non-configurable enumerable data descriptors. `fsSource` is a frozen
null-prototype exact 14-key record whose 14 frozen data properties each hold a
stable callable wrapper around one captured implementation and receiver.
Recursively assert prototypes, `Reflect.ownKeys`, descriptor flags,
frozen/non-extensible state, and mutation inertness for every reachable record
and array. For callable leaves, assert only `typeof value === "function"`, stable
identity on repeated reads, captured-receiver behavior, exact source-object
identity at capability binding, and the separate bound adapter's existing
revocation behavior. Do not assert a wrapper's `Function` prototype, own keys,
`name`, `length`, descriptors, extensibility, or frozen state; the current
rest-argument arrow-wrapper details are deliberately private.

- [ ] **Step 1.1: Write discovery and bootstrap RED tests**

Each case creates and commits its own temporary Git repository. Require an
absolute NFC non-symlink top level, nonempty NFC symbolic branch (detached HEAD
rejected), lowercase 40/64-hex HEAD, expected count in `0..9999`, clean
tracked/staged state, no unexpected untracked residue, regular source/canonical
files, both non-symlink generated roots, external mode-`0700` quarantine root,
and the same device.

Assert the exact argument-array Git commands and strictly parse
`git -c core.fsmonitor=false status --porcelain=v1 -z --untracked-files=all`:
fatal UTF-8, required final NUL when nonempty, no empty interior frame, and only
`?? <safe numbered path>`.
Reject tracked/staged/rename/copy/malformed records and every unrelated
untracked path. Assert the exact final-component numbered suffix, strict NFC
POSIX paths, derived regular canonical path, UTF-8 bytewise ordering, and the
fixed two generated directories. Do not impose an aggregate status stdout cap:
valid output for 9,999 paths may exceed 1 MiB. Cap each in-progress or complete
porcelain record, including `?? ` but excluding its NUL, at exactly 1,048,576
bytes. Exercise the exact boundary and require byte 1,048,577 before NUL to
kill the child, await close and all streams, and produce `ERR_PREFLIGHT`.
Retain at most `expectedCount` parsed paths plus a streaming raw-status digest;
exercise count overflow without an unbounded path array, and accept a legal
multi-record aggregate status body larger than 1 MiB.

Require two completely independent passes. Each pass reruns Git identity and
status, streams fresh source/canonical hashes, captures source/canonical
dev/ino/mode/size/hash plus generated-root dev/ino/mode, and encodes the exact
canonical NUL frame from the design. Compare the complete bytes. Mutate a path,
body, inode, canonical file, generated-root identity, Git branch/HEAD, or status
between passes and require failure before run creation. Replace a root or
ancestor with a symlink and prove an external sentinel is unchanged.

Assert every runtime discovery Git argv begins exactly
`git -c core.fsmonitor=false` before its subcommand. For divergent history
assert streamed
`git -c core.fsmonitor=false log --all --format=%H -z -- <path>` with incremental
exact lowercase 40/64-hex OID parsing. Each OID body is at most 64 bytes and its
NUL-terminated frame at most 65 bytes; 4,096 frames therefore imply the exact
`4,096 * 65 = 266,240`-byte aggregate invariant without a separate total-byte
cap. Accept 4,096 frames; reject a 4,097th frame and a 65th body byte before
NUL, killing the child and awaiting close and all streams on both failures.
Exercise both an exact 64-byte lowercase OID body plus NUL and the rejected
65-byte body. Do not require a 1-MiB history-output boundary test. For each
commit, assert exact
`git -c core.fsmonitor=false ls-tree -z --full-tree <commitOid> -- <canonicalPath>`
argument boundaries and strict empty-or-one-record parsing. Include canonical
names containing a newline and pathspec punctuation. Empty exit-zero output is
absent. Only exact `100644 blob` and `100755 blob` pairs are body-eligible;
exactly `040000 tree`, `120000 blob`, and `160000 commit` skip without opening
an object body. Reject every other mode/type pair or width/value, as well as
multiple/malformed/mismatched/oversized output, missing NUL, nonzero exit, or
signal. The design's separate 1-MiB stdout cap and boundary tests for
`ls-tree -z` remain required.

For an eligible record assert exact
`git -c core.fsmonitor=false cat-file blob <blobOid>` with the blob OID as the
only object selector, 64-KiB streaming reads, bounded 64-KiB stderr, no
whole-body buffer, and full stdin/stdout/stderr/process settlement on every
success or failure seam. No body command receives a path or `commit:path`.
Assert the stored `historyMatch` is the exact lowercase candidate commit OID,
not the blob OID; the blob OID never leaves the local streaming lookup.

Every Git child must receive the design's exact new null-prototype environment:
only the inherited cross-platform execution/locale allowlist plus
`GIT_OPTIONAL_LOCKS=0`, `GIT_NO_LAZY_FETCH=1`, and
`GIT_LITERAL_PATHSPECS=1`. Assert the env for every command, unchanged Git index
device/inode/mode/size/mtime/ctime, no new lock residue, and an untouched remote
helper/network sentinel when a required promisor object is unavailable.
Configure a hostile `core.fsmonitor` hook or daemon sentinel that would omit a
fresh untracked path if invoked. Assert the sentinel is untouched and status is
complete. Stay scoped to fsmonitor: these read-only commands invoke no repository
hook, diff driver, or textconv filter.

Require `inspectWorkspace` to remain read-only and advisory, including no
writability probe. Require `prepareQuarantineWorkspace` to repeat every gate
only after literal writer attestation. A false/missing attestation fails before
Git or filesystem/layout work. Assert the exact `QuarantineError` name, code,
and fixed sanitized message mapping for `ERR_USAGE`, `ERR_PREFLIGHT`,
`ERR_EXDEV`, and `ERR_INTEGRITY`; injected hook failures propagate unchanged.
For each mapped failure, assert a non-exported Node.js 22 `QuarantineError`
instance whose exact own-key set is `stack`, `message`, `name`, and `code`, with
no symbols or `cause`. Assert all four are non-enumerable frozen data
descriptors, `name`/`message`/`code` exact values, a string stack, read-only code,
non-extensibility, `Object.keys(error) === []`, and
`JSON.stringify(error) === "{}"`. The CLI remains responsible for explicitly
serializing only the fixed code and message.

- [ ] **Step 1.2: Verify RED**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-transaction.test.ts
```

Expected: FAIL because the focused transaction/runtime modules do not exist.

- [ ] **Step 1.3: Implement discovery, source capture, and bootstrap**

Use `git -c core.fsmonitor=false status --porcelain=v1 -z --untracked-files=all`
with argument arrays, and apply the same global `-c core.fsmonitor=false`
prefix to every other Git child.
Implement the design's fatal decoding, exact status grammar, canonical
NUL-frame, fresh two-pass identity, bytewise sorting, streamed hashes, and
bounded child-process lifecycle. Status parsing has no aggregate stdout cap;
enforce its exact per-record bound while retaining at most `expectedCount`
paths and a streaming digest. History parsing enforces exact OID frame length
and count bounds whose arithmetic limits valid output to 266,240 bytes; it has
no redundant 1-MiB aggregate cap. Use `ls-tree -z` only to derive a validated
regular blob OID, then hash only
`git -c core.fsmonitor=false cat-file blob <blobOid>` stdout. Every
read-only Git spawn uses the exact sanitized environment and settles all child
resources. Enforce the design's exact two eligible and three skippable
mode/type pairs; every other pair is fatal. Persist only a matching candidate
commit OID as `historyMatch` and discard the streaming blob OID. No public
result exposes a per-entry path, payload/body content,
per-entry content hash, or undocumented hash; the documented inspection `head`
and later `manifestSha256` outputs remain allowed. No error or hook receives a
path list, content hash, body, diff, stderr, or dynamic underlying error
message. Only the runtime-only `LAYOUT_READY` handoff carries validated paths
and per-entry hashes needed by Slice 2.

The runtime reads each of the existing 14 filesystem methods and its receiver
once into a frozen source before the first filesystem await. Use that exact
source for bootstrap and retain it in the private handoff for Slice 2 to supply
by identity to `withQuarantineRunCapability`; never re-export the private
filesystem context. Test hostile getters, later source mutation, a missing
method, and an equal-looking wrong adapter.

The existing external mode-`0700` quarantine root must already exist. Inspection
performs no write probe; prepare's first required `mkdir` proves writability.
Create only the exact design allowlist one component at a time. For every new
or adopted child: run `mkdir(0700)` only when absent, validate
type/mode/device/realpath/containment, then fsync its containing parent before
advancing. A leaf needs no extra self-sync after its directory entry's parent
is durable. Add a fault for every prefix after create/adoption but before parent
sync; retry must adopt, revalidate, and re-fsync that parent. Revalidate the
complete layout, then call only `faultHook("after-layout-sync")`.

Retry adopts only exact allowlisted private non-symlink directories. Enumerate
each expected parent and reject any file, later-stage artifact, foreign name,
wrong mode/type, symlink, or replacement with `ERR_INTEGRITY`, preserving every
byte. Never chmod, delete, replace, or call `rm`. Direct transaction tests may
import the runtime-only helper but must prove it is absent from the public
transaction module, package exports, and compatibility facade.

- [ ] **Step 1.4: Verify, commit, and review Slice 1**

```bash
npm test -- --runInBand \
  __tests__/scripts/quarantine-run-capability.test.ts \
  __tests__/scripts/quarantine-path-policy.test.ts \
  __tests__/scripts/quarantine-transaction.test.ts
git diff --check
git add scripts/quarantine-workspace-runtime.mjs scripts/quarantine-transaction.mjs \
  __tests__/scripts/quarantine-transaction.test.ts
git commit -m "feat: add stable quarantine preflight"
```

Require Critical 0 / Important 0 / Minor 0 before Slice 2.

#### Slice 2: Apply atomic journaled moves

**Interface added in this slice:**

```js
export async function quarantineWorkspace({
  repoRoot, quarantineRoot, expectedBranch, expectedHead, expectedCount,
  transactionId, createdAt, writersStopped, fsApi, faultHook,
}) {}
```

This is the first slice that publicly exports `quarantineWorkspace`. It consumes
the internal `LAYOUT_READY` handoff, enters a live run capability with the exact
captured filesystem source, and returns only the final `QUARANTINED` result after
the complete durable protocol below. After this slice,
`quarantine-workspace-runtime.mjs` exports exactly `inspectWorkspace`,
`prepareQuarantineWorkspace`, and `quarantineWorkspace`; the transaction module
exports exactly `inspectWorkspace` and `quarantineWorkspace` and is the
authoritative Slice 2 interface. Slice 2 makes no edit to the legacy facade,
package exports, CLI, or package scripts; those change only in Slice 6. An
unrelated legacy facade export already named `quarantineWorkspace` remains
untouched and is not the Slice 2 implementation. The runtime implementation uses
a non-exported core mode named `apply-precommit-resume`; direct
`prepareQuarantineWorkspace` remains strict and no second prepare API is
exposed.

- [ ] **Step 2.1: Add atomic-apply RED cases**

The happy fixture contains two source copies, `node_modules`, and `.next`.
Require this exact precommit order before the first source rename:

```text
closed option snapshot + true writer attestation
-> capture/freeze the one filesystem source
-> nonmutating exact existing-run gate before Git discovery
-> if permitted, two fresh stable discovery passes
-> fixed-layout bootstrap/revalidation + bound run capability
-> deterministic pre inventories in manifest entry order
-> after-pre-inventories
-> divergent patches in manifest entry order
-> after-divergent-diff:<entryId> after each durable patch
-> immutable PREPARED manifest generation
-> after-prepared-generation
-> PREPARED { transactionId, manifestSha256 }
-> after-event:PREPARED after append returns
-> MOVING {}
-> after-event:MOVING after append returns
```

The exact divergent command is one sanitized read-only child with `cwd` equal
to the validated repository root and argv:

```text
git -c core.fsmonitor=false -c core.quotePath=true
  diff --no-index --binary --full-index --no-color --no-ext-diff --no-textconv
  --src-prefix=a/ --dst-prefix=b/ --
  <canonicalRelative> <sourceRelative>
```

Require exit `1`; exit `0` is an integrity mismatch and a signal or any other
exit is fatal. Stream stdout bytes without decoding or newline rewriting into a
capability-derived mode-`0600` temporary opened with `O_EXCL` by the current
invocation using fixed memory. Extend the
closed capability table with exact request
`{ purpose: "divergent-diff-temp", id: <source-copy-entry-id> }`, deriving only
`divergent-diffs/.<entry-id>.tmp`; reject every generated/invalid ID, phase,
wrong hidden name, symlink, nonregular type, non-`0600` mode, device mismatch,
containment change, and identity replacement. Enforce the
exact inclusive safe-integer cap
`4 * (sourceSize + canonicalSize) + 1,048,576`; drain and sanitize bounded
stderr. Sync the temporary, publish without replacement, sync the parent, and
revalidate post-sync identity. Then unlink the current-invocation temporary,
sync the parent again, and capability-revalidate temporary `ENOENT` plus the
final's captured identity before the durable-publish hook. On retry, recompute
and stream-compare exact bytes, digest, and mode before adopting an existing
complete patch.
`--no-ext-diff --no-textconv` must leave hostile external-diff and textconv
sentinels untouched. Treat the exact Git executable/version, argv, closed
environment, and repository built-in attributes/configuration as the canonical
byte inputs; retry reruns the command instead of trusting the previous process
context.

Then require this exact durable order per entry:

```text
MOVE_INTENT -> source/destination recheck -> rename -> payload fsync
-> destination-parent fsync -> source-parent fsync
-> moved-pass-1 inventory -> MOVED
```

After all entries require `VERIFYING`, independent `moved-pass-2`, all sources
absent, no numbered residue, then `QUARANTINED`. Assert no intermediate
byte-identical manifest generation and no root `current` pointer before
validation.

Add retry fixtures for a kill or injected failure at every precommit seam. The
same `quarantineWorkspace` invocation must rerun fresh discovery and may adopt
only exact deterministic complete published `pre` inventories, divergent
patches, and the immutable PREPARED generation. Preserve every preexisting
inventory work/publication temporary and manifest temporary; Slice 2 never
adopts or cleans them because their public fault seams follow final publication.
Primitive-internal owned-temp cleanup remains local to the primitive and a
current-invocation `O_EXCL` handle identity. Preserve complete
mismatches, foreign names/files, symlinks, wrong modes, identity replacements,
and unresolved lock/tombstone evidence and require `ERR_INTEGRITY` or
`ERR_INDETERMINATE_JOURNAL_APPEND` as applicable. Assert no source rename before
durable PREPARED.

Before allowing the fixture's first Git child, assert the exact existing-run
decision priority. After option and filesystem-source snapshot, an absent exact
run path may continue. An existing wrong type/mode/symlink/device/containment
fails `ERR_INTEGRITY`. An exact run is inspected under its capability: any
complete journal beginning at PREPARED, including a QUARANTINED tip, or any
lock, tombstone, torn journal, or append residue causes zero mutation and
`ERR_RECOVERY_REQUIRED`. Permit `ERR_INDETERMINATE_JOURNAL_APPEND` instead only
when the primitive evidence proves one exact attempted candidate; otherwise
recovery-required wins. Assert that this journal/recovery branch has priority
over a simultaneous precommit-looking mismatch and launches no Git child.

With no journal or residue, admit every ancestor-closed subset of the exact
Slice 1 fixed directories when every present name is a same-device,
realpath-equal, non-symlink mode-`0700` directory and no file or foreign name
exists. Strict bootstrap must complete and re-fsync every such prefix. Add a
table-driven case for every prefix from run-root-only through the complete empty
layout. Also admit valid branching subsets, such as present `manifests` and
`payload` while `inventories` is absent when both required parents are present;
reject an orphan child whose fixed lexical parent is absent, plus files and
foreign names.

Private precommit resume requires the complete fixed layout and admits only
published `pre` inventories, one published manifest digest generation, legal
divergent final patches, and deterministic divergent temporaries. Reject and
preserve any inventory/work or manifest temporary even when its UUID/digest
grammar and mode look valid, plus any payload, moved/validation/restore
inventory, current pointer, rollback, conflict, foreign name, or malformed
artifact. Direct `prepareQuarantineWorkspace` retains the Slice 1 strict
rejection of every file; only runtime `quarantineWorkspace` may enter the
non-exported `apply-precommit-resume` core mode.

Test the exact divergent temporary matrix. A final alone is adopted only after
capturing device/inode/mode/size before the streamed comparison and proving the
same identity after read and after final/parent sync. With final plus temp,
unlink temp only when its current complete identity equals the captured exact
final after final and parent durability. After unlink, fsync the
`divergent-diffs` parent again and capability-revalidate temporary `ENOENT` plus
the final's exact captured identity; a different/reappeared temp or changed
final is preserved with `ERR_INTEGRITY`. With temp alone, capture its complete identity before read,
recompute and stream-compare the complete canonical patch, and recheck that
identity after read and immediately before link. Publish no-replace, require the
final identity to equal the capture, sync final, recheck final and temp before
parent sync, sync parent, and recheck both afterward. Only then
identity-check/unlink temp and fsync the parent again. Inject swaps after compare
but before link, after link but before final sync, after final sync but before
parent sync, and after parent sync; every mismatch preserves evidence and
returns `ERR_INTEGRITY`. Preserve partial, mismatching, nonregular, wrong-mode,
and replaced temps. Only a temp
successfully `O_EXCL`-created by the current invocation may be identity-checked
and removed on its local prepublication failure; path/mode/inode observations
alone never authorize deletion of a preexisting temp.

For both cleanup branches, inject failure of the parent fsync after temp unlink,
a final swap after cleanup sync, and temporary reappearance before post-sync
validation. Require no successful adoption, exact `ERR_INTEGRITY`, preservation
of every remaining or foreign artifact, temporary `ENOENT` plus final captured
identity on success, and no attempt to unlink a reappeared path.

Make normal current-invocation publication, final-plus-same-inode retry, and
temp-only retry call one private durable cleanup helper with that exact
unlink/parent-sync/ENOENT/final-identity protocol. Apply the same cleanup-sync,
final-swap, and temp-reappearance RED cases to all three branches. None may call
`after-divergent-diff:<id>` or advance toward PREPARED before the helper returns.

Seed each durable Slice 2 tip `PREPARED`, `MOVING`, `VERIFYING`, and
`QUARANTINED`, then call `quarantineWorkspace` again. Require no filesystem or
journal mutation and the exact frozen `QuarantineError` code/message for
`ERR_RECOVERY_REQUIRED`. The presence of any complete PREPARED frame, not only
the current nonterminal state, closes fresh apply. Slice 2 must not append
`RECOVERY_REQUIRED`; that belongs to Slice 3.

Inject rename `EXDEV` and require fresh checks that the source identity is
unchanged and destination remains absent, then the exact frozen `ERR_EXDEV`
error, no copy, no unlink, and no later mutation. Change either side after
`EXDEV` and require `ERR_INTEGRITY`. Inject deterministic failures after durable
PREPARED and require the current durable tip plus every existing lock/tombstone
artifact to remain unchanged. Inject append uncertainty at every event and
require the exact frozen `ERR_INDETERMINATE_JOURNAL_APPEND` error and no later
mutation.

For every expected error, assert the frozen closed `QuarantineError` prototype,
the exact non-enumerable own keys `stack`, `message`, `name`, and `code`, the
fixed code-mapped message, no cause/dynamic evidence, and `{}` JSON. Ordinary
orchestration-hook rejections remain untranslated and are asserted at their
documented durable seams. Rejection from final
`after-event:QUARANTINED` or `before-lock-cleanup` is instead wrapped by the
journal primitive and must produce `ERR_INDETERMINATE_JOURNAL_APPEND`.

Record hook order and call count. Require every ordinary
`after-event:PREPARED`, `after-event:MOVING`, `after-event:MOVE_INTENT:<id>`,
`after-event:MOVED:<id>`, and `after-event:VERIFYING` callback to occur after
its append primitive has returned and removed its owned lock. For final
`QUARANTINED`, require `after-event:QUARANTINED` exactly once followed by
`before-lock-cleanup`, both after replay can observe the complete durable frame
and while the owned lock still exists. Kill at either final hook and require the
durable tip and lock evidence to remain.

Assert exact journal payload schemas (`PREPARED` has only `transactionId` and
`manifestSha256`; lifecycle events have `{}`; intent/completion events have
only the documented ID and inventory summary), exact immutable manifest bytes,
exact inventory summaries, and the exact closed success result. Diff fixtures
cover text with and without final newline, paths requiring Git quoting, binary
output, a divergent fixture with one zero-byte side, cap and cap-plus-one,
safe-integer boundary and overflow rejection before spawn, exit `0`, exit `1`,
signal, stderr of exactly 64 KiB and 64 KiB plus one with full child/stream
settlement, partial stream failure, no-replace collision, post-sync identity
swap, hostile external-diff/textconv sentinels, and exact retry adoption. Tests
must observe fixed memory rather than buffer complete bodies.

- [ ] **Step 2.2: Verify RED**

```bash
npm test -- --runInBand \
  __tests__/scripts/quarantine-run-capability.test.ts \
  __tests__/scripts/quarantine-transaction.test.ts
```

- [ ] **Step 2.3: Implement minimal apply**

Use runtime entry plans containing only the validated manifest entry plus
ephemeral source/destination locations. All persistent references are entry IDs
and summaries. Implement the existing-run gate and private precommit
reconciliation in the runtime module's non-exported core mode
`apply-precommit-resume`, using existing capability-derived inventory, manifest,
and temporary publication primitives. Export runtime `quarantineWorkspace` and
have the transaction module export it alongside `inspectWorkspace`; preserve the
exact runtime and transaction export sets specified above. Do not edit the
legacy facade or package in Slice 2, even if the facade already has an unrelated
legacy symbol with the same name. Keep direct `prepareQuarantineWorkspace` on
the strict Slice 1 core mode.

Extend `quarantine-run-capability.mjs` only with the closed
`divergent-diff-temp` purpose and its deterministic hidden entry-ID path. Under
an exact run capability, require its existing parent and the optional temporary
to pass the documented mode/type/device/no-follow/identity checks before and
after mutation. Implement the exact final/temporary matrix above. Never infer
deletion authority from a preexisting temp's path/mode/inode alone; unlink on a
local failure only when the current invocation successfully created it with
`O_EXCL` and retained its handle identity.

Use a fresh `withJournalLock` boundary for each append. Do not claim or attempt
to hold one journal lock across discovery, diff, inventory, rename, or tree-sync
work. For every normal non-final event, invoke its public `after-event` hook only
after the append primitive returns and its successful lock cleanup is complete.
On an indeterminate append, map to `ERR_INDETERMINATE_JOURNAL_APPEND` and stop
before the next seam. A deterministic post-PREPARED error preserves the tip and
all existing lock evidence and does not synthesize a recovery event.

For the final `QUARANTINED` append only, pass a private journal fault hook that
invokes public `after-event:QUARANTINED` and then `before-lock-cleanup` after the
frame and journal parent are durable but before owned-lock cleanup. Do not invoke
`after-event:QUARANTINED` again after append returns.

Return only:

```js
{ transactionId, status: "QUARANTINED", movedEntries, manifestSha256 }
```

- [ ] **Step 2.4: Verify, commit, and review Slice 2**

```bash
npm test -- --runInBand \
  __tests__/scripts/quarantine-run-capability.test.ts \
  __tests__/scripts/quarantine-transaction.test.ts \
  __tests__/scripts/quarantine-inventory.test.ts \
  __tests__/scripts/quarantine-journal.test.ts \
  __tests__/scripts/quarantine-manifest.test.ts
git diff --check
git add scripts/quarantine-run-capability.mjs scripts/quarantine-workspace-runtime.mjs \
  scripts/quarantine-transaction.mjs \
  __tests__/scripts/quarantine-run-capability.test.ts \
  __tests__/scripts/quarantine-transaction.test.ts
git commit -m "feat: apply atomic quarantine moves"
```

Require Critical 0 / Important 0 / Minor 0 before Slice 3.

#### Slice 3: Recover every apply crash boundary

**Interface:**

```js
export async function recoverQuarantine({
  repoRoot, quarantineRoot, transactionId,
  action, writersStopped, fsApi, faultHook,
}) {}
```

`action` is exactly `resume` or `rollback`.

- [ ] **Step 3.1: Write actual-SIGKILL and mutation RED matrices**

Spawn a child and kill it through `faultHook` after manifest publication, each
durable journal event, rename, payload sync, destination-parent sync,
source-parent sync, first inventory publication, second inventory publication,
and before lock cleanup. Run `resume` and `rollback` from fresh fixtures.
For rollback specifically, kill after source-to-payload rename, after the moved
payload sync, after destination-parent sync, and after source-parent sync as
four distinct seams using `after-rollback-rename:${entryId}`,
`after-rollback-payload-sync:${entryId}`,
`after-rollback-destination-parent-sync:${entryId}`, and
`after-rollback-source-parent-sync:${entryId}`.

Assert this matrix without overwrites:

| Source | Payload | Required result |
|---|---|---|
| present/matching | absent | resume moves; rollback preserves source |
| absent | present/matching | resume records completion; rollback moves back |
| present | present | preserve both; rollback unrelated entries; conflict |
| absent | absent | fatal evidence loss; no further mutation |
| absent | present/mismatching | resume refuses; rollback returns mutated payload |
| present/mismatching | absent | conflict and preserve source |
| present | present/any mismatch | preserve both and conflict |

Also reject duplicate/out-of-order semantic entry events even when their
individual journal frames are structurally valid. A new apply or restore must
refuse every nonterminal run. Kill at PREPARED and MOVING before the first
`MOVE_INTENT`; require `RECOVERY_REQUIRED { entryIds: [] }` to resume or enter
`ROLLING_BACK` and reach `ROLLED_BACK` without an entry rollback event.
Kill after the final `MOVED` and after `VERIFYING`. In both cases require the
recovery payload to repeat every durable `MOVE_INTENT` ID in original forward
journal order, including every completed ID. Resume must still reach
`QUARANTINED`; rollback must reverse the complete ledger and reach
`ROLLED_BACK`. Add a valid non-bytewise intent-order fixture so neither runtime
nor crash recovery sorts the payload.

- [ ] **Step 3.2: Implement semantic replay and reverse rollback**

Replay before filesystem action. Reconcile an indeterminate append from the
durable ledger plus the matrix and append the next required event only when the
state transition proves it absent. Use `settleDurableTip` only for an owned
stale artifact and one exact stable-tip allowlist pair; make no claim about an
unrecorded candidate. Construct `RECOVERY_REQUIRED.entryIds` from the complete
durable intent ledger in forward journal order, never by subtracting IDs with
durable completion events. Resume derives unfinished work separately from
completion events and filesystem state; rollback processes the authoritative
complete ledger in reverse order.
`QUARANTINED` resume is idempotent;
`recoverQuarantine(... action: "rollback")` rejects `QUARANTINED` and directs
the operator to restore.

Assert the exact closed recovery results:

```text
{ transactionId, status: "QUARANTINED"|"VALIDATED", action: "resume",
  reconciledEntries }
| { transactionId, status: "ROLLED_BACK", action: "rollback",
    reconciledEntries }
| { transactionId, status: "INCOMPLETE_CONFLICT",
    action: "resume"|"rollback", conflictEntryIds }
```

- [ ] **Step 3.3: Verify, commit, and review Slice 3**

```bash
npm test -- --runInBand \
  __tests__/scripts/quarantine-transaction.test.ts \
  __tests__/scripts/quarantine-transaction-crash.integration.test.ts \
  __tests__/scripts/quarantine-journal.test.ts
git diff --check
git add scripts/quarantine-workspace-runtime.mjs scripts/quarantine-transaction.mjs \
  __tests__/scripts/quarantine-transaction.test.ts \
  __tests__/scripts/quarantine-transaction-crash.integration.test.ts \
  __tests__/fixtures/quarantine
git commit -m "feat: recover interrupted quarantine moves"
```

Require Critical 0 / Important 0 / Minor 0 before Slice 4.

#### Slice 4: Validate regeneration and establish four-day retention

**Interface:**

```js
export async function markQuarantineValidated({
  repoRoot, quarantineRoot, transactionId, validatedAt,
  writersStopped, fsApi, faultHook,
}) {}
```

- [ ] **Step 4.1: Write validation and activation RED tests**

Require journal state `QUARANTINED` or the same already-durable `VALIDATED`
digest, matching repository root/HEAD, clean tracked/staged/unexpected
untracked state, no source numbered copies, two independent inventories for
both regenerated roots, matching summaries, and no numbered basename in either
JSONL stream. Reject a path-bearing pointer, another transaction, changed HEAD,
missing generated root, inventory drift, or stale foreign lock without mutation.

When replay is already `VALIDATED`, supply a different canonical `validatedAt`
and require the journal tip's digest to select the existing immutable generation.
Verify and return its stored `validatedAt` and `deleteAfter`; do not construct a
second digest. Missing, digest-mismatched, schema-invalid, wrong-state,
wrong-transaction/repository/HEAD/entries, or invalid four-day retention fields
in that journal-named generation are fatal and preserve all evidence.

Kill after VALIDATED append and before pointer publication, then rerun. Recovery
must settle the exact allowlisted `(VALIDATED, VALIDATED)` durable tip with
owned stale evidence, return `already-present` to manifest
activation, and publish only the canonical root-level pointer.

- [ ] **Step 4.2: Implement validated generation and activation**

On a `QUARANTINED` replay, `validatedAt` is canonical UTC. Build the closed
`VALIDATED` generation with `deleteAfter = validatedAt + 96 hours`,
`deletionStatus: "retained"`, and `deletionRequiresConfirmation: true`. On an
already-`VALIDATED` replay, ignore the supplied timestamp for construction,
read and fully validate the journal-named immutable generation, activate it if
needed, and return its stored timestamp, deadline, and digest. Return only:

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

Accept only the design's `ValidationPhase` fault-hook union. Regeneration is
expected between apply and this function; stop all writers and establish a new
truthful attestation immediately before `markQuarantineValidated` rather than
carrying the apply attestation across regeneration.

- [ ] **Step 4.3: Verify, commit, and review Slice 4**

```bash
npm test -- --runInBand \
  __tests__/scripts/quarantine-transaction.test.ts \
  __tests__/scripts/quarantine-transaction-crash.integration.test.ts \
  __tests__/scripts/quarantine-manifest.test.ts
git diff --check
git add scripts/quarantine-transaction.mjs \
  __tests__/scripts/quarantine-transaction.test.ts \
  __tests__/scripts/quarantine-transaction-crash.integration.test.ts
git commit -m "feat: validate quarantined workspaces"
```

Require Critical 0 / Important 0 / Minor 0 before Slice 5. No code in this
slice may schedule or perform deletion.

#### Slice 5: Restore and reverse interrupted restore

**Interfaces:**

```js
export async function restoreQuarantine({
  repoRoot, quarantineRoot, transactionId, writersStopped, fsApi, faultHook,
}) {}

export async function recoverRestore({
  repoRoot, quarantineRoot, transactionId,
  action, writersStopped, fsApi, faultHook,
}) {}
```

- [ ] **Step 5.1: Write restore and actual-SIGKILL RED matrices**

Derive one deterministic prefixed `RestoreId` from the already validated NFC
transaction ID using exactly this private algorithm in
`scripts/quarantine-restore.mjs`:

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
  return [
    "restore-",
    hex.slice(0, 8), "-", hex.slice(8, 12), "-", hex.slice(12, 16), "-",
    hex.slice(16, 20), "-", hex.slice(20),
  ].join("");
}
```

Require the fixed vector
`tx-0001 -> restore-c3624475-87d7-4886-b0bf-68a5061663d2`, repeated calls to
return the same ID, and every public result, `RESTORE_PREPARED`, capability
request, rollback path, and fsync option to carry that exact prefixed string.
Reject a bare UUID everywhere.
For each existing generated root, write and `fsync` its fixed `restore-active`
inventory; for an absent root, write no inventory JSONL and independently
recheck absence immediately before the event. Then append `RESTORE_PREPARED`
with both fixed IDs in bytewise-sorted order and each exact summary or null, and
enter `RESTORING`. For each generated entry, append one `RESTORE_INTENT`, rename
active to its fixed rollback-entry, sync the tree and both parents, rename
original payload to active, sync the restored payload and both parents, then
append `RESTORED_ENTRY`. Source copies use one payload-to-source move.
Assert `after-inventory:restore-active:${generatedEntryId}` occurs exactly once
for each present root and never for an absent root; the absent case first
becomes durable only in the following `RESTORE_PREPARED` null.
Parameterize all four current-repository presence combinations for `.next` and
`node_modules`. For every present root, require a durable inventory and the
exact matching non-null payload summary. For every absent root, require no
inventory JSONL and exact null. Immediately before `RESTORE_PREPARED`, perform
an independent live `repoRoot` presence check for both fixed IDs and require it
to match the assembled null/non-null payload. Recreate an absent root and remove
a previously inventoried root at that seam in separate cases; both must fail
without appending `RESTORE_PREPARED` or entering `RESTORING`. These
presence-consistency and TOCTOU cases belong to the restore/runtime suites, not
the Slice 0 journal suite.

Kill after every append, active rename, tree/payload sync, parent sync, and
original rename. Include separate hooks after original `A -> P` rename, payload
sync, payload-parent sync, and active-parent sync, plus after regenerated
`R -> A` rename, active-tree sync, active-parent sync, and rollback-parent sync.
Use exactly `after-original-active-to-payload-rename:${entryId}`,
`after-original-payload-sync:${entryId}`,
`after-original-payload-parent-sync:${entryId}`,
`after-original-active-parent-sync:${entryId}`,
`after-regenerated-rollback-to-active-rename:${generatedEntryId}`,
`after-regenerated-active-tree-sync:${generatedEntryId}`,
`after-regenerated-active-parent-sync:${generatedEntryId}`, and
`after-regenerated-rollback-parent-sync:${generatedEntryId}`. Normal restore's
payload move uses `after-payload-to-active-rename:${entryId}` followed by
`after-restored-payload-sync:${entryId}` and its two distinct parent-sync hooks.
`resume` must reach `RESTORED`. `rollback` before `RESTORED` must process durable
`RESTORE_INTENT` records in reverse order, reverse processed entries, and append
the abort event matching the durable state immediately before
`RESTORE_PREPARED`. Concurrent active recreation, payload mutation, missing
evidence, and both-side mutation must never be overwritten or deleted. A
completed `RESTORED` run cannot be silently undone.

Kill after the final `RESTORED_ENTRY` before `RESTORED`. Recovery must append
the full non-empty forward `RESTORE_INTENT` ledger, including completed IDs.
Resume reaches `RESTORED`; rollback reverses the complete ledger and returns to
the exact pre-restore state. A valid non-bytewise restore-intent order remains
in that journal order in `RECOVERY_REQUIRED.entryIds`.

For every generated entry, parameterize the design's complete `A/R/P` matrix
using canonical original summary `O`, regenerated summary/presence `G`, absence,
byte-equal `O == G`, distinct concurrent inodes, and mismatching content. Assert
the prescribed resume and rollback action for each valid row, including every
allowed row when `O == G`; role comes from the durable phase and authorized
physical location,
not matching-summary multiplicity. Missing `O` or a required `G` is fatal
evidence loss with no mutation. Only a physical path/inode pattern unauthorized
by that exact three-location row, or content matching neither persisted role,
is preserved as `INCOMPLETE_CONFLICT`. Kill in
RESTORE_PREPARED and RESTORING before the first `RESTORE_INTENT`; an empty
recovery ID array must resume or directly abort to the exact prior state without
an entry rollback event.

- [ ] **Step 5.2: Implement restore and reverse replay**

Create the restore parent as a mode-`0700` capability-validated directory, use
only rollback-entry paths named by the deterministic prefixed `RestoreId`, and
preserve regenerated rollback content after a successful restore. On conflict,
append bytewise-sorted unique IDs to `INCOMPLETE_CONFLICT` and keep every
observed location. Resume processes durable
`RESTORE_INTENT` records forward; rollback processes them in reverse durable
intent order and reverses a generated entry as active original to payload, then
rollback regenerated to active. `restoreQuarantine` accepts only `RestorePhase`
and returns:

```js
{ transactionId, restoreId, status: "RESTORED", restoredEntries }
```

`recoverRestore` accepts only `RestoreRecoveryPhase` and returns exactly:

```text
{ transactionId, restoreId, status: "RESTORED", action: "resume",
  reconciledEntries }
| { transactionId, restoreId, status: "QUARANTINED"|"VALIDATED",
    action: "rollback", reconciledEntries, restoreAborted: true }
| { transactionId, restoreId, status: "INCOMPLETE_CONFLICT",
    action: "resume"|"rollback", conflictEntryIds }
```

- [ ] **Step 5.3: Verify, commit, and review Slice 5**

```bash
npm test -- --runInBand \
  __tests__/scripts/quarantine-restore.test.ts \
  __tests__/scripts/quarantine-restore-crash.integration.test.ts \
  __tests__/scripts/quarantine-transaction.test.ts \
  __tests__/scripts/quarantine-journal.test.ts
git diff --check
git add scripts/quarantine-restore.mjs scripts/quarantine-workspace-runtime.mjs \
  __tests__/scripts/quarantine-restore.test.ts \
  __tests__/scripts/quarantine-restore-crash.integration.test.ts \
  __tests__/fixtures/quarantine
git commit -m "feat: restore quarantined workspaces"
```

Require Critical 0 / Important 0 / Minor 0 before Slice 6.

#### Slice 6: Replace the legacy facade and expose the closed CLI

- [ ] **Step 6.1: Preserve the useful legacy sentinels and delete obsolete assumptions**

Keep and adapt tests for numbered-path mapping, identical/divergent
classification without body serialization, all-ref history match, branch/HEAD/
count/clean-index gates, external same-device root, concurrent recreation,
immutable-generation corruption, four-day deadline, and restore conflict.

Delete tests that require archive free space, copy-verify-remove,
`manifest.json`/`manifest.sha256`, run-local `current`,
`.quarantine-delete-*`, copy-corruption seams, or timestamp run names. Atomic
same-device rename supersedes those behaviors.

- [ ] **Step 6.2: Write exact facade and spawned-CLI RED tests**

The seven public modules are the capability, path-policy, journal, manifest,
inventory, transaction, and restore modules named in the design. Assert that
the facade's bytewise-sorted `Object.keys()` equals exactly these 33 unique
names:

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

It never exports the filesystem-context registry, workspace runtime, fault
helpers, or fixtures. Test exact CLI commands:

```text
cleanup:quarantine inspect --repo-root <abs> --quarantine-root <abs> --expected-branch <name> --expected-head <sha> --expected-count <n>
cleanup:quarantine apply --repo-root <abs> --quarantine-root <abs> --expected-branch <name> --expected-head <sha> --expected-count <n> --writers-stopped
cleanup:quarantine recover --repo-root <abs> --quarantine-root <abs> --transaction-id <id> --action resume|rollback --writers-stopped
cleanup:quarantine mark-validated --repo-root <abs> --quarantine-root <abs> --transaction-id <id> --writers-stopped
cleanup:quarantine restore --repo-root <abs> --quarantine-root <abs> --transaction-id <id> --writers-stopped
```

Apply generates a transaction ID and flushes the design's exact
`{ ok: true, command: "apply", status: "STARTING", transactionId }` JSONL record
before layout mutation so a killed process remains recoverable. Assert every
per-command success record and each exact recovery result variant from the
design. `recover` dispatches to apply or restore recovery from the validated
journal ledger. Reject duplicate/unknown flags, unknown commands, relative
roots, and malformed values. Reject missing attestation for apply, recovery,
mark-validation, and restore; `inspect` accepts no attestation flag and remains
advisory.

For restore and restore-recovery success records, require `restoreId` to match
the exact prefixed grammar and the deterministic transaction vector from Slice
5. The CLI must never emit or accept the bare UUID suffix as a restore ID.

API conflict variants are durable results, but the CLI must convert them to the
closed `ERR_CONFLICT` stderr record and exit 3; it must not label a conflict
`ok: true` or print the conflict IDs.

For every error class assert exactly
`{ ok: false, command: ErrorCommand, code, message }` on stderr, where
`ErrorCommand` is exactly
`"inspect"|"apply"|"recover"|"mark-validated"|"restore"|null`. Assert empty
stdout unless apply already flushed STARTING, and the design's exit code
mapping: usage/preflight 2, recovery/conflict/integrity/EXDEV 3, indeterminate
append 4, and sanitized internal failure 1. Missing, unknown, malformed, or
otherwise invalid command tokens must always serialize as null and must never
be echoed. A recognized command with invalid arguments may retain only its
canonical value. Parameterize arbitrary path-, URL-, credential-, Unicode-, and
flag-shaped unknown tokens and assert their raw bytes are absent from stdout and
stderr. No record may contain a stack, file body, diff, credential, URL,
authorization value, or production response.

- [ ] **Step 6.3: Implement facade, CLI, package script, and verify**

Add:

```json
"cleanup:quarantine": "node scripts/quarantine-numbered-copies.mjs"
```

```bash
npm test -- --runInBand \
  __tests__/scripts/quarantine-cli.test.ts \
  __tests__/scripts/quarantine-numbered-copies.test.ts \
  __tests__/scripts/quarantine-transaction.test.ts \
  __tests__/scripts/quarantine-restore.test.ts
git diff --check
git add scripts/quarantine-numbered-copies-support.mjs \
  scripts/quarantine-numbered-copies.mjs package.json package-lock.json \
  __tests__/scripts/quarantine-cli.test.ts \
  __tests__/scripts/quarantine-numbered-copies.test.ts
git commit -m "feat: expose quarantine cleanup CLI"
```

- [ ] **Step 6.4: Obtain Slice 6 specification and quality approval**

Require exact facade exports, closed CLI behavior, sanitized output, and
Critical 0 / Important 0 / Minor 0.

#### Task 2 aggregate, history, and original-checkout gates

- [ ] **Step A: Run the complete Task 2 gate**

```bash
npm test -- --runInBand \
  __tests__/scripts/quarantine-run-capability.test.ts \
  __tests__/scripts/quarantine-path-policy.test.ts \
  __tests__/scripts/quarantine-journal.test.ts \
  __tests__/scripts/quarantine-manifest.test.ts \
  __tests__/scripts/quarantine-inventory.test.ts \
  __tests__/scripts/quarantine-transaction.test.ts \
  __tests__/scripts/quarantine-transaction-crash.integration.test.ts \
  __tests__/scripts/quarantine-restore.test.ts \
  __tests__/scripts/quarantine-restore-crash.integration.test.ts \
  __tests__/scripts/quarantine-cli.test.ts \
  __tests__/scripts/quarantine-numbered-copies.test.ts
npm test -- --runInBand --no-cache
git diff --check
```

Give exact output plus path attacks, ordinary/stale journal recovery,
apply/restore SIGKILL, concurrency, `EXDEV`, FD/RSS, generation/current identity,
and adapter-binding evidence to independent specification and quality reviewers.
Require Critical 0 / Important 0 / Minor 0.

- [ ] **Step B: Rewrite unsafe history only behind a safety reference**

Create a safety tag or backup branch first. Then use interactive rebase to
squash-replace `848e440` and drop or replace unsafe implementation commits
`30f16a2`, `a087008`, `abc82a5`, `7375de5`, and `2c27ecc`. Preserve the original
design/plan commits and this amendment. Re-run Step A against the rewritten
branch and obtain a final Critical 0 / Important 0 / Minor 0 review. Never reset
or rebase the original checkout.

- [ ] **Step C: Perform the original operation in this exact ten-step order**

1. Stop development servers, builds, package installs, editors, and every
   repository/quarantine writer before apply. `inspect` is advisory and needs
   no attestation. Each later apply recovery, restore recovery, restore, or
   mark-validation command requires writers to be stopped again and a fresh
   truthful `--writers-stopped`; the attestation does not span regeneration.
2. From the feature worktree, create or verify the external quarantine root as
   a mode-`0700` non-symlink directory. Do not change the original checkout.
3. Run read-only `inspect` against the original checkout and require exact
   branch/HEAD, same device, 65 total, 61 identical, and 4 divergent. Any
   mismatch stops the operation.
4. Run `apply` with the same approved inputs, capture the flushed transaction
   ID, replay the journal, and require `QUARANTINED`, two matching destination
   inventories, absent sources, and private modes. On failure, never start a new
   apply; stop all writers and use explicit recovery with that ID.
5. Run in the original checkout:
   `npm ci`, `npm ls --depth=0`, `npm run check:audit`,
   `npm run lint -- --max-warnings=0`, `npm run typecheck`,
   `npm test -- --runInBand --no-cache`, `npm run check:extension`, and
   `npm run build`.
6. Require regenerated `node_modules` and `.next` roots to exist, require no
   numbered-copy basename anywhere inside either root, require no numbered
   source copy, and require no unexpected Git status. A failure leaves
   quarantine intact and stops before validation; choose explicit recovery or
   restore only after reviewing the exact journal state.
7. Stop all writers again, then run `mark-validated` with the captured
   transaction ID and a fresh attestation.
   Require a replayable `VALIDATED` state and canonical root pointer.
8. Require `deleteAfter` exactly 96 hours after `validatedAt`,
   `deletionRequiresConfirmation: true`, and retained payload/diffs. Create only
   a review reminder; do not schedule deletion.
9. Keep the external quarantine read-only for four full days while subsequent
   subprojects proceed. Recheck current generation digest, journal, four
   divergent classifications, tests/CI evidence, and restoration requests at
   the deadline.
10. Delete quarantined payload and divergent diffs only after a new explicit
    final user confirmation. Keep immutable generations, current pointer,
    inventories, and journal as the body-free audit record. Without that
    confirmation, retain everything and take no deletion action.

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
