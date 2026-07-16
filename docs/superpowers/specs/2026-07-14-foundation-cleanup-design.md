# Foundation Cleanup Design

## Goal

Restore a trustworthy local checkout without losing any numbered-copy content,
make the documented manual backup path reuse the hardened backup coordinator,
and close the remaining real-Docker interruption assurance gap before starting
extension, API, or database work.

## Scope and sequencing

This is the first subproject in the approved sequence:

1. foundation cleanup;
2. extension stabilization;
3. Application API validation;
4. database deduplication and migration.

This subproject does not modify extension behavior, Application API behavior,
the Prisma schema, production data, authentication, CORS, or sessions.

## Verified starting state

The design targets `main` at merge commit `78c403f`.

- The checkout contains 65 non-ignored numbered copies. Sixty-one are
  byte-identical to their canonical files and four are divergent.
- The divergent copies are older or superseded in shape, but they are treated
  as unpublished user material until final deletion is explicitly confirmed.
- The ignored generated trees are also polluted: `node_modules` contains
  numbered files and directories, and `.next` contains numbered files and
  directories. The canonical `package.json` and lockfile are unchanged.
- The automated backup coordinator already writes PostgreSQL credentials to a
  mode-`0600` service file and invokes `pg_dump` through a service name.
- The manual production runbook still passes the complete database URL as a
  `pg_dump` argument and must be routed through the existing coordinator.
- Direct-child and fake-Docker signal cleanup tests exist. The remaining gap is
  proof that a real Linux Docker container has no surviving `pg_dump` process
  or temporary control files after interruption.

## Chosen approach

Use a same-filesystem atomic-move quarantine backed by a durable append-only
journal, followed by clean regeneration and test-first operations hardening.
This replaces the earlier copy-verify-remove design. Atomic `rename` preserves
the original inode and avoids copying roughly 894 MB of generated content, while
the journal makes every interrupted transition observable and recoverable.

The tool has two non-negotiable operating gates:

1. all development servers, builds, package installs, editors or other processes
   that can write `node_modules`, `.next`, or numbered-copy paths are stopped;
2. the repository and external quarantine root are on the same filesystem
   device according to `lstat().dev`.

The operator explicitly attests writer quiescence separately on `apply`,
`mark-validated`, recovery, and restore. `inspect` is advisory and read-only, so
it accepts no writer-stopped attestation. During each attested command, no other
apply, validation, recovery, or restore and no repository, quarantine, journal,
or lock writer may run. Clean regeneration is intentionally performed between
apply and validation and may create `node_modules` and `.next`; writers must be
stopped again before `mark-validated`. Stable preflight passes can detect some
concurrent changes but cannot make an open writer safe.
A device mismatch or `EXDEV` is fatal; there is no
copy fallback. A future cross-device workflow requires a separately reviewed
durable streaming-copy design.

### Quarantine layout

Create one external directory per cleanup run:

```text
~/Library/Application Support/easy-job-application-tracker/quarantine/
  current
  <transaction-id>/
    journal.log
    manifests/
      <manifest-sha256>.json
    inventories/
      pre/<entry-id>.jsonl
      moved-pass-1/<entry-id>.jsonl
      moved-pass-2/<entry-id>.jsonl
      restore-active/<generated-entry-id>.jsonl
      validation-pass-1/<generated-entry-id>.jsonl
      validation-pass-2/<generated-entry-id>.jsonl
      work/
    divergent-diffs/
    payload/
      source-copies/<entry-id>
      generated/node_modules/
      generated/.next/
    rollback/
      regenerated-before-restore/<restore-id>/
    conflicts/
```

Fixed-layout bootstrap creates exactly the run root and these directories, one
path component at a time:

```text
manifests
inventories
inventories/pre
inventories/moved-pass-1
inventories/moved-pass-2
inventories/restore-active
inventories/validation-pass-1
inventories/validation-pass-2
inventories/work
payload
payload/source-copies
payload/generated
rollback
rollback/regenerated-before-restore
conflicts
divergent-diffs
```

Bootstrap does not create `current`, `journal.log`, manifest generations,
inventory or diff files, payload entry roots, generated payload roots, or a
restore-ID directory. Those artifacts belong to later durable phases.

`<restore-id>` everywhere in this design means exactly
`restore-<lowercase-v4-shaped-uuid>`; a bare UUID is never a restore ID.

The quarantine root, run directory, and every derived quarantine subdirectory
must be non-symlink directories with mode `0700`. The canonical `current`
pointer, journal, immutable manifest generation, inventory, and diff files must
have mode `0600`. Quarantine payload paths are
derived only from a live run capability, a closed purpose enum, validated entry
IDs, and the fixed generated-root allowlist; untrusted manifest or journal path
strings never become filesystem destinations. No quarantined content lives
under the repository, so Git, Jest, ESLint, and Next.js cannot rediscover it.

### Run capability and writer boundary

Every quarantine writer operates inside a callback-scoped opaque run
capability. The only creator accepts a validated quarantine root, validated
transaction ID, and `writersStopped === true`; it does not expose a
constructible or serializable capability value. Before invoking the callback it
uses `lstat` and `realpath` to prove that the quarantine root and derived run
root are non-symlink directories, are mode `0700`, are contained under the
approved real quarantine root, and records each directory's device and inode.
It also proves that the repository and quarantine root are on the same device.
The capability becomes inactive before callback settlement cleanup, whether the
callback succeeds or throws. A leaked capability and any caller-created
lookalike are rejected.

The capability also owns one normalized filesystem view for its complete
lifetime. A private `quarantine-run-fs-context.mjs` registry binds the opaque
capability through a `WeakMap` to one frozen adapter whose method
implementations and receiver are captured exactly once during capability
creation. Journal, manifest, and capability-bound inventory writers obtain
their actual filesystem operations only from that binding. Their existing
optional `fsApi` fields remain accepted solely as source-identity assertions:
when present, the object must be the exact source object supplied when the
capability was created, and an equal-looking or writer-local adapter is rejected
before mutation. Omitting the field selects the bound adapter. Replacing a
source object's methods after capability creation cannot change the captured
view. The binding is invalidated before callback settlement on both success and
failure and is never re-exported by the compatibility facade. This internal
registry adds no export to the run-capability, journal, manifest, or inventory
public modules; their current exact export sets remain unchanged.

Journal, inventory, manifest, payload, rollback, conflict, and temporary-file
writers accept this capability rather than caller-supplied destination paths.
They derive every path from the capability, a closed purpose enum, and validated
transaction, entry, restore, or digest IDs. Immediately before the first
filesystem mutation and immediately after its last durability sync, each writer
revalidates `lstat`/`realpath` containment and the recorded root/run device and
inode. Writers that have multiple externally visible mutation phases repeat the
identity check at every phase boundary. Each derived journal, inventory,
manifest, payload, rollback, and conflict parent is separately `lstat`ed as a
mode-`0700` non-symlink directory and realpath-checked for containment before
use and after sync. A root/run replacement, parent symlink swap, containment
change, or device/inode mismatch aborts without following the replacement and
preserves all evidence needed for explicit recovery.

This is a cooperative safety boundary under the truthful writer-quiescence
attestation. The design detects identity changes at defined seams; it does not
claim atomic protection from a hostile process replacing a pathname between a
check and a Node filesystem call. Apply, mark-validation and manifest
activation, restore, recovery, and terminal cleanup therefore all require
`writersStopped === true`.

### Immutable manifest generations

Manifest publication is split into five APIs with separate responsibilities:

- `buildValidatedManifest` is pure and returns the exact closed-schema manifest
  value;
- `writeManifestGeneration` canonicalizes it, hashes the exact bytes, and
  durably creates `<run>/manifests/<sha256>.json` without overwriting an existing
  generation;
- `activateManifestGeneration` atomically publishes the one canonical pointer;
- `readCurrentManifestPointer` validates and returns only the pointer; and
- `readManifestGeneration` derives the generation path from the validated
  digest, verifies filename and content-digest agreement, and validates the
  closed manifest schema.

The root-level `current` file contains exactly
`{ schemaVersion, transactionId, manifestSha256 }` in canonical JSON. Its
transaction ID selects the validated run directory and its lowercase
64-character digest selects the immutable generation. The combined
write-and-activate protocol writes and syncs the generation temporary file,
publishes its digest name with a deterministic same-filesystem hard link that
never replaces an existing generation, and syncs the generation directory.
Activation then appends and syncs the journal event that makes that generation
eligible, writes and syncs a pointer temporary file, renames that pointer over
`current`, and syncs the quarantine root. Readers therefore resolve either the
previous complete generation or the new complete generation, never a partially
published manifest. Prior generations remain readable audit evidence.

Publication success additionally requires target identity after the last
parent-directory sync. A newly linked generation must still be the temporary
file's recorded device/inode and exact mode `0600`; an adopted existing
generation must still match the identity and exact mode captured by its bounded
read. Activation retains the generation identity across its directory sync and
revalidates it before appending `VALIDATED`. After pointer rename and quarantine
root sync, `current` must still have the pointer temporary's recorded
device/inode and exact mode `0600` before activation returns. An identity or
mode mismatch fails closed and preserves the available generation, pointer, and
temporary evidence. In particular, once generation hard-link publication has
begun, a post-link or post-sync generation identity/mode failure must not delete
the owned generation temporary; it remains evidence for explicit reconciliation.

An existing generation at the requested digest is accepted only when its exact
canonical bytes are identical; the same digest name with different bytes is a
fatal integrity error. `VALIDATED` has exactly
`{ manifestSha256: <lowercase SHA-256> }` as its payload, and the digest must
name the already durable generation. No API writes `manifest.json`,
`manifest.sha256`, a run-local current file, or an ID-only pointer.

Each immutable manifest generation records:

- repository root and exact HEAD commit;
- transaction ID, creation and validation timestamps in UTC;
- each validated original relative path, entry ID, and fixed payload kind;
- canonical relative path when one exists;
- byte length and SHA-256 of both copy and canonical file for source copies;
- classification as `identical` or `divergent`;
- Git-history match when verified;
- file mode;
- per-entry inventory digest, entry count, and byte count rather than embedded
  directory entries;
