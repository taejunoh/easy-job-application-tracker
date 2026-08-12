# Quarantine Lifecycle Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish quarantine lifecycle Slice 3 recovery, Slice 4 private-core validation and four-day retention, Slice 5 restore and restore recovery, Slice 6's exact facade and canonical npm CLI, then pass the aggregate verification gate.

**Architecture:** Preserve the existing capability, journal, manifest, inventory, and path-policy authorities. Add one private `scripts/quarantine-lifecycle-core.mjs` boundary before Slice 4; it captures the filesystem source once, validates an existing run, and hands exact state to internal validation/restore callbacks without adding a public API. Keep apply recovery in the runtime, reuse the core for validation and restore, then close the facade and CLI around the original final contracts.

**Tech Stack:** Node.js ESM on Node `>=22.22.2 <23`, Jest 30 with TypeScript/ts-jest tests, Prisma/Next project scripts, Git fixture repositories and child subprocesses, and same-device filesystem moves.

## Global Constraints

- Foundation Cleanup is complete through Task 2 Slice 2; execute tasks in order: Slice 3 recovery, Slice 4 core/validation/retention, Slice 5 restore/recovery, Slice 6 facade/CLI, aggregate gate.
- Preserve the existing capability, journal, manifest, inventory, and path-policy authorities; do not duplicate capability/bootstrap/path-validation/security logic.
- `scripts/quarantine-lifecycle-core.mjs` may export exactly `withExistingQuarantineRun` for direct internal ESM imports; transaction, runtime, restore, facade, package, and CLI surfaces must not export, re-export, serialize, return, or otherwise expose that binding.
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
- Preserve six independently spawned npm invocations: inspect, apply, recover-resume, recover-rollback, mark-validated, and restore.
- `package-lock.json` is out of scope and must remain byte-for-byte unchanged; prove it with `git diff --exit-code -- package-lock.json`.
- Final aggregate checks include the focused 12-suite command, `npm test -- --runInBand --no-cache`, lint with `--max-warnings=0`, typecheck, build, `git diff --check`, evidence-based no-touch proof, retention/deletion review, and independent specification/code-quality review.

---

Line numbers below are orientation anchors from the current HEAD. Symbol names, exact interfaces, and schemas are authoritative if earlier edits move lines.

## File map

- Modify `scripts/quarantine-workspace-runtime.mjs:1222-2403` for recovery orchestration, private-core integration, validation, and exact runtime fault seams.
- Modify `scripts/quarantine-transaction.mjs:1-4` to expose the approved transaction surface as Slice 3 and Slice 4 APIs are added.
- Modify `scripts/quarantine-journal.mjs:497-723,1139-1188,1332-1345,1529-1560,1841-2083` only through its existing transition/replay/lock authorities and tests for semantic recovery evidence.
- Modify `scripts/quarantine-run-fs-context.mjs:20-123` so all source capture and bound-adapter lifecycle remains in the one private registry.
- Create `scripts/quarantine-lifecycle-core.mjs` as the private existing-run handoff boundary; it is never a facade or package export.
- Create `scripts/quarantine-restore.mjs` for normal restore and restore recovery; it exports exactly `restoreQuarantine` and `recoverRestore` at the final boundary.
- Modify `scripts/quarantine-numbered-copies-support.mjs:1-380` into the thin compatibility facade only in Task 6.
- Create `scripts/quarantine-numbered-copies.mjs` and modify `package.json` only in Task 7.
- Modify `__tests__/scripts/quarantine-transaction.test.ts:1722-5001`, `__tests__/scripts/quarantine-journal.test.ts`, and create `__tests__/scripts/quarantine-transaction-crash.integration.test.ts` for Slice 3.
- Create `__tests__/fixtures/quarantine/quarantine-lifecycle-child.mjs` as the disposable child used by apply and restore crash suites.
- Create `__tests__/scripts/quarantine-lifecycle-core.test.ts` and extend transaction/core tests for private handoff and mutation-free preconditions.
- Create `__tests__/fixtures/quarantine/quarantine-test-harness.ts` as the shared test-only fixture/worker module used by Tasks 1–5.
- Reuse `__tests__/scripts/quarantine-manifest.test.ts:1265-1891` for generation/pointer retry assertions; create `__tests__/scripts/quarantine-restore.test.ts` and `__tests__/scripts/quarantine-restore-crash.integration.test.ts` for Slice 5.
- Modify `__tests__/scripts/quarantine-numbered-copies.test.ts:1-1046` for the exact final facade export set; create `__tests__/scripts/quarantine-cli.test.ts` for spawned npm CLI behavior.

## Execution preflight

Run this before Task 1. It records the implementation base and a private,
mode-0600 inventory of the original checkout's ignored-excluded untracked
paths under Git metadata. The Node program is complete, writes metadata
directly to the designated mode-0600 file, and discards stdout to `/dev/null`;
it emits no path or file body.

```bash
EVIDENCE_DIR="$(git rev-parse --git-path quarantine-lifecycle-evidence)"
mkdir -p "$EVIDENCE_DIR"
chmod 0700 "$EVIDENCE_DIR"
IMPLEMENTATION_BASE="$(git rev-parse HEAD)"
ORIGINAL_CHECKOUT="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
export EVIDENCE_DIR IMPLEMENTATION_BASE ORIGINAL_CHECKOUT
EVIDENCE_SUFFIX=before
export EVIDENCE_SUFFIX
printf '%s\n' "$IMPLEMENTATION_BASE" > "$EVIDENCE_DIR/implementation-base"
git -C "$ORIGINAL_CHECKOUT" ls-files --others --exclude-standard -z > "$EVIDENCE_DIR/untracked-paths.$EVIDENCE_SUFFIX"
chmod 0600 "$EVIDENCE_DIR/implementation-base" "$EVIDENCE_DIR/untracked-paths.$EVIDENCE_SUFFIX"
node --input-type=module > /dev/null <<'NODE'
import { createHash } from "node:crypto";
import { chmodSync, closeSync, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, writeFileSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { resolve } from "node:path";

const root = process.env.ORIGINAL_CHECKOUT;
const evidenceDir = process.env.EVIDENCE_DIR;
const suffix = process.env.EVIDENCE_SUFFIX;
const pathsPath = resolve(evidenceDir, `untracked-paths.${suffix}`);
const metaPath = resolve(evidenceDir, `untracked-meta.${suffix}`);

function splitNul(buffer) {
  const paths = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) { if (index > start) paths.push(buffer.subarray(start, index)); start = index + 1; }
  }
  if (start !== buffer.length) throw new Error("unterminated path list");
  return paths;
}

function pathBuffer(rawPath) {
  if (rawPath.length === 0 || rawPath[0] === 0x2f) throw new Error("invalid path");
  let segmentStart = 0;
  for (let index = 0; index <= rawPath.length; index += 1) {
    if (index === rawPath.length || rawPath[index] === 0x2f) {
      if (rawPath.subarray(segmentStart, index).equals(Buffer.from(".."))) throw new Error("parent escape");
      segmentStart = index + 1;
    }
  }
  return Buffer.concat([Buffer.from(root), Buffer.from("/"), rawPath]);
}

function hashRegularFile(pathBufferValue, before) {
  const descriptor = openSync(pathBufferValue, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.mode !== before.mode) throw new Error("identity changed");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, offset);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(descriptor);
    const relisted = lstatSync(pathBufferValue);
    if (after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode || after.size !== before.size || relisted.dev !== before.dev || relisted.ino !== before.ino || relisted.mode !== before.mode || relisted.size !== before.size) throw new Error("identity changed");
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

async function main() {
  const rawPaths = splitNul(readFileSync(pathsPath));
  const rows = [];
  for (const rawPath of rawPaths) {
    const absolute = pathBuffer(rawPath);
    const stat = lstatSync(absolute);
    let type = "other";
    let hash = null;
    if (stat.isFile()) {
      type = "file";
      hash = hashRegularFile(absolute, stat);
    } else if (stat.isSymbolicLink()) {
      type = "symlink";
      const linkBytes = readlinkSync(absolute, { encoding: "buffer" });
      hash = createHash("sha256").update(linkBytes).digest("hex");
      const relisted = lstatSync(absolute);
      if (relisted.dev !== stat.dev || relisted.ino !== stat.ino || relisted.mode !== stat.mode) throw new Error("identity changed");
    } else if (stat.isDirectory()) {
      type = "directory";
    }
    rows.push(JSON.stringify({
      path: rawPath.toString("base64"),
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      size: stat.size,
      type,
      hash,
    }));
  }
  rows.sort((left, right) => Buffer.from(JSON.parse(left).path, "base64").compare(Buffer.from(JSON.parse(right).path, "base64")));
  writeFileSync(metaPath, rows.length === 0 ? "" : `${rows.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(metaPath, 0o600);
}

