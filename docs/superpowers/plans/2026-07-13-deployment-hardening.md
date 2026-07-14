# Hosted Deployment Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the single-user hosted JobTracker safe to expose publicly while preserving the in-progress extension reliability work.

**Architecture:** The web UI authenticates with a signed HttpOnly session and the extension uses a Bearer token after per-origin permission and verification. Shared server-only helpers enforce environment validation, exact CORS, authentication, bounded public-network fetching, and upload limits; existing Route Handlers keep their successful payloads.

**Tech Stack:** Next.js 16 App Router, TypeScript, Node crypto/net/dns, Prisma 7/PostgreSQL, Jest 30, Chrome Manifest V3, GitHub Actions.

**Design:** `docs/superpowers/specs/2026-07-13-deployment-hardening-design.md`

---

### Task 0: Restore a runnable test baseline

**Files:**
- Delete: `jest.config.ts`
- Create: `jest.config.cjs`
- Restore: `package-lock.json` to `HEAD`

- [ ] Confirm the existing failure with `npm test -- --runInBand`; expected: Jest reports that `ts-node` is required to read `jest.config.ts`.
- [ ] Restore only the incidental npm 10 lockfile churn and confirm `git diff -- package-lock.json` is empty.
- [ ] Replace the TypeScript config with CommonJS while retaining `preset: "ts-jest"`, `testEnvironment: "node"`, the `@/` mapper, and current test match.

```js
/** @type {import("jest").Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleNameMapper: { "^@/(.*)$": "<rootDir>/src/$1" },
  testMatch: ["**/__tests__/**/*.test.ts"],
};
```

- [ ] Run `npm test -- --runInBand`; expected: all 3 existing suites and 11 tests pass.
- [ ] Commit only the Jest config rename: `git commit -m "test: restore Jest configuration baseline"`.

### Task 1: Characterize and preserve extension messaging reliability

**Files:**
- Create: `__tests__/extension/content.test.ts`
- Create: `__tests__/extension/popup.test.ts`
- Modify only as needed for testability: `extension/content.js`, `extension/popup.js`

- [ ] Add a VM-based Chrome mock test that executes `content.js` twice and expects `chrome.runtime.onMessage.addListener` once.
- [ ] Add popup tests for first-send success, inject-and-retry success, retry failure, and use by extraction/keyword/profile flows.
- [ ] Run `npm test -- --runInBand __tests__/extension`; expected RED until popup helpers are exported or injected for tests.
- [ ] Make the smallest wrapper/export change that does not alter browser behavior and preserves `window.__jobTrackerInjected` plus one retry only.
- [ ] Run the extension tests and the full suite; expected PASS.
- [ ] Commit the pre-existing reliability diff and characterization tests: `git commit -m "fix(extension): retry missing content scripts safely"`.

### Task 2: Validate server-only environment configuration

**Files:**
- Create: `src/lib/server-env.ts`
- Create: `__tests__/lib/server-env.test.ts`
- Modify: `.env.example`, `README.md`

- [ ] Write tests for valid production/local configs and rejection of missing or weak `DATABASE_URL`, `ENCRYPTION_SECRET`, `APP_ACCESS_TOKEN`, `APP_BASE_URL`, and `CORS_ALLOWED_ORIGINS`.
- [ ] Run the focused test; expected RED because `parseServerEnv` is absent.
- [ ] Implement `parseServerEnv(source, nodeEnv)` and lazy `getServerEnv()` without exposing values in error messages.
- [ ] Require PostgreSQL, 32-byte secrets, HTTPS outside localhost, exact origins, and inclusion of the app origin.
- [ ] Update `.env.example` and README generation instructions without committing real secrets.
- [ ] Run focused and full tests; expected PASS. Commit: `feat(security): validate hosted deployment environment`.

### Task 3: Add authentication and session primitives

**Files:**
- Create: `src/lib/security/auth.ts`
- Create: `__tests__/lib/security/auth.test.ts`