- retention deadline and deletion status.

The manifest entry schema is fixed before transaction orchestration is added.
`quarantine-path-policy.mjs` validates only the filesystem locator
`{ id, kind, relativePath, canonicalRelativePath? }`.
`quarantine-inventory.mjs` validates the reusable closed summary
`{ sha256, entries, bytes }`. `quarantine-manifest.mjs` composes those two
boundaries into this exact discriminated union:

```ts
type InventorySummary = {
  sha256: string;
  entries: number;
  bytes: number;
};

type SourceCopyManifestEntry = {
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
};

type GeneratedRootManifestEntry =
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

type ManifestEntry =
  | SourceCopyManifestEntry
  | GeneratedRootManifestEntry;
```

Every object above has an exact key set. Hashes are lowercase 64-character
SHA-256 values; `historyMatch` is null or the lowercase 40/64-character
candidate commit OID whose historical regular blob matched, never a blob OID;
modes are safe integers from `0` through `0o7777`; sizes, entry
counts, and byte counts are non-negative safe integers. A source-copy summary
has exactly one entry and its byte count equals `size`. `identical` requires
equal source/canonical sizes and hashes, while `divergent` requires unequal
hashes. Entry IDs and relative paths are unique. Source copies are assigned
`copy-0001`, `copy-0002`, and so on in bytewise relative-path order; generated
entries use exactly `generated-next` and `generated-node-modules`. The complete
manifest entry array is bytewise sorted by relative path and contains each
generated root exactly once. The expected numbered-copy count remains an
invocation precondition enforced by transaction orchestration.

Inventory JSONL paths are always derived as
`inventories/pre/<validated-entry-id>.jsonl`. Neither a manifest entry nor a
journal payload may store an inventory path, payload destination, rollback
destination, or other free-form filesystem target. The transaction layer may
construct runtime entry plans and journal references, but those objects refer
back to the manifest entry ID and summary; they do not replace or duplicate the
authoritative enriched manifest entry.

Directory inventories exclude the directory root and record only exact
`{ scope: "relative", path, ...typeMetadata }` descendants. Relative paths are
NFC POSIX paths; empty, absolute, backslash, NUL, duplicate-separator, `.`, and
`..` components are rejected. A regular-file inventory root emits exactly one
`{ scope: "root", type: "file", mode, size, sha256 }` record with no `path`, so
equal bytes and mode produce identical JSONL and summary bytes under different
basenames. A symlink inventory root is always rejected. Inventory consumers
branch on `scope` before resolving a relative path.

Unified diffs and verified Git-history matches for all four divergent files are
stored in `divergent-diffs/`. No divergent content is automatically merged into
canonical files.

Manifest, journal, inventory, and CLI inputs use closed schemas: unknown keys,
absolute paths, empty or `.`/`..` components, NUL bytes, non-normalized Unicode
or path encodings, and paths outside the repository are rejected. The only
generated roots are exactly `node_modules` and `.next`; every source-copy path
must match the numbered-copy suffix rule and its stored canonical path must equal
the value derived from that rule. Repository and generated-root symlinks are
rejected. Inner symlinks are inventoried as leaf entries and are never followed.
Every resolved path passes a resolve-under-root guard before any read, rename,
restore, or deletion operation.

### Quarantine transaction and durable journal

The journal is the authoritative transaction record. It is a mode-`0600`,
append-only sequence of length-framed canonical JSON records. Every record has a
monotonic sequence, previous-record hash, payload, and record hash. Each append
is flushed and `fsync`ed before the corresponding destructive transition; new
files and rename operations also `fsync` their containing directories. General
replay recognizes a torn final frame but never treats it as a complete event.
Inside a live run capability, the ordinary appender creates a mode-`0600` lock
with `wx`, keeps its handle open, writes the exact length-framed canonical
metadata `{ version: 1, ownerToken, pid, checksum }`, and `fsync`s both lock and
parent directory. `EEXIST` always fails; normal append never reclaims by TTL or
PID liveness. It then invokes the caller under an opaque held-lock capability
that is valid only for the callback lifetime. While holding that capability,
append replays through the same journal handle, truncates only a recognized
torn final frame to the last valid offset, and `fsync`s the file and parent
directory before appending. Sequential awaited callback appends are allowed;
forged or leaked held-lock capabilities are rejected.

Every journal, live lock, stale lock, and tombstone read or recovery path
requires a non-symlink regular file with exact mode `0600`, including rejection
of special permission bits. New journal and lock files are explicitly changed
to and verified at mode `0600` through both the open handle and pathname before
use. For append, capability `after-sync` revalidation and journal/held-lock
identity and mode checks occur only after the journal's final parent-directory
sync; a torn-tail truncation is likewise revalidated after its file and parent
sync before the next mutation. Stale-lock rename and each terminal or recovery
artifact removal are separate mutation phases with capability revalidation
before mutation and after the resulting parent sync. A phase mismatch preserves
the journal and all artifacts that cannot still be proven owned.

All public journal option records are snapshotted before their first await as
exact closed plain objects. Unknown string or symbol keys and missing required
own keys are rejected, and every accepted property getter is evaluated exactly
once. The snapshot rule applies without changing the existing journal export
set or allowing a per-call filesystem view.

Ordinary append and stale-lock recovery use the same ownership and uncertainty
rules. Both compare the open lock handle's device/inode with a non-symlink
regular-file `lstat` immediately before journal truncate/write, immediately
after journal sync, and immediately before lock cleanup. A mismatch before the
first journal mutation is an ordinary ownership error with unchanged journal
bytes. Once truncate or frame write begins, every later append or ownership
error is `IndeterminateJournalAppendError` carrying the candidate's
`expectedSequence` and `expectedRecordHash`. The candidate may be present zero
or one time; only explicit attested recovery may determine which and make it
present exactly once. Cleanup removes a lock only when the same owned
device/inode is still at the path. A foreign replacement is never deleted, and
the original lock, foreign lock, tombstones, journal, and candidate metadata are
preserved as applicable for recovery.

Stale-lock recovery is a separate `reclaimJournalLock` operation that requires
`writersStopped === true`; false attestation fails before journal, lock, or
tombstone mutation. It rejects and preserves symlink, non-regular,
oversized, and malformed complete locks. Only valid checksummed metadata or a
recognizable creation-torn frame is reclaimable. Creation-torn means zero bytes
or a strict byte prefix of the exact frame: partial length bytes must prefix an
admissible PID-dependent body length, and any partial body must be a possible
canonical ASCII object and deterministic-checksum prefix. Random bytes,
impossible lengths, invalid UTF-8, and invalid canonical prefixes remain fatal
and unchanged. Recovery atomically renames the old lock to a unique tombstone,
`fsync`s the parent, durably creates a new `wx` lock, and invokes recovery with
an append function under that held lock. The capability is active only while
that callback runs and becomes inactive on both successful and failed callback
exit, before cleanup. Each append compares the held lock handle's device/inode
with a non-symlink regular-file `lstat` of the current lock path. This is
cooperative serialization and intrusion detection under the attestation, not
an atomic defense against hostile concurrent pathname replacement: built-in
Node cannot atomically couple that path check to a separate journal write.

Recovery applies the shared pre/post-mutation ownership and indeterminate rules
above. The caller stops before any destructive seam, preserves the current lock
and tombstones, and never blindly retries the same event. The next explicit
attested recovery replays the journal, accepts the candidate zero or one time,
appends it only if absent, or advances with the next legal event if present.
Partial and complete-frame `SIGKILL` cases must finish with that candidate
exactly once. If held-lock close also fails, the original indeterminate error
retains its code and candidate identity while the close error is attached as
supplemental `AggregateError` cause metadata. Without a primary recovery error,
the close error is surfaced directly. Cleanup does not remove the lock or
tombstones in either close-failure case.

On success, recovery revalidates and removes the current lock and all
prior well-formed tombstone residues, then `fsync`s the parent. Malformed names,
malformed frames, symlinks, and non-regular tombstones are preserved and fatal
before recovery mutation.

Task 2 closes one orchestration-only recovery seam without weakening this
ownership boundary. Under `writersStopped === true`, recovery may remove an
owned stale lock/tombstone without appending only when it holds a fresh lock,
replays the same complete non-torn journal tip twice, and the callback returns
exactly:

```text
{
  settleDurableTip: {
    sequence,
    recordHash,
    event,
    state
  }
}
```

All four values must equal the replayed tip and resulting state. The only
allowed `(event, state)` pairs are:

```text
(QUARANTINED, QUARANTINED)
(VALIDATED, VALIDATED)
(RESTORE_ABORTED_TO_QUARANTINED, QUARANTINED)
(RESTORE_ABORTED_TO_VALIDATED, VALIDATED)
```

`ROLLED_BACK`, `RESTORED`, and `INCOMPLETE_CONFLICT` are deliberately absent:
they use only the existing terminal cleanup-only path and have no settlement
variant. Unknown fields, a pair outside the four-pair allowlist, changed
sequence/hash/event/state, a torn or changed tip, missing or foreign stale-lock/
tombstone ownership evidence, or a zero-append callback without this exact
result preserves every artifact and fails. This protocol makes no claim about
an unrecorded candidate's identity and is never authorization to clean an
arbitrary nonterminal journal.

Terminal stale artifacts use a separate cleanup-only API; recovery append is
not reused. The API accepts only a fully replayed journal whose last durable
state is exactly `ROLLED_BACK`, `RESTORED`, or `INCOMPLETE_CONFLICT`, requires
`writersStopped === true`, validates the complete non-torn journal tail and
every stale lock/tombstone artifact, and records the journal tip sequence and
hash. Only after all preconditions pass, it atomically renames the validated
stale lock to a derived tombstone, syncs the parent, and acquires a fresh held
lock through the same run and lock capability boundaries. It replays the
journal again and requires the identical tip before removing only the validated
stale artifacts and its owned lock. It appends no event, never truncates the
journal, leaves journal bytes unchanged, and `fsync`s the journal directory
after cleanup. A missing/false attestation, nonterminal state, recognized torn
tail, changed tip, malformed artifact, symlink, non-regular artifact, or
identity mismatch fails before any journal, lock, or tombstone mutation.
`VALIDATED` is deliberately not an eligible cleanup-only state because its
payload may still be restored.

