# Foundation Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quarantine every numbered workspace copy without data loss, regenerate a deterministic local environment, route manual backups through the hardened coordinator, and prove real-Docker interruption cleanup.

**Architecture:** A built-in-only Node CLI streams deterministic inventories and atomically moves source copies plus complete generated roots into an external quarantine on the same filesystem. A hash-chained, fsync-backed append-only journal is the recovery authority for apply, rollback, and restore; strict path/schema validation and derived payload paths prevent a modified manifest from escaping the approved roots. Operations changes remain separate: a documentation contract replaces raw database-URL backup arguments, while a focused PostgreSQL 17 Docker test proves signal cleanup using the existing coordinator and CI service container.

**Tech Stack:** Node.js 22 ESM, Git CLI, Jest/ts-jest, PostgreSQL 17, Docker, GitHub Actions, Markdown operations contracts

---

## File map

- Create `scripts/quarantine-path-policy.mjs`: closed schemas, normalized relative-path policy, resolve-under-root guards, fixed generated-root allowlist, entry-ID derivation, and same-device checks.
- Create `scripts/quarantine-inventory.mjs`: bounded-memory file hashing and deterministic streaming JSONL inventories with digest/count/byte summaries.
- Create `scripts/quarantine-journal.mjs`: mode-`0600` length-framed hash-chain append, fsync, replay, torn-tail handling, and lifecycle validation.
- Create `scripts/quarantine-manifest.mjs`: closed manifest schema, atomic checksum/current-pointer publication, and four-day validation metadata.
- Create `scripts/quarantine-transaction.mjs`: preflight, atomic apply moves, destination verification, crash reconciliation, explicit resume, and reverse-order rollback.
- Create `scripts/quarantine-restore.mjs`: active-tree rollback moves, quarantined-payload restore, restore replay, and conflict preservation.
- Replace `scripts/quarantine-numbered-copies-support.mjs` with a thin compatibility facade exporting the focused modules.
- Create `scripts/quarantine-numbered-copies.mjs`: thin CLI with `inspect`, `apply`, `recover`, `mark-validated`, and `restore` subcommands.
- Replace `__tests__/scripts/quarantine-numbered-copies.test.ts` with behavior-level apply, recovery, restore, and CLI tests.
- Create `__tests__/scripts/quarantine-path-policy.test.ts`, `quarantine-inventory.test.ts`, and `quarantine-journal.test.ts` for focused security, RSS, and replay tests.
- Modify `package.json`: expose `cleanup:quarantine` and `test:backup:docker`.
- Modify `docs/operations/production-runbook.md` and its workflow contract test.
- Create `__tests__/scripts/create-snapshot-backup.docker.integration.test.ts`: real PostgreSQL 17 Docker signal proof.
- Modify `.github/workflows/ci.yml`, `__tests__/ci/workflow-contract.test.ts`, and `README.md`.

### Task 1: Replace unsafe quarantine primitives with focused durable modules

**Files:**
- Create: `scripts/quarantine-path-policy.mjs`
- Create: `scripts/quarantine-inventory.mjs`
- Create: `scripts/quarantine-journal.mjs`
- Create: `scripts/quarantine-manifest.mjs`
- Create: `__tests__/scripts/quarantine-path-policy.test.ts`
- Create: `__tests__/scripts/quarantine-inventory.test.ts`
- Create: `__tests__/scripts/quarantine-journal.test.ts`

- [ ] **Step 1: Write closed-path-policy attack tests**

Import these exact interfaces:

```ts
import {
  assertPathUnderRoot,
  assertSameDevice,
  canonicalPathForNumberedCopy,
  derivePayloadPath,
  parseManifestEntry,
} from "../../scripts/quarantine-path-policy.mjs";

it.each(["../victim", "/tmp/victim", "src/../victim", "src/\0victim", "src//victim"])(
  "rejects unsafe manifest paths: %s",
  (relativePath) => expect(() => parseManifestEntry(validEntry({ relativePath }))).toThrow(),
);

it("rejects unknown manifest fields", () => {
  expect(() => parseManifestEntry({ ...validEntry(), attackerPath: "../victim" })).toThrow(
    /unknown field/u,
  );
});

it("derives destinations from validated IDs rather than stored paths", () => {
  const entry = parseManifestEntry(validEntry({ id: "copy-0001" }));
  expect(derivePayloadPath(runRoot, entry)).toBe(join(runRoot, "payload/source-copies/copy-0001"));
});
```

