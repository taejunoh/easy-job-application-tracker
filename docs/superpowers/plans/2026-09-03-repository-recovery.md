# Repository Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the production backup start race, clear the blocking dependency advisories, align the environment example, and make every repository gate green.

**Architecture:** Preserve the exported-snapshot and interruption-cleanup design, but use one stable shell PID that waits for the start file and then `exec`s `pg_dump`. Resolve current advisories with exact transitive overrides; do not change the Prisma major or audit policy.

**Tech Stack:** Node.js 22.22.2, Jest 30, PostgreSQL 17 Docker, npm overrides, GitHub Actions.

---

### Task 1: Add a normal-completion Docker regression

**Files:**
- Modify: `__tests__/scripts/create-snapshot-backup.docker.integration.test.ts`

- [ ] **Step 1: Write the failing real-process test**

Add a test beside the existing PostgreSQL 17 interruption tests. The production break it catches is a dump process that remains stopped after the start gate is released.

```ts
it("completes a normal Docker snapshot after releasing the start gate", async () => {
  const token = randomBytes(5).toString("hex");
  const restoreDatabase = `jobtracker_restore_${token}`;
  const dumpPath = join(runDirectory!, "normal.dump");
  const fingerprintPath = join(runDirectory!, "normal.json");

  coordinatorProcess = runProcess(
    process.execPath,
    [coordinator, dumpPath, fingerprintPath],
    {
      ...process.env,
      BACKUP_CREDENTIAL_DIRECTORY: runDirectory,
      DATABASE_URL: secretDatabaseUrl(port),
      DOCKER_BIN: docker,
      PASSWORD_SENTINEL: passwordSentinel,
      PG_DUMP_DOCKER_CONTAINER: toolContainer,
      PRODUCTION_DATABASE_URL: secretDatabaseUrl(port),
      TZ: "UTC",
    },
  );

  const result = await boundedResult(coordinatorProcess.result, 15_000);
  expect(result).not.toBe("timeout");
  expect(result).toEqual({
    code: 0,
    signal: null,
    stdout: "Production backup snapshot created.\n",
    stderr: "",
  });
  expect((await stat(dumpPath)).size).toBeGreaterThan(0);
  expect((await stat(fingerprintPath)).size).toBeGreaterThan(0);

  await runDocker(["exec", sourceContainer, "createdb", "--username=jobtracker", restoreDatabase]);
  try {
    const dump = await readFile(dumpPath);
    await runDocker(
      [
        "exec", "--interactive", toolContainer, "pg_restore",
        "--exit-on-error", "--no-owner", "--no-privileges",
        "--host=127.0.0.1", `--port=${port}`, "--username=jobtracker",
        `--dbname=${restoreDatabase}`,
      ],
      dump.toString("binary"),
    );
    const restoredFingerprint = join(runDirectory!, "restored.json");
    const fingerprintResult = await runProcess(
      process.execPath,
      [fingerprintScript, restoredFingerprint],
      { ...process.env, DATABASE_URL: databaseUrl(testDatabaseUrl(port), restoreDatabase), TZ: "UTC" },
    ).result;
    expect(fingerprintResult).toMatchObject({ code: 0, stderr: "" });
    expect(await readFile(restoredFingerprint, "utf8")).toBe(
      await readFile(fingerprintPath, "utf8"),
    );
  } finally {
    await runDocker(["exec", sourceContainer, "dropdb", "--username=jobtracker", "--if-exists", restoreDatabase]);
  }
}, 30_000);
```

