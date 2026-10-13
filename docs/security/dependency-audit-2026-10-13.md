# Dependency security follow-up — 2026-10-13

Status: compatible patch implementation verified locally; full new-head release verification and production deployment remain pending. This record does not claim a deployment has occurred.

## Findings and minimal patch

The fresh audit of unchanged source `8a36873` reported two vulnerable packages: full critical=1/high=1 and production high=1, with zero exceptions. The October 7 clean results remain historical snapshots, not current guarantees.

- Next.js 16.3.6 → 16.3.8, with direct `@next/env` aligned to 16.3.8. The [Next.js 16.3.8 security release](https://github.com/vercel/next.js/releases/tag/v16.3.8) fixes the newly reported advisory ranges, including [Image Optimization SSRF](https://github.com/advisories/GHSA-cjq9-62q9-8jv4). No 16.4 upgrade was needed.
- Transitive Handlebars 4.7.9 → 4.7.10 through the existing ts-jest range. [AST type confusion](https://github.com/advisories/GHSA-8r5x-fm3f-whwj) and [own-property check bypass](https://github.com/advisories/GHSA-p8wg-vrv2-v86f) are fixed in 4.7.10. No direct dependency or override was added.

Patch source: `1046c693bd51da0986fd28a38b0d39f52394f8fe`. Only the manifest, lock and existing version-contract test changed. The required Next platform graph changed with the runtime; unrelated resolved package versions were retained. ESLint config/plugin remain 16.3.6, compatible with the runtime's peers. Private adapter 1.0.1, its immutable tarball, exact consumer edge/hash/call-shape guards, NYC YAML override and every audit policy/gate setting remain unchanged.

## Verification checkpoint

- The updated runtime version contract failed against the old manifest/lock before the patch, then passed afterward.
- A fresh sequential `npm ci`, `npm ls --all`, scoped lint and diff check passed. Earlier accidentally overlapping install attempts failed and are not counted as successful evidence.
- Four dependency/adapter/YAML/Docker suites passed all 85 tests.
- Independent specification and high-risk quality reviews approved the patch scope, compatibility, strict version checks and unchanged adapter/security boundaries; 923 unrelated lock package records were unchanged.
- Follow-up `2ec6d4d532b588e07668c872592f4fc2b5e8231c` changes only the CI contract's two runtime expected values. Its prior stale assertion failure is historical; affected suites passed 10/10, independent specification/quality reviews passed, and the full four-suite documentation/CI rerun passed 61/61 (18.705s).
- Lint, dummy-environment typecheck and production build, startup-environment and extension checks passed. Typecheck initially found the generated Prisma client missing after installation; the normal `prisma generate` prerequisite resolved it without a source/schema change. No Production credentials were used for local validation.
- A fresh controller `check:audit` passed: full and production critical/high/moderate/low all zero, exceptions zero. Existing review dates and policy expiry were not changed.
- A sleep-inhibited unchanged-source parallel baseline passed the quarantine suites but failed one short-deadline monitor fixture before its intended POST phase. Its unchanged isolated case passed. This failed run is preserved in ignored `predeploy-awake-2026-10-13-jest.json`, not relabeled green. New-head full verification uses the unchanged CI-standard serial command, without skipping tests or lengthening deadlines.

Latest full regression and CI results are recorded in PR #12 to avoid a documentation-only status commit triggering another verification loop. The Docker runtime includes development dependencies, so the full graph remains mandatory; this record is not a general OS/container vulnerability scan.

## Approved production boundary

The user approved a gate-preserving read-only release. Database, credentials, schema/migrations and existing write gates must remain unchanged. Successful CRUD, valid pairing/extension-save and write-resume validation are deferred, not claimed passed. Candidate authentication, reads, CORS, stopped-write responses, data parity and controlled promotion remain required by the release plan and operations runbook.