- [ ] Write RED tests for timing-safe Bearer validation, signed session issue/verify, expiry, tampering, and invalidation after token rotation.
- [ ] Implement `verifyBearerToken`, `createSessionToken`, `verifySessionToken`, and cookie constants using SHA-256/HMAC-SHA-256.
- [ ] Write RED tests for `authenticateApiRequest` accepting Bearer or cookie and rejecting cookie-authenticated unsafe methods with the wrong origin.
- [ ] Implement the request guard with stable `unauthorized` and `origin_not_allowed` errors.
- [ ] Run focused and full tests; expected PASS. Commit: `feat(security): add API and session authentication`.

### Task 4: Centralize exact CORS handling

**Files:**
- Create: `src/lib/security/cors.ts`
- Create: `__tests__/lib/security/cors.test.ts`

- [ ] Write RED tests for exact allowed origins, unknown/`null` origins, absent origin, `Vary: Origin`, credentials only for app origin, and `Authorization` preflight support.
- [ ] Implement `corsHeaders(request, methods)` and `corsPreflight(request, methods)` from validated env.
- [ ] Ensure unknown actual origins return a structured 403 before business logic and no function emits `*`.
- [ ] Run focused and full tests; expected PASS. Commit: `feat(security): enforce exact CORS origins`.

### Task 5: Build the web connection flow

**Files:**
- Create: `src/app/api/auth/session/route.ts`
- Create: `src/app/api/auth/verify/route.ts`
- Create: `src/app/connect/page.tsx`
- Create: `src/proxy.ts`
- Create: `__tests__/api/auth.test.ts`

- [ ] Write route tests for successful/failed session creation, secure cookie attributes, logout origin checks, and Bearer verification.
- [ ] Run focused tests; expected RED because routes do not exist.
- [ ] Implement session POST/DELETE and extension verify POST with stable error payloads.
- [ ] Add a password-style connect page that never stores or logs the token and redirects after success.
- [ ] Add a UX-only proxy redirect for protected pages; exclude `/connect`, `/api`, Next assets, and public files.
- [ ] Run focused tests, typecheck, and full tests; expected PASS. Commit: `feat(auth): add single-user connect flow`.

### Task 6: Protect every existing API route

**Files:**
- Modify: all seven route files under `src/app/api/`
- Create: `__tests__/api/protected-routes.test.ts`

- [ ] Add a table-driven RED test importing every product route and asserting anonymous requests return 401 before Prisma, LLM, fetch, or parsing calls.
- [ ] Apply the shared auth/origin/CORS guard to applications, application detail, extract, keyword analysis, parse-resume, settings, and stats.
- [ ] Ensure every success and error response for an allowed extension origin carries readable CORS headers.
- [ ] Remove all route-local wildcard CORS constants; verify with `rg 'Access-Control-Allow-Origin.*\\*' src/app/api` returning no matches.
- [ ] Run API and full tests; expected PASS. Commit: `feat(security): protect product API routes`.

### Task 7: Pair and authenticate the Chrome extension

**Files:**
- Modify: `extension/manifest.json`, `extension/popup.html`, `extension/popup.js`
- Extend: `__tests__/extension/popup.test.ts`

- [ ] Write RED tests for per-origin `chrome.permissions.request`, permission denial, verify failure, atomic storage after success, Bearer headers on all API calls, 401 token clearing, and server URL preservation.
- [ ] Add `optional_host_permissions` without `<all_urls>`.
- [ ] Add server URL, password token field, and Connect state; normalize to an origin and require HTTPS outside localhost.
- [ ] Implement `apiFetch(path, init)`, request only `${origin}/*`, verify before storing, remove obsolete origin permission after a server change, and never render the stored token.
- [ ] Upgrade existing localhost storage without losing the server URL; a missing token shows connection UI.
- [ ] Run extension and full tests; expected PASS. Commit: `feat(extension): add secure server pairing`.

### Task 8: Enforce safe public-network fetching