try {
  await main();
} catch {
  process.exitCode = 1;
}
NODE
chmod 0600 "$EVIDENCE_DIR/untracked-meta.$EVIDENCE_SUFFIX"
```

The same executable Node body, with only `.before`/`.after` evidence filenames
changed, is rerun in Task 8. The evidence directory is never inside the
original checkout, and every fixture mutation remains in disposable temporary
repositories.

### Task 1: Implement Slice 3 semantic apply recovery

**Files:**

- Modify: `scripts/quarantine-workspace-runtime.mjs:1222-2403` (`prepareWorkspaceCore`, `appendEvent`, `quarantineWorkspace`, and private recovery helpers)
- Modify: `scripts/quarantine-transaction.mjs:1-4` to re-export `recoverQuarantine`
- Modify: `scripts/quarantine-journal.mjs:497-723` (`validateTransition`, replay semantic validation, exact event payload parsers)
- Modify: `__tests__/scripts/quarantine-transaction.test.ts:1722-5001`
- Modify: `__tests__/scripts/quarantine-journal.test.ts:1-4644`
- Create: `__tests__/fixtures/quarantine/quarantine-test-harness.ts` and move the existing `Fixture` type, `fixture`, `invoke`, URL/constants/import setup, and exact bodies into exports `createQuarantineFixture` and `invokeQuarantineWorker`

Move the current implementations verbatim into concrete exported definitions:
`export function createQuarantineFixture(options?: FixtureOptions): Fixture`
contains the complete current fixture body, and
`export function invokeQuarantineWorker(operation: string, request:
Record<string, unknown>, extraEnvironment: Record<string, string> = {}, timeout
= 10_000): WorkerResult` contains the complete current invoke body. No
declaration-only signatures or aliases remain.
The moved `Fixture` record retains every existing field and adds the exact
`expectedCount: number` derived from its generated source-copy entries, so all
apply requests use the fixture's recorded count (including divergent fixtures).

The shared harness declares the concrete type used by every task:

```ts
export type Fixture = {
  base: string;
  repoRoot: string;
  quarantineRoot: string;
  branch: string;
  head: string;
  expectedCount: number;
  historyHead?: string;
  canonicalPath?: string;
  copyPath?: string;
};
```

The helper's worker dispatcher adds only `recoverQuarantine` and the existing
`replay-run` operation in Task 1. It does not import lifecycle core and has no
`core-contract` or preparation worker branch. The transaction test imports
these two helpers and is no longer a dependency of other tests.

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
function captureFsSource(source?: object): FrozenFsSource;
function buildApplyLedger(records: readonly JournalRecord[]): ApplyLedger;
function recoverApplyOnCapability(args: { capability: object; options: RecoveryOptions }): Promise<RecoveryResult>;
function resumeApplyFromLedger(args: { capability: object; replay: JournalReplay; ledger: ApplyLedger; faultHook?: FaultHook }): Promise<RecoveryResult>;
function rollbackApplyFromLedger(args: { capability: object; replay: JournalReplay; ledger: ApplyLedger; faultHook?: FaultHook }): Promise<RecoveryResult>;
```

`InternalRunHandoff`, `JournalRecord`, `JournalReplay`, `ApplyLedger`, `FaultHook`, and `RecoveryResult` are private TypeScript-only test descriptions whose property names are the exact JavaScript records specified here; they are not exported runtime types.

Before the first await, `recoverQuarantine` captures the supplied `fsApi`, or
the existing default filesystem source when omitted, through the existing
filesystem-context authority. It passes that exact frozen snapshot to
`withQuarantineRunCapability`; no later getter, receiver, or method mutation
can change the capability's source. This source-capture behavior remains in
Slice 3 and is not moved to the lifecycle core.

- [ ] **Step 1: Write the semantic RED matrix.** Add tests that seed valid journal frames and filesystem fixtures for every source/payload row: source present plus payload absent; source absent plus matching payload; both present; both absent; absent source plus mismatching payload; present mismatching source plus absent payload; and both present with any mismatch. Assert resume/rollback actions, preserved evidence, and exact result shapes. Add PREPARED and MOVING crashes with no intent, durable non-bytewise intent order, all-completed intents, idempotent QUARANTINED resume, QUARANTINED rollback rejection, duplicate/out-of-order semantic events, torn frame, wrong digest, changed journal tip, changed root/run identity, stale lock, changed evidence, and fatal evidence loss. Add supplied/default source tests that mutate a getter, receiver, and method after capture and assert the frozen capability snapshot remains authoritative.

```ts
import { createQuarantineFixture, invokeQuarantineWorker } from "../fixtures/quarantine/quarantine-test-harness";
it("builds RECOVERY_REQUIRED from the complete durable intent ledger", async () => {
  const fixtureRoot = createQuarantineFixture({ divergent: false });
  const one = { sha256: "a".repeat(64), entries: 1, bytes: 1 };
  const two = { sha256: "b".repeat(64), entries: 1, bytes: 1 };
  const response = invokeQuarantineWorker("recoverQuarantine", {
    repoRoot: fixtureRoot.repoRoot,
    quarantineRoot: fixtureRoot.quarantineRoot,
    transactionId: "tx-0001",
    action: "resume",
    writersStopped: true,
    replayEvents: [
      { event: "PREPARED", payload: { transactionId: "tx-0001", manifestSha256: "c".repeat(64) } },
      { event: "MOVING", payload: {} },
      { event: "MOVE_INTENT", payload: { id: "copy-0002", expected: two } },
      { event: "MOVED", payload: { id: "copy-0002", observed: two } },
      { event: "MOVE_INTENT", payload: { id: "copy-0001", expected: one } },
    ],
  });
  expect(response.ok).toBe(true);
  expect(response.result).toMatchObject({ transactionId: "tx-0001", action: "resume" });
});
```

Read the durable journal with the existing replay helper and assert its
`RECOVERY_REQUIRED` payload has `entryIds: ["copy-0002", "copy-0001"]`; the
public result remains one of the exact recovery result unions above.

Add journal RED assertions that valid individual frames still fail semantic replay when the intent ledger is duplicated, reordered by a completion event, or paired with a changed digest/tip. Assert no filesystem or journal mutation and no foreign replacement deletion.

- [ ] **Step 2: Run the Slice 3 semantic RED suites.**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-transaction.test.ts __tests__/scripts/quarantine-journal.test.ts
```

Expected: FAIL because `quarantine-transaction.mjs` does not export `recoverQuarantine`, semantic recovery results are absent, and the existing replay/transition path does not yet enforce the complete forward intent ledger.

- [ ] **Step 3: Implement replay-before-mutation and reverse rollback.** Capture the supplied/default source synchronously before the first await with the existing context authority, freeze it, and pass that exact object to `withQuarantineRunCapability`. Add a private recovery path in `quarantine-workspace-runtime.mjs` that enters one live capability, replays the journal before touching the filesystem, appends `RECOVERY_REQUIRED` only through the existing held-lock append authority, and derives resume work from durable completion events while rollback walks the complete durable intent ledger in reverse order. Reuse the existing source/payload identity and inventory helpers; do not sort IDs. For each row, preserve both sides on conflict, move only the authorized side, reject missing evidence as `ERR_INTEGRITY`, reject a foreign/stale lock or changed tip before mutation, and map `IndeterminateJournalAppendError` to the existing sanitized error. A durable QUARANTINED resume returns the existing terminal result without mutation; rollback from QUARANTINED rejects and directs the operator to restore.

```js
export async function recoverQuarantine(input) {
  const options = snapshotRecoveryOptions(input);
  const source = captureFsSource(options.fsApi);
  return withQuarantineRunCapability({
    repoRoot: options.repoRoot,
    quarantineRoot: options.quarantineRoot,
    transactionId: options.transactionId,
    writersStopped: options.writersStopped,
    fsApi: source,
  }, async (capability) =>
    recoverApplyOnCapability({ capability, options }));
}
```

Keep `recoverQuarantine` in the transaction module's approved export surface; keep all ledger helpers private. Task 3 leaves this runtime/transaction recovery callback on its existing setup path and introduces the lifecycle core only for validation and restore operations.

- [ ] **Step 4: Run the semantic GREEN and neighboring tests.**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-transaction.test.ts __tests__/scripts/quarantine-journal.test.ts __tests__/scripts/quarantine-run-capability.test.ts
```

Expected: PASS for every matrix row, exact three result unions, no overwrite/delete of foreign evidence, no mutation on torn/wrong-digest/root-swap/stale-lock/tip-change/integrity failures, and unchanged existing capability/journal export assertions.

- [ ] **Step 5: Review, stage, and commit Slice 3 semantic recovery.** Obtain a specification review and code-quality review with Critical 0 / Important 0 / Minor 0. Then run:

