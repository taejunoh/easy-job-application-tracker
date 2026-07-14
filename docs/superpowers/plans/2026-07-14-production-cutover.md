# Production Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve all existing Neon data, establish a correct Prisma migration baseline, and promote the authenticated build to the canonical Vercel production alias.

**Architecture:** Run every Prisma command from the clean linked worktree, create and restore-test a custom-format dump before writes, compare pre/post database fingerprints, then configure and stage Production without moving aliases. Promote only after security and data smoke tests pass.

**Tech Stack:** PostgreSQL 17/18 client tools, Neon, Prisma 7, Next.js 16, Vercel CLI 56, Node.js 22.

---

### Task 1: Establish private execution and backup paths

**Files:**
- Read: `/Users/taejunoh/Desktop/LFG/easy-job-application-tracker/.env`
- Write outside Git: `~/Library/Application Support/easy-job-application-tracker/backups/<UTC timestamp>/`

- [ ] **Step 1: Verify the clean worktree and migration set**

Run:

```bash
git status --short
test "$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" = "1"
test -f prisma/migrations/20260713000000_init/migration.sql
```

Expected: clean status and exactly one migration directory.

- [ ] **Step 2: Link the ignored local environment without copying secrets**

Run from the linked worktree:

```bash
ln -s ../../.env .env
test -L .env
```

Expected: `.env` resolves to the original ignored file and remains absent from `git status`.

- [ ] **Step 3: Create the private backup run directory**

Run with `umask 077`; create the timestamped directory with mode `0700`. Record its absolute path in the execution log without printing environment values.

### Task 2: Create and restore-test the production backup

**Files:**
- Create outside Git: `neon-pre-cutover.dump`
- Create outside Git: `neon-pre-cutover.dump.sha256`
- Create outside Git: `neon-pre-cutover.toc`
- Create outside Git: `fingerprint.before.json`
- Create outside Git: `fingerprint.restore.json`

- [ ] **Step 1: Validate the target without printing the URL**

Run a Node URL check that accepts only PostgreSQL protocols, a `.neon.tech` host, and a non-empty database name. Query `current_database()`, `inet_server_addr()`, and `inet_server_port()` and retain only non-secret identity metadata.

- [ ] **Step 2: Generate the custom-format dump**

Run:

```bash
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges --file="$BACKUP_FILE"
chmod 600 "$BACKUP_FILE"
pg_restore --list "$BACKUP_FILE" > "$TOC_FILE"
shasum -a 256 "$BACKUP_FILE" > "$CHECKSUM_FILE"
shasum -a 256 -c "$CHECKSUM_FILE"
```

Expected: non-empty dump and TOC, checksum `OK`.

- [ ] **Step 3: Fingerprint the source rows**

Use ordered `row_to_json` digests for `Application` and `Settings`. Save only counts and digests. Assert exactly 153 Applications and one Settings row.

- [ ] **Step 4: Restore into a local scratch database**

Create `jobtracker_restore_<timestamp>` on the local PostgreSQL server, restore with `pg_restore --exit-on-error`, generate the same fingerprint, and compare it byte-for-byte with the source fingerprint. Drop the scratch database only after equality is proven.

Expected: restore succeeds and both fingerprints match.

Stop the entire cutover if any backup, restore, count, or fingerprint check fails.

### Task 3: Baseline the existing Prisma schema

**Files:**
- Modify database metadata only: `public._prisma_migrations`
- Create outside Git: `migration-history.json`
- Create outside Git: `fingerprint.after-baseline.json`

- [ ] **Step 1: Prove schema parity before writing**

Run:

```bash
npx prisma validate
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
npx prisma migrate status
```

Expected: schema diff exits 0 with no difference; status reports only `20260713000000_init` pending.

- [ ] **Step 2: Record the initial migration as applied**

Run:

```bash
npx prisma migrate resolve --applied 20260713000000_init
npx prisma migrate deploy
npx prisma migrate status
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
```

Expected: no pending migrations and no schema difference.

- [ ] **Step 3: Verify history and row immutability**

Assert `_prisma_migrations` contains one finished `20260713000000_init` row with no rollback timestamp. Recompute the production fingerprint and compare it to `fingerprint.before.json`.

Stop if history is not exact or either data digest changes. Never run `migrate reset`, `db push --force-reset`, `resolve --rolled-back`, or `pg_restore --clean` against Production.

