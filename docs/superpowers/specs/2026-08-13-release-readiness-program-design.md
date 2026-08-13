# Release Readiness Program Design

**Date:** 2026-08-13

**Status:** Approved for implementation by the repository owner’s instruction to complete all seven items without intermediate approval pauses.
**Baseline:** `f0e3874e7d5acb0af289c552fc574cea27287a27`

## 1. Goal and execution policy

Finish seven release-readiness gaps without losing user data, weakening fail-closed boundaries, or silently changing public behavior:

1. quarantine and validate all 76 current untracked records, then retain them for four days;
2. remove every critical/high dependency advisory and refresh the reviewed audit evidence;
3. prove PostgreSQL 17 backup interruption cleanup against real Docker containers and remove raw database URLs from operator commands;
4. introduce a closed Application API input contract;
5. add canonical application identity, a lossless legacy backfill, and atomic idempotent creation;
6. replace the shared extension root token with installation-scoped, revocable credentials;
7. publish the quarantine operator guide and reconcile historical lifecycle documentation.

The program is executed in an isolated Git worktree. Original-checkout
mutations are limited to the reviewed final merge, approved quarantine
lifecycle, and deterministic regeneration/verification at that merged HEAD.
There are no `git clean`, unrelated cleanup, bulk deletion, or automatic
retention deletion steps.

## 2. Sequencing and invariants

The implementation order is fixed:

1. quarantine lifecycle enablement, without touching the original checkout;
2. dependency remediation;
3. PostgreSQL backup proof and runbook hardening;
4. Application request validation;
5. Application identity and deduplication;
6. extension installation credentials;
7. operator and historical documentation reconciliation;
8. aggregate verification and independent review;
9. local merge to the final `main` HEAD, then the live 76-record quarantine,
   regeneration, and validation at that fixed HEAD;
10. final smoke verification and push without any further commit or HEAD change.

Cross-cutting invariants:

- every state-changing slice is test-driven;
- expected operational failures use closed error codes and sanitized messages;
- database changes are additive and do not delete legacy Application rows;
- secrets never appear in argv, logs, manifests, snapshots, or client-readable payloads;
- extension credentials are stored only as one-way keyed digests on the server;
- generated and untracked user data are never discarded merely because their names look temporary;
- four-day retention begins only after durable validation and never schedules automatic deletion;
- `package-lock.json` changes only when the dependency graph changes;
- the final branch must pass lint with zero warnings, typecheck, build, all tests, audit policy, migration checks, and `git diff --check`.

## 3. Item 1 — complete quarantine of all 76 records

### 3.1 Observed workspace

At the baseline, the original checkout contains exactly:

- 37 numbered-copy regular files: then 33 byte-identical and 4 divergent;
- 39 `.BC.T_*` regular files, all zero-byte and mode `0600`;
- no tracked changes.

The existing CLI fails preflight because it parses every Git-status record but accepts only numbered-copy basenames. Its `--expected-count` remains the total Git-status record count, so the correct live value is 76.

The live final-HEAD gate fixes only 76 status records, 37 numbered sources, 39
temp residues, and two generated roots. It recomputes identical/divergent
classification against the merged HEAD; the baseline 33/4 split is evidence,
not a live precondition.

### 3.2 Temp-residue entry type

Add a third movable entry kind, `temp-residue`, throughout the existing capability, manifest, journal, apply/recovery, restore/recovery, inventory, and result boundaries. Existing v1 manifest/journal readers and exact key/ID grammars remain unchanged. Journal v2 adds an exact `schemaVersion:2` envelope field; its STARTING/PREPARED records establish the version before any entry IDs are parsed. Replay selects grammar from that envelope, so v1 rejects every `temp-*` and v2 accepts it. All v1 hash vectors remain byte-identical; v2 has independent golden vectors. An old binary fails closed on the unknown key/version.

A path qualifies only when all of the following are true:

- it is a strict NFC POSIX repository-relative path;
- its final basename matches exactly `.BC.T_[A-Za-z0-9]{6}`;
- it is a non-symlink regular file opened with no-follow semantics;
- its size is exactly zero;
- its permission mode is exactly `0600`;
- it is reported by the same captured Git-status snapshot as untracked;
- its parent/root/identity checks remain valid through the mutation boundary.

Any mismatch is an unexpected residue and fails preflight. Temp residues receive deterministic bytewise IDs `temp-0001` onward. The journal entry grammar is extended only for these IDs. Restore returns them to their original paths with the same no-overwrite and held-identity rules as numbered source copies.