A current PID with a different owner token is treated as possible PID reuse:
ordinary append still fails and only explicit attested recovery may proceed.
Tests use actual child-process `SIGKILL` after `wx` and after metadata `fsync`;
exception injection remains supplementary replay evidence, not crash proof.
Any malformed non-final frame, sequence
gap, hash-chain break, unknown field, or illegal state transition is fatal.
The envelope schema and event payload schema are separate closed boundaries.
Every event in the transition table has an exact payload parser on both append
and replay. Lifecycle-only events other than `VALIDATED` and
`RESTORE_PREPARED` accept exactly `{}`;
`PREPARED` accepts only the validated transaction ID and initial manifest
SHA-256, while `VALIDATED` accepts exactly `{ manifestSha256 }` naming its
durable immutable generation; `MOVE_INTENT` accepts only
the entry ID and expected `InventorySummary`; `MOVED` accepts only the entry ID
and observed `InventorySummary`. Entry-oriented rollback and restore events
accept only their validated entry ID plus any inventory summary explicitly
required by their documented transition. `RECOVERY_REQUIRED` accepts exactly
`{ entryIds: string[] }`, and `INCOMPLETE_CONFLICT` accepts exactly
`{ conflictEntryIds: string[] }`. A recovery-required array is dense, contains
unique validated entry IDs, has at most 4,096 elements, and equals every durable
`MOVE_INTENT` or `RESTORE_INTENT` ID in its original forward journal order. It
is empty if and only if that apply or restore context has zero durable intents;
completed entry events never remove IDs from this array. It has no independent
bytewise-sort rule: forward journal order wins even when it is non-bytewise. A
conflict array is always non-empty, bytewise sorted, unique, and limited to
4,096 validated entry IDs. Task 2 may extend an event payload
only after adding a failing exact-schema test and updating this contract;
arbitrary plain canonical JSON is never an accepted journal payload.

The restore ID type is closed and has one grammar:

```text
RestoreId = "restore-" + LowercaseV4ShapedUuid
LowercaseV4ShapedUuid =
  [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}
```

The deterministic derivation validates the NFC transaction ID, hashes the UTF-8
bytes of `"easy-job-application-tracker\0restore-id\0" + transactionId` with
SHA-256, takes the first 16 digest bytes, sets byte 6 to
`(byte & 0x0f) | 0x40` and byte 8 to `(byte & 0x3f) | 0x80`, formats those bytes
as a lowercase UUID, and prepends `restore-`. The fixed vector is:

```text
transactionId: tx-0001
restoreId: restore-c3624475-87d7-4886-b0bf-68a5061663d2
```

No public result, event, capability request, rollback path, or fsync option
accepts a bare UUID or another restore-ID grammar.

`RESTORE_PREPARED` accepts exactly
`{ restoreId, activeGenerated }`. `restoreId` is the deterministic validated
`RestoreId` derived from the transaction by the algorithm above.
`activeGenerated` is a dense array of
exactly these two records in this bytewise-sorted order:

```text
{ id: "generated-next", inventory: InventorySummary|null }
{ id: "generated-node-modules", inventory: InventorySummary|null }
```

A non-null summary names the already durable matching `restore-active`
inventory for an existing active root. For an absent active root, no inventory
JSONL is created: its absence is independently attested immediately before
`RESTORE_PREPARED`, and the event's exact null is the first durable
representation of that absence. Both fixed IDs remain present in the dense
array in the bytewise-sorted order above regardless of presence. Unknown fields,
another order/ID, null for a present root, non-null for an absent root, an
absent inventory for a non-null summary, or an inventory mismatch fails before
`RESTORE_PREPARED` is appended.

Restore preparation writes and `fsync`s `restore-active` inventory JSONL only
for generated roots that exist, captures those immutable summaries, then
performs a fresh independent absence check for every null entry immediately
before appending `RESTORE_PREPARED`. It appends the event only after assembling
the complete fixed two-record `activeGenerated` array. No inventory may be
created or replaced after that event to satisfy its payload.

The durable lifecycle is:

```text
PREPARED -> MOVING -> VERIFYING -> QUARANTINED -> VALIDATED
                 \-> RECOVERY_REQUIRED -> ROLLING_BACK -> ROLLED_BACK
                 \-> INCOMPLETE_CONFLICT
PREPARED -> RECOVERY_REQUIRED([]) -> MOVING|ROLLING_BACK
MOVING(no MOVE_INTENT) -> RECOVERY_REQUIRED([]) -> MOVING|ROLLING_BACK
MOVING|VERIFYING(with MOVE_INTENT) -> RECOVERY_REQUIRED([all intents forward])
QUARANTINED|VALIDATED -> RESTORE_PREPARED -> RESTORING -> RESTORED
                                             \-> RECOVERY_REQUIRED
RESTORE_PREPARED -> RECOVERY_REQUIRED([])
RESTORING(no RESTORE_INTENT) -> RECOVERY_REQUIRED([])
RESTORING(with RESTORE_INTENT) -> RECOVERY_REQUIRED([all intents forward])
RECOVERY_REQUIRED(apply context) -> MOVING|ROLLING_BACK
RECOVERY_REQUIRED(restore context) -> RESTORING|RESTORE_ROLLING_BACK
RESTORE_ROLLING_BACK -> RESTORE_ABORTED_TO_QUARANTINED -> QUARANTINED
                     \-> RESTORE_ABORTED_TO_VALIDATED -> VALIDATED
                     \-> INCOMPLETE_CONFLICT
```

`RESTORE_ROLLING_BACK`, `RESTORE_ABORTED_TO_QUARANTINED`, and
`RESTORE_ABORTED_TO_VALIDATED` accept exactly `{}`.
`RESTORE_ROLLBACK_INTENT` and `RESTORE_ROLLED_BACK_ENTRY` accept exactly
`{ id: <validated-entry-id> }` and keep the state at
`RESTORE_ROLLING_BACK`. The transaction layer derives the correct abort event
from the durable state immediately preceding `RESTORE_PREPARED`; it rejects an
abort event that does not return to that state. The existing
`RESTORING`, `RESTORE_INTENT`, and `RESTORED_ENTRY` payload schemas remain
unchanged. One `RESTORE_INTENT` covers the generated entry's
active-tree archival move followed by its original-payload restore move, whose
filesystem locations make either partial state unambiguous during replay.

The transition validator therefore accepts `RECOVERY_REQUIRED` directly from
`PREPARED`, `MOVING`, `VERIFYING`, `RESTORE_PREPARED`, and `RESTORING`. An empty
array is legal only at the two no-intent apply states or the two no-intent
restore states. Apply rollback then enters `ROLLING_BACK` and may append
`ROLLED_BACK` without entry events. Restore rollback enters
`RESTORE_ROLLING_BACK` and may append the abort event matching the state
immediately before `RESTORE_PREPARED`, also without entry events. After the
first durable relevant intent, semantic replay requires the exact complete
intent ledger in original forward journal order, including IDs whose `MOVED` or
`RESTORED_ENTRY` is already durable.

`RECOVERY_REQUIRED.entryIds` is a ledger confirmation, not a resume-only work
queue. Resume uses the durable completion events plus the filesystem matrix to
reconcile only unfinished intents in forward journal order. Rollback uses the
authoritative complete durable intent ledger in reverse order, including
completed entries. If every intent was completed before the crash, the full
non-empty array still permits resume to advance through `VERIFYING` to
`QUARANTINED` or directly to `RESTORED`, and still permits complete reverse
rollback. The 4,096-intent ledger is recoverable; a 4,097th intent or recovery
ID is rejected before mutation.

`INCOMPLETE_CONFLICT` is terminal until an operator resolves the preserved
source and destination evidence. A new `apply` or `restore` is refused whenever
the current transaction has a nonterminal journal. Recovery is explicit through
`recover --resume` or `recover --rollback`; rollback is the safer documented
default.

Before moving anything, the tool:

1. requires the invocation-supplied repository root, expected branch, expected
   HEAD, expected numbered-copy count, and writer-quiescence attestation;
2. requires no tracked or staged changes and two complete stable discovery
   passes as defined below;
3. rejects symlink roots and verifies the external quarantine path is outside
   the repository, mode-restricted, and on the same device; a mutating prepare
   establishes writability with its first required layout `mkdir`;
4. streams deterministic pre-move inventories to JSONL, computes their SHA-256,
   entry count, and byte count, and records only those summaries in the manifest;
5. durably writes the initial immutable manifest generation, divergent diffs,
   initial inventories, run directory, and `PREPARED` journal record; it does
   not activate `current` until the matching validated generation is durable.

### Closed workspace discovery

`repoRoot` and `quarantineRoot` are absolute NFC paths without NUL. Git's
resolved top level must equal the resolved, non-symlink `repoRoot` exactly.
`expectedBranch` is a non-empty NFC string without NUL and must equal the
symbolic branch name returned by Git; detached `HEAD` is rejected even if the
caller supplies `"HEAD"`. `expectedHead` is exactly a lowercase 40- or
64-character hexadecimal object ID. `expectedCount` is a safe integer from
zero through 9,999 inclusive, matching the four-digit nonzero source-copy ID
space. Every value is snapshotted from the closed option object before the
first await.

Each discovery pass invokes Git with argument arrays. Every invocation inserts
the exact global arguments `-c core.fsmonitor=false` before the subcommand, so
the common argv prefix is always `git -c core.fsmonitor=false`. It resolves
identity with `rev-parse --show-toplevel`,
`symbolic-ref --quiet --short HEAD`, and `rev-parse --verify HEAD`, then invokes
exactly:

```text
git -c core.fsmonitor=false status --porcelain=v1 -z --untracked-files=all
```

Every read-only Git child receives one newly created null-prototype environment
record. It copies only non-empty string values for `PATH`, `TMPDIR`, `TMP`,
`TEMP`, `SystemRoot`, `ComSpec`, `PATHEXT`, `LANG`, `LC_ALL`, and `LC_CTYPE`
from one process-environment snapshot captured before the first await, omits
every other inherited variable, then sets exactly these Git-specific overrides:

```text
GIT_OPTIONAL_LOCKS=0
GIT_NO_LAZY_FETCH=1
GIT_LITERAL_PATHSPECS=1
```

No caller-supplied `GIT_*`, credential, proxy, SSH, pager, editor, or prompt
variable is inherited. `GIT_OPTIONAL_LOCKS=0` makes discovery observational,
`GIT_NO_LAZY_FETCH=1` forbids promisor-object network hydration, and
`GIT_LITERAL_PATHSPECS=1` makes the single post-`--` path argument literal.
Focused tests record every child's exact environment, compare the repository
index device/inode/mode/size/mtime/ctime before and after inspection, require no
`.git/index.lock` or other new lock residue, and use an unavailable promisor
object plus a remote-helper sentinel to prove that discovery performs no fetch,
remote-helper, or network access.

The fixture also configures a hostile `core.fsmonitor` hook or daemon command
that writes a sentinel and would omit a newly created untracked path if invoked.
Every discovery child must retain the global `-c core.fsmonitor=false` prefix;
the sentinel remains absent and the full porcelain result still contains that
fresh path. The exact read-only command set does not invoke repository hooks,
diff drivers, or textconv filters, so no broader hook-disabling mechanism is
added; the sanitized environment already omits pager, editor, and prompt
variables.

An empty status is represented by zero bytes. A non-empty status must end in a
NUL byte and contain no empty interior record. Every record is decoded with a
fatal UTF-8 decoder. Any record other than exact `?? <relative-path>` is a
tracked, staged, malformed, or unsupported rename/copy record and fails. Every
untracked record must be an approved numbered-copy path; discovery never
silently ignores unrelated untracked residue. Paths use the existing strict NFC
POSIX relative-path and numbered-copy suffix validators, and are sorted by
their UTF-8 bytes. Both the source and its derived canonical path must resolve
under the repository through non-symlink ancestors and must be regular,
non-symlink files. `.next` and `node_modules` must each be a non-symlink
directory; their inner symlinks remain leaf inventory entries in later phases.

Porcelain stdout has no aggregate byte cap: all 9,999 legal path records may
legitimately total more than 1 MiB. Instead, the incremental NUL parser caps
each in-progress or complete record, including its exact `?? ` prefix but not
its terminating NUL, at exactly 1,048,576 bytes. If byte 1,048,577 arrives
before a NUL, the runtime kills the status child, awaits close and all stream
settlement, and then fails with the fixed `ERR_PREFLIGHT` error. It retains no
more than `expectedCount` parsed paths while incrementally hashing all accepted
raw status bytes; a count overflow fails without building an unbounded path
array. This per-record limit is above legal filesystem path limits and bounds a
malicious unterminated frame without rejecting a valid aggregate status body.

A complete pass streams, rather than buffers, source and canonical file bodies
through SHA-256. It produces this private canonical byte frame, with each field
encoded as UTF-8 and terminated by one NUL byte; numeric fields use canonical
unsigned decimal and hashes use lowercase hexadecimal:

```text
workspace, resolved-repo-root, branch, head, sha256(raw-status-bytes)
source, relative-path, canonical-relative-path,
  source-dev, source-ino, source-mode, source-size, source-sha256,
  canonical-dev, canonical-ino, canonical-mode, canonical-size,
  canonical-sha256
generated, relative-path, dev, ino, mode
```

The `workspace` record is first. All `source` and `generated` records then share
one UTF-8 bytewise `relative-path` order. Record tags and the fixed field counts
make the NUL framing unambiguous. Device and inode values must be
non-negative safe integers; modes are masked to `0o7777`; sizes are
non-negative safe integers. A pass also rechecks the Git top level, symbolic
branch, `HEAD`, and porcelain bytes after hashing and fails unless they still
equal the values framed by that pass.

Inspection and apply each run two new full passes, including new Git commands,
`lstat`/`realpath` checks, and fresh streamed hashes. Success requires the two
canonical frame byte sequences to be exactly equal. Comparing only path names,
raw porcelain output, or previously cached metadata is insufficient. Apply
runs both passes only after validating `writersStopped === true` and does not
reuse an inspection result as authority.

For each divergent source, enumerate candidate historical commits with exactly
`git -c core.fsmonitor=false log --all --format=%H -z -- <canonical-relative-path>`.
Parse stdout as
fatal UTF-8, NUL-terminated lowercase 40/64-character object IDs while it is
streaming. Each OID body is at most 64 bytes and its required NUL makes its
maximum complete frame 65 bytes. Retain at most 4,096 IDs, so valid output is
arithmetically bounded by `4,096 * 65 = 266,240` bytes without a redundant
aggregate byte cap. A 65th body byte before NUL or a 4,097th frame kills the
child; every success or failure closes and awaits the child and all streams
before commits are checked sequentially or the fixed `ERR_PREFLIGHT` error is
thrown.

For each commit OID, run exactly
`git -c core.fsmonitor=false ls-tree -z --full-tree <commitOid> -- <canonical-relative-path>`,
passing
the safe canonical path as one literal argument even when it contains a newline.
Stdout is capped at 1 MiB and parsed as raw NUL-framed bytes. Exit zero plus
empty stdout means absent and is skipped. Otherwise stdout must contain exactly
one NUL-terminated record of exact Git form
`<mode> SP <type> SP <lowerhexBlobOid> TAB <path> NUL`; fatal UTF-8 decoding is
applied only to the control fields and path, the returned path must equal the
canonical relative path byte-for-byte, and the OID must be lowercase 40/64-hex.
Only the exact pairs `100644 blob` and `100755 blob` are body-eligible. The only
well-formed nonregular pairs that skip without reading an object body are
exactly `040000 tree`, `120000 blob`, and `160000 commit`. Every other
mode/type pair, mode width/value, or object type is fatal, including a regular
mode paired with a non-blob type. Multiple records, malformed fields, a
mismatched path or OID, missing final NUL, oversized output, signal, or nonzero
exit is also fatal.

For an eligible blob, spawn exactly
`git -c core.fsmonitor=false cat-file blob <lowerhexBlobOid>` using the validated
blob OID only; no `commit:path` expression is passed to a body-reading command.
Stream stdout directly through a SHA-256 accumulator with a 64 KiB read
high-water mark and no whole-body or total-body buffer. Every Git child's stderr
is capped at 64 KiB and never returned. On a stream, decoder, limit, signal, or
child-process error, close or kill the child as appropriate and await
stdin/stdout/stderr/process settlement before throwing the fixed sanitized
preflight error.

When a blob hash matches, `historyMatch` is exactly the lowercase 40/64-hex
candidate commit OID emitted by `git log`, never the blob OID. The blob OID is an
ephemeral streaming locator only: it is not returned, persisted, added to a
manifest or runtime entry, or exposed by an error or hook. The first matching
eligible candidate commit in Git's emitted order wins; no match is `null`.

### FD-bounded inventory and durability traversal

Inventory and `fsyncTree` use iterative traversal; recursive function calls and
one-open-directory-per-depth algorithms are forbidden. The walker keeps no
more than one directory handle open at a time: it reads one directory, closes
that handle, stores only its bounded frontier records, and then advances. A
regular-file hash may add one input stream, so inventory traversal has at most
two simultaneous traversal/hash handles. Symlinks are emitted as leaf metadata
and are never opened or followed.

Deterministic bytewise order is produced with bounded sorted chunks and a
k-way merge rather than retaining the whole tree. Each in-memory sorted chunk
is flushed at 4,096 records or 8 MiB of encoded record data, whichever comes
first. The in-memory traversal frontier is limited to 1,024 records or 8 MiB of
encoded path data, whichever comes first; overflow uses a capability-derived,
mode-`0600`, disk-backed work file. Merge fan-in is at most 32 open readers, and
multi-pass merge applies the same limit. The JSONL writer and summary hash
consume the final merged stream once. A regular-file root hashes with
`createReadStream`. No payload body or complete generated-tree inventory is
loaded into memory, and the manifest never embeds the tens of thousands of
generated entries. Equal trees always produce the same JSONL bytes, digest,
entry count, and byte count regardless of traversal timing.

`fsyncTree` uses the same iterative, no-follow walker, the same frontier limits
and disk spill, and durable post-order:
sync each regular file, then each child directory after all its descendants,
and finally the moved payload root. It opens and closes each directory at the
point of sync, so its simultaneous directory-handle bound is also one. The
destination parent and then source parent are synced only after the payload
post-order completes.

For each source copy and each complete generated root, the tool:

1. appends and `fsync`s a `MOVE_INTENT` containing the validated entry ID and
   expected source inventory summary;
2. rechecks source identity and the absence of the derived destination;
3. atomically renames the source inode to the derived quarantine destination;
4. iteratively `fsync`s the moved payload in the bounded post-order above, then
   the destination parent, then the source parent; persisting the destination
   name before the source-name removal ensures a crash can produce the old name
   or both names, but not a deliberate neither-name durability window;
5. streams and verifies the destination inventory;
6. appends and `fsync`s `MOVED` with the observed summary.

After all moves, two independent streaming destination-inventory passes must
match the pre-move summaries. All original sources must remain absent and no
unexpected numbered-path residue may exist. Only then does the transaction
append `QUARANTINED`. The initial `PREPARED` generation already contains the
authoritative entries and pre-move summaries, so Task 2 does not publish a
byte-identical intermediate generation. After clean regeneration, validation
builds and durably publishes the `VALIDATED` generation, appends `VALIDATED`
with that exact digest, and atomically activates the canonical root-level
`current` pointer.
Selective cleanup within `node_modules` or `.next` is forbidden.

Crash replay reconciles every durable move intent against filesystem reality:

- source present, destination absent: the move did not occur;
- source absent, destination present: verify and fsync the moved payload, then
  durably record the completed move;
- source and destination both present: preserve both as concurrent recreation,
  mark a conflict, and roll back only unrelated entries;
- source and destination both absent: stop as fatal evidence loss;
- destination summary differs while source is absent: move the mutated payload
  back to its source during rollback;
