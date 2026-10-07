# Dependency security remediation — 2026-10-07

Status: scoped local remediation verified. Full and production-classification audits report zero findings, and the unchanged audit gate passes with zero exceptions. No production deployment or main merge is approved by this record; updated-head remote CI must still be checked.

## Final scoped remediation and evidence

Verified source: `1a360b6ea3f736440c87d4a31c2138e71236d66d`, including adapter fixes `1b9a911`, Docker artifact copy `b53ed8b` and policy review `df50982`.

- Only the pinned `@next/eslint-plugin-next@16.3.6` fast-glob edge is replaced by the honestly named private `@jobtracker/next-root-glob@1.0.1`. Its committed relative tarball contains only the manifest, implementation and README. Tests verify reproducible archive bytes, installed-source bytes and lock integrity. No lifecycle patching, fake upstream version or unrelated consumer replacement is used.
- This is **not a general fast-glob replacement**. It supports literal directories and complete single-segment `*` roots, including reviewed symlink aliases. Advanced syntax, unsupported options and dot/parent segments after a wildcard fail closed. The default Next root bypasses the adapter. Installed consumer version, source, imports and actual API/options are guarded; future updates require review. See the [adapter contract and maintenance guide](../../tools/next-root-glob/README.md).
- A separate exact-consumer override loads `js-yaml@4.3.2` for `@istanbuljs/load-nyc-config@1.1.0`. Real-loader tests cover normal configuration and document intentional YAML 4 numeric and unsafe-tag differences.
- Normal `npm ci`, `npm ls --all`, lint and typecheck passed. No actual `braces`, `micromatch`, `fast-glob` or `sprintf-js` package identity remains in the lock or installed tree. A `fast-glob` dependency edge name remains, resolving to the private adapter rather than vulnerable upstream code.
- Controller raw full and `--omit=dev` audits both exited 0 with every severity and total at zero at approximately 18:08 UTC. The unchanged `npm run check:audit` then passed: full and production critical/high/moderate/low all zero, exceptions zero. Audit results are an advisory-database snapshot, not a guarantee against unknown vulnerabilities.
- The policy changes only `reviewedOn` to `2026-10-07` and `reviewBy` to `2026-11-07`, after the clean review. `schemaVersion: 1` and `exceptions: []` remain unchanged. A regression proves clean full/production graphs still fail when the empty policy is expired.
- Independent specification and high-risk quality reviews approved the fixes. Five focused suites / 99 tests passed (3.048s). The fresh full run passed: **97 suites passed / 7 skipped; 2,820 tests passed / 38 skipped / zero failures**, 483.558s, exit 0. The earlier failed run below remains historical, not relabeled.
- Synthetic-environment production build, startup-environment validation and extension checks passed. Fresh tracked-export Docker onboarding passed all eight real authentication/CRUD/persistence/isolation checks and owned cleanup; the signal-enabled suite passed 26/26 (4.418s). Local reports: `.artifacts/onboarding/1791396870006.json`, `.artifacts/onboarding/1791396900435.json`, and `security-final-jest.json` (ignored, not published).
- The existing local preview was rebuilt successfully. Configuration bytes/permissions, project/port, database volume and read-only data count were preserved. Its actual runtime contains adapter 1.0.1 and NYC YAML 4.3.2, with the four forbidden upstream identities absent.

The Docker runtime still includes development dependencies for the existing Prisma CLI. This is why the **full** graph remains mandatory; production-classification zero alone would not describe the image. The fresh image is built from the verified lock and actual runtime identities were checked, but this record is not a general container/OS vulnerability scan or production approval.

## Historical published patch batch

Implementation revision: `5a6d1fc019550de1dbe74bad7b4ec274b68ebbe9`.

- Next, `@next/env`, `eslint-config-next`: 16.3.0 → 16.3.6.
- `@fastify/busboy`: 3.2.0 → 3.2.2; Undici: 7.29.0 → 7.29.1.
- Jest and `jest-environment-jsdom`: 30.3.0 → 30.5.2; `ts-jest` remains compatible with Jest 30.
- Compatible transitive patches include Sharp 0.35.5, `source-map-js` 1.2.2, `fast-uri` 3.1.8, `js-yaml` 4.3.2 / 3.15.2 and `brace-expansion` 1.1.21 / 2.1.7 / 5.0.12.
- ESLint 9 is retained. Its reported findings were transitive through `brace-expansion`, not an own ESLint advisory. No forced major upgrade or peer-check bypass was used.

The implementation changes only the package manifest and lockfile. Independent specification and quality reviews approved this patch batch. The broad lockfile refresh is predominantly the required Next/Jest graph, not unrelated direct dependency upgrades.

## Historical baseline and patch-only audit

Observed baseline: full graph 1 critical / 37 high / 2 moderate; production classification 1 critical / 6 high. After patches: full graph 0 critical / 5 high / 20 moderate; `npm audit --omit=dev` reports zero vulnerabilities. Counts depend on the current registry advisory database and include propagated package findings, not only unique advisory IDs.

At this patch-only stage, the Docker image was not claimed clean: it included development dependencies, and the full audit remained blocked despite production-classification zero.

The remaining actual advisory roots at that stage were:

- [`braces` GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), through Next's ESLint plugin → `fast-glob` → `micromatch`. No official fixed release was found at review time.
- [`sprintf-js` GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), through the Istanbul nyc-config loader → legacy `js-yaml` → `argparse`. No official fixed release was found at review time.

The user subsequently approved the restricted adapter and local maintenance contract described above. Published replacement-library experiments had disproved an earlier generic-compatibility proposal, which was not implemented. The YAML migration was separately reviewed rather than blindly forcing a major version.

## Historical patch-only verification

The patch batch passed normal `npm ci`, peer-tree validation, 294 targeted tests, lint, typecheck, production build, startup validation and extension checks. Actual clean-export Docker acceptance on `5a6d1fc` passed all eight checks with owned cleanup confirmed. The existing local preview was rebuilt without changing its managed configuration.

The patch-only full regression completed in 505.963 seconds: 2,730 passed, four stale exact-version assertions failed, 38 tests skipped. Only the two dependency/CI version-contract files failed. Commit `8e51292` updated those expectations without weakening other assertions; a fresh affected-suite rerun passed both suites / ten tests. The fresh final full run is recorded separately above.

At that stage the checker, CI gate, empty exception list and expired review dates were unchanged. Review dates were subsequently renewed only after the actual full-graph review passed, as recorded above. PR #12 remains draft; this work does not authorize main merge or production deployment.
