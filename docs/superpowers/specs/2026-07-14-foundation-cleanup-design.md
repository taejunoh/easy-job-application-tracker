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

The operator explicitly attests writer quiescence on `apply`, recovery, and
restore. For the full operation, no other apply, recovery, or restore and no
repository, quarantine, journal, or lock writer may run. Stable preflight
passes can detect some concurrent changes but cannot make an open writer safe.
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
renames it to its digest name without replacement, and syncs the generation
directory. Activation then appends and syncs the journal event that makes that
generation eligible, writes and syncs a pointer temporary file, renames it over
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
temporary evidence.

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
and replay. Lifecycle-only events other than `VALIDATED` accept exactly `{}`;
`PREPARED` accepts only the validated transaction ID and initial manifest
SHA-256, while `VALIDATED` accepts exactly `{ manifestSha256 }` naming its
durable immutable generation; `MOVE_INTENT` accepts only
the entry ID and expected `InventorySummary`; `MOVED` accepts only the entry ID
and observed `InventorySummary`. Entry-oriented rollback and restore events
accept only their validated entry ID plus any inventory summary explicitly
required by their documented transition. `RECOVERY_REQUIRED` accepts exactly
`{ entryIds: string[] }`, and `INCOMPLETE_CONFLICT` accepts exactly
`{ conflictEntryIds: string[] }`; both arrays are non-empty, bytewise sorted,
unique validated entry IDs. Task 2 may extend an event payload only
after adding a failing exact-schema test and updating this contract; arbitrary
plain canonical JSON is never an accepted journal payload.

The durable lifecycle is:

```text
PREPARED -> MOVING -> VERIFYING -> QUARANTINED -> VALIDATED
                 \-> RECOVERY_REQUIRED -> ROLLING_BACK -> ROLLED_BACK
                 \-> INCOMPLETE_CONFLICT
QUARANTINED|VALIDATED -> RESTORE_PREPARED -> RESTORING -> RESTORED
```

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
append `QUARANTINED`, durably write the final immutable manifest generation,
append `VALIDATED` with that exact generation digest, and atomically activate
the canonical root-level `current` pointer.
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
  regenerated tree, and atomically moves that tree into the derived
  `rollback/regenerated-before-restore/<restore-id>/` path. It fsyncs and records
  that move before atomically moving the quarantined original tree into the
  active path. It never unlinks the active tree to make room.
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
   temporary-file sync, generation rename, generation-directory sync, pointer
   temporary-file sync, pointer rename, and quarantine-root sync. After each
   interruption, a reader returns only the previous or new complete validated
   generation, and the prior generation remains readable. An existing digest
   filename containing different bytes is always rejected.
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