- destination summary differs while both exist: preserve both and mark a
  conflict without overwriting either.

Rollback runs entries in reverse durable-journal order. It never deletes or
overwrites a recreated source to make room for quarantined content.

### Clean regeneration

After quarantine:

1. run `npm ci` from the canonical lockfile;
2. require `npm ls --depth=0` to succeed;
3. require no numbered-copy pattern under the new `node_modules`;
4. run lint, typecheck, full Jest without cache, extension checks, and build;
5. require no numbered-copy pattern under the generated `.next` tree;
6. require Git status to contain no numbered source copies or unexpected files.

If regeneration or validation fails, keep the quarantine and restore the prior
generated trees only when needed to return the workspace to its starting state.
Do not discard evidence to make a validation command pass.

### Recoverable orchestration closure

Task 2 preserves the Task 1F current-pointer, immutable-generation, inventory,
journal, and capability-bound filesystem contracts. It adds only the derived
locations and state transitions required to compose those primitives into a
recoverable transaction.

The `restore-active` inventory phase accepts exactly
`generated-next` or `generated-node-modules` as its ID and, only for an existing
active root, writes respectively to:

```text
inventories/restore-active/generated-next.jsonl
inventories/restore-active/generated-node-modules.jsonl
```

An absent active root does not invoke this writer and has no corresponding
JSONL. Its independently rechecked absence is first made durable as the exact
null for its fixed ID in `RESTORE_PREPARED.activeGenerated`.

The two validation phases accept the same two generated IDs and write to:

```text
inventories/validation-pass-1/<generated-entry-id>.jsonl
inventories/validation-pass-2/<generated-entry-id>.jsonl
```

Source-copy IDs and restore IDs are rejected for all three phases. The original
`pre`, `moved-pass-1`, and `moved-pass-2` phase contracts remain unchanged.

A new `rollback-entry` run-path purpose accepts exactly a validated prefixed
`RestoreId` as `id` and one of the two generated entry IDs as `phase`. It
derives only:

```text
rollback/regenerated-before-restore/<restore-id>/.next
rollback/regenerated-before-restore/<restore-id>/node_modules
```

Its selected parent is the mode-`0700`, non-symlink
`rollback/regenerated-before-restore/<restore-id>` directory. `fsyncTree`
accepts this target only through the exact option shape
`{ capability, root, purpose: "rollback-entry", restoreId, entryId, fsApi?,
limits?, metrics? }`; the derived path must equal `root`. Its existing payload
shape and bounds remain unchanged.

Every public orchestration option is a closed plain object snapshotted before
its first await. The completed transaction module exports exactly
`inspectWorkspace`, `quarantineWorkspace`, `recoverQuarantine`, and
`markQuarantineValidated`. Slice 1 exports only `inspectWorkspace` from that
public module; Slice 2 adds `quarantineWorkspace` only when it can produce the
final durable `QUARANTINED` result, and later slices add the remaining two
exports. The restore module ultimately exports exactly
`restoreQuarantine` and `recoverRestore`. Their option contracts are:

```text
inspectWorkspace({ repoRoot, quarantineRoot, expectedBranch, expectedHead,
                   expectedCount, fsApi? })
quarantineWorkspace({ repoRoot, quarantineRoot, expectedBranch, expectedHead,
                      expectedCount, transactionId, createdAt, writersStopped,
                      fsApi?, faultHook? })
recoverQuarantine({ repoRoot, quarantineRoot, transactionId,
                    action: "resume"|"rollback", writersStopped,
                    fsApi?, faultHook? })
markQuarantineValidated({ repoRoot, quarantineRoot, transactionId,
                          validatedAt, writersStopped, fsApi?, faultHook? })
restoreQuarantine({ repoRoot, quarantineRoot, transactionId, writersStopped,
                    fsApi?, faultHook? })
recoverRestore({ repoRoot, quarantineRoot, transactionId,
                 action: "resume"|"rollback", writersStopped,
                 fsApi?, faultHook? })
```

Slice 1 additionally exports one runtime-only helper from
`quarantine-workspace-runtime.mjs`. It is importable only by transaction
orchestration and its focused internal tests; it is not a public package export
and never appears on the compatibility facade:

```text
prepareQuarantineWorkspace({
  repoRoot, quarantineRoot, expectedBranch, expectedHead, expectedCount,
  transactionId, createdAt, writersStopped, fsApi?, faultHook?
}) -> {
  status: "LAYOUT_READY",
  transactionId,
  createdAt,
  repoRoot,
  quarantineRoot,
  runRoot,
  branch,
  head,
  entries,
  fsSource
}
```

Its options are a closed plain object with the same snapshot and validation
rules as the eventual `quarantineWorkspace`. `createdAt` is canonical UTC,
`writersStopped` must be literal `true`, and the only phase Slice 1 may pass to
`faultHook` is `"after-layout-sync"`, after the complete layout is durable.
The result is structurally deep-frozen and acyclic: every reachable plain
record and array is frozen and non-extensible, while callable method leaves use
the narrower contract below. The top-level handoff has a null prototype, does
not claim a journal state or completed move, and has exactly the ten displayed
keys with no symbol or accessor property. Every top-level property is an
enumerable, non-writable, non-configurable data property. `repoRoot`,
`quarantineRoot`, and `runRoot` are the validated real absolute paths.
`fsSource` is the exact frozen filesystem source used for bootstrap and later
supplied by identity to `withQuarantineRunCapability`.

`entries` is a real frozen dense array with `Array.prototype`, no hole, and no
custom string or symbol key beyond its indices and `length`. Every index is an
enumerable, non-writable, non-configurable data property; `length` is a
non-enumerable, non-writable, non-configurable data property. The array uses
UTF-8 bytewise `relativePath` order. Every entry and nested identity is a frozen,
non-extensible, null-prototype record with exactly the keys shown below, no
symbols/accessors, and only enumerable, non-writable, non-configurable data
properties. A source element has exactly
`{ id, kind: "source-copy", relativePath, canonicalRelativePath,
sourceIdentity, canonicalIdentity, classification, historyMatch }`; a generated
element has exactly `{ id, kind: "generated-root", relativePath,
sourceIdentity }`. Each identity is exactly
`{ dev, ino, mode, size, sha256 }` for a regular file and
`{ dev, ino, mode }` for a generated directory. IDs, paths, modes, sizes,
hashes, classification, history match, generated-root pairing, and deterministic
source-copy numbering use the existing manifest/path validators. These are
private runtime plans, not manifest entries: Slice 2 adds `preMoveInventory`
before building the immutable `PREPARED` manifest and revalidates every identity
before mutation.

`fsSource` is likewise a frozen, non-extensible, null-prototype record with no
symbols/accessors and exactly the 14 filesystem method keys listed below. Each
property is an enumerable, non-writable, non-configurable data property. Its
value must be callable, must retain stable identity on repeated property reads,
and must call the one captured implementation with the one captured caller
filesystem adapter as its receiver. The exact `Function` prototype, own keys,
`name`, `length`, property descriptors, extensibility, and frozen state of a
callable leaf are deliberately not part of the contract: the existing filesystem
context creates ordinary rest-argument arrow wrappers whose own `length` and
`name` properties remain implementation details even though the containing
adapter is frozen. Tests assert only callability, stable wrapper identity, and
captured-receiver behavior for `fsSource` leaves. The separately created private
bound-adapter wrappers additionally retain their existing capability-lifetime
revocation contract. Tests assert the exact `fsSource` object identity at
capability binding but do not equate source and bound-adapter wrapper identity.
They recursively assert exact prototypes, own-key sets, dense-array shape,
descriptors, and frozen/non-extensible state for the result, entries,
identities, and `fsSource` record itself; mutating any record or array must not
change a later capability handoff.

Every successful result is also a closed plain object with exactly one of these
shapes:

```text
inspectWorkspace ->
  { status: "INSPECTED", totalEntries, sourceCopies, generatedRoots: 2,
    identicalCopies, divergentCopies, branch, head, sameDevice: true }

quarantineWorkspace ->
  { transactionId, status: "QUARANTINED", movedEntries, manifestSha256 }

recoverQuarantine ->
  { transactionId, status: "QUARANTINED"|"VALIDATED", action: "resume",
    reconciledEntries }
  | { transactionId, status: "ROLLED_BACK", action: "rollback",
      reconciledEntries }
  | { transactionId, status: "INCOMPLETE_CONFLICT",
      action: "resume"|"rollback", conflictEntryIds }

markQuarantineValidated ->
  { transactionId, status: "VALIDATED", manifestSha256, validatedAt,
    deleteAfter, deletionRequiresConfirmation: true }

restoreQuarantine ->
  { transactionId, restoreId, status: "RESTORED", restoredEntries }

recoverRestore ->
  { transactionId, restoreId, status: "RESTORED", action: "resume",
    reconciledEntries }
  | { transactionId, restoreId, status: "QUARANTINED"|"VALIDATED",
      action: "rollback", reconciledEntries, restoreAborted: true }
  | { transactionId, restoreId, status: "INCOMPLETE_CONFLICT",
      action: "resume"|"rollback", conflictEntryIds }
```

All counts are non-negative safe integers; hashes and IDs use their existing
closed validators; every returned `restoreId` uses the exact prefixed
`RestoreId` grammar, and conflict IDs are non-empty, bytewise sorted, and
unique.
For inspection, `generatedRoots` is exactly `2`, `sourceCopies` equals
`identicalCopies + divergentCopies`, and `totalEntries` equals
`sourceCopies + generatedRoots`.
Public results expose no per-entry path, payload/body content, per-entry content
hash, or undocumented/undisclosed hash. This restriction does not remove the
documented inspection `head` Git object ID or the documented
`manifestSha256` fields returned by later durable operations.
Integrity loss, an illegal action for the replayed state, or indeterminate
durability throws a typed error rather than inventing another result variant.

Expected orchestration failures throw a non-exported `QuarantineError extends
Error`. On the required Node.js 22 runtime, its prototype is exactly
`QuarantineError.prototype`, which inherits `Error.prototype`, and its own-key
set is exactly `stack`, `message`, `name`, and `code`, with no symbol key,
`cause`, path, body, content hash, diff, command output, or other
application-defined dynamic field. Own-key order is not a contract.