A v2 temp manifest entry has exact keys `id`, `kind`, `relativePath`, `mode`,
`size`, `sha256`, and `preMoveInventory`; it has no canonical-path field because
no canonical counterpart exists.
Mode is 384, size is zero, SHA-256 is the standard empty-byte digest, and the
inventory contains one regular zero-byte record. Payload is
`payload/temp-residues/temp-NNNN`. The current-pointer schema remains v1 and may
point to a v2 immutable manifest generation by digest.

CLI records intentionally include `schemaVersion:2` on STARTING and every v2
success/failure/recover/restore/reconcile result; exact-output tests and
consumers are updated together. When operating on a valid v1 run, the CLI emits
`schemaVersion:1` and preserves v1 data fields. Inspect adds `tempResidues` and retains the
existing numbered-copy counts. For this checkout, apply moves 78 entries: 37
numbered copies, 39 temp residues, `.next`, and `node_modules`.

### 3.3 Generated-root validation

Pre-move inventories remain immutable restoration evidence. Validation no longer requires regenerated roots to be byte-identical to pre-move generated roots. Instead, after quarantine, after every generator is idle, and under a fresh writer-stopped attestation, it captures two independent held-identity inventories of each newly generated root and requires those two captures to match exactly. The exact 76 captured source/temp paths must be absent; generated-tree basename scans remain a supplementary anomaly check.

This proves stable regenerated state without treating build identifiers or legitimate dependency updates as payload corruption. It does not weaken restore: the original generated-root inventories remain bound to the payload and are used whenever restore/recovery reads or moves original content.

In PREPARED/QUARANTINED v2, `validationAttempt` is null and no post-regeneration
references exist. In VALIDATED v2, it is a strong ID and
`regeneratedEvidence` is an exact two-key object (`generated-next`,
`generated-node-modules`); each value has exact `pass1Path`, `pass1Summary`,
`pass2Path`, and `pass2Summary` with run-relative inventory paths and closed
summary records. Manifest v2 therefore binds four immutable attempt-scoped
inventory files. Existing-run
validation reopens and verifies all four against the manifest. A failed attempt
never wedges retry: a new unique attempt publishes new no-replace files, and
only the successful manifest generation selects them; capability-owned
unselected artifacts use guarded cleanup. Root/ancestor dev-inode-realpath and
canonical identity are checked before and after every traversal and publication.

Manifest v2 stores the captured branch plus canonical repository top-level and
root dev/inode identities. Branch, HEAD, repository identity, clean tracked
state, absence of captured residue, and generated-root ownership are
revalidated through durable `VALIDATED` publication.

CLI apply accepts a caller-generated transaction ID. The live command records
this ID in a mode-0600 operator log before mutation. Same-ID precommit retry is
supported; a different fresh apply is rejected while an owned precommit run
exists. This closes interruption after layout creation but before PREPARED.

### 3.4 Live operation

Only after every implementation commit is reviewed and merged to the final
local `main` HEAD, use the external same-device root:

`/Users/taejunoh/Developer/LFG/.easy-job-application-tracker-quarantine`

Create it once as a non-symlink directory with mode `0700`. Run the final
merged CLI from `main`, never an older original-checkout script or a different
worktree's npm wrapper. Capture the flushed `STARTING` record’s transaction ID.
After apply, regenerate with the remediated locked dependency graph and complete
lint, typecheck, tests, extension checks, audit, and build. Then stop writers and
mark the same transaction validated. No commit, merge, checkout, reset, or other
HEAD change occurs from inspect through the entire retention/recovery window.

Inspect may write an optional detailed evidence artifact only beneath the
external quarantine root. It is mode 0600, uses no-follow identity capture,
contains paths as base64 plus types/modes/sizes/hashes (no content), is fsynced,
and its digest is recorded in the operator log. The public JSON remains
sanitized counts. No evidence file is written inside Git metadata.

Success means:

- original checkout has no untracked records;
- manifest contains 78 entries and exact original evidence;
- both generated-root validation passes match;
- durable state is `VALIDATED`;
- `deleteAfter = validatedAt + 96 hours`;
- `deletionRequiresConfirmation` is true;
- payload remains present and no automatic deletion job exists.

## 4. Item 2 — dependency security remediation

Upgrade direct packages conservatively within their existing major lines:

- `next`, `@next/env`, and `eslint-config-next` exactly to 16.3.0;
- `prisma`, `@prisma/client`, and `@prisma/adapter-pg` together to 7.9.1;
- `undici` exactly to 7.29.0;
- root `postcss` exactly to 8.5.26.