Also require final-component numbered suffix mapping, fixed generated roots
`node_modules|.next`, root symlink rejection, inner symlinks as leaf entries,
Unicode normalization rejection, resolve-under-root containment, quarantine
outside the repository, device mismatch rejection, and `EXDEV` propagation.
For a source-copy entry, require that the original path matches the numbered
suffix and that its canonical path exactly equals the derived canonical path.

- [ ] **Step 2: Run the path suite to verify RED**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-path-policy.test.ts
```

Expected: FAIL because `quarantine-path-policy.mjs` does not exist.

- [ ] **Step 3: Implement the minimal path and schema policy**

Export:

```js
export const GENERATED_ROOTS = Object.freeze(["node_modules", ".next"]);
export function canonicalPathForNumberedCopy(relativePath) {}
export function parseManifestEntry(value) {}
export function assertPathUnderRoot(root, relativePath) {}
export function derivePayloadPath(runRoot, entry) {}
export async function assertSameDevice(repoRoot, quarantineRoot, fsApi) {}
```

Use `/^(.*) ([2-9][0-9]*)(\.[^/]+)$/u` on the final component only. Require
plain objects with exact key sets and NFC-normalized POSIX relative paths. Reject
absolute, empty, `.`, `..`, NUL, backslash, duplicate separator, symlink-root,
and resolved-escape inputs. Compare `lstat().dev`; translate neither a mismatch
nor `EXDEV` into a copy operation.

- [ ] **Step 4: Verify path GREEN and commit**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-path-policy.test.ts
git add scripts/quarantine-path-policy.mjs __tests__/scripts/quarantine-path-policy.test.ts
git commit -m "feat: enforce quarantine path policy"
```

- [ ] **Step 5: Write streaming inventory and RSS tests**

Import `hashFileStream`, `writeInventoryJsonl`, `parseInventoryRecord`, and
`parseInventorySummary`.
Require the summary parser to accept exactly `{ sha256, entries, bytes }` and
reject unknown or missing keys, malformed hashes, and negative or unsafe
integers. Build a synthetic generated tree containing exactly 40,000 small
files, two nested directories, and one leaf symlink; the inventory excludes its
root and therefore contains 40,003 entries. Require deterministic JSONL and
summary equality across two independent passes:

```ts
expect(second.summary).toEqual(first.summary);
expect(second.summary).toMatchObject({ entries: 40003 });
expect(readFileSync(second.path, "utf8").split("\n")[0]).toContain('"type":"directory"');
```

Spawn the inventory worker with `node --expose-gc`, capture peak RSS from its
JSON summary, and require `peakRssBytes < 160 * 1024 * 1024`. Monkey-patch or
inject payload `readFile` to throw, proving regular-file bodies are consumed via
`createReadStream`. Require bytewise path order, mode/type/size/hash/link-target
coverage, no symlink traversal, mode `0600`, and a manifest-sized summary of
only `{ sha256, entries, bytes }`.
Directory inventories exclude the root itself and emit only exact
`{ scope: "relative", path, ...typeMetadata }` descendants. Relative paths are
NFC POSIX paths and reject empty, absolute, backslash, NUL, duplicate-separator,
`.`-component, and `..`-component forms. A regular-file root emits exactly
`{ scope: "root", type: "file", mode, size, sha256 }` with no `path`, while a
symlink root remains rejected. Consumers must branch on `scope` before resolving
a relative path. Equal file bytes and mode therefore produce identical JSONL
and summary bytes regardless of the root basename.