All four properties are own non-enumerable data properties. `name`, `message`,
and `code` contain respectively `"QuarantineError"`, the code's fixed message,
and one code from the closed set below. Because Node.js initially exposes
`stack` through an engine-defined own accessor, construction first reads the
standard string stack and redefines `stack` as a non-enumerable own data
property, then freezes the instance. Thus every own descriptor has
`writable: false` and `configurable: false`, the instance is non-extensible,
and assignment or redefinition cannot change `code`. Consequently
`Object.keys(error)` is empty and `JSON.stringify(error)` is exactly `{}`; the
non-enumerable stack is never serialized. The CLI explicitly reads only `code`
and the fixed `message`, never copies a stack or an underlying exception
message. Focused tests assert the prototype, exact `Reflect.ownKeys` set, every
descriptor flag and value category, frozen/non-extensible state, failed code
mutation, empty enumerable keys, and empty default JSON serialization.

```text
ERR_USAGE: "Invalid quarantine request."
ERR_PREFLIGHT: "Workspace preflight failed."
ERR_RECOVERY_REQUIRED: "Explicit quarantine recovery is required."
ERR_CONFLICT: "Quarantine recovery found preserved conflicts."
ERR_INTEGRITY: "Quarantine evidence failed integrity validation."
ERR_EXDEV: "Repository and quarantine must be on the same filesystem."
ERR_INDETERMINATE_JOURNAL_APPEND:
  "Journal durability could not be determined."
ERR_INTERNAL: "Unexpected quarantine failure."
```

For Slice 1, invalid option shape/value, missing or false writer attestation,
invalid `fsApi`, and invalid `faultHook` map to `ERR_USAGE`. Git identity,
detached branch, clean-state, expected-count, path/type, generated-root,
stable-pass, quarantine mode/externality, or initial `mkdir` permission failures
map to `ERR_PREFLIGHT`. A device mismatch or filesystem `EXDEV` maps to
`ERR_EXDEV`. An unexpected existing run-layout name or type, a symlink or mode
violation inside an existing partial layout, or root/parent identity replacement
during bootstrap maps to `ERR_INTEGRITY`. Later slices retain the CLI mapping
below for recovery, conflict, journal, and unexpected failures. A test-only
`faultHook` rejection is not translated; it propagates unchanged after the
defined durable seam so crash tests can identify their injected failure.

`faultHook` is called as `(phase) => void | Promise<void>` and accepts only the
following literals or validated entry-ID templates:

```text
ApplyPhase =
  "after-layout-sync" | "after-pre-inventories" |
  "after-prepared-generation" | "after-event:PREPARED" |
  "after-event:MOVING" | "after-event:VERIFYING" |
  "after-event:QUARANTINED" | "before-lock-cleanup" |
  `after-event:MOVE_INTENT:${entryId}` |
  `after-rename:${entryId}` | `after-payload-sync:${entryId}` |
  `after-destination-parent-sync:${entryId}` |
  `after-source-parent-sync:${entryId}` |
  `after-inventory:moved-pass-1:${entryId}` |
  `after-event:MOVED:${entryId}` |
  `after-inventory:moved-pass-2:${entryId}`

ApplyRecoveryPhase = ApplyPhase |
  "after-event:RECOVERY_REQUIRED" | "after-event:ROLLING_BACK" |
  "after-event:ROLLED_BACK" | "after-event:INCOMPLETE_CONFLICT" |
  `after-event:ROLLBACK_INTENT:${entryId}` |
  `after-rollback-rename:${entryId}` |
  `after-rollback-payload-sync:${entryId}` |
  `after-rollback-destination-parent-sync:${entryId}` |
  `after-rollback-source-parent-sync:${entryId}` |
  `after-event:ROLLED_BACK_ENTRY:${entryId}`

ValidationPhase =
  `after-inventory:validation-pass-1:${generatedEntryId}` |
  `after-inventory:validation-pass-2:${generatedEntryId}` |
  "after-validated-generation" | "after-event:VALIDATED" |
  "after-pointer-temporary-sync" | "after-pointer-rename" |
  "after-pointer-root-sync" | "before-lock-cleanup"

RestorePhase =
  "after-event:RESTORE_PREPARED" | "after-event:RESTORING" |
  "after-event:RESTORED" | "before-lock-cleanup" |
  `after-inventory:restore-active:${generatedEntryId}` |
  `after-event:RESTORE_INTENT:${entryId}` |
  `after-active-to-rollback-rename:${generatedEntryId}` |
  `after-rollback-tree-sync:${generatedEntryId}` |
  `after-rollback-destination-parent-sync:${generatedEntryId}` |
  `after-rollback-source-parent-sync:${generatedEntryId}` |
  `after-payload-to-active-rename:${entryId}` |
  `after-restored-payload-sync:${entryId}` |
  `after-restore-destination-parent-sync:${entryId}` |
  `after-restore-source-parent-sync:${entryId}` |
  `after-event:RESTORED_ENTRY:${entryId}`

RestoreRecoveryPhase = RestorePhase |
  "after-event:RECOVERY_REQUIRED" |
  "after-event:RESTORE_ROLLING_BACK" |
  "after-event:RESTORE_ABORTED_TO_QUARANTINED" |
  "after-event:RESTORE_ABORTED_TO_VALIDATED" |
  "after-event:INCOMPLETE_CONFLICT" |
  `after-event:RESTORE_ROLLBACK_INTENT:${entryId}` |
  `after-original-active-to-payload-rename:${entryId}` |
  `after-original-payload-sync:${entryId}` |
  `after-original-payload-parent-sync:${entryId}` |
  `after-original-active-parent-sync:${entryId}` |
  `after-regenerated-rollback-to-active-rename:${generatedEntryId}` |
  `after-regenerated-active-tree-sync:${generatedEntryId}` |
  `after-regenerated-active-parent-sync:${generatedEntryId}` |
  `after-regenerated-rollback-parent-sync:${generatedEntryId}` |
  `after-event:RESTORE_ROLLED_BACK_ENTRY:${entryId}`
```

`quarantineWorkspace`, `recoverQuarantine`,
`markQuarantineValidated`, `restoreQuarantine`, and `recoverRestore` accept
respectively `ApplyPhase`, `ApplyRecoveryPhase`, `ValidationPhase`,
`RestorePhase`, and `RestoreRecoveryPhase`. `inspectWorkspace` accepts no
`faultHook`. A hook receives no path, summary body, file content, credential, or
unvalidated string.

The recovery hooks expose each durability seam in operation order. Apply
rollback uses rename, moved-payload sync, destination-parent sync, then
source-parent sync. Normal restore uses payload-to-active/source rename,
restored-payload sync, destination-parent sync, then source-parent sync. Restore
rollback uses original `A -> P` rename, payload sync, payload-parent sync, then
active-parent sync; regenerated `R -> A` uses rename, active-tree sync,
active-parent sync, then rollback-parent sync. The destination and source parent
phases are distinct and may not be collapsed into one hook.

`createdAt` and `validatedAt` are canonical UTC ISO strings. Mutating and
recovery functions require `writersStopped === true`. `faultHook` receives only
a closed phase name and exists for subprocess crash proof; it receives no path
or file content. No API accepts a run directory, payload destination, rollback
destination, manifest path, inventory path, or current-pointer path.

The transaction captures the caller filesystem source once, uses that frozen
source for the idempotent fixed-layout bootstrap, passes the same source object
to `withQuarantineRunCapability`, and obtains the live normalized adapter from
the private run filesystem context inside the callback. The private registry is
never re-exported. After capability creation, transaction and restore rename,
sync, inventory, manifest, and journal operations use only that bound adapter.
The complete source has exactly these 14 existing context methods: `lstat`,
`realpath`, `mkdir`, `open`, `readdir`, `rm`, `rename`, `unlink`, `link`,
`opendir`, `readlink`, `createReadStream`, `lstatSync`, and `realpathSync`.
Runtime reads every method getter once, captures its receiver once, and freezes
the resulting source before any filesystem await. A caller adapter must be a
complete plain object. Later source mutation is ineffective, an equal-looking
object fails the downstream identity assertion, and bootstrap never calls
`rm`, recursive or otherwise.

The seven public modules are exactly `quarantine-run-capability.mjs`,
`quarantine-path-policy.mjs`, `quarantine-journal.mjs`,
`quarantine-manifest.mjs`, `quarantine-inventory.mjs`,
`quarantine-transaction.mjs`, and `quarantine-restore.mjs`. The compatibility
facade exposes exactly these 33 unique names in bytewise order:

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

`quarantine-run-fs-context.mjs`, workspace-runtime helpers, fault helpers, and
test fixtures are internal and never appear on the facade.

The CLI writes one closed JSON object per line. Successful stdout records have
exactly these key sets and values; the serializer emits one trailing newline:

```text
inspect:
  { ok: true, command: "inspect", status: "INSPECTED", sourceCopies,
    generatedRoots: 2, identicalCopies, divergentCopies }
apply before mutation:
  { ok: true, command: "apply", status: "STARTING", transactionId }
apply completion:
  { ok: true, command: "apply", status: "QUARANTINED", transactionId,
    movedEntries, manifestSha256 }
recover:
  { ok: true, command: "recover", ...one non-conflict recover result }
mark-validated:
  { ok: true, command: "mark-validated", status: "VALIDATED", transactionId,
    manifestSha256, validatedAt, deleteAfter,
    deletionRequiresConfirmation: true }
restore:
  { ok: true, command: "restore", status: "RESTORED", transactionId,
    restoreId, restoredEntries }
```

The CLI supplies current canonical UTC strings for `createdAt` and
`validatedAt`. A failure writes exactly
`{ ok: false, command: ErrorCommand, code, message }` to stderr and nothing
else, where:

```text
ErrorCommand = "inspect" | "apply" | "recover" | "mark-validated" |
               "restore" | null
```