Regenerate the lockfile with Node 22.22.2 in CI or a pinned local runtime; local
verification may use any engine-compatible `>=22.22.2 <23` runtime. Do not use
audit exceptions for critical or high advisories. Remove resolved historical
exceptions. A remaining moderate/low exception is allowed only when its
advisory, exact dependency path, non-exploitability rationale, remediation
trigger, reviewed date, and future review date are recorded and exactly match
live audit output. Sanitized audit snapshots are temporary gate artifacts, not
committed machine/path-bearing reports.

The audit checker must report production and development graphs separately while keeping the full graph as the blocking gate.

Acceptance:

- `npm audit` and `npm audit --omit=dev` both report critical/high 0;
- audit policy passes and no stale exception remains;
- Next build, Prisma generation, migration diff, unit tests, and extension E2E pass.

## 5. Item 3 — PostgreSQL 17 backup interruption proof

Keep the production design: PostgreSQL 17 custom-format dump, PostgreSQL 17 scratch restore, fingerprint comparison, then encryption.

Add a dedicated Docker integration test and CI job using an isolated named network and disposable digest-pinned PostgreSQL 17 containers. It uses container PG17 binaries, never host PostgreSQL tools. A transaction holds `LOCK TABLE "Application" IN ACCESS EXCLUSIVE MODE`, blocking the dump's ACCESS SHARE. The test sends both SIGINT and SIGTERM to the coordinator and proves:

- exit 130 or 143 as appropriate;
- no coordinator database session remains;
- no remote dump process/backend remains;
- source locks and transactions are released;
- host and container credential, PID, start, cancel, dump, fingerprint, and partial files are absent;
- captured stdout/stderr contain no sentinel database URL or password; raw
  Docker inspect metadata is never persisted.

The nightly workflow also asserts `pg_restore --version`, cleans all plaintext and partial paths in `if: always()`, and fingerprints every new table introduced by this program.

The production runbook removes `pg_dump "$DATABASE_URL"`. Its sole manual
command family uses a mode-0600 service file containing host/database/user only,
a separate mode-0600 `PGPASSFILE`, and PG17
`pg_dump --dbname=service=<name>`, so credentials never enter child argv.

## 6. Item 4 — closed Application API contract

Create `src/lib/applications/contract.ts` as the single parser/normalizer for list, create, and update requests.

### 6.1 Shared rules

- JSON bodies are capped at 256 KiB.
- Only plain JSON objects are accepted; arrays, null, and unknown keys fail.
- Errors are closed: 400 `invalid_request`, 413 `request_too_large`.
- Text limits are measured consistently and documented.
- Status is exactly `Applied | Interview | Offer | Rejected`.
- Job type is exactly `Remote | Hybrid | Onsite | null`.
- Code-point limits are URL 2048, title/company 256, location/salary 512,
  notes 20,000, description 100,000, and list search 256. Empty optional text
  normalizes to null consistently in POST and PATCH; the web detail serializer
  sends null rather than empty strings.

### 6.2 POST

Allowed keys are `url`, `jobTitle`, `company`, `status`, `appliedDate`, `description`, `notes`, `salary`, `location`, and `jobType`.

`url`, `jobTitle`, and `company` are trimmed required nonblank strings. URL is
`http:` or `https:`, contains no credentials, control characters, or fragment,
and is at most 2048 characters. `appliedDate`, when present, matches an exact
RFC 3339 grammar with required `Z` or numeric offset and round-trips through
parse plus UTC `toISOString`; date-only and timezone-free values fail. Optional
text fields accept string or null; empty optional text normalizes to null.

### 6.3 PATCH

The ID is a UUID. The body must contain at least one allowed mutable field. URL,
identity, applied date, creation time, and IDs cannot be changed. Empty required
strings fail; nullable fields accept null and also normalize empty strings to
null for compatibility.

### 6.4 GET

Allow only `status`, `jobType`, `search`, `sortBy`, and `sortOrder`. Sort fields are `appliedDate | createdAt | updatedAt | jobTitle | company`; direction is `asc | desc`. Invalid filters are rejected rather than ignored, and arbitrary Prisma field names never reach `orderBy`.

## 7. Item 5 — canonical identity and lossless deduplication

### 7.1 Identity

New applications require a valid URL. Canonicalization:

1. parse with the platform URL parser;
2. lowercase scheme and hostname and remove default port;
3. reject credentials and fragments;
4. remove only known tracking parameters (`utm_*`, `gclid`, `fbclid`, `trk`, `ref`, `source`);
5. require the parsed URL serialization to be NFC, sort remaining decoded
   `(name,value)` pairs by their UTF-8 bytes, preserve duplicate and empty
   names/values, and let the platform URL serializer percent-encode them;