- [ ] **Step 6: Verify inventory RED, implement streaming inventory, and verify GREEN**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-inventory.test.ts
```

Expected first result: FAIL because `quarantine-inventory.mjs` is missing.
Implement:

```js
export async function hashFileStream(absolutePath, options = {}) {}
export async function writeInventoryJsonl({ root, outputPath, fsApi }) {}
export function parseInventoryRecord(value) {}
export function parseInventorySummary(value) {}
export async function compareInventorySummary(expected, observed) {}
export async function fsyncTree(root, fsApi) {}
```

Use `createReadStream`, incremental SHA-256, bounded directory batches, sorted
UTF-8 path buffers, backpressure-aware JSONL writes, `FileHandle.sync()`, and
`lstat`/`readlink` without following symlinks. Then run the same Jest command and
require PASS plus RSS below the bound.

- [ ] **Step 7: Commit streaming inventory**

```bash
git add scripts/quarantine-inventory.mjs __tests__/scripts/quarantine-inventory.test.ts
git commit -m "feat: stream quarantine inventories"
```

- [ ] **Step 8: Write journal framing, replay, and crash-boundary tests**

Import:

```ts
import {
  appendJournalRecord,
  replayJournal,
  validateTransition,
} from "../../scripts/quarantine-journal.mjs";
```

Test the complete state graph and supplementary interruption simulations:
exception injection after journal file creation, frame append, and fsync, plus
step-limited filesystem moves after payload rename, payload fsync, parent fsync,
verification, and `MOVED` append. Those harnesses demonstrate replay invariants
but are not process-crash proof.
Additionally terminate real child processes with `SIGKILL` immediately after
lock `wx` creation and immediately after lock-metadata `fsync`; normal append
must reject both stale locks, while explicit attested reclaim appends the next
event with an intact sequence and hash chain. A torn final frame must replay to
the preceding record; a malformed middle frame, changed
payload, unknown key, sequence gap, hash mismatch, or illegal transition must
fail closed. Assert the journal is mode `0600` and every successful append calls
both file `sync()` and parent-directory sync before resolving.

Journal envelopes and event payloads are independent closed schemas. Add a
table-driven payload-validator test for every event already present in the
transition graph. At minimum require these exact shapes:

```ts
type InventorySummary = {
  sha256: string;
  entries: number;
  bytes: number;
};

type RequiredJournalPayloads = {
  PREPARED: { transactionId: string; manifestSha256: string };
  MOVING: Record<string, never>;
  MOVE_INTENT: { id: string; expected: InventorySummary };
  MOVED: { id: string; observed: InventorySummary };
  VERIFYING: Record<string, never>;
  QUARANTINED: { manifestSha256: string };
};
```

Lifecycle-only events outside this minimum accept exactly `{}` unless their
Task 2 transition contract defines a narrower entry-ID or inventory-summary
payload. `RECOVERY_REQUIRED` accepts exactly `{ entryIds: string[] }`, while
`INCOMPLETE_CONFLICT` accepts exactly `{ conflictEntryIds: string[] }`; both
arrays must be non-empty, bytewise sorted, unique validated entry IDs. Tests
must prove that an empty-payload event rejects
one unknown key; `PREPARED` rejects a missing or extra field, invalid transaction
ID, and invalid checksum; `MOVE_INTENT` and `MOVED` reject unknown fields, invalid
entry IDs, invalid nested summary keys, hashes, counts, and byte sizes. Replay
must reject a canonical, correctly re-hashed frame whose event payload violates
its event schema. Assert that every event in the transition map has a payload
parser, so adding a transition without a schema fails the suite.

- [ ] **Step 9: Verify journal RED, implement durable replay, and verify GREEN**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-journal.test.ts
```

Expected first result: FAIL because `quarantine-journal.mjs` is missing.
Implement length-prefixed canonical JSON frames whose envelope is exactly:

```ts
type JournalFrame = {
  sequence: number;
  previousHash: string;
  event: string;
  payload: Record<string, unknown>;
  recordHash: string;
};
```