```bash
git diff --check
git add scripts/quarantine-workspace-runtime.mjs scripts/quarantine-transaction.mjs scripts/quarantine-run-fs-context.mjs scripts/quarantine-journal.mjs __tests__/fixtures/quarantine/quarantine-test-harness.ts __tests__/scripts/quarantine-transaction.test.ts __tests__/scripts/quarantine-journal.test.ts
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
- Apply phases under test are exactly `after-layout-sync`, `after-pre-inventories`, `after-divergent-diff:${entryId}`, `after-prepared-generation`, `after-event:PREPARED`, `after-event:MOVING`, `after-event:VERIFYING`, `after-event:QUARANTINED`, `before-lock-cleanup`, `after-event:MOVE_INTENT:${entryId}`, `after-rename:${entryId}`, `after-payload-sync:${entryId}`, `after-destination-parent-sync:${entryId}`, `after-source-parent-sync:${entryId}`, `after-inventory:moved-pass-1:${entryId}`, `after-event:MOVED:${entryId}`, and `after-inventory:moved-pass-2:${entryId}`. Recovery adds `after-event:RECOVERY_REQUIRED`, `after-event:ROLLING_BACK`, `after-event:ROLLED_BACK`, `after-event:INCOMPLETE_CONFLICT`, `after-event:ROLLBACK_INTENT:${entryId}`, `after-rollback-rename:${entryId}`, `after-rollback-payload-sync:${entryId}`, `after-rollback-destination-parent-sync:${entryId}`, `after-rollback-source-parent-sync:${entryId}`, and `after-event:ROLLED_BACK_ENTRY:${entryId}`.

- [ ] **Step 1: Write the SIGKILL child and RED integration matrix.** Create the child with a closed JSON request and a phase hook:

```js
const request = JSON.parse(process.env.QUARANTINE_CHILD_REQUEST);
const faultHook = async (phase) => {
  if (phase === request.killAt) process.kill(process.pid, "SIGKILL");
};
const ALLOWED_OPERATIONS = Object.freeze(["quarantineWorkspace", "recoverQuarantine", "restoreQuarantine", "recoverRestore"]);
if (!ALLOWED_OPERATIONS.includes(request.operation)) throw new Error("unknown child operation");
const api = await import(new URL("../../../scripts/quarantine-transaction.mjs", import.meta.url));
const operationTable = {
  quarantineWorkspace: api.quarantineWorkspace,
  recoverQuarantine: api.recoverQuarantine,
};
if (request.operation === "restoreQuarantine" || request.operation === "recoverRestore") {
  const restoreApi = await import(new URL("../../../scripts/quarantine-restore.mjs", import.meta.url));
  Object.assign(operationTable, { restoreQuarantine: restoreApi.restoreQuarantine, recoverRestore: restoreApi.recoverRestore });
}
const operations = Object.freeze(operationTable);
if (!Object.hasOwn(operations, request.operation)) throw new Error("unknown child operation");
const operation = operations[request.operation];
if (typeof operation !== "function") throw new Error("unknown child operation");
await operation({ ...request.options, faultHook });
```

Define the complete apply-options helper before every child row:

```ts
import type { Fixture } from "../fixtures/quarantine/quarantine-test-harness";

