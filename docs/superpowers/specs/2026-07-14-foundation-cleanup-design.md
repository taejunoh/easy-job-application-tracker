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
    divergent-diffs/
    payload/
      source-copies/<entry-id>
      generated/node_modules/
      generated/.next/
    rollback/
      regenerated-before-restore/<restore-id>/
    conflicts/
```

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
check and a Node filesystem call. Apply, restore, recovery, terminal cleanup,
and manifest activation therefore all require `writersStopped === true`.

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
SHA-256 values; `historyMatch` is null or an accepted 40/64-character Git
object ID; modes are safe integers from `0` through `0o7777`; sizes, entry
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
(ROLLED_BACK, ROLLED_BACK)
(RESTORED, RESTORED)
(INCOMPLETE_CONFLICT, INCOMPLETE_CONFLICT)
(RESTORE_ABORTED_TO_QUARANTINED, QUARANTINED)
(RESTORE_ABORTED_TO_VALIDATED, VALIDATED)
```

`ROLLED_BACK`, `RESTORED`, and `INCOMPLETE_CONFLICT` normally use the existing
terminal cleanup-only path; listing them here fixes the complete stable-tip
allowlist rather than broadening nonterminal cleanup. Unknown fields, a pair
outside the allowlist, changed sequence/hash/event/state, a torn or changed tip,
missing or foreign stale-lock/tombstone ownership evidence, or a zero-append
callback without this exact result preserves every artifact and fails. This
protocol makes no claim about an unrecorded candidate's identity and is never
authorization to clean an arbitrary nonterminal journal.

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
`{ conflictEntryIds: string[] }`. Both arrays are bytewise sorted and contain
unique validated entry IDs. A recovery-required array may be empty only when
replay proves that the interrupted apply or restore contains zero durable
`MOVE_INTENT` or `RESTORE_INTENT` records respectively; once any relevant
intent is durable, the array must be non-empty and contain exactly the unresolved
entry IDs. A conflict array is always non-empty. Task 2 may extend an event payload only
after adding a failing exact-schema test and updating this contract; arbitrary
plain canonical JSON is never an accepted journal payload.

`RESTORE_PREPARED` accepts exactly
`{ restoreId, activeGenerated }`. `restoreId` is the deterministic validated
restore ID derived from the transaction. `activeGenerated` is a dense array of
exactly these two records in this order:

```text
{ id: "generated-next", inventory: InventorySummary|null }
{ id: "generated-node-modules", inventory: InventorySummary|null }
```

A non-null summary names the already durable matching `restore-active`
inventory; null proves that the corresponding active root was absent during
the attested restore preflight. Unknown fields, another order/ID, an absent
inventory for a non-null summary, or an inventory mismatch fails before
`RESTORE_PREPARED` is appended.

The durable lifecycle is:

```text
PREPARED -> MOVING -> VERIFYING -> QUARANTINED -> VALIDATED
                 \-> RECOVERY_REQUIRED -> ROLLING_BACK -> ROLLED_BACK
                 \-> INCOMPLETE_CONFLICT
PREPARED -> RECOVERY_REQUIRED([]) -> MOVING|ROLLING_BACK
MOVING(no MOVE_INTENT) -> RECOVERY_REQUIRED([]) -> MOVING|ROLLING_BACK
QUARANTINED|VALIDATED -> RESTORE_PREPARED -> RESTORING -> RESTORED
                                             \-> RECOVERY_REQUIRED
RESTORE_PREPARED -> RECOVERY_REQUIRED([])
RESTORING(no RESTORE_INTENT) -> RECOVERY_REQUIRED([])
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
`PREPARED`, `MOVING`, `RESTORE_PREPARED`, and `RESTORING`. An empty array is
legal only at the two no-intent apply states or the two no-intent restore
states. Apply rollback then enters `ROLLING_BACK` and may append `ROLLED_BACK`
without entry events. Restore rollback enters `RESTORE_ROLLING_BACK` and may
append the abort event matching the state immediately before
`RESTORE_PREPARED`, also without entry events. The transaction semantic replay
layer rejects an empty array after the first durable relevant intent and rejects
a non-empty array that is not the exact sorted unresolved set.

`INCOMPLETE_CONFLICT` is terminal until an operator resolves the preserved
source and destination evidence. A new `apply` or `restore` is refused whenever
the current transaction has a nonterminal journal. Recovery is explicit through
`recover --resume` or `recover --rollback`; rollback is the safer documented
default.

Before moving anything, the tool:

1. requires the invocation-supplied repository root, expected branch, expected
   HEAD, expected numbered-copy count, and writer-quiescence attestation;
2. requires no tracked or staged changes and two stable numbered-path discovery
   passes;
3. rejects symlink roots and verifies the external quarantine path is outside
   the repository, mode-restricted, writable, and on the same device;
4. streams deterministic pre-move inventories to JSONL, computes their SHA-256,
   entry count, and byte count, and records only those summaries in the manifest;
5. durably writes the initial immutable manifest generation, divergent diffs,
   initial inventories, run directory, and `PREPARED` journal record; it does
   not activate `current` until the matching validated generation is durable.

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
`generated-next` or `generated-node-modules` as its ID and writes respectively
to:

```text
inventories/restore-active/generated-next.jsonl
inventories/restore-active/generated-node-modules.jsonl
```

The two validation phases accept the same two generated IDs and write to:

```text
inventories/validation-pass-1/<generated-entry-id>.jsonl
inventories/validation-pass-2/<generated-entry-id>.jsonl
```

Source-copy IDs and restore IDs are rejected for all three phases. The original
`pre`, `moved-pass-1`, and `moved-pass-2` phase contracts remain unchanged.

A new `rollback-entry` run-path purpose accepts exactly a validated restore ID
as `id` and one of the two generated entry IDs as `phase`. It derives only:

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
its first await. The transaction module exports exactly `inspectWorkspace`,
`quarantineWorkspace`, `recoverQuarantine`, and
`markQuarantineValidated`. The restore module exports exactly
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
closed validators; conflict IDs are non-empty, bytewise sorted, and unique.
For inspection, `generatedRoots` is exactly `2`, `sourceCopies` equals
`identicalCopies + divergentCopies`, and `totalEntries` equals
`sourceCopies + generatedRoots`.
Integrity loss, an illegal action for the replayed state, or indeterminate
durability throws a typed error rather than inventing another result variant.

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
  `after-original-payload-parent-sync:${entryId}` |
  `after-original-active-parent-sync:${entryId}` |
  `after-regenerated-rollback-to-active-rename:${generatedEntryId}` |
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
`{ ok: false, command: string|null, code, message }` to stderr and nothing else.
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
must already exist outside the repository. Bootstrap creates only the validated
transaction directory and its fixed mode-`0700` children, syncing every created
parent. It never removes a partial layout; retry with the same transaction ID
adopts only the expected private directories and otherwise preserves evidence
and fails.

Apply records `MOVE_INTENT`, revalidates the source and absent destination,
renames, syncs the moved tree, destination parent, and source parent in that
order, verifies `moved-pass-1`, and records `MOVED`. A second independent pass
and source-absence check precede `QUARANTINED`. `EXDEV` is fatal and never
selects a copy fallback. Explicit recovery uses the source/payload matrix above;
rollback is reverse journal order, never overwrites a recreated source, and
ends at `ROLLED_BACK` or `INCOMPLETE_CONFLICT`.

The restore ID is deterministically derived from the transaction ID as a
version-4-shaped UUID, so every retry selects the same validated rollback
paths without persisting a free-form destination. For a generated entry,
restore inventories the active regenerated tree, records one
`RESTORE_INTENT`, moves that tree to its `rollback-entry`, then moves the
quarantined original payload to the active path. Both moves use payload/tree
sync, destination-parent sync, and source-parent sync.

Generated restore recovery treats active (`A`), rollback-entry (`R`), and
quarantined payload (`P`) as three independent locations. `O` is the canonical
original summary from the manifest; `G` is the canonical regenerated summary
and presence bit recorded by `restore-active` before the first intent. A dash is
absence. After a durable `RESTORE_INTENT`, the exhaustive practical matching
matrix is:

| A | R | P | Resume | Rollback |
|---|---|---|---|---|
| `G` | `-` | `O` | archive `A` to `R`, then restore `P` to `A` | no move; abort restore |
| `-` | `G` | `O` | restore `P` to `A` | move `R` to `A`; abort restore |
| `O` | `G` | `-` | record the entry complete | move `A` to `P`, then `R` to `A`; abort restore |
| `-` | `-` | `O` | restore `P` to `A` when the active tree was originally absent | no move; abort restore |
| `O` | `-` | `-` | record complete when the active tree was originally absent | move `A` to `P`; abort restore |

The last two rows are legal only when the persisted restore-active presence bit
was false. If `O` exists nowhere, or a previously present `G` required for
rollback exists nowhere, recovery stops as fatal evidence loss without further
mutation. If `O` or `G` appears in more than its one expected location, all
three locations are present, an unexpected location is present, or any present
summary differs from the row's `O`/`G`, recovery preserves every location and
records `INCOMPLETE_CONFLICT`; it never chooses one copy by timestamp or name.
This includes concurrent recreation after the active-to-rollback rename and a
mutated payload or rollback tree. Source-copy restore uses the corresponding
two-location rules from apply recovery.

Restore resume processes durable `RESTORE_INTENT` records in forward order.
Restore rollback processes them in reverse durable `RESTORE_INTENT` order; for
one generated entry it reverses the original restore first (`A` to `P`) and the
active archival second (`R` to `A`). It returns to the exact pre-restore
`QUARANTINED` or `VALIDATED` state. A completed `RESTORED` transaction is not
silently undone.

Validation writes independent `validation-pass-1` and `validation-pass-2`
inventories for both regenerated roots, rejects every numbered basename and
unexpected workspace residue, and requires matching summaries before
activation. `deleteAfter` is exactly 96 hours after `validatedAt`,
`deletionRequiresConfirmation` remains true, and neither Task 2 nor any
scheduled action deletes quarantine content. Permanent deletion remains a
separate explicit operator decision after four full days and final review.

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
- Generated restore first appends `RESTORE_PREPARED`, inventories the active
  regenerated `.next` and `node_modules` trees separately, and atomically moves
  each tree into its derived child under
  `rollback/regenerated-before-restore/<restore-id>/`. It fsyncs and records
  each move before atomically moving the corresponding quarantined original
  tree into the active path. It never unlinks an active tree to make room.
- Restore uses the same replay matrix and explicit recovery commands as apply.
  A crash can therefore resume or reverse each atomic move without guessing.
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
- Use NUL-safe path enumeration and argument arrays; do not evaluate filenames
  as shell code.
- Treat manifests, inventories, journal frames, current pointers, and restore
  arguments as untrusted. Validate closed schemas and derive payload paths from
  validated IDs; a hash or checksum is corruption evidence, not authorization.
- Require writer quiescence and same-device identity on apply, recovery, and
  restore. `EXDEV` is fatal and never triggers a copy fallback.
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
   the same empty array after an intent is fatal.
9. **Durable-tip settlement:** an exact allowlisted non-torn tip may be settled
   without a new event only through the closed `settleDurableTip` result while
   the owned stale lock/tombstone evidence remains proven. A changed
   sequence/hash/event/state, unknown key, non-allowlisted pair, changed tip,
   missing or foreign owned evidence, or torn tail preserves all artifacts.
10. **Restore and reverse restore:** inventory both active generated roots,
    interrupt after every intent, active-tree move, original-tree move, and
    durability sync, then prove resume reaches `RESTORED` and rollback returns
    to the exact prior `QUARANTINED` or `VALIDATED` state. Concurrent or mutated
    evidence remains in place and yields `INCOMPLETE_CONFLICT`; a completed
    `RESTORED` transaction is not silently undone. Exercise every practical
    matching/missing/mismatching `A/R/P` row, reverse durable intent order, and
    the empty-ID no-intent abort path.
11. **Validation and retention:** two independent inventories for each
    regenerated root match and contain no numbered basename before the
    `VALIDATED` generation and canonical pointer become current. Recovery from
    every validation publication boundary yields one complete current
    generation, `deleteAfter` exactly 96 hours after `validatedAt`, retained
    content, and no automatic deletion path.

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