The field is a known canonical command only after the parser recognizes that
exact command token. A missing, unknown, or malformed/invalid command token
always produces `command: null`; the CLI never copies an untrusted raw token
into JSON. Argument errors after a recognized command may retain that known
canonical value.

`ERR_USAGE` and `ERR_PREFLIGHT` exit 2;
`ERR_RECOVERY_REQUIRED`, `ERR_CONFLICT`, `ERR_INTEGRITY`, and `ERR_EXDEV` exit 3;
`ERR_INDETERMINATE_JOURNAL_APPEND` exits 4; an unexpected sanitized
`ERR_INTERNAL` exits 1. `message` is a fixed code-mapped sentence and never
contains a stack, path body, diff, credential, URL, authorization value, or
production response. An API `INCOMPLETE_CONFLICT` result is durable audit state,
but the CLI converts it to `ERR_CONFLICT` and exit 3 rather than emitting an
`ok: true` record; the journal remains the detailed conflict-ID authority.

Inspection is advisory and read-only. Apply repeats branch, HEAD, clean-index,
same-device, root-identity, and two NUL-safe byte-identical discovery passes
after the truthful writer attestation. The existing mode-`0700` quarantine root
must already exist outside the repository. Inspection validates its existence,
type, realpath, mode, externality, and device without a write probe; it does not
claim more than advisory writability. Apply establishes writability with the
first required run-layout `mkdir`, without creating and deleting a probe.

Bootstrap creates only the validated transaction directory and the exact fixed
mode-`0700` directory list above. For every allowlisted child in order, it first
creates the child with `mkdir(child, { mode: 0o700 })` when absent. Whether the
child was newly created or adopted after `EEXIST`, it then validates the child
with `lstat` and `realpath` as a same-device, contained, non-symlink mode-`0700`
directory, opens and `fsync`s the containing parent, and does not advance until
that parent sync settles. This parent sync is the durability requirement for
the directory entry. A directory that later receives children is synced again
as each child's parent; an empty leaf needs no additional self-sync after its
own parent has been synced. A crash after `mkdir` or adoption but before the
parent sync leaves an adoptable prefix; retry must revalidate that child and
repeat the containing-parent fsync rather than treating `EEXIST` as durable.
After every created or adopted name has passed this sequence, bootstrap
revalidates the full layout and invokes `faultHook("after-layout-sync")`.

Retry with the same transaction ID adopts only directories at exact allowlisted
locations when each is mode `0700`, non-symlink, same-device, realpath-equal to
its lexical location, and contained by the recorded roots. Slice 1 permits no
file and no non-allowlisted child anywhere under the run root. Any later-stage
artifact, partial journal, foreign name, wrong type/mode, or replacement is
preserved and fails with `ERR_INTEGRITY`; a later apply implementation routes a
recognized nonterminal journal to explicit recovery instead of weakening this
bootstrap rule. Bootstrap never deletes, chmods, replaces, or recursively
removes a partial layout.

Apply records `MOVE_INTENT`, revalidates the source and absent destination,
renames, syncs the moved tree, destination parent, and source parent in that
order, verifies `moved-pass-1`, and records `MOVED`. A second independent pass
and source-absence check precede `QUARANTINED`. `EXDEV` is fatal and never
selects a copy fallback. Explicit recovery uses the source/payload matrix above;
rollback is reverse journal order, never overwrites a recreated source, and
ends at `ROLLED_BACK` or `INCOMPLETE_CONFLICT`.

The restore ID is deterministically derived from the transaction ID by the
domain-separated SHA-256 algorithm above as a prefixed `RestoreId`, so every
retry selects the same validated rollback paths without persisting a free-form
destination. The same exact string appears in public results,
`RESTORE_PREPARED`, rollback capability requests, rollback paths, and fsync
options. For a generated entry,
restore writes and `fsync`s `restore-active` inventory only for each existing
generated root, independently rechecks every absent root immediately before the
event, and captures both fixed IDs as summary-or-null records in one durable
`RESTORE_PREPARED`. It then enters `RESTORING`, records one `RESTORE_INTENT`,
moves that tree to its `rollback-entry`, and moves the quarantined original
payload to the active path. Both moves use payload/tree sync,
destination-parent sync, and source-parent sync in that order.

Generated restore recovery treats active (`A`), rollback-entry (`R`), and
quarantined payload (`P`) as three independent locations. `O` is the canonical
original summary from the manifest; `G` is the canonical regenerated summary
when present. The presence bit and summary-or-null are persisted by
`RESTORE_PREPARED.activeGenerated` before the first intent; every non-null
summary is backed by its durable `restore-active` inventory. A dash is absence.
After a durable `RESTORE_INTENT`, the exhaustive practical matching matrix is:

| A | R | P | Resume | Rollback |
|---|---|---|---|---|
| `G` | `-` | `O` | archive `A` to `R`, then restore `P` to `A` | no move; abort restore |
| `-` | `G` | `O` | restore `P` to `A` | move `R` to `A`; abort restore |
| `O` | `G` | `-` | record the entry complete | move `A` to `P`, then `R` to `A`; abort restore |
| `-` | `-` | `O` | restore `P` to `A` when the active tree was originally absent | no move; abort restore |
| `O` | `-` | `-` | record complete when the active tree was originally absent | move `A` to `P`; abort restore |

The last two rows are legal only when the persisted `activeGenerated` presence
bit was false. `O` and `G` are persisted roles, not labels inferred by counting
matching summary bytes. When `O == G`, the durable ledger phase, persisted
`activeGenerated` presence bit, authorized path, and observed inode/location
assign the role; all five rows above remain legal even when the two summaries
are byte-equal. Two authorized locations in one listed row are not a duplicate
conflict merely because their content digests match.

If `O` exists nowhere, or a previously present `G` required for rollback exists
nowhere, recovery stops as fatal evidence loss without further mutation.
`INCOMPLETE_CONFLICT` is reserved for a physical location pattern unauthorized
by the exact three-location table for the durable ledger phase, a distinct
concurrent inode at an unauthorized path, or a present summary that matches
neither persisted role. Recovery preserves every location and never chooses one
copy by timestamp or name. This includes concurrent recreation after the
active-to-rollback rename and a mutated payload or rollback tree. Source-copy
restore has no rollback entry; its exact location table is the `A`/`P`
projection of the durable restore phases above with `R` required absent.

Restore resume processes durable `RESTORE_INTENT` records in forward order.
Restore rollback processes them in reverse durable `RESTORE_INTENT` order; for
one generated entry it reverses the original restore first (`A` to `P`) and the
active archival second (`R` to `A`). It returns to the exact pre-restore
`QUARANTINED` or `VALIDATED` state. A completed `RESTORED` transaction is not
silently undone.

Validation writes independent `validation-pass-1` and `validation-pass-2`
inventories for both regenerated roots, rejects every numbered basename and
unexpected workspace residue, and requires matching summaries before
activation. On a first transition from `QUARANTINED`, the canonical supplied
`validatedAt` constructs the immutable `VALIDATED` generation and
`deleteAfter` is exactly 96 hours later. On retry when replay is already
`VALIDATED`, the journal tip's `manifestSha256` is authoritative: the function
ignores the newly supplied `validatedAt` for manifest construction, reads that
immutable generation by digest, and verifies its digest, state, transaction,
repository/root/HEAD, entry set, `retentionDays: 4`,
`deletionRequiresConfirmation: true`, `deletionStatus: "retained"`, and
`deleteAfter == stored validatedAt + 96 hours`. It returns or activates the
stored generation's `validatedAt`, `deleteAfter`, and digest. A different valid
input timestamp alone neither creates a new digest nor causes failure. A
missing, mismatched, or corrupt journal-named generation is fatal and preserves
all evidence. Neither Task 2 nor any scheduled action deletes quarantine
content. Permanent deletion remains a separate explicit operator decision after
four full days and final review.

## Backup documentation hardening

The production runbook must not document `pg_dump "$DATABASE_URL"` or any
URL-bearing `--dbname` argument. The supported manual backup command invokes
`scripts/create-snapshot-backup.mjs` with `DATABASE_URL` supplied by the
approved secret-management environment. The coordinator remains solely
responsible for the temporary mode-`0600` libpq service file, sanitized child
arguments, output rollback, fingerprinting, and cleanup.

A documentation contract test must fail if the runbook reintroduces a raw
database URL in `pg_dump` arguments and must require the coordinator-based
manual path. Existing rules against logging URLs, credentials, and row bodies
remain unchanged.

## Real-Docker interruption assurance

Add a Linux-only integration test using an actual PostgreSQL 17 Docker
container. It starts a controlled backup, interrupts the coordinator with both
SIGINT and SIGTERM, and verifies within bounded deadlines:

- exit status is respectively 130 or 143;
- no container-side `pg_dump` process remains;
- no service, PID, start, or cancellation control file remains in the
  container;
- no local credential file remains;
- no partial or published dump/fingerprint output remains.

The test skips with a clear reason when Docker is unavailable and the test was
not explicitly requested. An explicit request, including CI, fails rather than
skips when Docker or the expected PostgreSQL 17 container is unavailable.
Fake-Docker and direct child tests remain as fast coverage.

The existing supervisor is not redesigned unless this test reproduces an
orphan or bounded-cleanup failure. A reproduction stops this subproject before
merge and triggers a separate design for a uniquely identifiable one-shot dump
container with bounded forced removal and a final janitor.

## Retention and deletion

Quarantine content is retained for four full days after the clean-regeneration
validation timestamp. There is no automatic deletion. After the deadline, the
operator reviews the current immutable manifest generation, the four divergent
diffs, the green local/CI evidence, and the absence of requested restoration.
Permanent deletion occurs only after an explicit final confirmation.

The immutable manifest generations, current pointer, and journal remain as the
audit record after quarantined file contents are deleted. They contain no file
bodies, credentials, database URLs, or application data. Divergent diff files
are part of the quarantined content because they reproduce source text, so final
deletion removes them as well.

## Rollback

- Source rollback atomically moves quarantined files to their exact validated
  original relative paths and modes in reverse journal order. It never merges
  them into canonical files and never overwrites a concurrently recreated path.
