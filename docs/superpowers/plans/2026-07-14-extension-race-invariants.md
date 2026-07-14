# Extension Race Invariants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make extension credential, permission, and UI mutations obey newest-generation-wins, durable disconnect, and retried permission-cleanup invariants.

**Architecture:** Keep one serialized credential mutation queue. Start the permission request synchronously in the Connect click handler, then keep verification, commit-time permission validation, record commit, old-origin cleanup, and success status in the queued transaction. Store active or invalidated credentials and pending cleanup origins in one local record; use a secret-free session tombstone only to prevent resurrection when explicit disconnect cannot update local storage.

**Tech Stack:** Manifest V3 Chrome extension APIs, plain JavaScript, Jest with a stateful `vm` harness.

---

### Task 1: Stateful race reproductions

**Files:**
- Modify: `__tests__/extension/popup-lifecycle.test.ts`

- [x] **Step 1: Extend the harness with deferred local reads, per-call permission behavior, shared local/session/grant state, and popup event access.**

  The harness must let tests defer `storage.local.get`, reopen against the same `storageState`, `sessionState`, and `grantedOrigins`, reject selected set/remove calls, and resolve permission cleanup after a newer request starts.

- [x] **Step 2: Add deferred RED tests named after the four invariants.**

  Cover delayed startup read versus B pairing, same-origin reconnect versus old 401, connect cleanup versus new-generation 401, explicit disconnect set+remove failure followed by reopen, persistent cleanup retry on reopen, trusted-storage purge success/failure, revoked startup permission, captured no-resume settings URL, and stale save target suppression.

- [x] **Step 3: Run the focused lifecycle suite and record expected failures.**

  Run: `npm test -- --runInBand __tests__/extension/popup-lifecycle.test.ts`

  Expected: new cases fail for stale storage restore, permission/status races, missing cleanup persistence/session tombstone, missing purge, and stale UI targets.

### Task 2: Credential state machine

**Files:**
- Modify: `extension/popup.js`
- Test: `__tests__/extension/popup-lifecycle.test.ts`

- [x] **Step 1: Introduce explicit state and record helpers.**

  Add `pendingStoredCredential`, an in-memory disconnect tombstone, secret-free `storage.session` tombstone helpers, normalized `pendingCleanupOrigins`, safe purge helpers, and generation predicates. `setConnectionStatus` enables Disconnect for either active or pending stored credentials.

- [x] **Step 2: Make startup snapshot and verification generation-safe.**

  Capture generation before `storage.local.get`; after every await, mutate only through the queue and only if the generation remains current. Check session tombstone and `permissions.contains` before verification. Network/403 leaves the credential inactive but purgeable; 401 and revoked permission persist invalidation.

- [x] **Step 3: Make Connect one queued credential transaction.**

  Start `permissions.request` synchronously in the click handler. Queue permission result, verify, commit-time `contains`, record write, old-origin cleanup persistence/retry, and success status. If commit-time permission is absent, do not store the token and instruct the user to click Connect again. Render Connected only when the committed epoch and active connection still match.

- [x] **Step 4: Harden disconnect and 401 invalidation.**

  Explicit disconnect writes a session tombstone before local mutation, falls back from invalidated-record set to removing all known credential keys, and retains the in-memory tombstone when storage APIs fail. All permission removal failures are added to `pendingCleanupOrigins`; successful retry removes them from the record.

- [x] **Step 5: Guard post-request UI effects.**

  Build no-resume Settings links from the captured authenticated request origin. Apply save success status and View target only if the captured connection is still the active generation.

- [x] **Step 6: Run the focused extension suites until green.**

  Run: `npm test -- --runInBand __tests__/extension`

  Expected: all extension suites pass.

### Task 3: Background fail-closed purge

**Files:**
- Modify: `extension/background.js`
- Modify: `__tests__/extension/background.test.ts`

- [x] **Step 1: Add RED tests for credential purge after `setAccessLevel` rejection and handled purge rejection.**

  Run: `npm test -- --runInBand __tests__/extension/background.test.ts`

  Expected: failure because the background currently catches access-level rejection without removing known keys.

- [x] **Step 2: Implement minimal background purge.**

  On trusted-access failure, remove `connection`, `serverUrl`, and `accessToken`; catch removal failure so no unhandled rejection occurs. The background never reads or uses a credential in this path.

- [x] **Step 3: Re-run the background suite.**

  Run: `npm test -- --runInBand __tests__/extension/background.test.ts`

  Expected: pass.

### Task 4: Design and complete verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-13-deployment-hardening-design.md`

- [x] **Step 1: Document the four invariants and failure-state schema.**

  Specify generation capture before startup reads, queued Connect atomicity and commit-time permission validation, session tombstone behavior, inactive pending startup credentials, and persistent cleanup retry.

- [x] **Step 2: Self-review production and tests against every requested race.**

  Inspect the cached diff for stale post-await writes, secret-bearing URLs/logging/session keys, and storage return values that are ignored.

- [x] **Step 3: Run fresh full verification.**

  Run: `npm test -- --runInBand && npm run lint && npm run build && npx tsc --noEmit && npx eslint extension/popup.js extension/background.js __tests__/extension/popup.test.ts __tests__/extension/popup-lifecycle.test.ts __tests__/extension/background.test.ts && node --check extension/popup.js && node --check extension/background.js && git diff --check`

  Expected: exit 0; report any pre-existing lint warnings separately.

- [ ] **Step 4: Commit the scoped change.**

  Run: `git add extension/popup.js extension/background.js __tests__/extension/popup-lifecycle.test.ts __tests__/extension/background.test.ts docs/superpowers/specs/2026-07-13-deployment-hardening-design.md docs/superpowers/plans/2026-07-14-extension-race-invariants.md && git commit -m "fix(extension): enforce credential race invariants"`
