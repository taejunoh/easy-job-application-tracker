# Dependency security patch — 2026-10-26

Status: compatible patch implementation verified locally on branch `codex/security-patch-20261026`; pushed CI, new-head release verification and production deployment remain pending. Production deployment has NOT happened, and this record does not claim one.

## Findings and minimal patch

A fresh audit on Node 22.23.4 of unchanged `main` source `da98d0a` reported five vulnerable packages. The full and production-classification (`--omit=dev`) graphs were identical: critical=1, high=2, moderate=2, with zero exceptions. The October 21 clean results remain historical snapshots, not current guarantees.

- Next.js 16.3.8 → 16.4.3, with direct `@next/env` aligned to 16.4.3. Both stay exact pins. This fixes [SVG Image Optimization RCE](https://github.com/advisories/GHSA-2464-fhr4-w9xw) (critical), [`use cache` typed-array RCE](https://github.com/advisories/GHSA-673q-mjm6-r5xr) (critical) and [Server Actions DoS](https://github.com/advisories/GHSA-p3m5-59mp-jv5r) (high), all affecting `>=16.0.0 <=16.4.0`. npm reported 16.4.3 as the non-major fix. Next's own dependency graph is unchanged apart from `@next/env`, the eight `@next/swc-*` binaries and its optional `sharp` floor moving from `^0.35.4` to `^0.35.5`. The lock already resolved `sharp` 0.35.5, so no `sharp` record changed.
- Undici 7.29.1 → 7.30.1, the minimal fixed version, still an exact pin. It fixes [content-coding chain crash](https://github.com/advisories/GHSA-xjj6-f33q-929c) (high) plus the [EventSource](https://github.com/advisories/GHSA-4qv8-2p9j-2685) and [SRI algorithm](https://github.com/advisories/GHSA-f72v-6w45-q472) moderates. `cheerio`'s `^7.19.0` dependency dedupes to the same copy.
- Transitive zod 4.3.6 → 4.6.7 through `npm update zod`, within existing ranges, fixing [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) (high, fixed in 4.6.6). zod is installed for `eslint-plugin-react-hooks` (development). It also satisfies the optional `zod` peers of `@anthropic-ai/sdk` and `openai`, which puts it in the production-classification audit. Application code does not import zod. npm resolved the latest 4.x patch, 4.6.7, published one day after 4.6.6. No direct dependency or override was added.
- Transitive fast-uri 3.1.8 → 3.1.9, fixing four moderate/low advisories ([GHSA-w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg), [GHSA-wjr9-j795-jxcr](https://github.com/advisories/GHSA-wjr9-j795-jxcr), [GHSA-xhq7-xmqj-769h](https://github.com/advisories/GHSA-xhq7-xmqj-769h), [GHSA-333x-w4r6-6crp](https://github.com/advisories/GHSA-333x-w4r6-6crp)) and the propagated `ajv` moderate. The parent range did not block the fix: Prisma's `@prisma/streams-local` → `ajv@8.20.0` declares `^3.0.1`. The block was the repository's existing exact `"fast-uri": "3.1.8"` override. That existing value changed to `3.1.9`, following the [October 7 precedent](dependency-audit-2026-10-07.md) (3.1.6 → 3.1.8). No override was added.

Lock impact: 13 package records changed (`next`, `@next/env`, eight `@next/swc-*`, `undici`, `zod`, `fast-uri`), plus the root `dependencies` field. 921 package records are unchanged, none were added or removed, and the total stays at 935. ESLint config/plugin remain 16.3.6: `eslint-config-next` 16.3.6 peers only on `eslint`/`typescript`, so the runtime bump forces no lint change. Private adapter 1.0.1, its immutable tarball, exact consumer edge/hash/call-shape guards, the NYC YAML override, `scripts/check-audit.mjs` and `docs/operations/npm-audit-exceptions.json` are unchanged.

### Main CI contract repair

`da98d0a` raised `package.json` engines to `>=22.23.4 <23` but left `package-lock.json` `packages[""].engines.node` at `>=22.22.2 <23`. That made the CI contract "pins the supported Node 22 runtime everywhere" fail on `main`. A lock-only `npm install --package-lock-only` changed exactly that one line, committed separately before the dependency patch as `13083a3`. The full regression run also found a second deterministic `da98d0a` failure: a stale `/22\.22\.2/` assertion in `__tests__/scripts/local-setup.test.ts`. Its test-only fix is the separate commit `e4c0aa8`. The dependency patch itself is `7e344aa`; only the manifest, lock and the two existing version-contract test files changed in it.

### Application exposure notes

- The app imports no `next/image` and sets no `images` configuration. However, the default `/_next/image` optimizer route still exists, the proxy matcher excludes it from authentication, and `public/` contains SVG files. The advisory states no configuration precondition beyond SVG use and glibc Linux. It also lists `sharp` ≥0.35.5 as a workaround, and the lock already resolved `sharp` 0.35.5 before this patch. The pre-patch deployment therefore cannot be called proven unaffected, only likely mitigated.
- No `"use cache"`, `cacheComponents` or `"use server"` (Server Actions) usage exists in `src`. Next still routes Server Action requests on App Router pages, so the DoS fix is treated as relevant.
- 16.4 changes reviewed against `next.config.ts` and `src/proxy.ts`:
  - Strict route matching is now the default (build passed with no warnings).
  - Turbopack `outputFileTracingIncludes` glob traversal changed. The `/api/parse-resume` trace still contains the PDF worker, the three `pdfjs-dist` files and the `@napi-rs/canvas` files.
  - `proxy.ts` no longer loads the app-page runtime (16.4.3).
  - Turbopack export-name mangling, the shared runtime and shorter CSS class names are now on by default.
  - React 19.3 is now the App Router's bundled React. The repository's `react`/`react-dom` 19.2.4 pins still satisfy Next's `^19.0.0` peer.
- Undici 7.30.1 now preserves function-valued `Agent` TLS options and rejects responses with more than five content codings before the body stream. `safe-fetch` passes a custom `connect` connector function with a pinned `lookup`; its real-transport tests pass unchanged.

## Verification checkpoint

All local results are on Node 22.23.4 / npm 10.9.9.

- **TDD order:**
  - On the unchanged lock, the CI contract failed 1/10 (root engines) and passed 10/10 after the lock fix.
  - The updated runtime version expectations (`next`/`@next/env` 16.4.3, `undici` 7.30.1 in the version and CI contracts) then failed 4/10 against the old manifest/lock, and passed 10/10 after the patch.
- **Install and audit:**
  - A fresh sequential `npm ci` (with `node_modules` removed first) and `npm ls --all` exited 0. `npm ls` showed only optional peer/platform `UNMET OPTIONAL` entries, with no invalid, missing or extraneous packages.
  - Raw `npm audit --json` and `npm audit --omit=dev --json` both exited 0 with info/low/moderate/high/critical/total all zero, on the first attempt.
  - The unchanged `npm run check:audit` passed live in about 1 s: full and production critical/high/moderate/low all zero, exceptions zero. No local timeout occurred this time.
  - The same unchanged gate also passed on the saved raw reports via `--audit-file`/`--production-audit-file`. As a negative control, it failed on the saved pre-patch reports (critical=1 high=2 moderate=2).
  - Policy dates were not changed (`reviewedOn` 2026-10-21, `reviewBy` 2026-11-21).
- **Static checks:** `npm run lint` (0 warnings), `npx prisma generate`, `npx prisma validate`, `npm run typecheck`, `npx tsc --noEmit -p .`, `npm run check:extension` and `npm run test:diagnostic-safety` (48/48) passed.
- **Build:** the production `npm run build` on Next.js 16.4.3 (Turbopack) and `npm run check:startup-env` passed. Both used only the non-secret dummy values from the CI `verify` job env. The test-only database opt-in flags were left unset because the build does not read them. No Production credentials were used.
- **Targeted Jest:** `__tests__/ci`, `__tests__/docs`, `__tests__/dependencies` and every suite importing `next`/`undici` ran, plus server-env, instrumentation and check-audit: 21 suites passed, 641 tests passed. Two database-integration suites (14 tests) skipped by design, because `RUN_DATABASE_INTEGRATION` is CI-only.
- **Full run:** a single sleep-inhibited `npm run test:ci` ran at patch head `7e344aa`, without the CI database opt-in flags or `DATABASE_URL`. A local PostgreSQL was listening on 5432, so destructive database suites were deliberately not enabled. The run exited 1 after 989 s:
  - Suites: 95 passed, 2 failed, 7 skipped. Tests: 2,817 passed, 7 failed, 38 skipped, all of them env-gated opt-in suites.
  - The quarantine suites passed this time (the slowest took 304 s), so no load-related flakiness was observed in this run.
  - The failures are not relabeled green:
    - `__tests__/scripts/local-setup.test.ts` (5 tests) failed deterministically, independent of this patch. `da98d0a` changed the script's message to `>=22.23.4` and added a 22.23.3 case, but the shared assertion still matched `/22\.22\.2/`. Separate test-only commit `e4c0aa8` updates that one regex. The suite went from 5 failed / 32 passed to 37/37. The full run was not repeated after this one-line change.
    - `__tests__/scripts/screenshot-context.integration.test.ts` (2 tests) failed locally because Playwright's `chromium_headless_shell-1217` browser is not installed on this machine. CI installs it before tests, and the `playwright` lock record is unchanged. No browser was downloaded for this record.

## Not verified locally

- Pushed CI on GitHub was not run, because nothing was pushed. That includes the database-integration suites against the CI PostgreSQL service, the `extension-e2e` journeys and the Docker backup-interruption job.
- Real Docker image acceptance was not run. The Docker runtime includes development dependencies, so the full graph remains mandatory. This record is not a general OS/container vulnerability scan.
- No preview or production deployment, Vercel change or production read/write validation was performed. Release still follows the existing gate-preserving release plan and operations runbook.