function applyOptions(f: Fixture, transactionId: string, createdAt: string) {
  return { repoRoot:f.repoRoot, quarantineRoot:f.quarantineRoot, expectedBranch:f.branch, expectedHead:f.head, expectedCount:f.expectedCount, transactionId, createdAt, writersStopped:true };
}
```

Each row uses a stable canonical UTC `createdAt` and explicit `transactionId`; the shared `Fixture` record includes the exact `expectedCount` derived from its generated source-copy entries. Spawn once for every seam. Pre-PREPARED seams (`after-layout-sync`, `after-pre-inventories`, `after-divergent-diff:${entryId}`, and `after-prepared-generation`) rerun `quarantineWorkspace` with the same options and assert valid adoption/completion; they do not call recovery without a durable journal. After PREPARED, call `recoverQuarantine`; resume/rollback assert exact durable journal transitions, source/payload locations, inventories, and terminal state. Only conflict/precondition failures snapshot evidence immediately before recovery and compare it unchanged after failure. Use the shared `replay-run` worker operation to inspect journal evidence. The 4,097th intent is rejected before mutation and valid non-bytewise intent order is never sorted.

```ts
import { fileURLToPath } from "node:url";
import { createQuarantineFixture, invokeQuarantineWorker } from "../fixtures/quarantine/quarantine-test-harness";
const fixtureRoot = createQuarantineFixture({ divergent: false });
const fixturePath = fileURLToPath(new URL("../fixtures/quarantine/quarantine-lifecycle-child.mjs", import.meta.url));
const transactionId = "tx-0001";
const createdAt = "2026-08-11T00:00:00.000Z";
const request = {
  operation: "quarantineWorkspace",
  killAt: "after-event:MOVE_INTENT:copy-0001",
  options: applyOptions(fixtureRoot, transactionId, createdAt),
};
const child = spawn(process.execPath, [fixturePath], { env: { ...process.env, QUARANTINE_CHILD_REQUEST: JSON.stringify(request) } });
const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
expect(result.signal).toBe("SIGKILL");
const recovery = invokeQuarantineWorker("recoverQuarantine", { ...request.options, action: "resume" });
expect(recovery.ok).toBe(true);
expect(recovery.result).toMatchObject({ status: "QUARANTINED" });
```

The shared harness exports `createQuarantineFixture`, `invokeQuarantineWorker`, and the `replay-run` worker operation; no Jest test module is imported. Conflict/precondition rows call the harness evidence snapshot immediately before attempted recovery.

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

### Task 3: Add the private lifecycle core and validate quarantined runs

**Files:**

- Create: `scripts/quarantine-lifecycle-core.mjs`
- Create: `__tests__/scripts/quarantine-lifecycle-core.test.ts`
- Modify: `scripts/quarantine-run-fs-context.mjs:20-123` so source capture, frozen method/receiver snapshot, identity assertion, and invalidation remain the sole filesystem-context authority
- Modify: `scripts/quarantine-workspace-runtime.mjs:1250-1287,2369-2403` to call the private core for existing-run operations
- Modify: `scripts/quarantine-transaction.mjs:1-4` to re-export only approved `markQuarantineValidated`; it never exports or re-exports `withExistingQuarantineRun`
- Modify: `__tests__/scripts/quarantine-transaction.test.ts:1722-5001` for validation of internal handoff consumption
- Modify: `__tests__/fixtures/quarantine/quarantine-test-harness.ts` to add host-only `prepareQuarantinedFixture` and the `core-contract` worker branch
- Modify: `scripts/quarantine-manifest.mjs:589-974` only through immutable generation/pointer authorities
- Modify: `__tests__/scripts/quarantine-manifest.test.ts:1265-1891` for generation/pointer retry assertions

**Interfaces:**

- Consumes: `withQuarantineRunCapability`, `getRunFsContext`, `bindRunFsContext`, `invalidateRunFsContext`, `replayJournal`, `readManifestGeneration`, `readCurrentManifestPointer`, `deriveRunPath`, and the exact public operation options.
- Produces exactly one internal ESM export with this exact callback contract:

```js
export async function withExistingQuarantineRun(
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

The handoff exists only during the internal callback; it is not returned by the public operation, exported, serialized, or stored after callback settlement. `journalTip` contains exact `sequence`, `recordHash`, `event`, `state`, and closed `payload`. `manifestGeneration` contains exactly the frozen keys `["manifestSha256", "state", "manifest"]` (the validated journal-named digest, state, and closed manifest value) needed by the internal caller; `manifestSha256` is present both in this record and in the enclosing handoff's generation evidence. `fsApi` is the bound frozen adapter, not a caller-mutated source.

This core is used only by `markQuarantineValidated`, `restoreQuarantine`, and `recoverRestore`; Slice 3 `recoverQuarantine` remains runtime/transaction-owned and never consumes this core. The private module assertion is exactly `Object.keys(await import("../../scripts/quarantine-lifecycle-core.mjs")) === ["withExistingQuarantineRun"]`; transaction, runtime, restore, facade, package, CLI, and public-result assertions are all negative for that name.

The private helper signatures are fixed for implementation and tests:

```ts
function snapshotExistingRunOptions(input: unknown): ExistingRunOptions;
function captureFsSource(source?: object): FrozenFsSource;
function validateExistingRun(args: { capability: object; fsApi: object } & ExistingRunOptions): Promise<{
  repoRoot: string; quarantineRoot: string; runRoot: string; transactionId: string;
  head: string; journalTip: JournalTip; manifestGeneration: ManifestGeneration;
}>;
function validateRestoreProvenance(args: {
  capability: object; fsApi: object; replay: JournalReplay;
  manifestGeneration: ManifestGeneration;
}): Promise<void>;
```

`ExistingRunOptions` is the five-key closed record defined above; `FrozenFsSource` is the existing 14-method source contract; `JournalTip` and `ManifestGeneration` are the frozen records in the handoff. These names are private descriptions only and are not runtime exports.

The same joint task produces exactly this transaction API and result:

```js
export async function markQuarantineValidated({
  repoRoot, quarantineRoot, transactionId, validatedAt,
  writersStopped, fsApi, faultHook,
}) {}
```

```text
{ transactionId, status: "VALIDATED", manifestSha256, validatedAt,
  deleteAfter, deletionRequiresConfirmation: true }
```

Its only public validation phases are
`after-inventory:validation-pass-1:${generatedEntryId}`,
`after-inventory:validation-pass-2:${generatedEntryId}`,
`after-validated-generation`, `after-event:VALIDATED`,
`after-pointer-temporary-sync`, `after-pointer-rename`,
`after-pointer-root-sync`, and `before-lock-cleanup`. Private helper bodies
must use the existing manifest, inventory, journal, and capability authorities;
they do not become exports.

- [ ] **Step 1: Write private-core RED tests and add the core-contract branch.** Import `createQuarantineFixture` and `invokeQuarantineWorker` from `__tests__/fixtures/quarantine/quarantine-test-harness.ts`; that test-only helper owns the moved `Fixture` type, URL/constants/import setup, exact current `fixture` body, exact current `invoke` body, and existing `replay-run` worker branch. In this step, add the `core-contract` branch alongside the RED assertions below. Assert the exact handoff key set/prototypes/descriptors/frozen state and callback-only lifetime. Cover supplied adapter capture and omitted default adapter capture before the first await; adapter identity mutation, wrong receiver, and method replacement after capture; forged capability; stale run identity; changed quarantine root or repository HEAD; torn or changed journal; wrong, missing, or corrupt journal-named generation; interrupted pointer publication; symlink/foreign replacement; and no journal, pointer, or payload mutation on every precondition failure.

```ts
const prepared = await prepareQuarantinedFixture();
const result = invokeQuarantineWorker("core-contract", { options: { repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot, transactionId: prepared.transactionId, writersStopped: true }, mutateSourceAfterCapture: true });
expect(result.ok).toBe(true);
expect([...(result.result?.handoffKeys ?? [])].sort()).toEqual([
  "capability", "fsApi", "head", "journalTip", "manifestGeneration",
  "quarantineRoot", "repoRoot", "runRoot", "transactionId",
].sort());
expect(result.result?.handoffFrozen).toBe(true);
expect(result.result?.prototype).toBe("null");
expect(result.result?.descriptors).toEqual(expect.any(Object));
expect(result.result?.evidenceBefore).toEqual(result.result?.evidenceAfter);
expect(result.result?.wrongReceiver).toBe(0);
expect(result.result?.callbackInvoked).toBe(true);
expect(result.result?.manifestGenerationKeys).toEqual(["manifestSha256", "state", "manifest"]);
expect(result.result?.getterReads).toEqual(Object.fromEntries([
  "lstat", "realpath", "mkdir", "open", "readdir", "rm", "rename", "unlink",
  "link", "opendir", "readlink", "createReadStream", "lstatSync", "realpathSync",
].map((name) => [name, 1])));
```

The worker branch for `operation === "core-contract"` mutates every captured
source method/getter after synchronous capture through non-throwing
`Reflect.set`/`Reflect.defineProperty` attempts and returns only JSON-safe
observations; it never returns the capability or handoff. The returned
`getterReads` map must contain exactly one read for every method, `wrongReceiver`
must remain zero, and the poison replacements must never be reached by the
captured implementations.

The separate stale test prepares a second fixture and snapshots its exact
journal, current-pointer (including absence), and manifest-generation bytes.
The worker's first `lstat` call is a synchronous barrier: it receives the
capability-derived run-root path, moves that run root and its containing
quarantine root to deterministic `.original` siblings, installs foreign roots
with a sentinel, and only then invokes the underlying `lstat`; this is the
`replaceRunIdentity: true` path and does not race the pending operation. The
pending core call is created before this barrier, and the replacement runs
before the underlying filesystem promise is created.
The test expects `ok === false`, no callback/result, and compares every snapshotted
byte with the corresponding file under the deterministic `.original` roots;
foreign sentinels remain untouched. It never expects handoff keys on stale
input.

Add state-specific tests: QUARANTINED obtains baseline digest/generation from PREPARED and requires manifest state PREPARED; it does not require a QUARANTINED tip payload or QUARANTINED generation. VALIDATED obtains the digest/generation and stored retention metadata from the VALIDATED tip. Add pointer tests that distinguish missing activation-pending from present malformed, foreign, path-bearing, or mismatched fatal pointers. Add restore-context RED cases for durable `RESTORE_PREPARED`, `RESTORING`, `RECOVERY_REQUIRED` emitted during restore, and `RESTORE_ROLLING_BACK`: reconstruct the pre-restore QUARANTINED-or-VALIDATED provenance from the durable restore ledger, validate every active/rollback/payload location and state-specific generation through the existing journal authority, and assert callback-not-invoked plus no mutation on any mismatch.

Modify the shared host harness here with this executable helper; it is not a
worker operation. It invokes the existing worker operation `"apply"`, checks
the exact successful result, then optionally regenerates ignored roots:

```ts
export async function prepareQuarantinedFixture(options: { divergent?: boolean; regenerate?: boolean } = {}) {
  const fixture = createQuarantineFixture({ divergent: options.divergent ?? false });
  const transactionId = "tx-0001";
  const createdAt = "2026-08-11T00:00:00.000Z";
  const applyOptions = { repoRoot: fixture.repoRoot, quarantineRoot: fixture.quarantineRoot, expectedBranch: fixture.branch, expectedHead: fixture.head, expectedCount: fixture.expectedCount, transactionId, createdAt, writersStopped: true };
  const applyResult = invokeQuarantineWorker("apply", applyOptions);
  if (!applyResult.ok || applyResult.result?.status !== "QUARANTINED") throw new Error("apply did not produce QUARANTINED");
  if (options.regenerate) {
    mkdirSync(join(fixture.repoRoot, ".next"), { recursive: true, mode: 0o700 });
    mkdirSync(join(fixture.repoRoot, "node_modules"), { recursive: true, mode: 0o700 });
    writeFileSync(join(fixture.repoRoot, ".next", "build"), "regenerated");
    writeFileSync(join(fixture.repoRoot, "node_modules", "package"), "regenerated");
  }
  return { fixture, transactionId, createdAt, runRoot: join(fixture.quarantineRoot, transactionId), applyResult };
}
```

The host imports `mkdirSync`, `writeFileSync`, and `join`. The inline worker
source gains `core-contract` only in this task: it conditionally imports the
private lifecycle core, invokes it with `request.options`, and returns only
JSON-safe handoff keys, frozen/prototype/descriptor observations, and evidence
bytes read from exact capability-derived fixture evidence paths. It never
returns the capability or handoff. The worker also keeps the existing
`recoverQuarantine` and `replay-run` branches; preparation remains host-only.
That worker branch imports `readFileSync` and the existing `deriveRunPath`
authority before reading those capability-derived evidence paths. It also
imports `dirname`, `join`, `mkdirSync`, `renameSync`, and `writeFileSync` for
the deterministic first-`lstat` replacement seam below, while retaining the
existing `fsPromises`, `createReadStream`, `lstatSync`, and `realpathSync`
imports used to construct `baseFsApi`.
The host computes `const coreUrl = pathToFileURL(join(__dirname, "../../scripts/quarantine-lifecycle-core.mjs")).href` beside the existing transaction URL and injects `${JSON.stringify(coreUrl)}` into the worker source; the generated worker never resolves this module relative to its own evaluated `import.meta.url`.

```js
const FS_METHODS = Object.freeze([
  "lstat", "realpath", "mkdir", "open", "readdir", "rm", "rename", "unlink",
  "link", "opendir", "readlink", "createReadStream", "lstatSync", "realpathSync",
]);
const baseFsApi = { ...fsPromises, createReadStream, lstatSync, realpathSync };
function makeMutableFsSource({ beforeFirstAwait } = {}) {
  const source = Object.create(null);
  const calls = Object.fromEntries(FS_METHODS.map((name) => [name, 0]));
  const getterReads = Object.fromEntries(FS_METHODS.map((name) => [name, 0]));
  let wrongReceiver = 0;
  for (const name of FS_METHODS) Object.defineProperty(source, name, {
    enumerable: true,
    configurable: true,
    get() {
      getterReads[name] += 1;
      const implementation = baseFsApi[name];
      return function (...args) {
        if (this !== source) wrongReceiver += 1;
        calls[name] += 1;
        if (beforeFirstAwait) {
          const handled = beforeFirstAwait(name, args);
          if (handled) beforeFirstAwait = undefined;
        }
        return Reflect.apply(implementation, baseFsApi, args);
      };
    },
  });
  return { source, calls, getterReads, get wrongReceiver() { return wrongReceiver; } };
}
function replaceActualRunIdentity(runRootPath) {
  const quarantineRootPath = dirname(runRootPath);
  const originalRunRootPath = `${runRootPath}.original`;
  const originalQuarantineRootPath = `${quarantineRootPath}.original`;
  renameSync(runRootPath, originalRunRootPath);
  renameSync(quarantineRootPath, originalQuarantineRootPath);
  mkdirSync(quarantineRootPath, { recursive: true, mode: 0o700 });
  mkdirSync(runRootPath, { recursive: true, mode: 0o700 });
  writeFileSync(join(runRootPath, "foreign-sentinel"), "foreign");
}
} else if (operation === "core-contract") {
  const { withExistingQuarantineRun } = await import(${JSON.stringify(coreUrl)});
  let callbackInvoked = false;
  const mutable = makeMutableFsSource({
    beforeFirstAwait: (name, args) => {
      const candidate = String(args[0] ?? "");
      if (request.replaceRunIdentity && name === "lstat" && candidate.endsWith(`/${request.options.transactionId}`)) {
        replaceActualRunIdentity(candidate);
        return true;
      }
      return false;
    },
  });
  const pending = withExistingQuarantineRun({ ...request.options, fsApi: mutable.source }, async (handoff) => {
    callbackInvoked = true;
    const journalPath = deriveRunPath(handoff.capability, { purpose: "journal" });
    const pointerPath = deriveRunPath(handoff.capability, { purpose: "current-pointer" });
    const generationPath = deriveRunPath(handoff.capability, { purpose: "manifest-generation", id: handoff.manifestGeneration.manifestSha256 });
    const readOptional = (path) => { try { return readFileSync(path).toString("base64"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
    const evidenceBefore = [readFileSync(journalPath).toString("base64"), readOptional(pointerPath), readFileSync(generationPath).toString("base64")];
    const result = { handoffKeys: Object.keys(handoff), handoffFrozen: Object.isFrozen(handoff), prototype: Object.getPrototypeOf(handoff) === null ? "null" : "other", descriptors: Object.fromEntries(Object.keys(handoff).map((key) => [key, Object.getOwnPropertyDescriptor(handoff, key)])), manifestGenerationKeys: Object.keys(handoff.manifestGeneration), evidenceBefore };
    return { result, evidencePaths: [journalPath, pointerPath, generationPath] };
  });
  if (request.mutateSourceAfterCapture) for (const name of FS_METHODS) {
    const poison = () => { throw new Error("poison"); };
    if (!Reflect.set(mutable.source, name, poison)) Reflect.defineProperty(mutable.source, name, { configurable: true, enumerable: true, writable: true, value: poison });
  }
  const settled = await pending;
  const evidenceAfter = settled.evidencePaths.map((path) => { try { return readFileSync(path).toString("base64"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } });
  process.stdout.write(JSON.stringify({ ok: true, result: { ...settled.result.result, evidenceAfter, calls: mutable.calls, getterReads: mutable.getterReads, wrongReceiver: mutable.wrongReceiver, callbackInvoked } }) + "\n");
}
```

- [ ] **Step 2: Run the private-core RED suite.**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-lifecycle-core.test.ts
```

Expected: FAIL because `scripts/quarantine-lifecycle-core.mjs` is absent and the existing runtime still owns source capture/hand-off setup.

- [ ] **Step 3: Move source capture and implement the private core (GREEN).** In `quarantine-run-fs-context.mjs`, make the supplied source or `DEFAULT_SOURCE` snapshot occur synchronously before any filesystem await, evaluate each of the 14 method getters once, freeze the source and adapter, bind the exact source object to the live capability, and invalidate it before callback settlement on both success and failure. In `quarantine-lifecycle-core.mjs`, export only `withExistingQuarantineRun`, create the capability, derive the lexical transaction/run root only through capability rules, replay the journal, validate live run/root/repository identity and exact HEAD, then validate the state-specific generation and pointer evidence. Before invoking the callback, call `validateRestoreProvenance` for any restore ledger state (`RESTORE_PREPARED`, `RESTORING`, restore-context `RECOVERY_REQUIRED`, or `RESTORE_ROLLING_BACK`); reconstruct the durable pre-restore QUARANTINED-or-VALIDATED state, restore ID, intent order, active-generated inventory, rollback/payload locations, and state-specific generation from existing journal replay and path authorities, rejecting any mismatch without mutation. Return only the null-prototype frozen internal handoff above; do not add a restore field or public state, and do not reimplement path containment, bootstrap, or security checks.

```js
export async function withExistingQuarantineRun(options, callback) {
  const input = snapshotExistingRunOptions(options); // no await
  const source = captureFsSource(input.fsApi); // supplied or default, frozen before await
  return withQuarantineRunCapability({ ...input, fsApi: source }, async (capability) => {
    const fsApi = getRunFsContext(capability, source);
    const handoff = await validateExistingRun({ capability, fsApi, ...input });
    const replay = await replayJournal({ capability, fsApi });
    await validateRestoreProvenance({ capability, fsApi, replay, manifestGeneration: handoff.manifestGeneration });
    const frozenHandoff = Object.freeze(Object.assign(Object.create(null), handoff, { capability, fsApi }));
    return callback(frozenHandoff);
  });
}
```

The named export is the sole exception to the private boundary: direct internal ESM imports may bind it, but no transaction/runtime/restore/facade/package/CLI module or public result may re-export, serialize, return, or expose it.

- [ ] **Step 4: Run the validation RED suite.** Add validation tests now, before the validation implementation: seed QUARANTINED from a PREPARED ledger generation; regenerate `.next` and `node_modules`; assert clean Git status, exact root/HEAD, no source copies, two independent inventories per generated ID, matching summaries, and no numbered basename. Capture journal, pointer, and payload bytes before failures for changed HEAD/root, residue, missing root, inventory drift, stale lock, another transaction, wrong PREPARED generation, and path-bearing pointer; assert byte identity after each failure. Add VALIDATED retry with a different supplied `validatedAt`, missing-pointer activation-pending, and fatal present malformed/foreign/path-bearing/mismatched pointers.

```ts
import { prepareQuarantinedFixture } from "../fixtures/quarantine/quarantine-test-harness";
import { markQuarantineValidated } from "../../scripts/quarantine-transaction.mjs";
const prepared = await prepareQuarantinedFixture({ regenerate: true });
const validated = await markQuarantineValidated({ repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot, transactionId: prepared.transactionId, validatedAt: "2026-08-09T12:00:00.000Z", writersStopped: true });
expect(validated.status).toBe("VALIDATED");
```

VALIDATED retry setup reuses `prepared.applyResult` and the existing journal
and manifest primitives: replay the durable QUARANTINED journal, call the
approved validation implementation once to append VALIDATED and publish its
generation, then remove only the disposable fixture's current pointer before
the retry. The retry supplies a different `validatedAt` and must reuse the
tip-named generation and stored metadata.

The validation RED test then calls the public transaction operation on the same
prepared fixture and asserts the closed result and exact 96-hour deadline:

```ts
const validated = await markQuarantineValidated({ repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot, transactionId: prepared.transactionId, validatedAt: "2026-08-09T12:00:00.000Z", writersStopped: true });
expect(validated).toMatchObject({ transactionId: prepared.transactionId, status: "VALIDATED", deletionRequiresConfirmation: true });
expect(new Date(validated.deleteAfter).getTime() - new Date(validated.validatedAt).getTime()).toBe(96 * 60 * 60 * 1000);
const phases: string[] = [];
const retry = await markQuarantineValidated({ repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot, transactionId: prepared.transactionId, validatedAt: "2026-08-10T12:00:00.000Z", writersStopped: true, faultHook: (phase) => { phases.push(phase); expect(["after-inventory:validation-pass-1:generated-next", "after-inventory:validation-pass-1:generated-node-modules", "after-inventory:validation-pass-2:generated-next", "after-inventory:validation-pass-2:generated-node-modules", "after-validated-generation", "after-event:VALIDATED", "after-pointer-temporary-sync", "after-pointer-rename", "after-pointer-root-sync", "before-lock-cleanup"]).toContain(phase); } });
expect(retry.validatedAt).toBe(validated.validatedAt);
expect(retry.deleteAfter).toBe(validated.deleteAfter);
expect(phases).not.toContain("after-generation-directory-sync");
expect(phases).not.toContain("after-journal-sync");
expect(phases).not.toContain("after-quarantine-root-sync");
```

- [ ] **Step 5: Run validation RED.**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-transaction.test.ts __tests__/scripts/quarantine-lifecycle-core.test.ts __tests__/scripts/quarantine-manifest.test.ts
```

Expected: FAIL because `markQuarantineValidated` is not exported and no implementation publishes the journal-named immutable VALIDATED generation with state-specific retry semantics.

- [ ] **Step 6: Implement validation, retention, pointer retry, and public fault mapping.** Use the core handoff to write and compare `validation-pass-1` and `validation-pass-2` for `generated-next` and `generated-node-modules`, reject residue before append, and on QUARANTINED build `deleteAfter = validatedAt + 96 hours`, `deletionStatus: "retained"`, and `deletionRequiresConfirmation: true`; write the generation, append VALIDATED, then activate only the same digest. On VALIDATED retry, use the tip-named generation and stored timestamps, ignore supplied `validatedAt`, and activate only when `current` is missing. Preconditions never repair pointers; any present malformed, foreign, path-bearing, or mismatched pointer is fatal. The private phase wrapper is complete and exact:

```js
const VALIDATION_PHASES = new Set([
  "after-inventory:validation-pass-1:generated-next",
  "after-inventory:validation-pass-1:generated-node-modules",
  "after-inventory:validation-pass-2:generated-next",
  "after-inventory:validation-pass-2:generated-node-modules",
  "after-validated-generation", "after-event:VALIDATED",
  "after-pointer-temporary-sync", "after-pointer-rename",
  "after-pointer-root-sync", "before-lock-cleanup",
]);
function mapValidationFaultHook(publicHook, primitive) {
  if (!publicHook) return undefined;
  return async (phase) => {
    const mapped = primitive === "writeManifestGeneration"
      ? phase === "after-generation-directory-sync" ? "after-validated-generation" : null
      : primitive === "activateManifestGeneration"
        ? phase === "after-pointer-temporary-sync" || phase === "after-pointer-rename" ? phase
          : phase === "after-quarantine-root-sync" ? "after-pointer-root-sync" : null
        : null;
    if (mapped && VALIDATION_PHASES.has(mapped)) await publicHook(mapped);
  };
}
function journalValidationFaultHook(publicHook) {
  if (!publicHook) return undefined;
  return async (phase) => {
    if (phase === "after-journal-sync") return;
    if (phase === "before-lock-cleanup") {
      await publicHook("after-event:VALIDATED");
      await publicHook("before-lock-cleanup");
    }
  };
}
async function ensureValidated({ capability, transactionId, manifestSha256, fsApi, publicHook }) {
  return withJournalLock({ capability, fsApi }, async (heldLock) => {
    const replay = await replayJournal({ capability, fsApi });
    const tip = replay.records.at(-1);
    if (replay.state === "VALIDATED") {
      if (tip?.event !== "VALIDATED" || tip.payload.manifestSha256 !== manifestSha256) throw new Error("validated digest mismatch");
      return { status: "already-present", manifestSha256 };
    }
    if (replay.state !== "QUARANTINED") throw new Error("invalid validation state");
    await appendJournalRecord({ capability, heldLock, event: "VALIDATED", payload: { manifestSha256 }, fsApi, faultHook: journalValidationFaultHook(publicHook) });
    return { status: "appended", manifestSha256 };
  });
}
async function publishValidated({ handoff, manifest, publicHook }) {
  const { manifestSha256 } = await writeManifestGeneration({ capability: handoff.capability, manifest, fsApi: handoff.fsApi, faultHook: mapValidationFaultHook(publicHook, "writeManifestGeneration") });
  return activateManifestGeneration({ capability: handoff.capability, transactionId: handoff.transactionId, manifestSha256, fsApi: handoff.fsApi, faultHook: mapValidationFaultHook(publicHook, "activateManifestGeneration"), appendValidated: ({ manifestSha256: requested }) => ensureValidated({ capability: handoff.capability, transactionId: handoff.transactionId, manifestSha256: requested, fsApi: handoff.fsApi, publicHook }) });
}
```

The wrapper suppresses every other generation, journal, and pointer primitive phase; the public hook receives only the ValidationPhase literals above.

- [ ] **Step 7: Run the combined GREEN suite.**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-lifecycle-core.test.ts __tests__/scripts/quarantine-run-capability.test.ts __tests__/scripts/quarantine-transaction.test.ts __tests__/scripts/quarantine-journal.test.ts __tests__/scripts/quarantine-manifest.test.ts
```

Expected: PASS for core source/method mutation, callback invalidation, exact QUARANTINED PREPARED provenance, VALIDATED tip provenance, retained metadata, pointer retry, every mapped/suppressed fault phase, mutation-free preconditions, and exact private/public export assertions.

- [ ] **Step 8: Joint review and commit.** Review source capture and recovery ownership, the private export boundary and negative assertions, state provenance, two-pass validation, retention metadata, missing-pointer retry, all fatal pointer variants, and the complete fault mapping. Slice 4 is not approved before this joint gate. Then run:

```bash
git diff --check
git add scripts/quarantine-lifecycle-core.mjs scripts/quarantine-run-fs-context.mjs scripts/quarantine-workspace-runtime.mjs scripts/quarantine-transaction.mjs scripts/quarantine-manifest.mjs __tests__/fixtures/quarantine/quarantine-test-harness.ts __tests__/scripts/quarantine-lifecycle-core.test.ts __tests__/scripts/quarantine-transaction.test.ts __tests__/scripts/quarantine-manifest.test.ts
git commit -m "feat: validate quarantined workspaces"
```

### Task 4: Implement normal Slice 5 restore

**Files:**

- Create: `scripts/quarantine-restore.mjs`
- Modify: `scripts/quarantine-workspace-runtime.mjs:2369-2403` only for private shared-core/runtime wiring
- Create: `__tests__/scripts/quarantine-restore.test.ts`
- Modify: `__tests__/scripts/quarantine-lifecycle-core.test.ts` for restore handoff reuse
- Modify: `__tests__/fixtures/quarantine/quarantine-test-harness.ts` for `prepareQuarantinedFixture`

**Interfaces:**

- Consumes: Task 3's private core and its QUARANTINED/VALIDATED generation, manifest, journal, inventory, and pointer evidence.
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
import { createHash } from "node:crypto";

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
function snapshotRestoreOptions(input: unknown): Readonly<RestoreOptions>;
function snapshotRestoreRecoveryOptions(input: unknown): Readonly<RestoreRecoveryOptions>;
function pickExistingRunOptions(input: RestoreOptions): ExistingRunOptions;
function captureActiveGenerated(handoff: InternalRunHandoff, restoreId: string, faultHook?: FaultHook): Promise<ActiveGenerated>;
function appendRestorePrepared(handoff: InternalRunHandoff, restoreId: string, activeGenerated: ActiveGenerated, faultHook?: FaultHook): Promise<void>;
function appendRestoreStarted(handoff: InternalRunHandoff, faultHook?: FaultHook): Promise<void>;
function restoreEntry(args: { handoff: InternalRunHandoff; restoreId: string; entry: ManifestEntry; faultHook?: FaultHook }): Promise<void>;
function appendRestored(handoff: InternalRunHandoff, faultHook?: FaultHook): Promise<void>;
```

Both public entry points use these complete synchronous snapshots before any
`await` or `deriveRestoreId` call. They read each input getter once, reject
unknown keys and non-literal `writersStopped`, validate recovery action exactly,
and return a null-prototype frozen record; later caller mutation cannot affect
the captured values:

```js
function snapshotRestoreRecord(input, recovery) {
  if (!input || typeof input !== "object") throw new Error("invalid restore options");
  const allowed = new Set(["repoRoot", "quarantineRoot", "transactionId", "writersStopped", "fsApi", "faultHook", ...(recovery ? ["action"] : [])]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error("invalid restore options");
  const repoRoot = input.repoRoot;
  const quarantineRoot = input.quarantineRoot;
  const transactionId = input.transactionId;
  const writersStopped = input.writersStopped;
  const fsApi = input.fsApi;
  const faultHook = input.faultHook;
  if (typeof repoRoot !== "string" || typeof quarantineRoot !== "string" || typeof transactionId !== "string" || writersStopped !== true || (faultHook !== undefined && typeof faultHook !== "function")) throw new Error("invalid restore options");
  const snapshot = Object.create(null);
  Object.assign(snapshot, { repoRoot, quarantineRoot, transactionId, writersStopped, fsApi, faultHook });
  if (recovery) {
    const action = input.action;
    if (action !== "resume" && action !== "rollback") throw new Error("invalid restore action");
    snapshot.action = action;
  }
  return Object.freeze(snapshot);
}
function snapshotRestoreOptions(input) { return snapshotRestoreRecord(input, false); }
function snapshotRestoreRecoveryOptions(input) { return snapshotRestoreRecord(input, true); }
```

`RestoreOptions` is the closed record `{ repoRoot, quarantineRoot,
transactionId, writersStopped, fsApi?, faultHook? }`; `RestoreRecoveryOptions`
is that same record plus `action: "resume" | "rollback"`. The snapshots retain
the supplied `transactionId` and `faultHook` values and are private records,
not additional public APIs.

`ActiveGenerated` is the fixed two-record `{ id, inventory: InventorySummary | null }[]` payload; `ManifestEntry` is the closed manifest union from the original design. Both descriptions are private and are not new public APIs.

Restore journal payloads stay exact: `RESTORE_PREPARED` is `{ restoreId, activeGenerated }`; `RESTORING`, `RESTORED`, and `RESTORE_ROLLING_BACK` are `{}`; `RESTORE_INTENT`, `RESTORE_ROLLBACK_INTENT`, `RESTORED_ENTRY`, and `RESTORE_ROLLED_BACK_ENTRY` are `{ id }`; `RESTORE_ABORTED_TO_QUARANTINED` and `RESTORE_ABORTED_TO_VALIDATED` are `{}`; and `INCOMPLETE_CONFLICT` is `{ conflictEntryIds }`.

- [ ] **Step 1: Write restore RED tests and exact vector test.** Assert the fixed vector and prefixed grammar. Parameterize all four presence combinations for `.next` and `node_modules`; existing active roots write and fsync exactly one `restore-active` inventory, absent roots write no JSONL and are rechecked immediately before `RESTORE_PREPARED`. Assert dense bytewise-sorted `activeGenerated` records with the two fixed IDs and exact summary-or-null. Recreate an absent root or remove an inventoried root at the final presence seam and assert no `RESTORE_PREPARED`/`RESTORING` mutation. Add closed-option tests with accessor-backed `repoRoot`, `quarantineRoot`, `transactionId`, `writersStopped`, and `faultHook`: each getter is read once, the frozen null-prototype snapshot remains unchanged after caller mutation, and invalid extra keys or non-literal writers/action values are rejected before `deriveRestoreId` or any await.

```ts
import { prepareQuarantinedFixture } from "../fixtures/quarantine/quarantine-test-harness";
const prepared = await prepareQuarantinedFixture({ regenerate: false });
const restoreOptions = { repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot, transactionId: prepared.transactionId };
await expect(restoreQuarantine({ ...restoreOptions, writersStopped: true })).resolves.toMatchObject({
  transactionId: "tx-0001",
  restoreId: "restore-c3624475-87d7-4886-b0bf-68a5061663d2",
  status: "RESTORED",
});
```

The restore test reuses the copied transaction `invoke` worker helper and defines `restoreOptions` from the disposable fixture's absolute repository/quarantine roots and transaction ID before this assertion.

Run separate crash/replay rows for `RESTORE_PREPARED`, `RESTORING`,
restore-context `RECOVERY_REQUIRED`, and `RESTORE_ROLLING_BACK`; each row must
prove the private core reconstructs the same pre-restore QUARANTINED-or-VALIDATED
provenance and rejects altered journal, generation, or inventory evidence before
any callback or filesystem mutation.

Assert source-copy P-to-A moves and generated A-to-R followed by P-to-A moves, each with payload/tree sync, destination-parent sync, and source-parent sync in order, with no overwrite or unlink of active concurrent evidence. Assert exact hooks `after-event:RESTORE_PREPARED`, `after-event:RESTORING`, `after-inventory:restore-active:${generatedEntryId}`, `after-event:RESTORE_INTENT:${entryId}`, `after-active-to-rollback-rename:${generatedEntryId}`, `after-rollback-tree-sync:${generatedEntryId}`, `after-rollback-destination-parent-sync:${generatedEntryId}`, `after-rollback-source-parent-sync:${generatedEntryId}`, `after-payload-to-active-rename:${entryId}`, `after-restored-payload-sync:${entryId}`, `after-restore-destination-parent-sync:${entryId}`, `after-restore-source-parent-sync:${entryId}`, `after-event:RESTORED_ENTRY:${entryId}`, `after-event:RESTORED`, and `before-lock-cleanup`.

- [ ] **Step 2: Run restore RED.**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-restore.test.ts
```

Expected: FAIL because `scripts/quarantine-restore.mjs` and its `restoreQuarantine` implementation/test do not exist.

- [ ] **Step 3: Implement normal restore through the private core.** Validate the exact durable QUARANTINED or VALIDATED evidence, reject any already-present in-progress restore ledger mutation-free (recovery owns those states), derive the deterministic prefixed restore ID, create only capability-derived rollback entries, write the fixed inventories, append `RESTORE_PREPARED` and `RESTORING`, then process entries in manifest order with the required sync order. Preserve regenerated rollback content after successful restore; never overwrite or delete an active concurrent replacement.

```js
export async function restoreQuarantine(input) {
  const options = snapshotRestoreOptions(input);
  const restoreId = deriveRestoreId(options.transactionId);
  return withExistingQuarantineRun(pickExistingRunOptions(options), async (handoff) => {
    if (["RESTORE_PREPARED", "RESTORING", "RECOVERY_REQUIRED", "RESTORE_ROLLING_BACK"].includes(handoff.journalTip.state)) throw new Error("restore recovery required");
    const activeGenerated = await captureActiveGenerated(handoff, restoreId, options.faultHook);
    await appendRestorePrepared(handoff, restoreId, activeGenerated, options.faultHook);
    await appendRestoreStarted(handoff, options.faultHook);
    for (const entry of handoff.manifestGeneration.manifest.entries) {
      await restoreEntry({ handoff, restoreId, entry, faultHook: options.faultHook });
    }
    await appendRestored(handoff, options.faultHook);
    return Object.freeze({ transactionId: options.transactionId, restoreId, status: "RESTORED", restoredEntries: handoff.manifestGeneration.manifest.entries.length });
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
git add scripts/quarantine-restore.mjs scripts/quarantine-workspace-runtime.mjs __tests__/fixtures/quarantine/quarantine-test-harness.ts __tests__/scripts/quarantine-restore.test.ts __tests__/scripts/quarantine-lifecycle-core.test.ts
git commit -m "feat: restore quarantined workspaces"
```

### Task 5: Implement restore recovery and real SIGKILL restore proof

**Files:**

- Modify: `scripts/quarantine-restore.mjs`
- Modify: `__tests__/fixtures/quarantine/quarantine-lifecycle-child.mjs`
- Create: `__tests__/scripts/quarantine-restore-crash.integration.test.ts`
- Modify: `__tests__/scripts/quarantine-restore.test.ts`
- Modify: `__tests__/fixtures/quarantine/quarantine-test-harness.ts` to export `spawnLifecycleChild` for recovery setup reuse

**Interfaces:**

- Consumes: Task 4's restore ledger and private core; the shared child fixture from Task 2.
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

Recovery event phases are exactly `after-event:RECOVERY_REQUIRED`, `after-event:RESTORE_ROLLING_BACK`, `after-event:RESTORE_ABORTED_TO_QUARANTINED`, `after-event:RESTORE_ABORTED_TO_VALIDATED`, `after-event:INCOMPLETE_CONFLICT`, `after-event:RESTORE_ROLLBACK_INTENT:${entryId}`, and `after-event:RESTORE_ROLLED_BACK_ENTRY:${entryId}`, in addition to the normal restore phases listed in Task 4.

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
import { prepareQuarantinedFixture, spawnLifecycleChild } from "../fixtures/quarantine/quarantine-test-harness";
const resumePrepared = await prepareQuarantinedFixture({ regenerate: false });
const resumeOptions = { repoRoot: resumePrepared.fixture.repoRoot, quarantineRoot: resumePrepared.fixture.quarantineRoot, transactionId: resumePrepared.transactionId };
const resumeChild = await spawnLifecycleChild({ operation: "restoreQuarantine", options: { ...resumeOptions, writersStopped: true }, killAt: "after-event:RESTORE_INTENT:copy-0001" });
expect(resumeChild.signal).toBe("SIGKILL");
expect(await recoverRestore({ ...resumeOptions, action: "resume", writersStopped: true }))
  .toMatchObject({ transactionId: "tx-0001", restoreId: "restore-c3624475-87d7-4886-b0bf-68a5061663d2", status: "RESTORED", action: "resume" });
const rollbackPrepared = await prepareQuarantinedFixture({ regenerate: false });
const rollbackOptions = { repoRoot: rollbackPrepared.fixture.repoRoot, quarantineRoot: rollbackPrepared.fixture.quarantineRoot, transactionId: rollbackPrepared.transactionId };
const rollbackChild = await spawnLifecycleChild({ operation: "restoreQuarantine", options: { ...rollbackOptions, writersStopped: true }, killAt: "after-event:RESTORE_PREPARED" });
expect(rollbackChild.signal).toBe("SIGKILL");
expect(await recoverRestore({ ...rollbackOptions, action: "rollback", writersStopped: true }))
  .toMatchObject({ status: "QUARANTINED", action: "rollback", restoreAborted: true });
```

`spawnLifecycleChild` is the existing crash-test helper body moved into the
shared harness with this signature and behavior. The harness imports `spawn`
and `fileURLToPath`, defines `fixturePath` from the sibling child module, and
keeps the exit waiter executable in the same file:

```ts
const fixturePath = fileURLToPath(new URL("./quarantine-lifecycle-child.mjs", import.meta.url));
type ChildExit = { once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void };
function waitForExit(child: ChildExit): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}
export function spawnLifecycleChild(request: { operation: string; options: Record<string, unknown>; killAt: string }) {
  const child = spawn(process.execPath, [fixturePath], { env: { ...process.env, QUARANTINE_CHILD_REQUEST: JSON.stringify(request) } });
  return waitForExit(child);
}
```

`waitForExit` is the existing helper that resolves `{ code, signal }` from the
child's `exit` event. Each action uses a fresh prepared fixture. Resume asserts the
durable post-RESTORE_INTENT journal and terminal RESTORED state. Rollback
asserts the exact prior QUARANTINED state and its rollback events; neither
action calls recovery on a plain fixture or reuses the other action's fixture.

- [ ] **Step 2: Run restore recovery RED.**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-restore.test.ts __tests__/scripts/quarantine-restore-crash.integration.test.ts
```

Expected: FAIL because `recoverRestore` and the restore crash integration suite are absent and no A/R/P replay can yet return the exact prior state.

- [ ] **Step 3: Implement forward resume and reverse rollback.** Snapshot and freeze restore-recovery options before deriving the restore ID or awaiting; replay before mutation, preserve `RESTORE_INTENT` order, and process rollback in reverse durable order. The private core has already reconstructed and validated the durable pre-restore QUARANTINED-or-VALIDATED provenance for `RESTORE_PREPARED`, `RESTORING`, restore-context `RECOVERY_REQUIRED`, and `RESTORE_ROLLING_BACK`; recovery then uses that ledger and state-specific generation without exposing a new public state. For generated entries rollback moves active original A to payload P, then regenerated R to active A; append the abort event matching the state immediately before `RESTORE_PREPARED`. Use the exact `RESTORE_ROLLING_BACK`, `RESTORE_ROLLBACK_INTENT`, `RESTORE_ROLLED_BACK_ENTRY`, `RESTORE_ABORTED_TO_QUARANTINED`, and `RESTORE_ABORTED_TO_VALIDATED` schemas. Treat `O === G` by persisted role, phase, authorized path, and inode, never by digest multiplicity.

```js
export async function recoverRestore(input) {
  const options = snapshotRestoreRecoveryOptions(input);
  const restoreId = deriveRestoreId(options.transactionId);
  return withExistingQuarantineRun(pickExistingRunOptions(options), async (handoff) => {
    const replay = await replayJournal({ capability: handoff.capability, fsApi: handoff.fsApi });
    const ledger = buildRestoreLedger(replay.records); // original durable order
    return options.action === "resume"
      ? resumeRestore({ handoff, replay, ledger, restoreId, faultHook: options.faultHook })
      : rollbackRestore({ handoff, replay, ledger, restoreId, faultHook: options.faultHook });
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
git add scripts/quarantine-restore.mjs __tests__/fixtures/quarantine/quarantine-lifecycle-child.mjs __tests__/fixtures/quarantine/quarantine-test-harness.ts __tests__/scripts/quarantine-restore-crash.integration.test.ts __tests__/scripts/quarantine-restore.test.ts
git commit -m "feat: recover interrupted quarantine restores"
```

### Task 6: Close the compatibility facade

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

### Task 7: Expose the closed canonical npm CLI

**Files:**

- Create: `scripts/quarantine-numbered-copies.mjs`
- Create: `__tests__/scripts/quarantine-cli.test.ts`
- Modify: `package.json`
- Modify: `__tests__/scripts/quarantine-numbered-copies.test.ts` only for final CLI/facade contract coexistence

**Interfaces:**

- Consumes the exact facade exports from Task 6 and the closed operation option/result contracts from Tasks 1, 3, 4, and 5.
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
git diff --exit-code -- package-lock.json
```

Expected: PASS for each of the six npm command forms, exact JSONL/exit mapping, sanitized failures, STARTING-before-mutation, direct-node-only harness coverage, exact facade exports, and an unchanged `package-lock.json`.

- [ ] **Step 5: Review and commit the closed CLI.** Obtain CLI contract review, then run:

```bash
git diff --check
git add scripts/quarantine-numbered-copies.mjs package.json __tests__/scripts/quarantine-cli.test.ts __tests__/scripts/quarantine-numbered-copies.test.ts
git commit -m "feat: expose quarantine cleanup CLI"
```

### Task 8: Run the aggregate verification gate

**Files:**

- Verify only all Task 1-7 files and their committed changes.
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
EVIDENCE_DIR="$(git rev-parse --git-path quarantine-lifecycle-evidence)"
IMPLEMENTATION_BASE="$(cat "$EVIDENCE_DIR/implementation-base")"
npm test -- --runInBand --no-cache
npm run lint -- --max-warnings=0
npm run typecheck
npm run build
git diff --check "$IMPLEMENTATION_BASE"..HEAD
```

Expected: all commands exit 0; lint reports zero warnings; build succeeds without modifying the plan's scope.

- [ ] **Step 3: Regenerate after-evidence and prove no-touch/no-deletion invariants.** Set `EVIDENCE_SUFFIX=after`, rerun the exact executable Node script from Execution preflight (same imports, raw-buffer NUL/path validation, `lstatSync`, one-open `readSync` hashing with post-read identity/size checks, symlink `readlinkSync` hashing, sorted base64-path JSONL, and mode-0600 write) against the same `ORIGINAL_CHECKOUT`, producing `untracked-paths.after` and `untracked-meta.after` under the same 0700 `EVIDENCE_DIR`. Use disposable fixtures for all mutations. Then run:

```bash
EVIDENCE_DIR="$(git rev-parse --git-path quarantine-lifecycle-evidence)"
ORIGINAL_CHECKOUT="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
IMPLEMENTATION_BASE="$(cat "$EVIDENCE_DIR/implementation-base")"
export EVIDENCE_DIR ORIGINAL_CHECKOUT IMPLEMENTATION_BASE
test "$(stat -f '%Lp' "$EVIDENCE_DIR")" = 700
test -f "$EVIDENCE_DIR/implementation-base" && test -f "$EVIDENCE_DIR/untracked-paths.before" && test -f "$EVIDENCE_DIR/untracked-meta.before"
test "$(stat -f '%Lp' "$EVIDENCE_DIR/implementation-base")" = 600
test "$(stat -f '%Lp' "$EVIDENCE_DIR/untracked-paths.before")" = 600
test "$(stat -f '%Lp' "$EVIDENCE_DIR/untracked-meta.before")" = 600
EVIDENCE_SUFFIX=after
export EVIDENCE_SUFFIX
git -C "$ORIGINAL_CHECKOUT" ls-files --others --exclude-standard -z > "$EVIDENCE_DIR/untracked-paths.after"
chmod 0600 "$EVIDENCE_DIR/untracked-paths.after"
node --input-type=module > /dev/null <<'NODE'
import { createHash } from "node:crypto";
import { chmodSync, closeSync, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, writeFileSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { resolve } from "node:path";

const root = process.env.ORIGINAL_CHECKOUT;
const evidenceDir = process.env.EVIDENCE_DIR;
const suffix = process.env.EVIDENCE_SUFFIX;
const pathsPath = resolve(evidenceDir, `untracked-paths.${suffix}`);
const metaPath = resolve(evidenceDir, `untracked-meta.${suffix}`);

function splitNul(buffer) {
  const paths = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) { if (index > start) paths.push(buffer.subarray(start, index)); start = index + 1; }
  }
  if (start !== buffer.length) throw new Error("unterminated path list");
  return paths;
}

function pathBuffer(rawPath) {
  if (rawPath.length === 0 || rawPath[0] === 0x2f) throw new Error("invalid path");
  let segmentStart = 0;
  for (let index = 0; index <= rawPath.length; index += 1) {
    if (index === rawPath.length || rawPath[index] === 0x2f) {
      if (rawPath.subarray(segmentStart, index).equals(Buffer.from(".."))) throw new Error("parent escape");
      segmentStart = index + 1;
    }
  }
  return Buffer.concat([Buffer.from(root), Buffer.from("/"), rawPath]);
}

function hashRegularFile(pathBufferValue, before) {
  const descriptor = openSync(pathBufferValue, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.mode !== before.mode) throw new Error("identity changed");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, offset);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(descriptor);
    const relisted = lstatSync(pathBufferValue);
    if (after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode || after.size !== before.size || relisted.dev !== before.dev || relisted.ino !== before.ino || relisted.mode !== before.mode || relisted.size !== before.size) throw new Error("identity changed");
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

async function main() {
  const rawPaths = splitNul(readFileSync(pathsPath));
  const rows = [];
  for (const rawPath of rawPaths) {
    const absolute = pathBuffer(rawPath);
    const stat = lstatSync(absolute);
    let type = "other";
    let hash = null;
    if (stat.isFile()) {
      type = "file";
      hash = hashRegularFile(absolute, stat);
    } else if (stat.isSymbolicLink()) {
      type = "symlink";
      const linkBytes = readlinkSync(absolute, { encoding: "buffer" });
      hash = createHash("sha256").update(linkBytes).digest("hex");
      const relisted = lstatSync(absolute);
      if (relisted.dev !== stat.dev || relisted.ino !== stat.ino || relisted.mode !== stat.mode) throw new Error("identity changed");
    } else if (stat.isDirectory()) {
      type = "directory";
    }
    rows.push(JSON.stringify({
      path: rawPath.toString("base64"),
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      size: stat.size,
      type,
      hash,
    }));
  }
  rows.sort((left, right) => Buffer.from(JSON.parse(left).path, "base64").compare(Buffer.from(JSON.parse(right).path, "base64")));
  writeFileSync(metaPath, rows.length === 0 ? "" : `${rows.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(metaPath, 0o600);
}

try {
  await main();
} catch {
  process.exitCode = 1;
}
NODE
chmod 0600 "$EVIDENCE_DIR/untracked-meta.after"
cmp -s "$EVIDENCE_DIR/untracked-paths.before" "$EVIDENCE_DIR/untracked-paths.after"
cmp -s "$EVIDENCE_DIR/untracked-meta.before" "$EVIDENCE_DIR/untracked-meta.after"
git diff --name-only "$IMPLEMENTATION_BASE"..HEAD
git diff --check "$IMPLEMENTATION_BASE"..HEAD
git diff --exit-code "$IMPLEMENTATION_BASE"..HEAD -- package-lock.json
rg -n "deleteAfter|setTimeout|setInterval|cron|rm\(|unlink\(|rmdir\(" scripts __tests__/scripts
```

Expected: both `cmp -s` commands pass; the implementation base is read only from `implementation-base`; the name-only diff contains Task 1-7 implementation/test changes plus any review-fix commits and no fixed commit count; user paths remain byte/inode-identical. Treat deletion matches as review evidence only: manually trace each match to a capability-owned explicit terminal/recovery cleanup operation, and prove no retention auto-delete or scheduler exists.

- [ ] **Step 4: Obtain independent specification and code-quality reviews.** Review each task at its commit boundary, then review the complete branch against both `docs/superpowers/specs/2026-08-04-quarantine-lifecycle-continuation-design.md` and `docs/superpowers/specs/2026-07-14-foundation-cleanup-design.md` section by section. Require Critical 0 / Important 0 / Minor 0. Re-run the focused and full gates after every correction; produce evidence only and create no plan/code commit in this aggregate task.
