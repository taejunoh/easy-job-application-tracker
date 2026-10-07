# Dependency security remediation — 2026-10-07

Status: partial remediation; the full security gate remains blocked. No production deployment or main merge is approved by this record.

## Published patches applied

Implementation revision: `5a6d1fc019550de1dbe74bad7b4ec274b68ebbe9`.

- Next, `@next/env`, `eslint-config-next`: 16.3.0 → 16.3.6.
- `@fastify/busboy`: 3.2.0 → 3.2.2; Undici: 7.29.0 → 7.29.1.
- Jest and `jest-environment-jsdom`: 30.3.0 → 30.5.2; `ts-jest` remains compatible with Jest 30.
- Compatible transitive patches include Sharp 0.35.5, `source-map-js` 1.2.2, `fast-uri` 3.1.8, `js-yaml` 4.3.2 / 3.15.2 and `brace-expansion` 1.1.21 / 2.1.7 / 5.0.12.
- ESLint 9 is retained. Its reported findings were transitive through `brace-expansion`, not an own ESLint advisory. No forced major upgrade or peer-check bypass was used.

The implementation changes only the package manifest and lockfile. Independent specification and quality reviews approved this patch batch. The broad lockfile refresh is predominantly the required Next/Jest graph, not unrelated direct dependency upgrades.

## Audit evidence and limits

Observed baseline: full graph 1 critical / 37 high / 2 moderate; production classification 1 critical / 6 high. After patches: full graph 0 critical / 5 high / 20 moderate; `npm audit --omit=dev` reports zero vulnerabilities. Counts depend on the current registry advisory database and include propagated package findings, not only unique advisory IDs.

**The shipped Docker image is not claimed clean.** The current Dockerfile copies development dependencies into runtime so the existing Prisma migration CLI is available. Consequently the zero production-classification result does not describe the whole container dependency tree. The full audit remains the blocking gate.

The remaining actual advisory roots are:

- [`braces` GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), through Next's ESLint plugin → `fast-glob` → `micromatch`. No official fixed release was found at review time.
- [`sprintf-js` GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), through the Istanbul nyc-config loader → legacy `js-yaml` → `argparse`. No official fixed release was found at review time.

A proposed restricted adapter preserves this repository's default-root Next lint behavior and all existing rules while removing the vulnerable glob dependency. It would support literal paths and simple single-segment wildcard roots, rejecting advanced glob syntax; it is not a generic compatible replacement. It requires accepting both local maintenance and that narrower configuration contract. Actual published replacement-library tests disproved the earlier generic-compatibility proposal. No adapter has been implemented pending the user's choice. A scoped YAML 4 migration for the nyc loader is also separately reviewed rather than blindly forcing a major version.

## Verification and policy

The patch batch passed normal `npm ci`, peer-tree validation, 294 targeted tests, lint, typecheck, production build, startup validation and extension checks. Actual clean-export Docker acceptance on `5a6d1fc` passed all eight checks with owned cleanup confirmed. The existing local preview was rebuilt without changing its managed configuration.

The full regression run completed in 505.963 seconds: 2,730 passed, four stale exact-version assertions failed, 38 opt-in tests skipped. Only the two dependency/CI version-contract files failed. Commit `8e51292` updates those expectations to the new exact supported versions without weakening the other assertions; a fresh affected-suite rerun passed both suites / ten tests. The earlier full run is not relabeled as green. A fresh full passing run is still required before overall security release approval after the remaining design decision.

No audit checker, CI gate or exception was changed. The exception list remains empty and its existing review date remains expired. Review dates must only be renewed after an actual passing full-graph review; extending a date does not resolve the remaining findings. PR #12 remains draft and must not merge while these gates fail.