Hash the canonical envelope without `recordHash`, append one complete frame,
`sync()` the handle, and fsync its directory. Replay ignores only an incomplete
final length/body pair and reports the last valid byte offset. Appends create a
mode-`0600` lock with `wx`, keep its handle open, and write one length-framed
canonical `{ version: 1, ownerToken, pid, checksum }` record. They `fsync` the
lock and parent directory before touching the journal, then use the same journal
handle to revalidate, truncate only a recognized torn tail, sync the truncation
and parent, and append. `EEXIST` always fails; normal append never uses TTL or
PID-liveness reclamation and never races concurrent appenders.

Export `reclaimJournalLock` as the only stale-lock recovery primitive. It
requires `writersStopped === true`, rejects symlink, non-regular, oversized, and
malformed complete locks without changing them, and accepts only a valid
checksummed lock or a recognizable creation-torn frame (including zero bytes).
It atomically renames the stale lock to a unique tombstone, `fsync`s the parent,
creates and durably publishes a new `wx` lock, and runs a recovery callback with
an append function under that held lock. Only after the recovery journal append
is durable may it remove the new lock and tombstone and `fsync` the parent.
Current-PID/different-token locks model PID reuse: ordinary append still fails,
while explicitly attested recovery is permitted.
Replay validates every complete frame, event-specific
payload, and lifecycle edge. Implement an exact payload-parser table keyed by
event and invoke it during both append and replay; accepting an arbitrary plain
object after canonicalization is forbidden. Task 2 may add fields only by first
adding the corresponding RED exact-schema tests and updating the documented
event contract.
Run the same Jest command and require PASS.

- [ ] **Step 10: Implement the small manifest publisher with RED/GREEN tests**

Add manifest tests to `quarantine-journal.test.ts` that reject unknown fields and
path-bearing current pointers, verify atomic temporary-file replacement, verify
file/directory fsync ordering, and require:

```ts
type InventorySummary = {
  sha256: string;
  entries: number;
  bytes: number;
};

type ManifestEntry =
  | {
      id: string;
      kind: "source-copy";
      relativePath: string;
      canonicalRelativePath: string;
      mode: number;
      size: number;
      sha256: string;
      canonicalSize: number;
      canonicalSha256: string;
      classification: "identical" | "divergent";
      historyMatch: string | null;
      preMoveInventory: InventorySummary;
    }
  | {
      id: "generated-next";
      kind: "generated-root";
      relativePath: ".next";
      mode: number;
      preMoveInventory: InventorySummary;
    }
  | {
      id: "generated-node-modules";
      kind: "generated-root";
      relativePath: "node_modules";
      mode: number;
      preMoveInventory: InventorySummary;
    };
```

The manifest parser owns this enriched exact-key union. Keep the path-policy
parser focused on the locator fields and export a reusable closed
`parseInventorySummary` from `quarantine-inventory.mjs`; do not duplicate hash,
count, or byte validation in transaction code. Inventory files are derived as
`inventories/pre/<validated-entry-id>.jsonl`, so reject any `inventoryPath`,
`payloadPath`, destination, rollback path, or other free-form path field.

Add positive source-copy and generated-root fixtures plus failures for every
missing/unknown field, malformed hash, unsafe mode, negative or unsafe integer,
invalid classification/hash relationship, invalid history match, source
summary not equal to one entry/source byte size, duplicate ID, duplicate
relative path, unsorted entries, nondeterministic `copy-NNNN` IDs, a missing or
duplicate generated root, and generated IDs/paths that are not exactly
`generated-next`/`.next` and `generated-node-modules`/`node_modules`. Require
the complete manifest entry array to use bytewise relative-path order and to
contain both generated roots exactly once. The transaction's invocation-supplied
expected copy count is checked in Task 2 and is not stored as a free-form
manifest override.

Also require validation metadata behavior:

```ts
expect(marked).toMatchObject({
  retentionDays: 4,
  deletionRequiresConfirmation: true,
  deleteAfter: "2026-07-18T12:00:00.000Z",
});
```

