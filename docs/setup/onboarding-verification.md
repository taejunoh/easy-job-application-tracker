# Local onboarding verification

Verification date: 2026-10-07. This is a local-development acceptance record, not a production deployment or security approval.

## Scope

The beginner workflow is a clean Git checkout followed by `npm run setup`, without host-installed application dependencies or PostgreSQL. Docker builds the production app, starts an internal database, applies migrations and retains generated configuration and database data across restarts. The optional extension is not needed for first use.

All acceptance data is synthetic. Authentication and application storage APIs use the actual app and PostgreSQL; only extraction is simulated to avoid relying on an external job site or a paid provider. Screenshots use a separate fail-closed synthetic API policy and contain no real user data.

## Checks

The fresh-install harness checks:

1. A clean tracked-source export has no host `node_modules`.
2. Setup produces a healthy isolated app/database and leaves an unrelated root `.env` unchanged.
3. Repeated setup preserves configuration bytes; private source sentinels are absent from the app image.
4. An unauthenticated write is rejected.
5. Browser sign-in and saving use real authentication/application APIs; real read and update requests confirm the saved data.
6. The same application ID and data survive stop/start and container recreation; the original token still authenticates.
7. Extension-origin registration is idempotent and preserves credentials.
8. Real deletion succeeds and the subsequent read returns 404.

The harness removes only its disposable project, volume and temporary credentials. It never targets the user's normal managed configuration. A separate interrupted-run regression exercises cleanup when the process receives a signal.

At final implementation revision `c7ea3a6f2d16157ae21cfbdc52188ca676762cc1`, all eight checks and resource cleanup passed. A separate real SIGINT regression also passed on that revision. Ten isolated fault regressions cover failed clicks/responses, malformed or failed extraction callbacks, abort failure and a missing extraction request; they confirm that failures remain in the awaited flow and reach redacted reporting and cleanup. Independent specification and quality reviews approved the repair.

Documentation contracts: seven suites and 71 tests passed at `0d84005`. Independent specification and quality reviews approved the guide split and preservation of existing deployment safeguards.

The final smoke suite has 22 passing tests and one deliberately opt-in signal test. The signal test was then explicitly enabled and passed. Final lint, production build (including TypeScript), startup-environment checks and extension checks passed.

The full Jest regression run passed with `npm test -- --maxWorkers=3`: 94 suites passed, seven opt-in suites skipped; 2,734 tests passed, 38 skipped, zero failed (490.372 seconds, exit 0). The final smoke suite was included with all 23 assertions. The existing preview was rebuilt successfully with its managed configuration byte-identical afterward.

## Release limitation

The existing dependency audit fails on the unchanged live-main dependency baseline. Findings include an unpatched high-severity [`braces` advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), and the existing exception policy's review date has expired. This onboarding work does not update vulnerable dependencies, waive findings or extend the exception policy.

The changes may be published as a **draft pull request**, but must not merge to `main` until separately scoped security remediation restores the relevant gate. Passing local onboarding checks does not override that release limitation.

Subsequent user-approved security patches and their remaining blockers are recorded in the [2026-10-07 security remediation review](../security/dependency-audit-2026-10-07.md). This onboarding record describes its original acceptance revision, not the latest dependency inventory; the full security gate remains blocked after the partial patch batch.
