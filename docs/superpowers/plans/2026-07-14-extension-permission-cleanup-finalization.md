# Extension Permission Cleanup Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finalize idempotent permission cleanup, tombstone transfer, synchronous API failure handling, and generation-safe keyword UI behavior.

**Architecture:** Keep the existing credential queue and single local connection record. Make permission removal idempotent by observing permission state before and after removal, filter the active origin out of pending cleanup during Connect, and transfer a different session tombstone origin into the new active record before clearing the tombstone. Expand only the synchronous call boundaries and add one captured-generation guard to keyword analysis.

**Tech Stack:** Manifest V3 Chrome APIs, plain JavaScript, Jest stateful VM tests.

---

### Task 1: Add focused lifecycle RED coverage

**Files:**
- Modify: `__tests__/extension/popup-lifecycle.test.ts`
- Modify: `__tests__/extension/popup.test.ts`
- Modify: `__tests__/extension/background.test.ts`

- [x] **Step 1: Add tests for M140 and synchronous storage/permission exceptions.**

  Assert manifest minimum Chrome 140, background purge after a missing or synchronously throwing `local.setAccessLevel`, and Connect UI reset after synchronous `permissions.contains` or `permissions.request` exceptions.

- [x] **Step 2: Add stateful cleanup tests.**

  Reopen a same-origin connection whose record contains its active origin in `pendingCleanupOrigins`; assert the permission remains granted and verification runs. Simulate permission removal success followed by record-set failure; reopen and assert the now-absent permission is treated as clean and the marker disappears.

- [x] **Step 3: Add session tombstone transfer and stale keyword tests.**

  Preserve a session-only tombstone for A after failed cleanup, connect B while A cleanup still fails, assert B stores A as pending and clears the tombstone, then reopen and retry A. Defer A keyword analysis, connect B, resolve A, and assert B's UI is unchanged.

- [x] **Step 4: Run focused tests and record RED.**

  Run: `npm test -- --runInBand __tests__/extension`

  Expected: failures identify Chrome version, synchronous throws, active-origin cleanup, idempotent absent permission, tombstone transfer, and stale keyword UI.

### Task 2: Implement surgical lifecycle fixes

**Files:**
- Modify: `extension/manifest.json`
- Modify: `extension/background.js`
- Modify: `extension/popup.js`

- [x] **Step 1: Set the supported browser floor and harden background startup.**

  Set `minimum_chrome_version` to `140`. Put the `local.setAccessLevel` invocation itself inside `try`; route synchronous throws, rejected promises, and missing methods to a purge helper that also catches synchronous and asynchronous removal failures.

- [x] **Step 2: Make permission cleanup idempotent.**

  Before removal, call `permissions.contains`; false means clean, while rejection or synchronous throw remains fail-closed. If `remove` returns false, call `contains` again and accept only a confirmed false result as clean. Existing pending records are then removable on reopen even when permission removal already happened before record persistence failed.

- [x] **Step 3: Normalize Connect pending cleanup.**

  Filter the new active origin from inherited pending origins. Add a different in-memory session tombstone origin to the new record's pending list, clear the tombstone only after the record is stored, and run cleanup for every non-active pending origin while retaining failures.

- [x] **Step 4: Use current working cleanup state at startup.**

  In the matching tombstone path, build invalidation from `workingRecord.pendingCleanupOrigins`, not the stale storage snapshot. This prevents already-clean markers from being reinserted.

- [x] **Step 5: Catch synchronous Connect exceptions and guard keyword UI.**

  Create both direct user-gesture permission calls inside the outer Connect `try` and retain the existing `finally` UI reset. After keyword JSON resolves, require the captured request connection to still equal the active generation before rendering any prompt or analysis result.

- [x] **Step 6: Run focused extension tests until green.**

  Run: `npm test -- --runInBand __tests__/extension`

  Expected: all extension tests pass.

### Task 3: Documentation, self-review, verification, and commit

**Files:**
- Modify: `docs/superpowers/specs/2026-07-13-deployment-hardening-design.md`

- [x] **Step 1: Document M140 and cleanup semantics.**

  Explain that the Chrome reference labels generic `StorageArea.setAccessLevel` as Chrome 102+, while Chromium commit `a8f1f337c692360aaec9470a0a91f965011d37a3` enabled local/sync implementations in the M140 development cycle; therefore the extension requires Chrome 140.

- [x] **Step 2: Self-review each requested invariant.**

  Check active-origin filtering, absent-permission idempotency, marker persistence failure recovery, tombstone A-to-B transfer, synchronous error UI reset, and stale keyword rendering in the scoped diff.

- [x] **Step 3: Run fresh full verification.**

  Run: `npm test -- --runInBand && npm run lint && npm run build && npx tsc --noEmit && npx eslint extension/popup.js extension/background.js __tests__/extension/popup.test.ts __tests__/extension/popup-lifecycle.test.ts __tests__/extension/background.test.ts && node --check extension/popup.js && node --check extension/background.js && git diff --check`

  Expected: exit 0, with only documented pre-existing warnings.

- [x] **Step 4: Commit only extension, tests, plan, and design.**

  Run: `git commit -m "fix(extension): finalize permission cleanup lifecycle"`