- Generated restore first writes and `fsync`s separate inventories for each
  existing active regenerated `.next` and `node_modules` root. It creates no
  JSONL for an absent root, independently rechecks each absence immediately
  before the event, then appends `RESTORE_PREPARED` with both fixed IDs and each
  exact summary or null. It
  atomically moves each tree into its derived child under
  `rollback/regenerated-before-restore/<restore-id>/`. It fsyncs and records
  each move before atomically moving the corresponding quarantined original
  tree into the active path. It never unlinks an active tree to make room.
- Restore uses the exact `A/R/P` three-location table and explicit restore
  recovery commands above. A crash can therefore resume or reverse each atomic
  move without guessing.
- A successful restore consumes the quarantined payload but retains the
  manifest generations, inventories, current pointer, and journal as its audit
  record. Regenerated rollback content remains quarantined until explicit
  disposition.
- Runbook and test changes use an ordinary Git revert.
- If hash verification, installation, tests, build, or real-Docker assertions
  fail, stop with the quarantine intact and report the exact failing gate.

## Security and operational constraints

- Never print file bodies, credentials, database URLs, authorization headers,
  or production response bodies.
- Never echo an unknown or invalid CLI command token. Error JSON exposes only
  one of the five canonical command values or null.
- Use NUL-safe path enumeration and argument arrays; do not evaluate filenames
  as shell code.
- Treat manifests, inventories, journal frames, current pointers, and restore
  arguments as untrusted. Validate closed schemas and derive payload paths from
  validated IDs; a hash or checksum is corruption evidence, not authorization.
- Require writer quiescence and same-device identity on apply, mark-validation,
  recovery, and restore. `EXDEV` is fatal and never triggers a copy fallback.
- Stream payload hashes and JSONL inventories with bounded memory. Never call
  `readFile` on payload bodies or serialize a complete generated tree into one
  JSON value.
- Fsync payload data, append-only journal transitions, and both sides of every
  rename before advancing state. For cross-directory moves, fsync the destination
  parent before the source parent.
- Do not read browser storage, local credential files, or production secrets as
  part of workspace cleanup.
- A post-merge production-backup workflow dispatch may validate the changed
  default-branch operations path. It must remain a read-only production backup
  and must not restore into or mutate Production.

## Contract precedence and superseded wording

This amendment is authoritative wherever older prose, committed plans, or
pre-amendment tests conflict with it. In particular, it supersedes all wording
that permits:

- a mutable `manifest.json`, `manifest.sha256` sidecar, ID-only `current`, or
  run-local current pointer instead of immutable digest-named generations and
  the canonical root-level pointer;
- manifest or checksum validation without a live run capability, generation
  content-digest verification, and the pure closed-schema builder;
- caller-supplied writer destinations or independent writer path validation
  instead of capability-derived paths and pre/post identity checks;
- journal, manifest, or capability-bound inventory writers selecting or
  normalizing a filesystem adapter independently of their live capability;
- ordinary journal append without the held-lock ownership, conditional cleanup,
  and indeterminate-error rules used by recovery;
- terminal stale-lock cleanup that appends an event, changes journal bytes,
  accepts a torn tail, or mutates artifacts before the second same-tip replay;
- a single restore-active inventory keyed only by restore ID, a shared rollback
  destination for both generated roots, or restore recovery that cannot return
  to the exact pre-restore `QUARANTINED` or `VALIDATED` state;
- treating `settleDurableTip` as authorization to clean an arbitrary
  nonterminal journal rather than exact confirmation of the unchanged durable
  allowlisted tip plus owned stale evidence under explicit attested recovery;
  or
- recursive directory traversal, one open directory per depth, unbounded
  in-memory sorting, more than 32 merge readers, or following a symlink during
  inventory or durability sync.

The lock metadata checksum remains only a closed-frame corruption check. A
manifest generation digest binds exact canonical bytes but is not authorization;
authorization to write still comes exclusively from the live callback-scoped
capability and writer-quiescence attestation.

## Required RED acceptance matrix

Implementation begins by proving that the pre-amendment behavior fails these
tests. The completed implementation must make every row pass without weakening
the assertions:

1. **Terminal cleanup:** for each of `ROLLED_BACK`, `RESTORED`, and
   `INCOMPLETE_CONFLICT`, cleanup leaves journal bytes identical, appends no new
   event, removes only validated stale lock/tombstone artifacts, and syncs their
   parent. For a nonterminal state, torn final journal frame, or missing/false
   writer-stopped attestation, the journal, lock, tombstones, and every other
   artifact remain byte-for-byte identical.
2. **Capability and symlink attacks:** independently swap the quarantine root,
   run root, journal parent, inventory parent, and manifest parent for symlinks;
   attempt capability forgery and callback leakage; and replace a validated
   root/run with a different device/inode. Each case fails, follows no swapped
   link, and leaves a sentinel external victim byte-for-byte unchanged.
3. **Manifest-generation crash matrix:** interrupt immediately after generation
   temporary-file sync, deterministic generation hard-link publication,
   generation-directory sync, pointer temporary-file sync, pointer rename, and
   quarantine-root sync. After each interruption, a reader returns only the
   previous or new complete validated generation, and the prior generation
   remains readable. An existing digest filename containing different bytes is
   always rejected.
4. **Ordinary append lock replacement:** replace the lock before journal
   mutation, after journal mutation/sync, and immediately before cleanup. The
   pre-mutation case leaves journal bytes unchanged. Each post-mutation case
   records the candidate zero or one time and explicit recovery makes it present
   exactly once. No phase deletes the foreign replacement lock.
5. **Bounded traversal:** a virtual tree 10,000 directories deep completes with
   at most one simultaneous directory handle. A real 40,000-entry fixture has
   peak RSS below 160 MiB, uses at most 32 merge readers, and produces identical
   JSONL bytes and digest across repeated traversals. Durability order is
   file-before-child-directory-before-parent post-order, and symlink targets are
   never opened or followed.
6. **Capability-bound filesystem view:** bind one instrumented adapter when the
   run capability is created, omit writer-local adapters, and prove capability,
   journal, manifest, inventory, stream, and cleanup calls use only the captured
   methods. Passing a distinct equal-looking adapter to a writer fails before
   mutation, source-method replacement cannot change the bound view, and
   callback settlement invalidates the binding.
7. **Durable target identity and private modes:** prove journal parent sync
   precedes append `after-sync` revalidation; every cleanup mutation has matching
   pre/post capability boundaries; journal, lock, and tombstone mode violations
   preserve evidence; and manifest generation/current publication returns only
   after the post-sync target retains its recorded identity and exact mode
   `0600`.
8. **Atomic apply and replay:** use actual child `SIGKILL` after every journal,
   rename, payload-sync, parent-sync, and inventory-publication boundary. Resume
   or reverse rollback must reach `QUARANTINED`, `ROLLED_BACK`, or
   `INCOMPLETE_CONFLICT` with no lost or overwritten path. `EXDEV` never invokes
   copy or unlink. PREPARED/MOVING crashes before the first intent use an empty
   exact recovery ID array and can resume or roll back without an entry event;
   the same empty array after an intent is fatal. Every post-intent recovery
   array exactly repeats all durable intent IDs in forward journal order,
   including completed IDs; exercise non-bytewise intent order, an all-completed
   crash, both recovery actions, the 4,096 boundary, and 4,097 rejection.
9. **Durable-tip settlement:** an exact allowlisted non-torn tip may be settled
   without a new event only through the closed `settleDurableTip` result while
   the owned stale lock/tombstone evidence remains proven. A changed
   sequence/hash/event/state, unknown key, non-allowlisted pair, changed tip,
   missing or foreign owned evidence, or torn tail preserves all artifacts. The
   three terminal outcomes use cleanup-only and reject settlement variants.
10. **Restore and reverse restore:** write and sync inventory JSONL for each
    existing active generated root, write none for absence, independently
    recheck each absence immediately before the fixed two-ID
    `RESTORE_PREPARED`, then interrupt after every intent, active-tree move,
    original-tree move, and durability sync. Prove
    resume reaches `RESTORED` and rollback returns
    to the exact prior `QUARANTINED` or `VALIDATED` state. Concurrent or mutated
    evidence remains in place and yields `INCOMPLETE_CONFLICT`; a completed
    `RESTORED` transaction is not silently undone. Exercise every practical
    matching/missing/mismatching `A/R/P` row including `O == G`, classify roles
    by ledger phase and authorized location, reverse durable intent order, and
    exercise the empty-ID no-intent abort path. The fixed derivation vector and
    every result, event, capability request, path, and fsync option use the same
    prefixed `RestoreId`; bare UUIDs are rejected.
11. **Validation and retention:** two independent inventories for each
    regenerated root match and contain no numbered basename before the
    `VALIDATED` generation and canonical pointer become current. Recovery from
    every validation publication boundary yields one complete current
    generation, `deleteAfter` exactly 96 hours after `validatedAt`, retained
    content, and no automatic deletion path. An already-`VALIDATED` retry uses
    the journal-named immutable generation and returns its stored timestamps;
    a different supplied timestamp never creates a second digest.
12. **Closed CLI errors:** exercise each of the five canonical command values,
    plus missing, unknown, and malformed command tokens. Only a recognized
    canonical command may appear in error JSON; every other token produces null
    and its raw bytes are absent from stdout and stderr.

## Success criteria

The subproject is complete when:

1. all 65 source copies and both generated trees are recoverable from a
   same-device atomic-move quarantine whose journal replays cleanly;
2. the active checkout contains no numbered copies and has a deterministic
   dependency tree;
3. lint, typecheck, full tests, extension checks, build, and relevant backup
   tests pass from the regenerated environment;
4. the manual runbook uses the hardened coordinator and contract tests reject
   raw database URL arguments;
5. actual Docker interruption evidence proves no remote dump or control-file
   residue, or the project stops for a separately approved runner redesign;
6. the quarantine deadline is four days after validation and deletion still
   requires final explicit confirmation;
7. path/schema attack tests, crash-boundary replay, concurrent recreation and
   mutation, same-device/`EXDEV`, restore interruption, and bounded-memory RSS
   tests pass without overwriting or losing either side of a conflict.
