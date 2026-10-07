# Unpatched Dependency Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove both remaining unpatched advisory roots while preserving current application lint behavior and the unchanged full-graph security gate.

**Architecture:** A private local package replaces only the pinned Next plugin's directory discovery with a documented, fail-closed restricted API. A scoped YAML override removes the legacy sprintf chain. Independently test policy expiry; renew review dates only after actual raw audits are clean.

**Tech Stack:** Node 22, npm overrides/local packages, tinyglobby 0.2.17, picomatch 4.0.4, ESLint 9, js-yaml 4.3.2, Jest 30.5.

---

Use the existing isolated worktree `/Users/taejunoh/Developer/LFG/easy-job-application-tracker/.worktrees/easy-onboarding`, branch `codex/easy-onboarding`, base `42cde01bbdf9b699fda315377175e6dd64e4427e`. User approved the restricted design. No production mutations, main merge, dirty primary edits, audit exception, gate weakening, forced peer install or cosmetic vulnerability relabeling. Preserve parallel edits. All commits use `git commit --only` with exact owned paths.

## Task 1: Scoped dependency removal and compatibility proof

**Owner:** integration implementer; exclusive ownership of `package.json`, `package-lock.json`, `tools/next-root-glob/package.json`, `tools/next-root-glob/index.cjs`, `tools/next-root-glob/README.md`, `tools/vendor/jobtracker-next-root-glob-1.0.0.tgz`, `__tests__/dependencies/next-root-glob.test.ts`, `__tests__/dependencies/nyc-yaml-compat.test.ts` and a narrowly named golden fixture if needed.

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
    "@jobtracker/next-root-glob": "file:tools/vendor/jobtracker-next-root-glob-1.0.0.tgz"
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

Keep every existing declaration/override. The original directory reference was stopped and independently diagnosed: npm 10 fails `npm ci`; npm 12 can return success with a dangling link and invalid installed tree. The relative tarball wiring above preserves the approved identity and scope and passed isolated relocated cold-cache installation. Pack with `npm pack ./tools/next-root-glob --pack-destination ./tools/vendor --ignore-scripts --json`. Add a package `files` allowlist and tests proving deterministic repack bytes, the exact three archive members, installed-source bytes and Next-relative identity. Normal npm tooling may generate the lockfile; never use `--force` or `--legacy-peer-deps`.

The existing full-app lock also reproduces the consumer-relative resolution bug. Independent isolated proof succeeded by invalidating only the old `node_modules/@next/eslint-plugin-next` lock entry and the `node_modules/@istanbuljs/load-nyc-config` entry/subtree, then letting normal npm reconstruct those entries. Do not fabricate replacement metadata or delete the whole lock. Compare retained pins: the isolated result changed only the intentional `tinyglobby` 0.2.15 → 0.2.17 pin and removed the intended vulnerable chains. Actual app `npm ci`, installed-tree and audit proof remain required below; the manifest-only isolated install used `--ignore-scripts` because app scripts were not copied.
- [ ] Preserve directory-symlink wildcard aliases using the public tinyglobby `fs.readdirSync` hook and a narrow `statSync` directory classification, not a custom traversal/parser. Test nested, file/broken and cyclic aliases against original golden results with bounded child execution. Explicitly reject dot/parent segments after a wildcard, while retaining literal/leading dot-segments; document this fail-closed clarification.
- [ ] Tests must prove supported directory identity matches the captured original sets; unsupported globstar/brace/extglob/bracket/negative/escape patterns and malformed options throw. A bounded child-process hostile-input test must finish without stack overflow/hang. Inspect the actual pinned plugin source and fail the contract test if its reviewed version/API/options change.
- [ ] Through real ESLint, prove `no-html-link-for-pages` still reports errors with default, literal, root-array and simple `packages/*` settings. Prove representative React hooks, JSX a11y, TypeScript and Next rules still report their expected errors. Do not remove or weaken the repository lint configuration.
- [ ] Through the actual nyc loader test `.yml/.yaml`, relative extends, arrays, booleans, paths and thresholds, plus intentional YAML 4 unsafe-tag rejection and numeric semantics. Document supported/rejected differences rather than claiming universal YAML 3 compatibility.
- [ ] Run normal `npm ci`, `npm ls --all` peer validation, both new suites, existing dependency/version and audit suites, lint and typecheck. Verify lock **and installed tree** contain no vulnerable braces/micromatch/fast-glob/sprintf-js nodes. Run full and production raw audits; expect zero. The policy command may still fail solely because the review date has not yet been renewed; report exact evidence.
- [ ] Self-review and commit exact owned files. Independent specification review must pass before independent security/quality review. Fix/re-review findings before final integration. No pushes during implementation.

