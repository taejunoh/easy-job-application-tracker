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
restore. Stable preflight passes can detect some concurrent changes but cannot
make an open writer safe. A device mismatch or `EXDEV` is fatal; there is no
copy fallback. A future cross-device workflow requires a separately reviewed
durable streaming-copy design.

### Quarantine layout

Create one external directory per cleanup run:

```text
~/Library/Application Support/easy-job-application-tracker/quarantine/
  current
  <UTC timestamp>/
    journal.log
    manifest.json
    manifest.sha256
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

The quarantine root and run directory must have mode `0700`. The ID-only
`current` pointer, journal, manifest, checksum, inventory, and diff files must
have mode `0600`. Quarantine payload paths are
derived only from validated entry IDs and the fixed generated-root allowlist;
untrusted manifest or journal path strings never become filesystem destinations.
No quarantined content lives under the repository, so Git, Jest, ESLint, and
Next.js cannot rediscover it.

The small manifest records:

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
files and rename operations also `fsync` their containing directories. A torn
final frame is ignored during replay. Before touching the journal, the appender
creates a mode-`0600` lock with `wx`, keeps its handle open, writes the exact
length-framed canonical metadata
`{ version: 1, ownerToken, pid, checksum }`, and `fsync`s both lock and parent
directory. `EEXIST` always fails; normal append never reclaims by TTL or PID
liveness. While holding the lock, append replays through the same journal
handle, truncates only a recognized torn final frame to the last valid offset,
and `fsync`s the file and parent directory before appending. Lock removal is
also directory-`fsync`ed.

Stale-lock recovery is a separate `reclaimJournalLock` operation that requires
`writersStopped === true`. It rejects and preserves symlink, non-regular,
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
with a non-symlink regular-file `lstat` of the current lock path before journal
mutation. Sequential awaited callback appends are allowed; leaked capabilities
and missing, replaced, or non-regular lock paths are rejected without journal
changes. It removes the tombstone and new lock, then `fsync`s the parent, only
after the recovery journal operation is durable.
A current PID with a different owner token is treated as possible PID reuse:
ordinary append still fails and only explicit attested recovery may proceed.
Tests use actual child-process `SIGKILL` after `wx` and after metadata `fsync`;
exception injection remains supplementary replay evidence, not crash proof.
Any malformed non-final frame, sequence
gap, hash-chain break, unknown field, or illegal state transition is fatal.
The envelope schema and event payload schema are separate closed boundaries.
Every event in the transition table has an exact payload parser on both append
and replay. Lifecycle-only events accept exactly `{}`; `PREPARED` accepts only
the validated transaction ID and manifest SHA-256; `MOVE_INTENT` accepts only
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
5. writes and `fsync`s the manifest, divergent diffs, initial inventories,
   checksum, run directory, and durable `PREPARED` journal record.

Inventory is always streaming. Regular-file hashes use `createReadStream`; tree
entries are emitted in deterministic bytewise path order to mode-`0600` JSONL.
No payload file or full generated-tree inventory is loaded into memory, and the
manifest never embeds the tens of thousands of generated entries.

For each source copy and each complete generated root, the tool:

1. appends and `fsync`s a `MOVE_INTENT` containing the validated entry ID and
   expected source inventory summary;
2. rechecks source identity and the absence of the derived destination;
3. atomically renames the source inode to the derived quarantine destination;
4. recursively `fsync`s the moved payload, then the destination parent, then the
   source parent; persisting the destination name before the source-name removal
   ensures a crash can produce the old name or both names, but not a deliberate
   neither-name durability window;
5. streams and verifies the destination inventory;
6. appends and `fsync`s `MOVED` with the observed summary.

After all moves, two independent streaming destination-inventory passes must
match the pre-move summaries. All original sources must remain absent and no
unexpected numbered-path residue may exist. Only then does the transaction
append `QUARANTINED` and publish the small manifest checksum/current pointer.
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
operator reviews the manifest, the four divergent diffs, the green local/CI
evidence, and the absence of requested restoration. Permanent deletion occurs
only after an explicit final confirmation.

The small manifest and checksum remain as the audit record after quarantined
file contents are deleted. They contain no file bodies, credentials, database
URLs, or application data. Divergent diff files are part of the quarantined
content because they reproduce source text, so final deletion removes them as
well.

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
  manifest, inventories, checksum, and journal as its audit record. Regenerated
  rollback content remains quarantined until explicit disposition.
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
  validated IDs; a checksum is corruption evidence, not authorization.
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
