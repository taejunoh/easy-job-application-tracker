# Foundation Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quarantine every numbered workspace copy without data loss, regenerate a deterministic local environment, route manual backups through the hardened coordinator, and prove real-Docker interruption cleanup.

**Architecture:** A built-in-only Node CLI inventories a target Git checkout, copies source and generated content into an external quarantine, verifies hashes and tree inventories, and removes originals only after verification. Operations changes remain separate: a documentation contract replaces raw database-URL backup arguments, while a focused PostgreSQL 17 Docker test proves signal cleanup using the existing coordinator and CI service container.

**Tech Stack:** Node.js 22 ESM, Git CLI, Jest/ts-jest, PostgreSQL 17, Docker, GitHub Actions, Markdown operations contracts

---

## File map

- Create `scripts/quarantine-numbered-copies-support.mjs`: inventory, hashing, copy-verify-remove, manifest, validation, and restore functions.
- Create `scripts/quarantine-numbered-copies.mjs`: thin CLI with `inspect`, `apply`, `mark-validated`, and `restore` subcommands.
- Create `__tests__/scripts/quarantine-numbered-copies.test.ts`: synthetic-repository safety tests.
- Modify `package.json`: expose `cleanup:quarantine` and `test:backup:docker`.
- Modify `docs/operations/production-runbook.md` and its workflow contract test.
- Create `__tests__/scripts/create-snapshot-backup.docker.integration.test.ts`: real PostgreSQL 17 Docker signal proof.
- Modify `.github/workflows/ci.yml`, `__tests__/ci/workflow-contract.test.ts`, and `README.md`.

### Task 1: Implement quarantine inventory and transactions

**Files:**
- Create: `scripts/quarantine-numbered-copies-support.mjs`
- Create: `__tests__/scripts/quarantine-numbered-copies.test.ts`

- [ ] **Step 1: Write failing path and inventory tests**

Create a temporary Git repository in every test. Commit canonical files, then
create one identical and one divergent copy. Import these exact interfaces:

```ts
import {
  canonicalPathForNumberedCopy,
  inspectWorkspace,
} from "../../scripts/quarantine-numbered-copies-support.mjs";

it.each([
  ["src/server-env 2.ts", "src/server-env.ts"],
  ["scripts/verify-invalid-startup 3.mjs", "scripts/verify-invalid-startup.mjs"],
  ["src/version2.ts", null],
  ["src/dir 2/file.ts", null],
])("maps only final numbered filename suffixes", (input, expected) => {
  expect(canonicalPathForNumberedCopy(input)).toBe(expected);
});

it("classifies Git-visible copies without retaining file bodies", async () => {
  const fixture = await createFixtureRepository();
  const inventory = await inspectWorkspace({
    repoRoot: fixture.root,
    expectedBranch: "main",
    expectedHead: fixture.head,
    expectedCount: 2,
  });
  expect(inventory.summary).toEqual({ total: 2, identical: 1, divergent: 1 });
  expect(JSON.stringify(inventory)).not.toContain("divergent unpublished body");
});
```

The fixture uses `git init --initial-branch=main`, local test-only user
configuration, and never reads the real checkout.

- [ ] **Step 2: Verify RED and commit the regression tests**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-numbered-copies.test.ts
git add __tests__/scripts/quarantine-numbered-copies.test.ts
git commit -m "test: specify workspace quarantine inventory"
```

Expected: test fails because the support module is missing, then the test-only
commit succeeds.

- [ ] **Step 3: Implement deterministic read-only inventory**

Export:

```js
export function canonicalPathForNumberedCopy(relativePath) {}
export async function inspectWorkspace(options) {}
```

Use `/^(.*) ([2-9][0-9]*)(\.[^/]+)$/u` only on the final path component.
Call Git through argument arrays, parse
`git status --porcelain=v1 -z --untracked-files=all` NUL-safely, reject
tracked/staged changes, and require invocation-supplied branch, HEAD, and copy
count. Require the quarantine root to be outside the repository and require
available space greater than the deterministic source/generated inventory size.
Each record contains repository/HEAD metadata, timestamps, relative path,
quarantine path, canonical path, mode, size, SHA-256,
`identical|divergent`, and a historical canonical commit when verified.
Divergent history matching compares the copy hash with
`git show <commit>:<canonical>` for commits returned by
`git log --all --format=%H -- <canonical>`.

- [ ] **Step 4: Add failing transaction and rollback tests**

Extend the import with `quarantineWorkspace`, `markQuarantineValidated`, and
`restoreQuarantine`, then require these behaviors:

```ts
it("copies, rehashes, and only then removes originals", async () => {
  const fixture = await createFixtureRepository({ includeGeneratedTrees: true });
  const result = await quarantineWorkspace({
    repoRoot: fixture.root,
    quarantineRoot: fixture.quarantineRoot,
    expectedBranch: "main",
    expectedHead: fixture.head,
    expectedCount: 2,
    now: new Date("2026-07-14T12:00:00.000Z"),
  });
  expect(result.manifest.status).toBe("quarantined");
  expect(await pathExists(join(fixture.root, "src/example 2.ts"))).toBe(false);
  expect(await pathExists(join(fixture.root, "node_modules"))).toBe(false);
  expect(await pathExists(join(fixture.root, ".next"))).toBe(false);
  expect((await stat(result.runDirectory)).mode & 0o777).toBe(0o700);
  expect((await stat(result.manifestPath)).mode & 0o777).toBe(0o600);
});
```

Also test branch mismatch, HEAD mismatch, count mismatch, tracked change, staged
change, a deliberately corrupted destination, checksum mismatch, symlink
handling, validation before regeneration, and restore. Every precondition or
verification failure must leave the corresponding original present. Include
explicit failures for a quarantine root inside the repository and insufficient
available space through an injected `statfs` result.

- [ ] **Step 5: Implement copy-verify-remove, manifest, validation, and restore**

Use `lstat`, `readlink`, and built-in filesystem APIs. Recursively inventory
sorted entries as `{ path, type, mode, size, sha256, linkTarget }`. Create the
run directory with mode `0700` and manifest/diff files with `0600`.
Copy source files and complete `node_modules`/`.next` trees, compare source and
destination inventories, and only then remove originals. Persist
`status: copying` before transfer and atomically replace it with
`status: quarantined`; write `manifest.sha256`.
Write one mode-`0600` unified diff per divergent copy under
`divergent-diffs/`; never embed diff or file bodies in the manifest or CLI
output.

`markQuarantineValidated` verifies the checksum and clean regenerated trees,
then writes `validatedAt`, `retentionDays: 4`, `deleteAfter` exactly four days
later, and `deletionRequiresConfirmation: true`.
`restoreQuarantine` first archives regenerated trees under
`rollback/regenerated-before-restore/<UTC timestamp>/`, verifies them, and
restores originals with the same copy-verify-remove transaction.

Never use shell interpolation, `eval`, raw `rm -rf`, or rename-only transfer.

- [ ] **Step 6: Verify GREEN and commit**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-numbered-copies.test.ts
git diff --check
git add scripts/quarantine-numbered-copies-support.mjs __tests__/scripts/quarantine-numbered-copies.test.ts
git commit -m "feat: add verified workspace quarantine transaction"
```