**Files:**
- Create: `src/lib/security/ip-address.ts`
- Create: `src/lib/security/safe-fetch.ts`
- Create: `__tests__/lib/security/ip-address.test.ts`
- Create: `__tests__/lib/security/safe-fetch.test.ts`
- Modify: `src/app/api/extract/route.ts`

- [ ] Write RED table tests for blocked IPv4/IPv6 ranges, credentials, non-80/443 ports, and unsupported schemes.
- [ ] Implement pure address classification and URL policy functions.
- [ ] Write adapter-driven RED tests for connect-time DNS selection, mixed DNS answers, redirect revalidation/limit, 10s request and 20s chain budgets, MIME checks, and streamed 2 MiB limits.
- [ ] Implement `safeFetchJobUrl` with injected resolver/transport for deterministic tests; follow at most three redirects manually and never forward credentials.
- [ ] Replace direct `fetch(url)` in extraction and map policy failures to the specified 413/415/422/504 codes.
- [ ] Run focused, API, and full tests; expected PASS. Commit: `feat(security): harden job URL extraction`.

### Task 9: Bound resume uploads and parsing

**Files:**
- Create: `src/lib/resume/upload-policy.ts`
- Create: `src/lib/resume/parse-resume.ts`
- Create: `__tests__/lib/resume/upload-policy.test.ts`
- Create: `__tests__/lib/resume/parse-resume.test.ts`
- Modify: `src/app/api/parse-resume/route.ts`

- [ ] Write RED tests for 6 MiB envelope/5 MiB file limits, signature/MIME mismatch, invalid UTF-8, 100-page, 500k-character, and 15-second deadline failures.
- [ ] Implement bounded multipart consumption before full buffering and isolated text/PDF parsing with cleanup on every exit path.
- [ ] Make the route explicitly Node runtime and map failures to stable 413/415/422 errors.
- [ ] Use small generated fixtures only; no real resume or personal data enters the repository.
- [ ] Run focused and full tests; expected PASS. Commit: `feat(security): bound resume parsing resources`.

### Task 10: Check in the PostgreSQL baseline migration

**Files:**
- Create: `prisma/migrations/20260713000000_init/migration.sql`
- Modify: `README.md`

- [ ] Generate SQL from the checked-in schema without applying it to the user's database and review table/default/timestamp parity.
- [ ] Validate on a disposable PostgreSQL database: `npx prisma migrate deploy`; expected one applied migration and both tables present.
- [ ] Document fresh deploy plus existing `db push` baseline using schema diff, backup, and `prisma migrate resolve --applied`.
- [ ] Run `npx prisma validate` and the disposable migration check again. Commit: `feat(db): add initial PostgreSQL migration`.

### Task 11: Add CI and final integration coverage

**Files:**
- Create: `.github/workflows/ci.yml`
- Create/extend: `__tests__/api/*.test.ts`
- Modify: `package.json`, `README.md`

- [ ] Add integration tests for authenticated CRUD/settings/stats, allowed/denied origins, SSRF rejection, and representative bounded resume parsing with external services mocked.
- [ ] Add scripts for `typecheck` and deterministic CI tests without changing dependency versions.
- [ ] Configure Node 22, `npm ci`, PostgreSQL service, generated non-secret test env, `prisma migrate deploy`, test, lint, typecheck, and build.
- [ ] Run locally: `npm ci`, `npm run lint`, `npm run typecheck`, `npm test -- --runInBand`, `npx prisma validate`, and `npm run build`.
- [ ] Confirm `rg -n '(APP_ACCESS_TOKEN|ENCRYPTION_SECRET|apiKey).*=' --glob '!package-lock.json'` contains no committed secret values.
- [ ] Commit: `ci: verify hosted deployment security baseline`.

## Final Review Gate

- [ ] Spec reviewer confirms every design completion criterion is represented by code and tests.
- [ ] Code-quality reviewer inspects authentication, CORS, SSRF, upload boundaries, extension permission scope, and migration safety.
- [ ] Fresh full verification output is captured; no task is reported complete from an earlier run.
- [ ] No push, deployment, token rotation, or production database operation occurs without explicit user authorization.
