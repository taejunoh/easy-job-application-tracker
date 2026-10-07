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

At the original onboarding implementation revision `c7ea3a6f2d16157ae21cfbdc52188ca676762cc1`, all eight checks and resource cleanup passed. A separate real SIGINT regression also passed on that revision. Ten isolated fault regressions cover failed clicks/responses, malformed or failed extraction callbacks, abort failure and a missing extraction request; they confirm that failures remain in the awaited flow and reach redacted reporting and cleanup. Independent specification and quality reviews approved the repair.

Documentation contracts: seven suites and 71 tests passed at `0d84005`. Independent specification and quality reviews approved the guide split and preservation of existing deployment safeguards.

The final smoke suite has 22 passing tests and one deliberately opt-in signal test. The signal test was then explicitly enabled and passed. Final lint, production build (including TypeScript), startup-environment checks and extension checks passed.

The full Jest regression run passed with `npm test -- --maxWorkers=3`: 94 suites passed, seven opt-in suites skipped; 2,734 tests passed, 38 skipped, zero failed (490.372 seconds, exit 0). The final smoke suite was included with all 23 assertions. The existing preview was rebuilt successfully with its managed configuration byte-identical afterward.

## Subsequent security-remediated acceptance

At `1a360b6ea3f736440c87d4a31c2138e71236d66d`, fresh tracked-export Docker acceptance again passed all eight checks with owned cleanup. The explicit signal-enabled suite passed 26/26 (4.418s). Redacted local reports are `.artifacts/onboarding/1791396870006.json` and `1791396900435.json` (ignored). The runtime uses private adapter 1.0.1; its required tarball is copied before Docker's dependency install.

The fresh full regression passed 97 suites with seven skipped; 2,820 tests passed, 38 skipped, zero failed (483.558s). Production build, startup-environment and extension checks passed. The existing local preview was rebuilt with identical managed configuration and permissions, the same project/port and database volume, unchanged read-only data count and healthy containers.

The original baseline's audit and expired-policy blockers were addressed in the separately scoped [2026-10-07 security remediation review](../security/dependency-audit-2026-10-07.md). Full and production audits now report zero; the unchanged gate passes with no exceptions and evidence-based review dates. These local results do not authorize main merge or production deployment. PR #12 remains draft pending final updated-head CI review.

## Remote CI follow-up

Remote fresh Docker onboarding and backup-interruption checks passed at `a2badb8`. The general verification job exposed an unrelated, pre-existing quarantine test-harness attack that was not explicitly selected. Test-only commit `43747b3` adds the missing opt-in guard and an instrumentation-only regression; the five affected cases pass on both host and disposable Linux environments. Production restore behavior and safety assertions are unchanged.

The extension job separately timed out during system-package installation before its build/E2E steps. The follow-up uses unchanged browser coverage on a fresh runner. These failures are not relabeled as passes; current full-suite and remote CI status is recorded in draft PR #12.