### Task 2: Add the CLI and perform the approved quarantine

**Files:**
- Create: `scripts/quarantine-numbered-copies.mjs`
- Modify: `package.json`
- Operate on: `/Users/taejunoh/Desktop/LFG/easy-job-application-tracker`

- [ ] **Step 1: Add failing spawned-CLI tests**

Against temporary repositories only, assert:

```ts
expect(runCli(["inspect", ...validArgs])).toMatchObject({ code: 0, stderr: "" });
expect(runCli(["apply", ...validArgs])).toMatchObject({ code: 0, stderr: "" });
expect(runCli(["mark-validated", "--manifest", manifestPath]))
  .toMatchObject({ code: 0, stderr: "" });
expect(runCli(["restore", "--manifest", manifestPath]))
  .toMatchObject({ code: 0, stderr: "" });
```

The fixture recreates clean `node_modules` and `.next` directories after
`apply` and before `mark-validated`; `restore` then proves the regenerated
trees are archived before the originals return.

Missing commands, relative roots, expectation mismatches, and premature
validation exit nonzero without printing file bodies.

- [ ] **Step 2: Verify RED, implement CLI, and add package script**

The only supported forms are:

```text
npm run cleanup:quarantine -- inspect --repo-root <abs> --quarantine-root <abs> --expected-branch <name> --expected-head <sha> --expected-count <n>
npm run cleanup:quarantine -- apply --repo-root <abs> --quarantine-root <abs> --expected-branch <name> --expected-head <sha> --expected-count <n>
npm run cleanup:quarantine -- mark-validated --manifest <abs>
npm run cleanup:quarantine -- restore --manifest <abs>
```

Add `"cleanup:quarantine": "node scripts/quarantine-numbered-copies.mjs"`.
Output JSON summaries only: counts, status, run directory, manifest path,
validation time, and deletion deadline.

- [ ] **Step 3: Verify GREEN and commit**

```bash
npm test -- --runInBand __tests__/scripts/quarantine-numbered-copies.test.ts
git diff --check
git add scripts/quarantine-numbered-copies.mjs package.json package-lock.json __tests__/scripts/quarantine-numbered-copies.test.ts
git commit -m "feat: add workspace quarantine CLI"
```

- [ ] **Step 4: Inspect the original checkout without mutation**

Run from the feature worktree after the original checkout is back on `main`:

```bash
TARGET=/Users/taejunoh/Desktop/LFG/easy-job-application-tracker
QUARANTINE="$HOME/Library/Application Support/easy-job-application-tracker/quarantine"
EXPECTED_HEAD="$(git -C "$TARGET" rev-parse HEAD)"
node scripts/quarantine-numbered-copies.mjs inspect \
  --repo-root "$TARGET" --quarantine-root "$QUARANTINE" \
  --expected-branch main --expected-head "$EXPECTED_HEAD" --expected-count 65
```

Require exactly 65 total, 61 identical, and 4 divergent. Stop if any value,
branch, or HEAD differs.

- [ ] **Step 5: Apply and verify the external quarantine**

Run `apply` with the identical arguments and same `EXPECTED_HEAD`. Record the
returned manifest path privately. Verify manifest checksum and mode `0600`,
run-directory mode `0700`, `status: quarantined`, and four divergent
classifications without printing diff contents.

- [ ] **Step 6: Regenerate and validate the original checkout**

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
the quarantine and report before considering `restore`.

- [ ] **Step 7: Mark validation and establish retention**

Run `mark-validated --manifest "$MANIFEST_PATH"`. Require four-day UTC
`deleteAfter` and `deletionRequiresConfirmation: true`. Create a reminder for
that timestamp to review the manifest and request final deletion confirmation;
never schedule automatic deletion.

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
npm test -- --runInBand __tests__/scripts/quarantine-numbered-copies.test.ts __tests__/ci/production-backup-workflow-contract.test.ts __tests__/ci/workflow-contract.test.ts __tests__/scripts/create-snapshot-backup.integration.test.ts
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
