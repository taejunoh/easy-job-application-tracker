# Read-only Release Security Patches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the newly reported Next.js and Handlebars audit blockers before the approved gate-preserving read-only production release.

**Architecture:** Update only compatible runtime/transitive patch releases. Keep the exact Next lint consumer, private adapter 1.0.1, its immutable archive, and all audit policy/gate behavior unchanged. Production remains identity=0,writes=0; database, credentials, migrations and positive mutation smoke are outside this patch.

**Tech Stack:** Node 22, Next.js 16.3.8, npm lockfile v3, Jest 30, Vercel, PostgreSQL.

## Evidence and boundaries

- Starting source: `8a368730d1b1b2c7281a8535862016eac0e646e1`; base/live main: `5e5610944698e18230c8e67378dda35d8eb311f8`.
- Fresh unchanged-source audit on October 13: full critical=1/high=1; production high=1; zero exceptions. This is the red security gate, not a waived finding.
- Handlebars 4.7.9 is reached through ts-jest 29.4.9; 4.7.10 satisfies its existing range. Next 16.3.6 is fixed by 16.3.8. No Next 16.4 upgrade is required.
- Keep `eslint-config-next` and `@next/eslint-plugin-next` 16.3.6: their manifests permit the patched runtime, and retaining them avoids unnecessary adapter-contract migration.
- The October 7 pre-deployment timeout run remains a failed historical record. A sleep-inhibited baseline is running; do not edit tracked source or install dependencies until it finishes.

## Task 1: Narrow dependency patch (fast worker)

**Files:**
- Modify: `package.json`.
- Generate narrowly: `package-lock.json`.
- Modify/Test: `__tests__/dependencies/version-contract.test.ts`.
- Do not modify any adapter, audit policy, CI, app, Prisma or production configuration file.

- [x] Wait for the orchestrator's baseline-complete signal.
- [x] Update the existing test's runtime `next` and `@next/env` expected literals from `16.3.6` to `16.3.8`, keeping lint expectations at `16.3.6`. Replace its last test with:

```typescript
it("keeps patched Next runtime separate from the reviewed lint consumer", () => {
  expect(packageJson.dependencies.next).toBe("16.3.8");
  expect(packageJson.dependencies["@next/env"]).toBe("16.3.8");
  expect(packageJson.devDependencies["eslint-config-next"]).toBe("16.3.6");
  expect(packageLock.packages["node_modules/next"]?.version).toBe("16.3.8");
  expect(packageLock.packages["node_modules/@next/env"]?.version).toBe("16.3.8");
  expect(packageLock.packages["node_modules/eslint-config-next"]?.version).toBe("16.3.6");
});
```

- [x] Run `npm test -- --runInBand __tests__/dependencies/version-contract.test.ts`. Require the intended runtime-version failures before changing the manifest.
- [x] Use apply_patch to change only these manifest values:

```json
"@next/env": "16.3.8",
"next": "16.3.8"
```

- [x] Regenerate the lock with `npm install --package-lock-only --ignore-scripts`, then `npm update handlebars --package-lock-only --ignore-scripts`. Require Handlebars 4.7.10; if another version or unrelated graph change appears, stop and report rather than widening scope.
- [x] Review the lock package/version delta: only the required Next runtime/platform/env graph and Handlebars may change. Do not delete the lock or manually fabricate package metadata.
- [x] Run normal `npm ci`, `npm ls --all` and `npm run check:audit`; require installation/peer validity and full/production zero findings with zero exceptions.
- [x] Run the existing version, adapter, NYC and Docker artifact tests:

```bash
npm test -- --runInBand __tests__/dependencies/version-contract.test.ts __tests__/dependencies/next-root-glob.test.ts __tests__/dependencies/nyc-yaml-compat.test.ts __tests__/dependencies/docker-local-package.test.ts
git diff --check
```

- [x] Self-review and commit only the three owned paths using `git commit --only`; report exact SHA, red/green proof, graph delta and any failures. Root owns the full new-head regression and production operations.
- [x] Independent specification review, then independent high-risk quality review; resolve findings before publishing.
- [x] Preserve the existing CI version contract by updating only `@next/env` and `next` expected values at `__tests__/ci/workflow-contract.test.ts` to `16.3.8`. The first four-suite documentation/CI run exposed this stale assertion (60 passed, one failed). Keep lint 16.3.6 and every workflow/gate assertion unchanged; verify the affected suites, commit only this follow-up path and review it independently.

## Task 2: Frozen-source release verification (orchestrator)

- [x] Record the patch evidence without relabeling old audit/test failures; commit this plan/evidence before final source freeze.
- [x] Run lint, dummy-environment typecheck/build, startup and extension checks. Do not use Production credentials for local builds/tests.
- [ ] Run `caffeinate -i npm run test:ci -- --json --outputFile=.artifacts/onboarding/predeploy-patched-2026-10-13-jest.json`; require zero failures. This uses the unchanged CI-standard serial runner, not skipped tests or longer deadlines. The parallel baseline's short-deadline monitor fixture failure is recorded separately; its unchanged isolated case passed. If the failure also reproduces in serial, diagnose and repair the fixture before release rather than retrying blindly.
- [ ] Push the same PR branch without force and require all new-head CI checks. Update PR evidence rather than committing only live-CI status and triggering a verification loop.
- [ ] Preserve the unrelated dirty primary checkout and private local preview configuration/data.

## Task 3: Approved read-only production release (operator after root GO)

This document is the pre-publication verification checkpoint. The remaining live full-suite/CI/release results are recorded in PR #12 rather than a status-only source commit that triggers another deployment cycle.

- [ ] Refresh protected production preflight and verified backup within 24 hours. Require Node 22, explicit gates 0/0, safe environment flags absent/0, authenticated reads, current migrations and empty schema diff.
- [ ] Record the current hardened Ready 0/0 deployment as rollback anchor. Record original autoAssignCustomDomains, temporarily set false and read it back; prove canonical still owns the old deployment.
- [ ] Merge reviewed PR; select only the exact new-main Production Ready zero-alias candidate. Require immutable candidate configuration, auth/CORS/read matrix, safe stopped-write probes and all-table fingerprint parity before promotion.
- [ ] Promote that exact candidate; recheck canonical deployment/SHA, authentication, reads, CORS, expected writes_stopped responses and database parity. Exclude only deliberate verified stopped-write 503 probes from the unrelated-5xx log gate.
- [ ] Restore and verify the original auto-assign setting when no concurrent production build can supersede the candidate. Remove owned private credential workspace; preserve backup identity and unrelated files.
- [ ] Report deployment URL/identity and read-only acceptance. Positive CRUD, valid pairing/extension-save and write-resume validation are explicitly deferred, never reported as passed.