## Task 2: Expiry regression and evidence-based review renewal

**Owner:** policy-test worker; `__tests__/scripts/check-audit.test.ts` and, only after the controller confirms clean raw audits, `docs/operations/npm-audit-exceptions.json`.

- [x] Inspect existing audit test helpers. Add or explicitly strengthen a case with zero vulnerabilities and zero exceptions but expired review dates; it must fail for expiry. Preserve malformed/network output, all severity, wrapper and exception checks. Never edit the checker or CI. Commits `b443000`, `124c2b4`.
- [x] Run `npm test -- --runInBand __tests__/scripts/check-audit.test.ts`; all cases must pass. Commit the test alone with exact-path commit. Spec review then quality review. Final regression covers both full and production graphs; 14/14 tests passed independently, and both reviews approved.
- [ ] After Task 1 clean full/production raw audits are confirmed, update only `reviewedOn` to `2026-10-07` and `reviewBy` to `2026-11-07`; preserve schema and `exceptions: []`. Run `npm run check:audit`, expect actual exit 0 and zero findings. If anything remains, do not renew or claim success. Commit only the policy file after evidence review.

## Task 3: Final regression and draft PR update

**Owner:** controller delegates execution/verification and synthesizes results; documentation belongs to controller.

- [ ] With implementation and reviewed policy stable, run full Jest with three workers, lint, typecheck, production build, startup validation and extension checks. Record exact counts/exits; no changes during the full run. Run actual clean-export Docker onboarding and the explicit SIGINT cleanup regression; require all eight checks and owned cleanup. Preserve the existing 3107 preview configuration and data.
- [ ] Update the security review and onboarding acceptance cross-reference with actual zero-audit evidence, adapter restrictions/maintenance, current test results and remaining limitations. Do not relabel earlier failed full runs as green. Final read-only integration/security review must approve all changes and unchanged gate.
- [ ] Recheck live main and excluded scope; preserve the dirty primary checkout. Push to the existing branch and update/attach PR #12. Check relevant CI results. Keep draft while any relevant check fails. Do not merge or modify production in this task.

## Additional remote onboarding diagnostic

- Reviewed commits `124c2b4` (full + production clean/expired-policy regression) and `9b8a8f0` (safe cleanup-failure categories) were pushed separately to the existing draft PR to obtain remote evidence while dependency work continues. Local signal-enabled suite: 26/26 passed; redacted report `.artifacts/onboarding/1791394890795.json` records intentional interruption and successful owned cleanup at source `9b8a8f0`. This does not establish or fix the prior remote cleanup failure's cause. Category reporting preserves strict cleanup checks and emits no raw subprocess error or resource identifiers.
- Remote [fresh Docker onboarding run 37661134346](https://github.com/taejunoh/easy-job-application-tracker/actions/runs/37661134346) at `9b8a8f0` passed actual acceptance, interrupted cleanup and build-context isolation. The preceding remote failure did not reproduce. The separate main CI `verify` job still failed at the expected, unchanged dependency-audit gate; extension E2E and backup interruption passed.
