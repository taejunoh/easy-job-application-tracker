# Production Cutover Design

## Goal

Replace the publicly exposed legacy Vercel deployment with the hardened `main`
build without losing or re-encrypting existing Neon data.

## Current State

- `main` is at `8172651` and its GitHub CI gate passes.
- Neon contains 153 `Application` rows and one `Settings` row.
- The live schema matches `prisma/schema.prisma`, but `_prisma_migrations`
  does not exist and the initial migration is not baselined.
- The persisted Settings API key was encrypted with the current
  `ENCRYPTION_SECRET`; rotating that secret would make it unreadable.
- Vercel Production has only `DATABASE_URL` and `ENCRYPTION_SECRET`.
- The public legacy alias still returns `200` from `/api/applications` without
  authentication. The new build must replace it as the first operational task.

## Considered Approaches

### A. Baseline the existing database and stage the hardened deployment

Back up and fingerprint the existing database, record the already-matching
initial migration as applied, stage a Production deployment without moving the
public alias, run security and data smoke tests, then promote it. This is the
recommended approach because it preserves all rows and provides a promotion
gate.

### B. Create a new database and import all rows

This creates a clean migration history but requires a sensitive data migration,
ID preservation, encrypted Settings verification, and a connection-string
cutover. It adds risk without resolving a schema mismatch because no mismatch
exists.

### C. Deploy without recording migration history

The application could run, but every later release would inherit an ambiguous
database state. This is rejected.

## Data Safety Design

All database commands run from the clean linked worktree. The original checkout
contains stale numbered conflict copies and must never run Prisma migration
commands.

Before any database write:

1. Create a custom-format `pg_dump` outside the repository with mode `0600`.
2. Record its SHA-256 digest and verify `pg_restore --list` can read it.
3. Record ordered, canonical fingerprints and counts for `Application` and
   `Settings` without writing secret values to logs.
4. Confirm `prisma migrate diff --exit-code` reports no difference.

The cutover stops if any backup, digest, fingerprint, or schema check fails.

The initial migration is then recorded with
`prisma migrate resolve --applied 20260713000000_init`. `migrate deploy`,
`migrate status`, and the schema diff run immediately afterward. Migration
history must contain exactly one finished, non-rolled-back row, and pre/post
data fingerprints must match.

`prisma migrate reset`, `db push --force-reset`, destructive schema repair, and
automatic SQLite import are prohibited. The 57-row legacy SQLite file remains a
read-only archive because merging it could duplicate or regress the 153-row
PostgreSQL source of truth.

## Production Environment

The canonical application origin is
`https://easy-job-application-tracker.vercel.app`.

Production receives exactly these required values:

- `DATABASE_URL`: the verified Neon PostgreSQL URL from the local environment.
- `ENCRYPTION_SECRET`: the existing value, unchanged.
- `APP_ACCESS_TOKEN`: a new random token of at least 32 bytes, stored locally in
  an ignored secret file and in Vercel.
- `APP_BASE_URL`: the canonical origin above.
- `CORS_ALLOWED_ORIGINS`: the canonical origin plus the exact installed Chrome
  extension origin. No wildcard is allowed.

Preview deployments remain fail-closed until they have an isolated preview
database and a branch-specific exact application origin. Production data is
never supplied to a Preview deployment.

## Deployment and Smoke Tests

The hardened build is first deployed with `vercel deploy --prod --skip-domain`.
It must become `Ready` before promotion. The staged deployment is tested with
Vercel-authenticated requests where necessary:

- no token and an invalid bearer token return `401`;
- a hostile Origin returns `403`;
- a valid bearer token returns `200` for Applications and Settings;
- Applications still total 153 before the smoke fixture is created;
- Settings reports an existing encrypted API key without exposing it.

After promotion, the canonical alias must serve the new deployment. Final smoke
tests cover session login, Settings read/write without semantic change, a
uniquely named Application create/update/delete cycle, exact CORS allow/deny,
and Chrome extension pairing and save. Smoke data is deleted in a `finally`
cleanup path.

## Rollback

Before promotion, a failed staged deployment is discarded and the alias remains
unchanged. After promotion, a deployment-only failure rolls back to the last
hardened deployment; the unauthenticated legacy deployment is not restored
unless the public alias is protected first.

A database fingerprint mismatch stops application writes. Recovery uses the
verified dump or Neon point-in-time restore, followed by count, fingerprint,
schema, and migration-state verification. Manual migration-row editing is not
part of rollback.

## Success Criteria

- A verified external backup and recovery manifest exist.
- Neon retains all 153 Applications and the Settings row.
- Prisma migration status and schema diff are clean.
- The canonical Vercel alias serves the hardened deployment.
- Unauthenticated and cross-origin data access is rejected.
- Web login, Settings, CRUD, and installed extension pairing/save pass.