If binary input through `runDocker` proves lossy because that helper currently types input as `string`, add a test-only `Buffer` overload and pass the buffer directly to `child.stdin.end`; do not encode the dump as UTF-8.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm run test:backup:docker -- --runTestsByPath __tests__/scripts/create-snapshot-backup.docker.integration.test.ts
```

Expected: the new test reaches the 15-second bound because the dump child remains stopped. Confirm with a container process-state query that the recorded PID is `T`; terminate the test-owned process/container through existing cleanup.

- [ ] **Step 3: Commit the RED test**

```bash
git add __tests__/scripts/create-snapshot-backup.docker.integration.test.ts
git commit -m "test: reproduce stopped production dump"
```

### Task 2: Remove the lost-CONT race

**Files:**
- Modify: `scripts/create-snapshot-backup.mjs`
- Test: `__tests__/scripts/create-snapshot-backup.docker.integration.test.ts`

- [ ] **Step 1: Replace only the Docker start wrapper**

Replace `DOCKER_DUMP_WRAPPER` with the stable-PID implementation below. Keep `DOCKER_STOP_WRAPPER`, credential transport, supervisor, and snapshot flow unchanged.

```js
const DOCKER_DUMP_WRAPPER = [
  "set -eu",
  "pidfile=$1; startfile=$2; cancelfile=$3; shift 3",
  "umask 077",
  "terminate() { exit 143; }",
  "trap terminate INT TERM HUP",
  "printf '%s\\n' \"$$\" > \"$pidfile\"",
  "while [ ! -e \"$startfile\" ]; do",
  "  [ -e \"$cancelfile\" ] && exit 143",
  "  sleep 0.05",
  "done",
  "[ -e \"$cancelfile\" ] && exit 143",
  "trap - INT TERM HUP",
  "exec pg_dump \"$@\"",
].join("\n");
```

The `exec` preserves the PID already written to the pidfile, so remote cleanup targets the waiting shell or `pg_dump` without a child handoff.

- [ ] **Step 2: Run the focused GREEN tests**

```bash
npm run test:backup:docker
RUN_BACKUP_INTEGRATION=1 npm test -- --runInBand __tests__/scripts/create-snapshot-backup.integration.test.ts
npm test -- --runInBand __tests__/ci/production-backup-workflow-contract.test.ts
```

Expected: normal completion and both SIGINT/SIGTERM cleanup cases pass; no credentials, control files, partial outputs, database sessions, locks, or `pg_dump` processes remain.

- [ ] **Step 3: Run the mutation check**

Temporarily restore the self-`STOP`/immediate-`CONT` sequence, rerun only the new normal-completion test, and require it to fail by timeout. Restore the stable wrapper and require the test to pass again.

- [ ] **Step 4: Commit the minimal fix**

```bash
git add scripts/create-snapshot-backup.mjs __tests__/scripts/create-snapshot-backup.docker.integration.test.ts
git commit -m "fix: start production dumps without signal race"
```

### Task 3: Remediate dependency advisories

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Record the failing baseline**

```bash
npm run check:audit
```

Expected: non-zero with full `high=6`, `moderate=1`, production `high=5`.

- [ ] **Step 2: Add the exact overrides**

Keep the existing scoped `minimatch@3.1.5` override and add:

```json
"@humanfs/node": "0.16.8",
"browserslist": "4.28.8",
"deepmerge-ts": "8.0.2",
"fast-uri": "3.1.6",
"mysql2": "3.24.3"
```

- [ ] **Step 3: Regenerate and reinstall from the lockfile**

```bash
npm install --package-lock-only
rm -rf node_modules
npm ci
```

Expected: install exits zero without `--force`; direct Prisma remains `7.9.1`.

- [ ] **Step 4: Verify the audit graph**

```bash
npm run check:audit
npm ls @humanfs/node browserslist deepmerge-ts fast-uri mysql2 prisma
```

Expected: full and production high/critical counts are zero, exceptions remain zero, and the five packages resolve to the exact versions above.

- [ ] **Step 5: Commit dependency remediation**

```bash
git add package.json package-lock.json
git commit -m "fix: remediate dependency security advisories"
```

### Task 4: Align the closed identity gate example

**Files:**
- Modify: `.env.example`
- Modify: `__tests__/docs/operations-docs-contract.test.ts`

- [ ] **Step 1: Add a failing documentation contract**

```ts
expect(readFileSync(join(root, ".env.example"), "utf8")).toContain(
  'APPLICATION_IDENTITY_WRITES_ENABLED="0"',
);
```

Run:

```bash
npm test -- --runInBand __tests__/docs/operations-docs-contract.test.ts
```

Expected: FAIL because `.env.example` omits the rollout gate.

- [ ] **Step 2: Add the safe default**

Append exactly:

```dotenv
APPLICATION_IDENTITY_WRITES_ENABLED="0"
```

- [ ] **Step 3: Run GREEN and commit**

```bash
npm test -- --runInBand __tests__/docs/operations-docs-contract.test.ts
git add .env.example __tests__/docs/operations-docs-contract.test.ts
git commit -m "docs: expose the closed identity rollout gate"
```

### Task 5: Run the complete repository gate

**Files:** None unless a test exposes a scoped defect.

- [ ] **Step 1: Run every local gate from a clean install**

```bash
rm -rf node_modules
npm ci
npm run check:audit
npx prisma generate
npx prisma validate
npm run check:extension
npm run test:ci
npm run test:backup:docker
npm run lint -- --max-warnings=0
npm run typecheck
npm run build
npm run check:startup-env
git diff --check
```

Expected: every command exits zero. Do not weaken a gate; fix only a demonstrated, in-scope defect and rerun the affected focused test before repeating the complete gate.

- [ ] **Step 2: Record repository state**

```bash
git status --short --branch
git log --oneline --decorate -8
```

Expected: only committed recovery changes on `codex/production-recovery-2026-09-03`, with no generated or secret files.
