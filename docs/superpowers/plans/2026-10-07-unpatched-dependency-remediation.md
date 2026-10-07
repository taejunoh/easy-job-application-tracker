# Unpatched Dependency Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove both remaining unpatched advisory roots while preserving current application lint behavior and the unchanged full-graph security gate.

**Architecture:** A private local package replaces only the pinned Next plugin's directory discovery with a documented, fail-closed restricted API. A scoped YAML override removes the legacy sprintf chain. Independently test policy expiry; renew review dates only after actual raw audits are clean.

**Tech Stack:** Node 22, npm overrides/local packages, tinyglobby 0.2.17, picomatch 4.0.4, ESLint 9, js-yaml 4.3.2, Jest 30.5.

---

Use the existing isolated worktree `/Users/taejunoh/Developer/LFG/easy-job-application-tracker/.worktrees/easy-onboarding`, branch `codex/easy-onboarding`, base `42cde01bbdf9b699fda315377175e6dd64e4427e`. User approved the restricted design. No production mutations, main merge, dirty primary edits, audit exception, gate weakening, forced peer install or cosmetic vulnerability relabeling. Preserve parallel edits. All commits use `git commit --only` with exact owned paths.

## Task 1: Scoped dependency removal and compatibility proof

**Owner:** integration implementer; exclusive ownership of `package.json`, `package-lock.json`, `tools/next-root-glob/package.json`, `tools/next-root-glob/index.cjs`, `tools/next-root-glob/README.md`, `__tests__/dependencies/next-root-glob.test.ts`, `__tests__/dependencies/nyc-yaml-compat.test.ts` and a narrowly named golden fixture if needed.

- [ ] Before removing fast-glob, capture reference result sets in a disposable directory tree containing literal directories, nested `packages/*/web`, hidden directories, spaces, scoped package names, symlinks and missing paths. Preserve source/version provenance in the fixture. Add failing tests for the absent adapter and the actual pinned Next rule/config contracts.
- [ ] Create a private CommonJS package with this dependency identity:

```json
{
  "name": "@jobtracker/next-root-glob",
  "version": "1.0.0",
  "private": true,
  "main": "index.cjs",
  "dependencies": { "tinyglobby": "0.2.17", "picomatch": "4.0.4" }
}
```

- [ ] Implement only `module.exports = { globSync }`. Validate a string pattern of at most 4096 characters and exactly `{ onlyDirectories: true }`; reject array arguments, unknown own options/symbols, control characters and unsupported syntax. Allow literal relative/absolute paths and complete `*` path segments only. Use a bounded raw syntax check before public `picomatch.scan` flags so hostile nested braces never reach recursive parsing. Do not rewrite glob patterns or implement brace expansion. Normalize native Windows separators deliberately; reject escape syntax on POSIX. Invoke tinyglobby with `onlyDirectories: true`, `expandDirectories: false` and `absolute: true` for absolute input. Error instead of returning an empty result for unsupported usage.
- [ ] Preserve the upstream Next plugin and all lint rules. Add the local direct dev dependency and only these scoped overrides:

```json
{
  "devDependencies": {
    "@jobtracker/next-root-glob": "file:tools/next-root-glob"
  },
  "overrides": {
    "@next/eslint-plugin-next@16.3.6": {
      "fast-glob": "$@jobtracker/next-root-glob"
    },
    "@istanbuljs/load-nyc-config@1.1.0": {
      "js-yaml": "4.3.2"
    }
  }
}
```

Keep every existing declaration/override. If npm does not support the local-reference form, stop and report the exact error before choosing another dependency identity or changing the design. Normal npm tooling may generate the lockfile; never use `--force` or `--legacy-peer-deps`.
- [ ] Tests must prove supported directory identity matches the captured original sets; unsupported globstar/brace/extglob/bracket/negative/escape patterns and malformed options throw. A bounded child-process hostile-input test must finish without stack overflow/hang. Inspect the actual pinned plugin source and fail the contract test if its reviewed version/API/options change.
- [ ] Through real ESLint, prove `no-html-link-for-pages` still reports errors with default, literal, root-array and simple `packages/*` settings. Prove representative React hooks, JSX a11y, TypeScript and Next rules still report their expected errors. Do not remove or weaken the repository lint configuration.
- [ ] Through the actual nyc loader test `.yml/.yaml`, relative extends, arrays, booleans, paths and thresholds, plus intentional YAML 4 unsafe-tag rejection and numeric semantics. Document supported/rejected differences rather than claiming universal YAML 3 compatibility.
- [ ] Run normal `npm ci`, `npm ls --all` peer validation, both new suites, existing dependency/version and audit suites, lint and typecheck. Verify lock **and installed tree** contain no vulnerable braces/micromatch/fast-glob/sprintf-js nodes. Run full and production raw audits; expect zero. The policy command may still fail solely because the review date has not yet been renewed; report exact evidence.
- [ ] Self-review and commit exact owned files. Independent specification review must pass before independent security/quality review. Fix/re-review findings before final integration. No pushes during implementation.

## Task 2: Expiry regression and evidence-based review renewal

**Owner:** policy-test worker; `__tests__/scripts/check-audit.test.ts` and, only after the controller confirms clean raw audits, `docs/operations/npm-audit-exceptions.json`.

- [ ] Inspect existing audit test helpers. Add or explicitly strengthen a case with zero vulnerabilities and zero exceptions but expired review dates; it must fail for expiry. Preserve malformed/network output, all severity, wrapper and exception checks. Never edit the checker or CI.
- [ ] Run `npm test -- --runInBand __tests__/scripts/check-audit.test.ts`; all cases must pass. Commit the test alone with exact-path commit. Spec review then quality review.
- [ ] After Task 1 clean full/production raw audits are confirmed, update only `reviewedOn` to `2026-10-07` and `reviewBy` to `2026-11-07`; preserve schema and `exceptions: []`. Run `npm run check:audit`, expect actual exit 0 and zero findings. If anything remains, do not renew or claim success. Commit only the policy file after evidence review.

## Task 3: Final regression and draft PR update

**Owner:** controller delegates execution/verification and synthesizes results; documentation belongs to controller.

- [ ] With implementation and reviewed policy stable, run full Jest with three workers, lint, typecheck, production build, startup validation and extension checks. Record exact counts/exits; no changes during the full run. Run actual clean-export Docker onboarding and the explicit SIGINT cleanup regression; require all eight checks and owned cleanup. Preserve the existing 3107 preview configuration and data.
- [ ] Update the security review and onboarding acceptance cross-reference with actual zero-audit evidence, adapter restrictions/maintenance, current test results and remaining limitations. Do not relabel earlier failed full runs as green. Final read-only integration/security review must approve all changes and unchanged gate.
- [ ] Recheck live main and excluded scope; preserve the dirty primary checkout. Push to the existing branch and update/attach PR #12. Check relevant CI results. Keep draft while any relevant check fails. Do not merge or modify production in this task.
