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
| `APP_ACCESS_TOKEN` | Private root credential with at least 32 bytes of entropy, used for web administrator sessions and protected monitoring only. |
| `APP_BASE_URL` | Canonical root HTTPS origin, without a path. |
| `CORS_ALLOWED_ORIGINS` | Exact canonical web origin plus each approved `chrome-extension://` origin; no wildcard. |

`APPLICATION_IDENTITY_WRITES_ENABLED` is an optional closed rollout gate. It
accepts only `"0"` or `"1"` and defaults to `"0"`. Keep it disabled until the
maintenance backfill below is complete; fresh empty databases may enable it
after migrations report current and the Application table is confirmed empty.

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

Vercel Preview builds need the same five variable names because this validation
runs during `npm run build`, but they must not reuse Production values. Configure
an inert loopback database URL, Preview-only encryption and access credentials,
and the stable Preview HTTPS alias for both `APP_BASE_URL` and
`CORS_ALLOWED_ORIGINS`. Database-backed Preview routes remain intentionally
unavailable unless a separate disposable Preview database is provisioned.
Never point Preview at the Production database.

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
   disconnect behavior on the canonical origin by completing
   [the Chrome extension smoke runbook](chrome-extension-smoke.md), including
   its unconditional row, permission, and credential cleanup.
7. Inspect Vercel logs for the release window and require no related 5xx
   response before closing the release.

Do not paste response bodies from Settings, Applications, or resume endpoints
into tickets or release evidence.

## Authentication and Chrome extension pairing

Web users open `/connect` and submit the application access credential. The app
exchanges it for a Secure, HttpOnly, SameSite=Strict session cookie and does not
persist the submitted value in browser storage. Never paste `APP_ACCESS_TOKEN` into the extension.

For Chrome extension pairing:

1. Load the reviewed `extension/` directory and record the installed extension
   ID through the approved private operator channel.
2. Confirm its exact `chrome-extension://` origin is present in
   `CORS_ALLOWED_ORIGINS` before deployment.
3. From the authenticated Settings page, open **Chrome extension
   installations**, select that exact origin, and create a one-time pairing code.
4. In the popup, enter the canonical server origin and the one-time pairing code,
   then select **Connect**. The code is single-use and must not be recorded.
5. Confirm a read and one reversible save operation. Delete the smoke record.
6. Use **Disconnect** before transferring or troubleshooting a browser profile.

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

## Application identity maintenance rollout

This is the one-time **Production identity maintenance** procedure for an
existing database. Do not combine or reorder the stages. The workflow is
manual-only and requires `writers_stopped=true` on both dispatches. Writers
remain stopped continuously until every post-resume smoke pass succeeds.

Capture the reviewed application commit before starting:

```bash
set -euo pipefail
export TARGET_SHA="$(git rev-parse HEAD)"
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
```

Follow this exact hosted sequence. The backup prerequisite, gate, Vercel pause
and canonical `503` must be established before either workflow phase runs.