6. normalize a non-root trailing slash;
7. compute `identityKey = "url-v1:" + SHA-256(canonicalUrl)`.

Meaningful query parameters, including provider job IDs, remain part of identity. A digest match with a different canonical URL fails as `409 identity_collision`.

### 7.2 Schema and atomic create

Add nullable `identityKey` with a unique index, nullable `canonicalUrl`, nullable `duplicateOfId`, and `identityState` with an index on `duplicateOfId`. Nullable fields keep legacy rows deployable.

Creation uses one PostgreSQL `INSERT ... ON CONFLICT (identityKey) DO NOTHING RETURNING` operation followed, on conflict, by a read of the existing row. Exactly one concurrent request returns 201 `result:"created"`; all others return 200 `result:"existing"`. A retry never mutates prior notes, status, dates, or enrichment.

The raw insert generates `id` with application `randomUUID()` and binds one
application-created `now` value to `createdAt`, `updatedAt`, and the default
`appliedDate`; it supplies every non-null/default field explicitly because
Prisma's `@updatedAt` is not a database default. Raw rows are mapped through an
explicit DTO. A conflict must read and compare the stored canonical URL. A
different canonical URL is a route-owned 409 `identity_collision`; a concurrent
delete permits one bounded retry and then remains an internal failure.

### 7.3 Backfill

The production rollout is fixed: deploy the additive migration while the legacy
write path remains active; enter maintenance mode and stop Application writers;
take and scratch-restore a backup; dry-run and apply backfill; verify the report,
counts, and indexes; deploy/enable the identity-aware POST; resume writers. The
backfill uses the production canonicalizer. This maintenance barrier prevents a
new identity row from racing a legacy null-identity row; row locks alone are not
claimed to serialize absent unique keys.

- Winner order: `createdAt ASC, id ASC`.
- A unique valid row becomes `canonical`.
- In a duplicate group, only the winner owns the identity key; all other rows remain intact and are marked `legacy_duplicate` with `duplicateOfId`.
- Invalid legacy URLs remain intact as `legacy_unresolved` with null identity.
- Reruns are idempotent. Writers resume only after the report and unique-index
  verification succeed.

The additive migration creates `identityState TEXT NOT NULL DEFAULT
'legacy_unresolved'` before adding the CHECK, so every existing and unexpected
legacy write has a closed state. Database consistency checks require: canonical
has non-null identity key/canonical URL and null duplicate pointer; legacy
duplicate has a non-null different-row pointer and null identity key; unresolved
has all three nullable identity fields null; self-reference is forbidden. The
state value CHECK allows only `canonical`, `legacy_duplicate`, and
`legacy_unresolved`. The self-reference uses `ON DELETE
RESTRICT`; the DELETE API returns 409 `identity_has_duplicates` when a canonical
winner has dependents. Existing duplicate rows
remain visible in this release; `duplicateOfId` is preservation metadata, not a
default-list filter. The additive migration and normal unique-index creation
run inside the same short maintenance window.

Row count must never decrease. Backup, scratch restore, migration status, pre/post counts, and a JSON backfill report are required before production apply.
The report is mode 0600 and contains only counts, state totals, and opaque/hashed
row identifiers—never raw URLs, titles, companies, bodies, or connection data.

## 8. Item 6 — installation-scoped extension credentials

### 8.1 Flow

Replace extension entry of the root `APP_ACCESS_TOKEN` with a web-issued, ten-minute, one-time pairing code:

1. an authenticated web session creates a pairing grant bound to the exact extension origin;
2. the extension obtains the optional host permission and exchanges the code once;
3. the server returns a single installation token once;
4. normal requests authenticate that installation token and origin;
5. disconnect revokes remotely first, then purges the local token and host permission.

Legacy root-token extension records are purged and require re-pairing. They are never promoted to installation credentials.

### 8.2 Storage and authentication

Add `ExtensionPairingGrant` and `ExtensionInstallation`. Pair codes and token secrets use at least 256 random bits. The database stores only domain-separated HMAC digests derived from `ENCRYPTION_SECRET`. Token format contains a public installation selector and secret; comparison is timing-safe.

Installation tokens are bound to an exact configured
`chrome-extension://<32-lowercase-letters>` origin, expire after 90 days, track
last use, and may be individually revoked. The management UI selects only
configured extension origins. Pair, verify, and every scoped route require both
CORS allowlisting and token-origin equality; failures use closed non-oracular
responses. Pairing consumption is a conditional one-time database update.

