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

Use evidence-first quarantine, clean regeneration, and test-first operations
hardening. This is safer than selective deletion and less disruptive than
replacing the whole active checkout.

### Quarantine layout

Create one external directory per cleanup run:

```text
~/Library/Application Support/easy-job-application-tracker/quarantine/
  <UTC timestamp>/
    manifest.json
    manifest.sha256
    divergent-diffs/
    source-copies/
    generated/
      node_modules/
      .next/
```

The run directory must have mode `0700`. Manifest and diff files must have mode
`0600`. `source-copies/` preserves every path relative to the repository root.
No quarantined content lives under the repository, so Git, Jest, ESLint, and
Next.js cannot rediscover it.

The manifest records:

- repository root and exact HEAD commit;
- creation and validation timestamps in UTC;
- original relative path and quarantine relative path;
- canonical relative path when one exists;
- byte length and SHA-256 of both copy and canonical file;
- classification as `identical` or `divergent`;
- Git-history match when verified;
- file mode;
- generated-tree directory hashes or deterministic inventories;
- retention deadline and deletion status.

Unified diffs and verified Git-history matches for all four divergent files are
stored in `divergent-diffs/`. No divergent content is automatically merged into
canonical files.

### Quarantine transaction

The cleanup tool performs these pre-move gates before moving anything:

1. require the expected repository root, branch, and commit;
2. require no tracked or staged changes;
3. inventory the numbered copies with NUL-safe path handling;
4. classify all 65 copies and write the manifest and divergent diffs;
5. verify sufficient disk space and quarantine permissions.

After the archive is written, every quarantined file is re-hashed and compared
with the pre-move manifest. Only verified files are removed from their original
paths. A partial failure stops the transaction and leaves the manifest marked
incomplete; it never deletes an unverified source.

The complete `node_modules` and `.next` directories are moved to
`generated/`. Selectively removing numbered generated files is not allowed
because it can leave polluted nested directories and an untrustworthy install.

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

The test skips with a clear reason when Docker is unavailable locally, while CI
must run it in an environment where Docker is available. Fake-Docker and direct
child tests remain as fast coverage.

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

- Source rollback restores quarantined files to their exact original relative
  paths and modes. It never merges them into canonical files.
- Generated rollback moves the regenerated directories aside and restores the
  quarantined `node_modules` and `.next` trees.
- Runbook and test changes use an ordinary Git revert.
- If hash verification, installation, tests, build, or real-Docker assertions
  fail, stop with the quarantine intact and report the exact failing gate.

## Security and operational constraints

- Never print file bodies, credentials, database URLs, authorization headers,
  or production response bodies.
- Use NUL-safe path enumeration and argument arrays; do not evaluate filenames
  as shell code.
- Do not read browser storage, local credential files, or production secrets as
  part of workspace cleanup.
- A post-merge production-backup workflow dispatch may validate the changed
  default-branch operations path. It must remain a read-only production backup
  and must not restore into or mutate Production.

## Success criteria

The subproject is complete when:

1. all 65 source copies and both generated trees are recoverable from a
   verified external quarantine;
2. the active checkout contains no numbered copies and has a deterministic
   dependency tree;
3. lint, typecheck, full tests, extension checks, build, and relevant backup
   tests pass from the regenerated environment;
4. the manual runbook uses the hardened coordinator and contract tests reject
   raw database URL arguments;
5. actual Docker interruption evidence proves no remote dump or control-file
   residue, or the project stops for a separately approved runner redesign;
6. the quarantine deadline is four days after validation and deletion still
   requires final explicit confirmation.