1. Verify the backup prerequisite before changing Production: complete
   [Backup and restore](#backup-and-restore), including a successful scratch
   restore, and record only the approved checksum, counts, schema, and
   migration identity. A verified backup prerequisite is mandatory.
2. Confirm the deployed candidate has the closed gate
   `APPLICATION_IDENTITY_WRITES_ENABLED=0` (the environment-file spelling is
   `APPLICATION_IDENTITY_WRITES_ENABLED="0"`). Do not proceed if the value is
   absent or enabled.
3. Pause Vercel Production using the provider's Production project pause
   control and require the canonical origin to return `503`. Record the pause
   and `503` confirmation, then stop every Application writer, including the
   web service, extension installations, monitoring writes, background work,
   and operator sessions. Keep writers stopped continuously; pausing traffic
   alone is not an attestation.
4. Dispatch the prepare phase from `main` with the required writer-stop
   attestation:

   ```bash
   PREPARE_DISPATCHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
   gh workflow run production-identity-maintenance.yml --ref main -f phase=prepare -f writers_stopped=true
   ```

   Capture numeric PREPARE_RUN_ID only after the dispatch. Retrieve the
   newest matching manual run for the exact workflow, `main`, and
   `TARGET_SHA`; retry while GitHub indexes the dispatch, then reject any
   non-numeric value:

   ```bash
   PREPARE_RUN_ID=""
   for _ in {1..30}; do
     PREPARE_RUN_ID="$(gh run list --workflow production-identity-maintenance.yml --branch main --event workflow_dispatch --limit 20 --json databaseId,headSha,createdAt --jq "[.[] | select(.headSha == \"$TARGET_SHA\" and .createdAt >= \"$PREPARE_DISPATCHED_AT\")] | sort_by(.createdAt) | last | .databaseId // empty")"
     [[ "$PREPARE_RUN_ID" =~ ^[1-9][0-9]*$ ]] && break
     sleep 2
   done
   [[ "$PREPARE_RUN_ID" =~ ^[1-9][0-9]*$ ]]
   PREPARE_METADATA="$(gh run view "$PREPARE_RUN_ID" --repo "$GITHUB_REPOSITORY" --json workflowName,event,headBranch,headSha)"
   jq -e --arg target "$TARGET_SHA" '(.workflowName == "Production identity maintenance") and (.event == "workflow_dispatch") and (.headBranch == "main") and (.headSha == $target)' <<<"$PREPARE_METADATA" >/dev/null
   ```

   Verify `headSha equals TARGET_SHA` from that metadata, then wait for the
   run to finish successfully:

   ```bash
   gh run watch "$PREPARE_RUN_ID" --exit-status
   ```

   Create a private mode-`0700` directory outside the repository and download
   the named artifact. Report paths and backfill execution are workflow-internal;
   do not set local `DRY_RUN_REPORT`/`APPLY_REPORT` variables or run the
   backfill directly.

   ```bash
   EVIDENCE_ROOT="/absolute/private/application-identity-maintenance"
   install -d -m 0700 "$EVIDENCE_ROOT/prepare"
   PREPARE_REPORT="$EVIDENCE_ROOT/prepare/application-identity-prepare.json"
   gh run download "$PREPARE_RUN_ID" --repo "$GITHUB_REPOSITORY" --name "application-identity-prepare-$PREPARE_RUN_ID" --dir "$EVIDENCE_ROOT/prepare"
   chmod 0700 "$EVIDENCE_ROOT/prepare"
   ```

   Run the comparator self-check on the prepare report, then review only its
   privacy-safe summary. Require matching row counts, state totals that sum to
   the count, and `uniqueIndexVerified=true`; never print URLs, titles,
   companies, bodies, credentials, or connection values.

   ```bash
   node scripts/compare-application-identity-reports.mjs --expected "$PREPARE_REPORT" --actual "$PREPARE_REPORT" --actual-mode dry-run
   jq '{schemaVersion, mode, rowCountBefore, rowCountAfter, stateTotals, uniqueIndexVerified}' "$PREPARE_REPORT"
   ```

   Review the prepare report and approve it before continuing.
5. Dispatch apply only after the prepare report is approved, using the same
   `TARGET_SHA` and an explicitly captured numeric `PREPARE_RUN_ID`:

   ```bash
   [[ "$PREPARE_RUN_ID" =~ ^[1-9][0-9]*$ ]]
   APPLY_DISPATCHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
   gh workflow run production-identity-maintenance.yml --ref main -f phase=apply -f writers_stopped=true -f prepare_run_id="$PREPARE_RUN_ID"
   ```

   Capture numeric APPLY_RUN_ID from the newest matching workflow-dispatch
   run after this dispatch, validate it, and verify the apply run's metadata:

   ```bash
   APPLY_RUN_ID=""
   for _ in {1..30}; do
     APPLY_RUN_ID="$(gh run list --workflow production-identity-maintenance.yml --branch main --event workflow_dispatch --limit 20 --json databaseId,headSha,createdAt --jq "[.[] | select(.headSha == \"$TARGET_SHA\" and .createdAt >= \"$APPLY_DISPATCHED_AT\")] | sort_by(.createdAt) | last | .databaseId // empty")"
     [[ "$APPLY_RUN_ID" =~ ^[1-9][0-9]*$ ]] && break
     sleep 2
   done
   [[ "$APPLY_RUN_ID" =~ ^[1-9][0-9]*$ ]]
   APPLY_METADATA="$(gh run view "$APPLY_RUN_ID" --repo "$GITHUB_REPOSITORY" --json workflowName,event,headBranch,headSha)"
   jq -e --arg target "$TARGET_SHA" '(.workflowName == "Production identity maintenance") and (.event == "workflow_dispatch") and (.headBranch == "main") and (.headSha == $target)' <<<"$APPLY_METADATA" >/dev/null
   ```

   Verify apply run headSha equals TARGET_SHA, then watch it with exit-status
   handling. A failed watch is an abort, not a reason to resume writers:

   ```bash
   gh run watch "$APPLY_RUN_ID" --exit-status
   install -d -m 0700 "$EVIDENCE_ROOT/apply"
   APPLY_REPORT="$EVIDENCE_ROOT/apply/application-identity-apply.json"
   gh run download "$APPLY_RUN_ID" --repo "$GITHUB_REPOSITORY" --name "application-identity-apply-$APPLY_RUN_ID" --dir "$EVIDENCE_ROOT/apply"
   chmod 0700 "$EVIDENCE_ROOT/apply"
   ```

   Run the comparator against the approved prepare report and actual apply
   report, then review the apply report's privacy-safe summary. Require the
   same counts, totals, and unique index result as prepare.

   ```bash
   node scripts/compare-application-identity-reports.mjs --expected "$PREPARE_REPORT" --actual "$APPLY_REPORT" --actual-mode apply
   jq '{schemaVersion, mode, rowCountBefore, rowCountAfter, stateTotals, uniqueIndexVerified}' "$APPLY_REPORT"
   ```

   compare the approved prepare report with the apply report using the command
   above. Do not proceed on any mismatch.
6. After the apply report, migration status, empty schema diff, row counts, and
   unique identity index are approved, set the Production gate to
   `APPLICATION_IDENTITY_WRITES_ENABLED=1` (environment-file spelling:
   `APPLICATION_IDENTITY_WRITES_ENABLED="1"`) while Vercel remains paused and
   the canonical `503` is still observed.
7. Deploy the same exact TARGET_SHA while Vercel remains paused and canonical
   503. Promote only the Vercel deployment whose assigned commit is exactly
   `TARGET_SHA`; require `Ready` and retain the assignment evidence. Do not
   create a new commit, deploy an unreviewed working tree, or run authenticated
   smoke checks while paused.
8. Resume Vercel Production, confirm the pause is cleared and the canonical
   origin is no longer `503`, but keep every Application writer stopped. Only
   after this resume run the `production monitor` and require its authenticated
   `200` result.
9. With Vercel online and writers still stopped, run the post-resume smoke
   sequence: authenticated UI create/read/delete cleanup; then extension
   pairing/exchange/create and read using a one-time pairing code; revoke the
   ExtensionInstallation; verify replay rejection and 401 from the revoked
   credential. These checks must not run while Vercel is paused.
10. The final action is `resume Application writers LAST`, only after every
    post-resume smoke pass succeeds. Retain only privacy-safe prepare/apply reports and approved
    backup evidence.

Abort behavior is part of the procedure. A pre-resume failure leaves Vercel
paused with canonical `503`; keep the gate at `0` unless a reviewed hosted
rollback explicitly changes it, and keep writers stopped. A post-resume smoke
failure leaves Application writers stopped; pause Vercel again before any
further hosted change, preserve sanitized evidence, and recover through an
isolated restore target and reviewed rollback. Any failure means writers remain
stopped continuously. do not enable identity writes, resume writers, or retry
apply with a different commit or report. Do not run `prisma db push`, `prisma
db reset`, or `prisma migrate reset`, or use other destructive shortcuts against
Production.

## Backup and restore

The scheduled `.github/workflows/production-backup.yml` job runs nightly and
may also be started manually after merge. It reads Production only through the
`PRODUCTION_DATABASE_URL` repository secret, creates a PostgreSQL 17 custom
dump, validates its checksum and table-of-contents, restores it into a fresh
local scratch database, and compares ordered SHA-256 fingerprints before age
encryption. GitHub retains only the encrypted dump, encrypted-file checksum,
and sanitized manifest for 30 days. The public recipient is stored in the
`BACKUP_AGE_RECIPIENT` repository variable.

The recovery identity is private operator material at
`~/Library/Application Support/easy-job-application-tracker/secrets/backup.agekey`.
Keep it outside Git and cloud artifacts with mode `0600`; never print or upload
it. Back it up through the approved private credential channel. After download,
verify the encrypted checksum, decrypt with `age --decrypt --identity`, verify
the decrypted dump against `dumpSha256` in the manifest, and follow the scratch
restore rehearsal below. Set `TZ=UTC` when running
`scripts/fingerprint-database.mjs` during a local restore comparison; otherwise
local timezone parsing of timestamp-without-time-zone fields can produce a
false Application digest mismatch. The scheduled workflow already runs in UTC.
Manual dispatch remains a post-merge validation: dispatch both operations
workflows after changing their definitions and require successful runs from the
default branch.

Before a migration or risky release, create a PostgreSQL custom-format dump in
an access-controlled location outside the repository. Use PostgreSQL 17 tools
only; confirm both client versions before starting. The service file contains
only host, port, database, and user. The separate password file uses libpq's
`hostname:port:database:username:password` format; escape any literal `:` or
`\\` in a field with `\\`. Substitute the reviewed values through a private
editor, never through shell arguments or command-line history:

```bash
umask 077
BACKUP_SERVICE_FILE="$HOME/.config/jobtracker/production-backup.pg_service.conf"
BACKUP_PASS_FILE="$HOME/.config/jobtracker/production-backup.pgpass"
install -d -m 0700 "$(dirname "$BACKUP_SERVICE_FILE")"
install -m 0600 /dev/null "$BACKUP_SERVICE_FILE"
install -m 0600 /dev/null "$BACKUP_PASS_FILE"
```

Write this exact service-file shape to `$BACKUP_SERVICE_FILE`:

```ini
[production_backup]
host=PRODUCTION_DATABASE_HOST
port=5432
dbname=PRODUCTION_DATABASE_NAME
user=PRODUCTION_DATABASE_USER
```

Write one matching libpq password record to `$BACKUP_PASS_FILE`:

```text
PRODUCTION_DATABASE_HOST:5432:PRODUCTION_DATABASE_NAME:PRODUCTION_DATABASE_USER:PRODUCTION_DATABASE_PASSWORD
```

Then run only the service-based command family:

```bash
chmod 0600 "$BACKUP_SERVICE_FILE" "$BACKUP_PASS_FILE"
export PGSERVICEFILE="$BACKUP_SERVICE_FILE"
export PGPASSFILE="$BACKUP_PASS_FILE"
pg_dump --version | grep -E '^pg_dump \(PostgreSQL\) 17\.'
pg_restore --version | grep -E '^pg_restore \(PostgreSQL\) 17\.'
pg_dump --dbname=service=production_backup \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="$BACKUP_FILE"
pg_restore --list "$BACKUP_FILE" > "$BACKUP_TOC"
shasum -a 256 "$BACKUP_FILE" > "$BACKUP_CHECKSUM"
shasum -a 256 -c "$BACKUP_CHECKSUM"
```

Unset `PGSERVICEFILE` and `PGPASSFILE` after the operation. Retain or destroy
their mode-`0600` files according to the private credential policy. Never put a
raw database URL or password in `pg_dump`/`pg_restore` arguments, logs, tickets,
or evidence.

Record only the checksum, schema/migration identity, table counts, and
non-reversible fingerprints. Never retain database URLs or row bodies in the
manifest.

Restore rehearsal:

1. Create a new isolated PostgreSQL database or Neon branch. Never target the
   Production database.
2. Run `pg_restore --exit-on-error --no-owner --no-privileges` against that
   isolated target.
3. Compare every public application table, including Application, Settings,
   ExtensionPairingGrant, ExtensionInstallation, and migration history, using
   the approved ordered fingerprints from the source manifest.
4. Run `npx prisma migrate status` and the schema-diff command against the
   restored target.
5. Destroy the rehearsal target only after the comparison succeeds; retain the
   protected dump and checksum according to the backup policy.

Restore to Production is a declared incident operation. Restore into an
isolated target first, validate it, then switch the application connection in a
controlled release. Do not overwrite the active database in place.

## Authenticated production monitoring

The `.github/workflows/production-monitor.yml` workflow runs hourly and may be
dispatched manually after merge. It supplies the root HTTPS origin from the
`PRODUCTION_APP_URL` repository variable and the credential from the
`PRODUCTION_APP_ACCESS_TOKEN` repository secret to `npm run check:production`.
Success requires an exact authenticated `200` JSON stats shape. All other
statuses, malformed responses, connection failures, and timeouts fail with a
generic message that excludes the URL, credential, and response body. Treat a
failed scheduled run as an incident signal and follow Vercel and Neon diagnosis
below; do not weaken authentication to make the check pass.

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
