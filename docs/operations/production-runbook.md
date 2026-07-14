# Production Operations Runbook

This is the authoritative operating guide for the JobTracker production
service. The supported hosted topology is a Vercel Node 22 deployment backed by
Neon PostgreSQL. Never copy Production credentials into Preview, CI, issue
trackers, command history, or this repository.

## Service objectives and ownership

- RPO: 24 hours. Retain at least one verified logical backup from the preceding
  24 hours in addition to the managed database provider's recovery history.
- RTO: 30 minutes. Within 30 minutes, either restore the last known-good
  application deployment or declare a database recovery incident and move to
  an isolated restore target.
- The operator performing a release owns the post-deploy checks and evidence.
  If recovery exceeds either objective, stop non-essential writes and escalate
  to the Vercel and Neon account owners.

## Production contract

Vercel Production must use Node 22 and provide exactly these five required
server variables:

| Variable | Contract |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection for the Production Neon database. |
| `ENCRYPTION_SECRET` | Existing encryption secret; changing it makes persisted encrypted settings unreadable. |
| `APP_ACCESS_TOKEN` | Private application access credential with at least 32 bytes of entropy. |
| `APP_BASE_URL` | Canonical root HTTPS origin, without a path. |
| `CORS_ALLOWED_ORIGINS` | Exact canonical web origin plus each approved `chrome-extension://` origin; no wildcard. |

Validate the checked-in build without printing any values:

```bash
npm ci
npx prisma validate
npx prisma generate
npm run lint -- --max-warnings=0
npm run typecheck
npm run test:ci
npm run check:extension
npm run build
```

The Vercel Next.js preset runs `npm run build`; Vercel does not run
`npm start`. Loading `next.config.ts` validates the complete server environment
at build time. At request-serving runtime, `src/instrumentation.ts` validates it
again before a new Node.js server instance handles requests. `npm start`
pre-listen validation applies to self-hosted Node only; it invokes the
production environment preloader before opening a listener. Do not bypass that
self-hosted contract with a direct Next.js command.

## Deployment and release verification

1. Confirm CI is green for the exact commit and the worktree is clean.
2. Confirm the target is Vercel Production and the database target is the
   intended Neon project without displaying connection details.
3. Inspect the candidate deployment and require `Ready` before promotion.
4. Before promotion, use the candidate URL to verify:
   - unauthenticated and invalid-credential API requests return `401`;
   - an unapproved Origin returns `403`;
   - authenticated Applications and Settings reads return `200`;
   - canonical-origin preflight returns `204`;
   - database counts and migration state match the release evidence.
5. Promote the candidate, repeat the public `401` check immediately, then run a
   create/update/delete smoke record with cleanup in a `finally` path.
6. Confirm browser session sign-in and Chrome extension pairing, save, and
   disconnect behavior on the canonical origin.
7. Inspect Vercel logs for the release window and require no related 5xx
   response before closing the release.

Do not paste response bodies from Settings, Applications, or resume endpoints
into tickets or release evidence.

## Authentication and Chrome extension pairing

Web users open `/connect` and submit the application access credential. The app
exchanges it for a Secure, HttpOnly, SameSite=Strict session cookie and does not
persist the submitted value in browser storage.

For Chrome extension pairing:

1. Load the reviewed `extension/` directory and record the installed extension
   ID through the approved private operator channel.
2. Confirm its exact `chrome-extension://` origin is present in
   `CORS_ALLOWED_ORIGINS` before deployment.
3. In the popup, enter the canonical server origin and access credential, then
   select **Connect**.
4. Confirm a read and one reversible save operation. Delete the smoke record.
5. Use **Disconnect** before transferring or troubleshooting a browser profile.

A `401` means the credential or session is invalid. A `403` means the request
Origin is not in the exact allowlist. Do not weaken either control during
incident response.

## Migration baseline

For a new empty database, run `npx prisma migrate deploy` and then
`npx prisma migrate status`. For an existing PostgreSQL database created before
migration history was tracked:

1. Complete Backup and restore verification below.
2. Require an empty schema diff:

   ```bash
   npx prisma migrate diff \
     --from-config-datasource \
     --to-schema prisma/schema.prisma \
     --exit-code
   ```

3. Only when schema parity and fingerprints are proven, record the checked-in
   baseline with `npx prisma migrate resolve --applied 20260713000000_init`.
4. Run `npx prisma migrate deploy`, `npx prisma migrate status`, and the schema
   diff again. Recompute counts and fingerprints and compare them with the
   pre-baseline evidence.

Never use destructive reset, forced schema synchronization, manual migration
row editing, or a restore with destructive cleanup against Production.

## Backup and restore

Before a migration or risky release, create a PostgreSQL custom-format dump in
an access-controlled location outside the repository:

```bash
umask 077
pg_dump "$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="$BACKUP_FILE"
pg_restore --list "$BACKUP_FILE" > "$BACKUP_TOC"
shasum -a 256 "$BACKUP_FILE" > "$BACKUP_CHECKSUM"
shasum -a 256 -c "$BACKUP_CHECKSUM"
```

Record only the checksum, schema/migration identity, table counts, and
non-reversible fingerprints. Never retain database URLs or row bodies in the
manifest.

Restore rehearsal:

1. Create a new isolated PostgreSQL database or Neon branch. Never target the
   Production database.
2. Run `pg_restore --exit-on-error --no-owner --no-privileges` against that
   isolated target.
3. Compare the Application, Settings, and migration counts plus the approved
   ordered fingerprints with the source manifest.
4. Run `npx prisma migrate status` and the schema-diff command against the
   restored target.
5. Destroy the rehearsal target only after the comparison succeeds; retain the
   protected dump and checksum according to the backup policy.

Restore to Production is a declared incident operation. Restore into an
isolated target first, validate it, then switch the application connection in a
controlled release. Do not overwrite the active database in place.

## Incident diagnosis

### Vercel logs and deployment health

- Confirm the canonical alias resolves to the intended deployment ID and that
  the deployment is `Ready`.
- Inspect Vercel logs for the incident window. Correlate status codes and route
  names, but do not export request bodies, authorization headers, cookies, or
  environment values.
- If all routes fail before requests are served, check startup validation and
  the five-variable contract before changing code.

### Neon connectivity

- Confirm the configured host belongs to the intended Neon project and the
  database name is non-empty without printing the URL.
- Run a read-only `SELECT 1`, then inspect connection limits and provider
  incidents. A failed connectivity check is not permission to run schema repair.
- If reads work but Prisma reports drift, stop the release and compare the
  schema against `prisma/schema.prisma` with the non-mutating diff command.

### PDF worker

Symptoms include `resume_parse_failed`, upload timeouts, worker exits, or memory
pressure while other routes remain healthy. Check Vercel logs for the
`/api/parse-resume` route and compare the failure window with deployment and
memory-limit changes. Reproduce only with a non-sensitive synthetic PDF. Do not
log document contents. The PDF worker is bundled with the application, so use
deployment rollback rather than attempting to replace the worker in place.

## Rollback order

1. **Security boundary failure:** stop promotion. If already promoted, move the
   alias to the most recent hardened deployment that rejects unauthenticated
   access. Never restore a known-public legacy deployment.
2. **Application or PDF worker regression:** promote the previous hardened
   Vercel deployment, verify `401`/`403`/authenticated `200` behavior, and check
   logs again. No database change is required when schema and data are intact.
3. **Environment regression:** restore the last known-good five-variable
   configuration through the private provider controls, redeploy, and rerun the
   release matrix. Do not rotate `ENCRYPTION_SECRET` as a troubleshooting step.
4. **Database migration or data failure:** stop writes, preserve new evidence,
   and recover through a verified dump or Neon point-in-time restore into an
   isolated target. Require count, fingerprint, schema, and migration parity
   before switching the application.
5. **Provider outage:** confirm provider status and keep the last known-good
   deployment and database unchanged. Escalate when the RTO is at risk.

After any rollback, record deployment IDs, timestamps, status codes, database
counts, and checksum references only. Keep credentials and user content out of
the incident record.
