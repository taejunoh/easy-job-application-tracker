# Operations and Repository Hygiene Design

## Goal

Make the deployed tracker recoverable and observable, align development and CI
runtimes, remove misleading operational guidance, and reduce dependency risk
without unsafe forced downgrades.

## Considered Approaches

### A. Small auditable operational controls

Use Neon restore history plus verified logical dumps, add a minimal database
health endpoint and scheduled check, pin Node to the CI runtime, selectively
upgrade direct dependencies, and document remaining upstream advisories. This
is recommended because every control is testable and has a narrow secret scope.

### B. Add third-party monitoring and backup vendors

This could provide richer paging and off-site retention, but it requires new
accounts, billing decisions, and wider production-data access. It is deferred
until the built-in controls demonstrate a concrete gap.

### C. Treat Vercel and Neon defaults as sufficient

This has no independent restore artifact or release health signal and is
rejected.

## Backup and Recovery

The pre-cutover custom-format dump is retained outside Git with mode `0600`, a
SHA-256 digest, table counts, and a recovery runbook. Neon restore history is
verified and its configured window is documented. A restore rehearsal uses a
scratch database or isolated Neon branch and proves the dump can recover the
expected schema and counts without touching Production.

No database credential or dump is committed, uploaded as a public artifact, or
printed to logs. Automated off-site dumps are not added until an encrypted
artifact store and retention owner are explicitly selected.

## Health and Release Observation

A minimal `/api/health` route checks application startup and a `SELECT 1`
database query. It returns only `{"status":"ok"}` on success and a generic
`503` body on failure; it exposes no environment, schema, latency breakdown, or
record counts. The route is rate-light and safe for an external uptime probe.

A scheduled GitHub Actions workflow and a post-deploy smoke script check the
canonical health URL. Workflow failures provide a durable release/uptime signal,
while Vercel deployment status and logs remain the source for build and runtime
diagnosis. The runbook records how to inspect 5xx errors, database connectivity,
and PDF worker failures.

## Runtime and Dependency Policy

Node `22.22.2` is pinned in `.nvmrc`, `.node-version`, and `package.json`
`engines` to match CI and the Prisma toolchain. Vercel uses Node 22.

Dependency remediation is selective:

- upgrade the direct Anthropic SDK only after a provider contract test fails on
  the old expectation and passes with the new SDK;
- keep Prisma packages on the same 7.x version and verify validate, generate,
  deploy, status, and schema diff;
- update safe transitive packages with a lockfile-only non-force operation;
- never accept npm audit's suggested Prisma 6.x or Next 9.x downgrade;
- document any Next-bundled or Prisma-tooling advisory that cannot be safely
  removed, including why it is non-runtime or upstream-pinned.

## Documentation and Cleanup

`handover.md` is rewritten for PostgreSQL, authenticated web/extension pairing,
the five-variable environment contract, migration baseline safety, CI guards,
and port 3000. README wording distinguishes local self-hosting from hosted
Neon/Vercel storage. Stale completed plan checkboxes are updated only when Git
history and tests prove completion.

The four lint warnings are removed mechanically. The 65 numbered stale conflict
copies in the original checkout are not part of the feature branch; deletion
requires explicit user approval even though hash analysis found no unique work.
The already-merged deployment-hardening branches are deleted only after the new
branch is merged.

## Success Criteria

- A documented backup and successful restore rehearsal exist.
- The health route passes locally and from the canonical deployment; forced DB
  failure returns generic `503` in tests.
- Node 22.22.2 is enforced locally, in CI, and in deployment configuration.
- Full tests, lint, typecheck, build, startup validation, extension checks, and
  Prisma gates pass.
- High/critical audit findings are zero; remaining moderate/low findings are
  either removed or explicitly documented with upstream constraints.
- Current docs contain no SQLite, port 3001, or destructive reset guidance.