### Task 4: Configure Vercel Production secrets and runtime

**Files:**
- Modify external state: Vercel project Production environment
- Create outside Git: `~/Library/Application Support/easy-job-application-tracker/secrets/app-access-token`

- [ ] **Step 1: Pin the Vercel project to Node 22.x**

Use the authenticated Vercel API to PATCH project `prj_07X8CvIQfV3nfjaj6t2ZHA5ZnGmI` with `nodeVersion: "22.x"`; verify with `vercel project inspect`.

- [ ] **Step 2: Preserve the encryption secret and select the access token**

Use the existing local `ENCRYPTION_SECRET` unchanged. Reuse the already-generated local `APP_ACCESS_TOKEN` only if it is at least 32 bytes and has never appeared in tracked files or logs; otherwise generate 48 random bytes into the private token file with mode `0600`.

- [ ] **Step 3: Verify the installed extension ID**

Read the installed unpacked extension identity from Chrome state and require `^[a-p]{32}$`. Expected current ID: `gihbagcjnmkhkekjkbfjhcbddnamaiap`.

- [ ] **Step 4: Set all five Production variables**

Pipe values through stdin so secrets never appear in process arguments:

```text
DATABASE_URL            existing verified Neon URL
ENCRYPTION_SECRET       existing value, unchanged
APP_ACCESS_TOKEN        private token
APP_BASE_URL            https://easy-job-application-tracker.vercel.app
CORS_ALLOWED_ORIGINS    https://easy-job-application-tracker.vercel.app,chrome-extension://gihbagcjnmkhkekjkbfjhcbddnamaiap
```

Verify `vercel env ls production` lists all five names. Do not configure Preview with Production data.

- [ ] **Step 5: Validate the remote environment and build**

Run:

```bash
npx vercel env run -e production -- node -e 'const {validateServerEnv}=require("./src/lib/server-env-core.js"); validateServerEnv(process.env,"production")'
npx vercel env run -e production -- npm run build
```

Expected: both commands exit 0 and a read-only DB check reports 153/1/1 for Applications, Settings, and migrations.

### Task 5: Stage, test, and promote the hardened deployment

**Files:**
- Modify external state: Vercel deployment and production aliases
- Create outside Git: private curl config and smoke evidence

- [ ] **Step 1: Create an alias-free Production deployment**

Run `npx vercel deploy --prod --skip-domain --yes`, capture the URL, and require `vercel inspect` status `Ready`.

- [ ] **Step 2: Run staged read-only security checks**

Using `vercel curl` and a mode-0600 curl config, assert:

```text
GET /api/applications without token       401
GET /api/applications with bad token      401
GET with Origin attacker.invalid          403
GET with valid bearer                     200 and 153 rows
GET /api/settings with valid bearer       200 and hasApiKey=true
OPTIONS from canonical app origin         204
```

- [ ] **Step 3: Promote the staged deployment**

Run `vercel promote <staged-url>` and verify all three production aliases point to the staged deployment ID.

- [ ] **Step 4: Verify the public authentication boundary immediately**

Run a plain public request to `https://easy-job-application-tracker.vercel.app/api/applications` and require `401`. If it returns `200`, re-enable deployment protection or restore the alias to a protected deployment and stop.

- [ ] **Step 5: Run authenticated CRUD and session smoke tests**

Create one uniquely marked Application, PATCH its status, DELETE it in a `finally` cleanup, and verify the row is absent. Create a session through `/api/auth/session`, store cookies in a mode-0600 jar, and verify cookie-authenticated Applications and Settings requests return 200.

- [ ] **Step 6: Check production logs**

Inspect the last ten minutes of Production logs and require no cutover-related 5xx response.

### Task 6: Record sanitized cutover evidence

**Files:**
- Create: `docs/operations/production-cutover-2026-07-14.md`

- [ ] **Step 1: Write non-secret evidence**

Record deployment ID, migration name/count, pre/post row counts, dump checksum prefix, smoke status matrix, backup directory, rollback instructions, and timestamps. Do not record tokens, URLs containing credentials, encrypted payloads, resume text, or row bodies.

- [ ] **Step 2: Verify and commit**

Run `git diff --check`, scan for secret patterns, then commit the sanitized report with message `docs: record production cutover`.
