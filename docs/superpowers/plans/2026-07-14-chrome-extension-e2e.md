# Chrome Extension End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exercise the real Manifest V3 extension in bundled Chromium and verify the installed Chrome extension against Production.

**Architecture:** A safety-guarded Node runner launches an isolated PostgreSQL database, copies the extension into a temporary profile, discovers its dynamic origin from the MV3 service worker, starts Next with exact CORS, and drives the popup against a deterministic Lever fixture. CI uses bundled Chromium; system Chrome is reserved for the final optional-permission smoke.

**Tech Stack:** Playwright 1.59, Chromium persistent contexts, Chrome MV3, PostgreSQL 16, Next.js 16, Jest, GitHub Actions.

---

### Task 1: Define E2E safety helpers with TDD

**Files:**
- Create: `scripts/extension-e2e-support.mjs`
- Create: `__tests__/scripts/extension-e2e-support.test.ts`

- [ ] **Step 1: Write failing tests**

Import `assertSafeExtensionE2EEnvironment`, `buildE2EManifest`, `extensionIdentityFromWorkerUrl`, and `parseDockerPort` from the missing support module. Test a valid 32-letter extension origin, rejection of HTTP worker URLs, insertion of required loopback host permission, explicit loopback/database-name/sentinel guards, and rejection of Neon or ambiguous URLs.

- [ ] **Step 2: Run RED**

Run `npm test -- --runInBand __tests__/scripts/extension-e2e-support.test.ts`. Expected: module-not-found failure.

- [ ] **Step 3: Implement the helpers**

Accept destructive execution only when:

```text
RUN_EXTENSION_E2E=1
ALLOW_DESTRUCTIVE_EXTENSION_E2E=jobtracker-extension-e2e-delete-all
database host is 127.0.0.1 or localhost
database has an explicit numeric port
database name is jobtracker_extension_e2e_test
EXPECTED_DATABASE_SERVER_ADDRESS matches the live server
```

- [ ] **Step 4: Run GREEN and commit**

Run the focused test and commit as `test: define extension e2e safety contracts`.

### Task 2: Add the deterministic supported-site fixture

**Files:**
- Create: `scripts/extension-e2e-fixtures.mjs`

- [ ] **Step 1: Define fixture constants**

Use URL `https://jobs.lever.co/jobtracker-e2e/senior-platform-engineer`, fixed non-production test secrets, and Lever selectors matching current `content.js`. Expected fields are Senior Platform Engineer, JobTracker E2E, New York NY, Remote, salary range, and two description paragraphs.

- [ ] **Step 2: Commit the isolated fixture**

Run syntax validation and commit as `test: add deterministic extension e2e fixture`.

### Task 3: Implement the real MV3 runner

**Files:**
- Create: `scripts/extension-e2e.mjs`
- Modify: `.gitignore`

- [ ] **Step 1: Observe RED**

Run `node scripts/extension-e2e.mjs` before creating it and record the expected missing-module failure.

- [ ] **Step 2: Build the orchestration**

Implement this fixed order: validate sentinels and live DB identity; deploy migrations; clear only the isolated database; copy the extension; add required loopback host permission to the copied manifest; launch bundled Chromium persistent context; discover extension ID; start Next on `127.0.0.1:3100` with exact CORS; route the Lever fixture; open the real action popup; drive the journeys; clean all resources in `finally`.

- [ ] **Step 3: Drive required popup journeys**

Assert extraction, invalid-token rejection without persistence, successful pairing, emptied token input, save and DB equality, connection restoration after popup reopen, disconnect invalidation, and absence of an access token after disconnect.

- [ ] **Step 4: Bound and sanitize diagnostics**

Save only a token-cleared popup screenshot and diagnostics containing step, browser version, and extension ID. Never persist HAR, trace, Authorization headers, resume text, or application descriptions. Ignore `/.artifacts/extension-e2e/`.

- [ ] **Step 5: Commit**

Run the runner against an isolated database, verify no child process/profile/row remains, and commit as `test: exercise extension pairing and save flow in chromium`.

### Task 4: Add one-command local PostgreSQL isolation

**Files:**
- Create: `scripts/extension-e2e-local.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Add scripts and observe RED**

Add `test:extension:e2e` and `test:extension:e2e:local` package scripts before the local wrapper exists; run the local command and observe module-not-found.

- [ ] **Step 2: Implement the Docker wrapper**

Start `postgres:16-alpine` with a random loopback port and database `jobtracker_extension_e2e_test`, obtain the host port and container IP, wait for `pg_isready`, pass all sentinels to the runner, and always `docker rm --force` in `finally`.

- [ ] **Step 3: Run GREEN and commit**

Run `npm run test:extension:e2e:local`; require every journey to pass and no container to remain. Commit as `test: add disposable local extension e2e command`.

### Task 5: Add the CI browser job with TDD

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `__tests__/ci/workflow-contract.test.ts`

- [ ] **Step 1: Write failing workflow assertions**

Require a separate `extension-e2e` job with PostgreSQL 16, database `jobtracker_extension_e2e_test`, Node 22.22.2, Playwright Chromium installation, live container-address capture, the exact destructive sentinels, `npm run test:extension:e2e`, and a sanitized seven-day failure artifact.

- [ ] **Step 2: Run RED**

Run `npm test -- --runInBand __tests__/ci/workflow-contract.test.ts`; expected failure is the absent job.

- [ ] **Step 3: Implement the job**

Reuse pinned checkout/setup-node actions and `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02`. Reference no Production secret.

- [ ] **Step 4: Run GREEN and commit**

Run the contract test and YAML parser checks. Commit as `ci: verify extension e2e in bundled chromium`.

### Task 6: Document and execute the installed-Chrome smoke

**Files:**
- Create: `docs/operations/chrome-extension-smoke.md`
- Modify: `README.md`

- [ ] **Step 1: Write the cleanup-first runbook**

Document canonical origin, verified local extension ID, production readiness preconditions, optional host permission approval/removal, unique smoke row marker, invalid token rejection, and unconditional row/permission/credential cleanup.

- [ ] **Step 2: Run the smoke in the user's installed Chrome**

Reload the unpacked extension, pair to Production, approve optional host access, extract a real supported listing, save one marked row, confirm it in the app, reopen the popup to verify connection restoration, disconnect, verify host access removal, reject a bad token, and delete the row.

- [ ] **Step 3: Commit docs**

Add local headed/headless commands to README and commit as `docs: add extension e2e and production smoke runbook`.

### Task 7: Verify the complete E2E gate

**Files:**
- Verify all E2E files

- [ ] **Step 1: Run focused and full checks**

```bash
npm run check:extension
npm test -- --runInBand __tests__/scripts/extension-e2e-support.test.ts
npm test -- --runInBand __tests__/ci/workflow-contract.test.ts
npm run test:ci -- --silent
npm run test:extension:e2e:local
npm run lint
npm run typecheck
npm run build
```

- [ ] **Step 2: Verify cleanup and secrets**

Require no Docker container, Next child, temporary browser profile, DB row, Authorization header, or secret-bearing artifact. Run `git diff --check` and a secret-pattern scan before handoff.