The protected-route layer becomes async and returns a principal. Root application credentials retain existing administrative access, but Chrome-origin root bearer authentication is rejected. Installation scope is limited to extension application creation, keyword analysis, explicitly approved extraction, a minimal profile read, verification, and self-revoke. Settings mutation, resume content, application modification, and deletion are forbidden.

### 8.3 UI and failure behavior

Settings gains installation list, create-pairing-code, and revoke controls.
Secrets are returned with `Cache-Control:no-store`, displayed once, removed from
component state after dismissal, and excluded from screenshots/history. The
extension keeps its serialized mutation queue, generation guard, tombstone, and
trusted-storage failure behavior. Offline disconnect destroys the local token
and host permission immediately and retains only installation ID plus
`remoteRevocationUnconfirmed`; it directs the operator to the authenticated web
management screen. It does not retain a secret or promise background network
retry after host permission removal.

Fingerprinting and backup verification include both new tables.

## 9. Item 7 — operator documentation and lifecycle reconciliation

Add `docs/operations/quarantine-runbook.md` and link it from README. The runbook contains:

- canonical `npm run cleanup:quarantine -- ...` forms;
- exact required flags and writer-stopped attestation;
- JSONL record and exit-code tables;
- apply/recovery/restore decision trees;
- validation/regeneration steps;
- state and next-action matrix;
- explicit statements that validation retention is not deletion and `deleteAfter` is the earliest review time;
- prohibitions on `git clean`, manual payload movement, journal editing, and retention auto-delete.

Add a separate read-only reconciliation authority and `reconcile` command; it
does not reuse the existing-run mutation handoff. It validates roots,
capability, journal chain, manifest/pointer, and state-specific physical layout
without reclaiming a lock, appending a record, or cleaning anything. Its
versioned output includes `schemaVersion:1`, state, `complete`, and `nextAction`.
The exact mapping is QUARANTINED→`mark_validated`,
VALIDATED→`retain_and_review`, RESTORED/ROLLED_BACK→`none` with complete true,
PREPARED/MOVING/VERIFYING/RESTORE_PREPARED/RESTORING/
RESTORE_ROLLING_BACK/RECOVERY_REQUIRED→`recover_required`, and
INCOMPLETE_CONFLICT→`investigate_conflict`. Torn, missing, or conflicting
evidence is `ERR_INTEGRITY`, never success JSON.

`reconcile` requires `--writers-stopped` as a coherent-evidence snapshot
attestation, not mutation permission. No best-effort observer may emit
`complete` or a recovery directive.

Historical implementation plans and design headers are annotated as completed historical records with commit range and final gate references. Their original step text is not rewritten; unchecked boxes are either checked with evidence or the document is clearly labeled historical so it cannot masquerade as live backlog.

Those annotations are made only after the implementation commits and final gate
exist. The runbook uses `$REPO_ROOT` and `$QUARANTINE_ROOT`, never a developer's
personal absolute path, and states that the flushed STARTING transaction ID is
the sole durable input for every later recovery/validation command.

No purge command is added in this program. Final retained-payload deletion requires a separate destructive lifecycle design after the four-day deadline.

## 10. Verification and release gate

Each slice receives implementation review and code-quality review. Verification
is split. The pre-merge gate runs locally on any engine-compatible Node
`>=22.22.2 <23`; CI is the exact Node 22.22.2 authority. The pre-merge gate includes:

- fresh `npm ci` and `npx --no-install prisma generate`;
- migration validation against disposable PostgreSQL 17;
- audit full graph and production graph;
- focused tests for every slice;
- full `npm test -- --runInBand --no-cache`;
- real Docker backup interruption tests;
- extension E2E with two installations, origin binding, revoke, expiry, replay rejection, and legacy purge;
- `npm run lint -- --max-warnings=0`;
- `npm run typecheck` with valid non-secret test environment;
- production build with safe dummy environment;
- `npm run check:extension`;
- `git diff --check` and clean isolated worktree;
- disposable exact-76 quarantine proof and no automatic deletion audit.

Only after the pre-merge gate and independent final review pass may the branch
fast-forward local `main`. Before merge, NUL-delimited sets prove no changed
tracked path intersects any of the 76 untracked paths; fetch/ancestry and remote
authentication/dry-run checks prove push readiness. The post-merge operational
gate freezes the final HEAD, recomputes residue classification, performs live
quarantine/regeneration/audit/smoke, publishes retention evidence, and proves
the original checkout clean. Only then is that unchanged HEAD pushed.
