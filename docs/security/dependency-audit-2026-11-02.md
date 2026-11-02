# Dependency audit exceptions — 2026-11-02

Status: exceptions and gate fix verified locally on branch `codex/audit-dev-advisories-20261102`; pushed CI pending at the time of writing.

## Finding

`npm run check:audit` began failing on every CI run after the October 26 patch (PR #20) passed it. The first failing commits were `0ef8879` on `main` and `df5f462` on PR #21. Neither change touched the affected packages.

Audit on Node 22.23.4: full graph critical=0, high=0, moderate=32, low=3; production classification (`--omit=dev`) all zero. The 35 packages trace to three advisories.

| Advisory | Severity | Package | Installed | Patched |
| --- | --- | --- | --- | --- |
| [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) | moderate | `minimatch` | 3.1.5, 9.0.9, 10.2.6 | 11.0.1 |
| [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) | moderate | `glob` | 10.5.0, 13.0.6 | 14.0.2 |
| [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) | low | `deepmerge` | 4.3.1 | none |

## Decision

All three are recorded as exceptions; no package version changed.

- No upgrade within supported ranges reaches a fix. Jest 30.5.2 (latest) requires `glob` ^13.0.6 and `deepmerge` ^4.3.1. ESLint 9 and its plugins require the `minimatch` 3.x line. `@typescript-eslint/typescript-estree` 8.72.1 requires `minimatch` ^10.2.2.
- npm's proposed fixes are unsupported downgrades (`jest` 25.1.0, `eslint` 4.0.0).
- Major-version overrides of toolchain internals were rejected, following the existing policy.
- ESLint 10 was not adopted here: it would resolve only part of `minimatch`, and is a separate toolchain migration.

## Exposure

- `src`, `scripts` and `extension` import none of the three packages.
- The packages run only inside Jest and ESLint, on repository paths and configuration.
- The Docker runtime image copies the build stage, so it does contain development dependencies. The container entrypoint does not run Jest or ESLint.

## Gate fix

The exceptions alone did not pass the gate. npm reports a cycle in this graph (`@eslint-community/eslint-utils` → `eslint` → `@eslint-community/eslint-utils`), and `mapConcreteAdvisories` in `scripts/check-audit.mjs` rejected any cycle as an invalid reference. That would have failed every future audit containing the cycle, whatever the exceptions said.

The function now resolves each package by reachability. These cases still fail closed, and each has a test:

- a cycle that reaches no concrete advisory;
- a reference to a package missing from the report;
- a cycle member missing from an exception scope.

High and critical advisories are rejected before this code runs, so that rule is unchanged.

## Policy dates

`reviewedOn` moves to 2026-11-02. `reviewBy` stays 2026-11-21, so the existing review schedule still applies.

## Verification

On Node 22.23.4:

- New cycle test failed before the gate fix and passed after it.
- `npm run check:audit`: passed, with full moderate=32 low=3, production all zero, exceptions=3.
- Jest on `check-audit`, the CI workflow contract, the README guide and `__tests__/dependencies`: 7 suites, 117 tests passed.
- `eslint` on the two changed code files: passed.

## Not verified locally

- The full Jest suite, build and typecheck were not run locally. The worktree was installed with `--ignore-scripts`, so the Prisma client was not generated. Pushed CI covers these.
- This record makes no claim about production writes or deployment.