Run the suite to see missing exports, then create
`scripts/quarantine-manifest.mjs` exporting `readManifest`, `publishManifest`,
and `markQuarantineValidated`. Compose the locator parser and exported inventory
summary parser into the enriched manifest-entry parser, enforce cross-entry and
cross-field invariants before publication and after reading, and keep all
normalized objects canonical. The current pointer contains only a validated
transaction ID, never a path. A Task 2 runtime summary/reference may point to
the validated manifest entry ID and its `preMoveInventory`, but cannot replace
or weaken the manifest schema. Rerun and require PASS.

- [ ] **Step 11: Commit journal and manifest primitives**

```bash
git diff --check
git add scripts/quarantine-inventory.mjs scripts/quarantine-journal.mjs scripts/quarantine-manifest.mjs __tests__/scripts/quarantine-inventory.test.ts __tests__/scripts/quarantine-journal.test.ts
git commit -m "feat: add durable quarantine journal"
```

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
export async function recoverQuarantine({ runDirectory, action, writersStopped, fsApi }) {}
```

Discovery uses `git status --porcelain=v1 -z --untracked-files=all`, argument
arrays, and two identical NUL-safe passes. `quarantineWorkspace` writes durable
`PREPARED`, then for every entry performs `MOVE_INTENT -> recheck -> rename ->
payload fsync -> destination-parent fsync -> source-parent fsync -> streaming
destination inventory -> MOVED`. Persisting the destination directory first
avoids a deliberate neither-name durability window. After all entries, perform
two independent destination passes, assert all sources absent and no numbered
residue, then append `QUARANTINED` and publish the manifest.

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
export async function restoreQuarantine({ runDirectory, writersStopped, fsApi }) {}
export async function recoverRestore({ runDirectory, action, writersStopped, fsApi }) {}
```

Append `RESTORE_PREPARED`; stream-inventory the active generated tree; atomically
move it to `rollback/regenerated-before-restore/<restore-id>`; fsync and journal
that move; then atomically move the original payload into the active location.
Never unlink an active tree. Reuse journal replay and the conflict matrix. Run
the behavior suite and require all restore crash cases PASS.

- [ ] **Step 9: Replace the facade and add spawned-CLI RED tests**

Make `quarantine-numbered-copies-support.mjs` export only the approved public
functions from the six focused modules. Test these exact CLI forms:

```text
npm run cleanup:quarantine -- inspect --repo-root <abs> --quarantine-root <abs> --expected-branch <name> --expected-head <sha> --expected-count <n>
npm run cleanup:quarantine -- apply --repo-root <abs> --quarantine-root <abs> --expected-branch <name> --expected-head <sha> --expected-count <n> --writers-stopped
npm run cleanup:quarantine -- recover --run-directory <abs> --action resume|rollback --writers-stopped
npm run cleanup:quarantine -- mark-validated --run-directory <abs>
npm run cleanup:quarantine -- restore --run-directory <abs> --writers-stopped
```

Require missing attestation, relative roots, unknown flags, unknown commands,
nonterminal conflicts, and path-bearing pointer attacks to exit nonzero without
printing file bodies. Output only counts, state, run-directory identifier,
validation time, and deletion deadline.

- [ ] **Step 10: Implement the CLI and package script, then verify GREEN**

Create the thin argument parser in `scripts/quarantine-numbered-copies.mjs` and
add:

```json
"cleanup:quarantine": "node scripts/quarantine-numbered-copies.mjs"
```

Run:

```bash
npm test -- --runInBand __tests__/scripts/quarantine-path-policy.test.ts __tests__/scripts/quarantine-inventory.test.ts __tests__/scripts/quarantine-journal.test.ts __tests__/scripts/quarantine-numbered-copies.test.ts
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
`--writers-stopped`. Record the returned run directory privately. Replay the
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

Run `mark-validated --run-directory "$RUN_DIRECTORY"`. Require a replayable
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
