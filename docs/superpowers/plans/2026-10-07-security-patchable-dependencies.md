# Patchable Security Dependencies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Remove published, patchable dependency vulnerabilities without suppressing the audit or forcing incompatible major upgrades.

**Architecture:** Update the existing dependency declarations and reproducible lockfile within supported Node 22 / Next 16 / Jest 30 boundaries. Keep all runtime, lint, test and audit behavior intact. Unpatched dependency removal is a separately reviewed follow-up, not an exception in this task.

**Tech Stack:** npm lockfile v3, Node 22, Next 16.3, Jest 30, ESLint 9.

---

Work only in `/Users/taejunoh/Developer/LFG/easy-job-application-tracker/.worktrees/easy-onboarding`, branch `codex/easy-onboarding`, starting at `54831c00e067e2069a2fd097b534e1dbfa66f69e`. The dirty primary checkout and production are out of scope. The user approved dependency-security remediation after draft PR #12 was blocked by the baseline audit. Do not add audit exceptions, lower severity thresholds, skip CI checks, use `--force` / `--legacy-peer-deps`, or change package identities to hide findings.

## Task 1: Compatible dependency and lockfile patches

**Owned files:** `package.json`, `package-lock.json` only. No parallel worker may edit them.

- [x] Reproduce the baseline with `npm run check:audit` and inspect current `npm audit --json` / `npm audit --omit=dev --json` findings. The observed baseline is full 1 critical / 37 high / 2 moderate and production 1 critical / 6 high; advisory counts are registry-dependent.
- [x] Use `apply_patch` for these declaration changes, preserving all unrelated keys:

```diff
-    "@fastify/busboy": "^3.2.0",
+    "@fastify/busboy": "^3.2.2",
-    "@next/env": "16.3.0",
+    "@next/env": "16.3.6",
-    "next": "16.3.0",
+    "next": "16.3.6",
-    "undici": "7.29.0"
+    "undici": "7.29.1"
-    "eslint-config-next": "16.3.0",
+    "eslint-config-next": "16.3.6",
-    "jest": "^30.3.0",
-    "jest-environment-jsdom": "^30.3.0",
+    "jest": "^30.5.2",
+    "jest-environment-jsdom": "^30.5.2",
-    "fast-uri": "3.1.6",
+    "fast-uri": "3.1.8",
-      "brace-expansion": "1.1.18"
+      "brace-expansion": "1.1.21"
```

- [x] Regenerate the npm lockfile using normal npm dependency tooling. Resolve compatible transitive patches to `sharp@0.35.5`, `source-map-js@1.2.2`, `js-yaml@4.3.2`, legacy `js-yaml@3.15.2` if still present, and `brace-expansion@1.1.21`, `2.1.7`, `5.0.12` in their respective major families. Prefer existing allowed ranges; introduce an exact scoped override only if a parent range requires it, and explain that parent/API compatibility before doing so. Do not upgrade ESLint to 10: current import/React/accessibility plugin peers cap at 9. Determine whether its reported range is a propagated metavulnerability after patching transitive packages.
- [x] Run `npm ci` without peer bypass flags to prove installation. Inspect `npm ls` for invalid peers and confirm the Next packages are aligned. Keep `braces` and `sprintf-js` findings explicit; no declaration in this task may pretend those unpatched packages are fixed.
- [x] Run `npm test -- --runInBand __tests__/scripts/check-audit.test.ts __tests__/lib/security/safe-fetch.test.ts __tests__/lib/server-env.test.ts`, `npm run lint`, and `npm run typecheck` with the existing non-secret dummy build environment if required. The actual audit is the regression oracle: patched package findings must disappear; any remaining findings must be reported individually rather than treating an expected nonzero audit as success.
- [x] Self-review the exact diff and commit **only** the two owned paths with `git commit --only package.json package-lock.json -m "fix: patch vulnerable runtime and development dependencies"`. Do not push. Report installed versions, remaining advisory IDs and roots, test counts/exits, and any peer/runtime concern.
- [x] Independent specification review, then independent quality review. No security release approval until both pass and the separate unpatched-dependency remediation passes the unchanged audit.

## Final integration requirements

After all dependency remediation tasks, renew the existing empty audit policy's reviewed dates only with a recorded, current, passing review. Retain its schema, severity rules and empty exception list. Run the full Jest suite, lint, typecheck, production build, startup checks, extension checks and real fresh-install Docker acceptance before pushing PR #12 updates. Keep the PR draft while any relevant check fails; do not merge or modify production as part of this task.

## Observed version-contract follow-up

The full 505.963-second regression run after dependency patches passed 2,730 tests and failed four stale exact-version assertions, with 38 opt-in tests skipped. The only failing files were `__tests__/ci/workflow-contract.test.ts` and `__tests__/dependencies/version-contract.test.ts`.

The same implementer was assigned those two additional files only: update the exact supported Next/env/lint-config baseline to `16.3.6` and Undici to `7.29.1`; preserve every other pin, lockfile-alignment assertion and CI contract. Commit `8e51292` changes only those expectations/test descriptions and passes both affected suites (ten tests). This targeted rerun does not relabel the preceding full run as a passing run. A fresh full run remains required before overall security release approval after the unpatched-dependency decision.

## Patch-batch execution evidence

- `5a6d1fc`: compatible manifest/lock patches; independent specification and quality reviews passed. No forced peers or audit waivers.
- Normal `npm ci`, valid peer tree, 294 targeted audit/fetch/environment tests, lint and typecheck passed.
- Main independently confirmed `npm audit --omit=dev`: zero vulnerabilities. Full gate remains failed at 0 critical / 5 high / 20 moderate (two actual unpatched advisory roots and their propagated findings).
- Main production build, startup validation and extension checks passed with Next 16.3.6.
- Actual clean-export Docker acceptance on `5a6d1fc` passed all eight checks with owned cleanup confirmed.
- Existing preview rebuilt with managed configuration byte-identical. The full container includes development tooling; production-classification zero is not a whole-image security claim.
- No policy date renewal, exception, checker change, main merge or hosted production mutation. A restricted local glob-adapter design remains proposed and awaits the user's choice.
