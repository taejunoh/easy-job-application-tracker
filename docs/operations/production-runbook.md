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

`APPLICATION_IDENTITY_WRITES_ENABLED` is a server-only identity gate. It accepts
only `"0"` or `"1"` and defaults to `"0"`. `APPLICATION_WRITES_ENABLED` is a
server-only application-write gate; it accepts exactly `"0"` or `"1"`, and a
missing value defaults closed (`"0"`). Any defined invalid value—including a
blank, whitespace, `true`, or another string—fails validation. Production must
set both gates explicitly. Normal local/CI uses `"1"` for application writes;
maintenance uses `"0"`. The identity and application gates are distinct: the
first controls identity maintenance writes, while the second stops ordinary
Application mutations. Keep the identity gate disabled until the maintenance
backfill below is complete; fresh empty databases may enable it after
migrations report current and the Application table is confirmed empty.

### Application stopped-write response contract

When `APPLICATION_WRITES_ENABLED="0"`, every persistent Application mutation
returns HTTP status `503` with exactly this JSON body:

```json
{ "error": "Application writes are temporarily disabled", "code": "writes_stopped", "retryable": true }
```

The response also includes exactly these headers:

```text
Cache-Control: private, no-store
Pragma: no-cache
Retry-After: 60
```

This application-level response is distinct from the platform response `503
DEPLOYMENT_PAUSED`, which Vercel returns while the project is paused.

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

The stages below call one parameterized candidate procedure. It is the
explicit form of the existing `vercel --prod --skip-domain` Production
operation: it never assigns the canonical domain during staging. Call it
only from an unpaused flow. The candidate procedure is unpaused-only. The raw
API response is never stored, echoed, uploaded, added to the ledger, or used
as evidence; only its allow-listed projection is retained, and temporary JSON
variables are unset after validation.

```bash
set -euo pipefail

stage_candidate() (
  local stage_name="${1:-}"
  local EXPECTED_PRODUCTION_ORIGIN="https://easy-job-application-tracker.vercel.app"
  local WORKTREE_STATUS="" CURRENT_SHA=""
  local CANDIDATE_DEPLOYMENT="" CANDIDATE_INSPECT="" CANDIDATE_METADATA="" CANONICAL_METADATA=""
  local CANDIDATE_ID="" CANDIDATE_URL=""
  set -o pipefail || return 1
  assert_canonical_unpaused() {
    local origin="${1:-}" HTTP_STATUS=""
    [[ "$origin" == "$EXPECTED_PRODUCTION_ORIGIN" ]] || return 1
    HTTP_STATUS="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --connect-timeout 5 --max-time 15 -- "$origin")" || return 1
    [[ "$HTTP_STATUS" != "000" && "$HTTP_STATUS" != "503" ]] || return 1
    [[ "$HTTP_STATUS" =~ ^(2[0-9]{2}|3[0-9]{2}|401)$ ]] || return 1
  }
  [[ "$stage_name" == "identity=1,writes=0" || "$stage_name" == "identity=1,writes=1" ]] || return 1
  [[ -n "${TARGET_SHA:-}" ]] || return 1
  [[ -n "${APP_BASE_URL:-}" ]] || return 1
  [[ "$APP_BASE_URL" == "$EXPECTED_PRODUCTION_ORIGIN" ]] || return 1
  WORKTREE_STATUS="$(git status --porcelain)" || return 1
  [[ -z "$WORKTREE_STATUS" ]] || return 1
  CURRENT_SHA="$(git rev-parse HEAD)" || return 1
  [[ "$CURRENT_SHA" == "$TARGET_SHA" ]] || return 1

  assert_canonical_unpaused "$APP_BASE_URL" || return 1
  CANDIDATE_DEPLOYMENT="$(vercel deploy . --prod --skip-domain --yes --format=json --no-color | jq -ce '{id,url}')" || return 1
  jq -e '(.id | type == "string") and (.id | test("^dpl_[A-Za-z0-9]+$")) and (.url | type == "string") and (.url | length > 0)' <<<"$CANDIDATE_DEPLOYMENT" >/dev/null || return 1
  CANDIDATE_ID="$(jq -er '.id' <<<"$CANDIDATE_DEPLOYMENT")" || return 1
  CANDIDATE_URL="$(jq -er '.url' <<<"$CANDIDATE_DEPLOYMENT")" || return 1

  CANDIDATE_INSPECT="$(vercel inspect "$CANDIDATE_ID" --wait --timeout 3m --format=json --no-color | jq -ce '{id,readyState,aliases}')" || return 1
  jq -e --arg id "$CANDIDATE_ID" '(.id == $id) and (.readyState == "READY") and (.aliases | type == "array") and ((.aliases | length) == 0)' <<<"$CANDIDATE_INSPECT" >/dev/null || return 1

  CANDIDATE_METADATA="$(vercel api "/v13/deployments/$CANDIDATE_ID" --raw | jq -ce 'if (.alias | type) == "array" then {id,readyState,target,url,githubCommitSha:.meta.githubCommitSha,aliases:(.alias//[])} else error("deployment alias shape is not an array") end')" || return 1
  jq -e --arg id "$CANDIDATE_ID" --arg sha "$TARGET_SHA" --arg url "$CANDIDATE_URL" '(.id == $id) and (.readyState == "READY") and (.target == "production") and (.githubCommitSha == $sha) and (.url == $url) and (.aliases | type == "array") and ((.aliases | length) == 0)' <<<"$CANDIDATE_METADATA" >/dev/null || return 1

  assert_canonical_unpaused "$APP_BASE_URL" || return 1
  vercel promote "$CANDIDATE_ID" --yes >/dev/null || return 1
  CANONICAL_METADATA="$(vercel inspect "$APP_BASE_URL" --format=json --no-color | jq -ce '{id}')" || return 1
  jq -e --arg id "$CANDIDATE_ID" '.id == $id' <<<"$CANONICAL_METADATA" >/dev/null || return 1
  printf '%s\n' "$CANDIDATE_ID" || return 1
)
```

Capture the reviewed application commit before starting:

```bash
set -euo pipefail
git fetch origin main --prune
export TARGET_SHA="$(git rev-parse origin/main)"
git rev-parse --verify refs/remotes/origin/main >/dev/null
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
```

`origin/main` is the authoritative source for `TARGET_SHA`: both manual
workflow dispatches below use `--ref main`, so a local branch `HEAD` or an
unreviewed worktree must never be used as the target. The run-list filters and
metadata checks for both phases must match this same SHA before a run is
watched or its artifact is reviewed.

Follow this exact hosted sequence. Vercel is unpaused for every build and
promotion. It is paused only across prepare/apply, and the actual platform
`503 DEPLOYMENT_PAUSED` must be observed before either workflow phase runs.

1. Verify the backup prerequisite before changing Production: complete
   [Backup and restore](#backup-and-restore), including a successful scratch
   restore, and record only the approved checksum, counts, schema, and
   migration identity. A verified backup prerequisite is mandatory.
2. Confirm a Ready canonical support deployment with
   `APPLICATION_IDENTITY_WRITES_ENABLED="0"` and
   `APPLICATION_WRITES_ENABLED="1"` (`identity=0,writes=1`). Before Stage 1
   promotion, use supported authenticated flows to create one disposable
   Application, one installed extension credential, and a second unconsumed
   pairing grant. Keep their URL, IDs, tokens, pairing codes, and request/
   response bodies only in a private mode-0700 workspace; never put them in
   logs, artifacts, Actions output, shell history, PR/comments, or docs.
   Create the private fixture ledger before creating or using any fixture. This
   creates a private directory with mode `0700` and a ledger with mode `0600`.
   The path is supplied by the operator and must be absolute and outside this
   repository; a missing, relative, or repository-local path fails closed:

   ```bash
   set -euo pipefail
   : "${EVIDENCE_ROOT:?set EVIDENCE_ROOT to a private path outside the repository}"
   file_mode() {
     stat -f '%Lp' -- "$1" 2>/dev/null || stat -c '%a' -- "$1"
   }
   [[ "$EVIDENCE_ROOT" == /* ]] || exit 1
   EVIDENCE_PARENT="$(dirname -- "$EVIDENCE_ROOT")"
   EVIDENCE_BASENAME="$(basename -- "$EVIDENCE_ROOT")"
   [[ "$EVIDENCE_BASENAME" != "." && "$EVIDENCE_BASENAME" != ".." && -n "$EVIDENCE_BASENAME" ]] || exit 1
   [[ -d "$EVIDENCE_PARENT" ]] || exit 1
   EVIDENCE_PARENT_REAL="$(cd -- "$EVIDENCE_PARENT" && pwd -P)" || exit 1
   EVIDENCE_CANDIDATE="$EVIDENCE_PARENT_REAL/$EVIDENCE_BASENAME"
   REPO_ROOT="$(cd -- "$(git rev-parse --show-toplevel)" && pwd -P)"
   case "$EVIDENCE_CANDIDATE" in
     "$REPO_ROOT"|"$REPO_ROOT"/*) exit 1 ;;
   esac
   [[ ! -L "$EVIDENCE_CANDIDATE" ]] || exit 1
   umask 077
   install -d -m 0700 -- "$EVIDENCE_CANDIDATE" || exit 1
   EVIDENCE_ROOT="$EVIDENCE_CANDIDATE"
   [[ -d "$EVIDENCE_ROOT" && ! -L "$EVIDENCE_ROOT" ]] || exit 1
   [[ "$(cd -- "$EVIDENCE_ROOT" && pwd -P)" == "$EVIDENCE_CANDIDATE" ]] || exit 1
   [[ "$(file_mode "$EVIDENCE_ROOT")" == "700" ]] || exit 1
   LEDGER="$EVIDENCE_ROOT/rollout-ledger.json"
   [[ ! -e "$LEDGER" && ! -L "$LEDGER" ]] || exit 1
   (set -o noclobber; : > "$LEDGER") || exit 1
   [[ -f "$LEDGER" && ! -L "$LEDGER" ]] || exit 1
   chmod 0600 "$LEDGER" || exit 1
   [[ "$(file_mode "$LEDGER")" == "600" ]] || exit 1
   ```

   Run this setup block locally before any fixture request; it contains no
   provider/API command and no real secret or credential. The ledger's required
   ownership and state fields are the rollout SHA, staged and promoted
   deployment IDs, canonical origin, exact owned Application IDs,
   pre/post-probe hashes, Settings existence and hashes, pairing grant and
   installation IDs, expected terminal state, and observed result.

   Retain `rollout-ledger.json` until cleanup verification succeeds. It is
   private operator material: never committed or uploaded; never echo or copy it to logs,
   Actions artifacts, pull requests, specifications, README files, shell
   history, or deployment output.
3. Stage the Stage 1 `identity=1,writes=0` candidate while unpaused:

   ```bash
   vercel env add APPLICATION_IDENTITY_WRITES_ENABLED production --value "1" --yes --force || exit 1
   vercel env add APPLICATION_WRITES_ENABLED production --value "0" --yes --force || exit 1
   STAGE_ONE_CANDIDATE_ID="$(stage_candidate "identity=1,writes=0")" || exit 1
   [[ "$STAGE_ONE_CANDIDATE_ID" =~ ^dpl_[A-Za-z0-9]+$ ]] || exit 1
   ```

   Immediately bind the reviewed Stage 1 evidence to that exact promoted
   deployment in the private ledger. This writes no provider response body and
   merges only the new `stage1` object into the pre-populated ledger; it never
   replaces fixture or cleanup ownership. Before this block, the private ledger
   must be a JSON object with `schemaVersion: 1` and `fixtureOwnership` records
   for exact Application IDs, pre/post hashes, Settings state/hashes, the
   pre-stop pairing grant/code reference, installed credential/installation,
   and at least one cleanup action. Do not continue if the ledger is missing,
   a symlink, has a conflicting `stage1`, or does not validate after the atomic
   rename. Every owned-ID list contains only non-empty strings; optional
   pairing, installation, and post-resume ID lists use the same rule. Each
   cleanup record includes a non-empty action, expected terminal state,
   timestamp, and observed result; `pending` is valid before cleanup succeeds.

   ```bash
   set -euo pipefail
   file_mode() {
     stat -f '%Lp' -- "$1" 2>/dev/null || stat -c '%a' -- "$1"
   }
   : "${EVIDENCE_ROOT:?private ledger path is required}"
   [[ -d "$EVIDENCE_ROOT" && ! -L "$EVIDENCE_ROOT" ]] || exit 1
   EVIDENCE_ROOT="$(cd -- "$EVIDENCE_ROOT" && pwd -P)" || exit 1
   LEDGER="$EVIDENCE_ROOT/rollout-ledger.json"
   [[ -f "$LEDGER" && ! -L "$LEDGER" ]] || exit 1
   [[ "$(file_mode "$EVIDENCE_ROOT")" == "700" ]] || exit 1
   [[ "$(file_mode "$LEDGER")" == "600" ]] || exit 1
   [[ "${TARGET_SHA:-}" != "" ]] || exit 1
   [[ "${APP_BASE_URL:-}" == "https://easy-job-application-tracker.vercel.app" ]] || exit 1
   [[ "$STAGE_ONE_CANDIDATE_ID" =~ ^dpl_[A-Za-z0-9]+$ ]] || exit 1
   STAGE_ONE_RECORDED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
   # mktemp performs exclusive noclobber creation in this verified physical directory.
   STAGE_ONE_LEDGER_TMP="$(mktemp "$EVIDENCE_ROOT/.rollout-ledger.stage1.XXXXXX")" || exit 1
   [[ -f "$STAGE_ONE_LEDGER_TMP" && ! -L "$STAGE_ONE_LEDGER_TMP" ]] || { rm -f -- "$STAGE_ONE_LEDGER_TMP"; exit 1; }
   chmod 0600 "$STAGE_ONE_LEDGER_TMP" || { rm -f -- "$STAGE_ONE_LEDGER_TMP"; exit 1; }
   jq -e '
     type == "object" and (.schemaVersion == 1) and (.stage1? == null) and
     (.fixtureOwnership | type == "object") and
     (.fixtureOwnership.applicationIds | type == "array" and length > 0) and
     all(.fixtureOwnership.applicationIds[]; (type == "string") and length > 0) and
     (.fixtureOwnership.ownedDeploymentIds | type == "array" and length > 0) and
     all(.fixtureOwnership.ownedDeploymentIds[]; (type == "string") and length > 0) and
     ((.fixtureOwnership.ownedDeploymentIds | unique | length) == (.fixtureOwnership.ownedDeploymentIds | length)) and
     (if (.fixtureOwnership | has("pairingGrantIds")) then (.fixtureOwnership.pairingGrantIds | type == "array" and all(.[]; (type == "string") and length > 0)) else true end) and
     (if (.fixtureOwnership | has("installationIds")) then (.fixtureOwnership.installationIds | type == "array" and all(.[]; (type == "string") and length > 0)) else true end) and
     (if (.fixtureOwnership | has("postResumeApplicationIds")) then (.fixtureOwnership.postResumeApplicationIds | type == "array" and all(.[]; (type == "string") and length > 0)) else true end) and
     (if (.fixtureOwnership | has("postResumePairingGrantIds")) then (.fixtureOwnership.postResumePairingGrantIds | type == "array" and all(.[]; (type == "string") and length > 0)) else true end) and
     (if (.fixtureOwnership | has("postResumeInstallationIds")) then (.fixtureOwnership.postResumeInstallationIds | type == "array" and all(.[]; (type == "string") and length > 0)) else true end) and
     (.fixtureOwnership.preProbeHash | type == "string" and length > 0) and
     (.fixtureOwnership.postProbeHash | type == "string" and length > 0) and
     (.fixtureOwnership.settings | type == "object") and
     (.fixtureOwnership.settings.existedBefore | type == "boolean") and
     (.fixtureOwnership.settings.contentHashBefore | type == "string" and length > 0) and
     (.fixtureOwnership.settings.contentHashAfter | type == "string" and length > 0) and
     (.fixtureOwnership.pairing | type == "object") and
     (.fixtureOwnership.pairing.preStopUnconsumedGrantId | type == "string" and length > 0) and
     (.fixtureOwnership.pairing.codeReference | type == "string" and length > 0) and
     (.fixtureOwnership.installation | type == "object") and
     (.fixtureOwnership.installation.credentialReference | type == "string" and length > 0) and
     (.fixtureOwnership.installation.installationId | type == "string" and length > 0) and
     (.fixtureOwnership.cleanup | type == "array" and length > 0) and
     .fixtureOwnership as $owned |
     all($owned.cleanup[]; (type == "object") and
       (.action | IN("delete_application", "consume_pairing_grant", "revoke_installation", "reconcile")) and
       (.expectedTerminalState | type == "string" and length > 0) and
       (.timestamp | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
       (.observedResult | IN("pending", "succeeded", "verified", "rejected")) and
       (if .action == "delete_application" then (.targetId as $id | ($owned.applicationIds | index($id)) != null)
        elif .action == "consume_pairing_grant" then (.targetId as $id | (($owned.pairingGrantIds // []) | index($id)) != null)
        elif .action == "revoke_installation" then (.targetId == $owned.installation.installationId)
        else .targetRef == "settings" end))
   ' "$LEDGER" >/dev/null || { rm -f -- "$STAGE_ONE_LEDGER_TMP"; exit 1; }
   jq \
     --arg id "$STAGE_ONE_CANDIDATE_ID" \
     --arg sha "$TARGET_SHA" \
     --arg origin "$APP_BASE_URL" \
     --arg observedAt "$STAGE_ONE_RECORDED_AT" \
     '. + {
       stage1: {
         deploymentId: $id,
         targetSha: $sha,
         gates: {identity: "1", writes: "0"},
         reviewedGateConfig: {identity: "1", writes: "0", reviewedAt: $observedAt},
         ready: true,
         readyState: "READY",
         readyEvidence: {deploymentId: $id, state: "READY", observedAt: $observedAt},
         canonicalPromotionVerified: true,
         canonicalPromotion: {origin: $origin, deploymentId: $id, verified: true, verifiedAt: $observedAt},
         compatibilityVerified: true,
         timestamps: {recordedAt: $observedAt, readyObservedAt: $observedAt, canonicalPromotionVerifiedAt: $observedAt}
       }
     }' "$LEDGER" > "$STAGE_ONE_LEDGER_TMP" || { rm -f -- "$STAGE_ONE_LEDGER_TMP"; exit 1; }
   [[ -f "$LEDGER" && ! -L "$LEDGER" && "$(file_mode "$LEDGER")" == "600" ]] || { rm -f -- "$STAGE_ONE_LEDGER_TMP"; exit 1; }
   mv -f -- "$STAGE_ONE_LEDGER_TMP" "$LEDGER" || { rm -f -- "$STAGE_ONE_LEDGER_TMP"; exit 1; }
   [[ -f "$LEDGER" && ! -L "$LEDGER" ]] || exit 1
   [[ "$(file_mode "$LEDGER")" == "600" ]] || exit 1
   jq -e --arg id "$STAGE_ONE_CANDIDATE_ID" --arg sha "$TARGET_SHA" --arg origin "$APP_BASE_URL" '
     type == "object" and .schemaVersion == 1 and
     (.fixtureOwnership | type == "object") and
     .stage1.deploymentId == $id and .stage1.targetSha == $sha and
     .stage1.gates == {identity: "1", writes: "0"} and
     .stage1.reviewedGateConfig.identity == "1" and .stage1.reviewedGateConfig.writes == "0" and
     .stage1.ready == true and .stage1.readyState == "READY" and
     .stage1.readyEvidence.deploymentId == $id and .stage1.readyEvidence.state == "READY" and
     .stage1.canonicalPromotionVerified == true and
     .stage1.canonicalPromotion.origin == $origin and .stage1.canonicalPromotion.deploymentId == $id and
     .stage1.canonicalPromotion.verified == true and .stage1.compatibilityVerified == true
   ' "$LEDGER" >/dev/null || exit 1
   unset STAGE_ONE_LEDGER_TMP STAGE_ONE_RECORDED_AT
   ```

   This stage sets `APPLICATION_IDENTITY_WRITES_ENABLED="1"` while keeping
   `APPLICATION_WRITES_ENABLED="0"`. The procedure inspects the candidate
   before promotion, proves the exact intended Git SHA, no aliases, and no
   canonical alias, and
   promotes that same ID while unpaused. Promote the candidate while unpaused
   only after every identity and provenance check passes. Record its staged
   deployment ID and
   promotion time, start a bounded drain, and wait at least
   `2 × maxDuration` (at least 60 seconds when
   modules have a 30-second maximum duration), and pass an authenticated
   negative probe. Use the exact fixtures to prove all eight persistent
   mutations return HTTP `503` with code `writes_stopped`: Application
   POST/PATCH/DELETE; Settings PUT; pairing creation; valid pair exchange;
   installation deletion; and self-revoke. The Settings singleton is created
   only on the first successful `PUT /api/settings`; Settings GET does not
   create a row, and an authenticated `GET /api/settings` never creates the
   row. Also prove
   installation-authenticated reads do not touch `lastUsedAt/updatedAt`.
   Compare only sanitized counts/hashes before and after, and record sanitized
   results in the private ledger.
4. Pause Vercel Production using the provider's Production project pause
   control and REQUIRE the actual canonical `503 DEPLOYMENT_PAUSED` before any
   prepare/apply. Record pause evidence and the observation. The operator must
   stop every Application writer, including web, extension, monitoring, background, and
   operator writers. Keep writers stopped continuously; pausing traffic alone
   is not an attestation. There is no build or promotion while paused. While
   paused, only observation and maintenance commands are allowed: no build,
   deploy, alias, or promote command may be run while paused, queued, or made
   reachable through the candidate procedure. The candidate procedure
   performs a fresh canonical-origin check before each deploy and promotion;
   no shell attestation or remembered unpaused state is authoritative.
5. Dispatch the prepare phase from `main` with the required writer-stop
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
6. Dispatch apply only after the prepare report is approved, using the same
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
7. After the apply report, migration status, empty schema diff, row counts, and
   unique identity index are approved, keep Vercel paused and confirm the
   actual `503 DEPLOYMENT_PAUSED`. Do not build or promote while paused.

   **Paused-after-apply state machine.** Enter `PAUSED_AFTER_APPLY` only after
   apply completed, the project is paused, and the recorded Stage 1 `identity=1,writes=0` deployment is known `Ready`. Review apply, migration, schema, identity, and private fixture evidence before any resume action.
   Any failure, or a missing or ambiguous compatible candidate, enters
   `HOLD_PAUSED`: preserve all evidence, keep ordinary and external writers stopped, and perform no build, deploy, alias, or promote. No paused state
   permits promotion, and never enable writers merely to recover. No state
   permits promotion while paused.

   The allowed transitions are ordered and explicit: `PAUSED_AFTER_APPLY ->
   UNPAUSED_READONLY` only after the approved evidence gate and the exact
   recorded deployment identity are confirmed; `PAUSED_AFTER_APPLY ->
   HOLD_PAUSED` on any failure or missing/ambiguous compatible target;
   `UNPAUSED_READONLY -> HOLD_PAUSED` on a missing or rejected rollback
   candidate; and a successful compatible rollback remains
   `UNPAUSED_READONLY`. Every failure transition keeps ordinary and external
   writers stopped and retains the ledger.

   Evidence approval resumes the recorded same-identity exact Stage 1 deployment
   deployment ID without redeploying and enters `UNPAUSED_READONLY`. Run only
   read-only and authenticated negative probes after the resume. Never resume
   an identity-unaware, pre-apply, remembered URL, or environment-claim-only
   target. If a regression occurs after resume, remain unpaused only long
   enough to reuse the existing `stage_candidate` procedure with stage name
   `identity=1,writes=0`; its Ready, inspected Production candidate must prove
   the recorded identity `identity=1,writes=0`, reviewed compatible exact SHA
   and exact ID before that exact ID is promoted. Execute the same
   guarded procedure only while unpaused; do not
   add a second deploy or promotion procedure. Drain at least 60 seconds and
   probe again. If absent, pause and enter `HOLD_PAUSED` with writers stopped.

   Cleanup or rejection failure first requires the provider Production pause
   control, followed by a bounded canonical-origin curl that proves HTTP `503`
   and `DEPLOYMENT_PAUSED`; only then is the state labeled `HOLD_PAUSED`.
   ledger retained with all evidence and the safe paused/read-only state is
   preserved. Ordinary and external writers remain stopped. Cleanup failure
   never permits an unbounded delete or a second unrecorded credential attempt.
   There is
   no build, deploy, alias, or promote command reachable from a paused state.

8. Resume Vercel Production only after the `PAUSED_AFTER_APPLY` evidence gate
   is approved. Resume the recorded same-identity exact Stage 1 deployment
   without redeploying. Confirm the pause is cleared and the canonical origin
   is no longer the platform `503`; do not build or promote as part of this
   resume. The private Stage 1 record is the resume target selector; validate
   it before using the provider's manual/UI resume control. If a read-only
   regression is observed after resume, run the following ordered transition
   while unpaused. It validates the same record before creating a new candidate
   with the existing guarded procedure; no environment-only target claim is
   accepted. The provider's Production pause control is manual/UI-only on this
   CLI version. Every missing/rejected record, candidate, evidence, or probe
   stops for that control, proves the exact canonical paused response, and only
   then labels the state `HOLD_PAUSED`. The block never prints ledger values or
   response bodies.

   ```bash
   set -euo pipefail
   # Writers remain stopped and the ledger is retained on every failure.
   CANONICAL_ORIGIN="https://easy-job-application-tracker.vercel.app"

   file_mode() {
     stat -f '%Lp' -- "$1" 2>/dev/null || stat -c '%a' -- "$1"
   }

   validate_evidence_root() {
     local REPO_ROOT="" EVIDENCE_PARENT="" EVIDENCE_BASENAME="" EVIDENCE_PARENT_REAL="" EVIDENCE_CANDIDATE=""
     [[ -n "${EVIDENCE_ROOT:-}" && "$EVIDENCE_ROOT" == /* ]] || return 1
     EVIDENCE_PARENT="$(dirname -- "$EVIDENCE_ROOT")" || return 1
     EVIDENCE_BASENAME="$(basename -- "$EVIDENCE_ROOT")" || return 1
     [[ -d "$EVIDENCE_PARENT" && -n "$EVIDENCE_BASENAME" && "$EVIDENCE_BASENAME" != "." && "$EVIDENCE_BASENAME" != ".." ]] || return 1
     EVIDENCE_PARENT_REAL="$(cd -- "$EVIDENCE_PARENT" && pwd -P)" || return 1
     EVIDENCE_CANDIDATE="$EVIDENCE_PARENT_REAL/$EVIDENCE_BASENAME"
     REPO_ROOT="$(cd -- "$(git rev-parse --show-toplevel)" && pwd -P)" || return 1
     case "$EVIDENCE_CANDIDATE" in "$REPO_ROOT"|"$REPO_ROOT"/*) return 1 ;; esac
     [[ -d "$EVIDENCE_CANDIDATE" && ! -L "$EVIDENCE_CANDIDATE" ]] || return 1
     [[ "$(cd -- "$EVIDENCE_CANDIDATE" && pwd -P)" == "$EVIDENCE_CANDIDATE" ]] || return 1
     [[ "$(file_mode "$EVIDENCE_CANDIDATE")" == "700" ]] || return 1
     EVIDENCE_ROOT="$EVIDENCE_CANDIDATE"
     LEDGER="$EVIDENCE_ROOT/rollout-ledger.json"
     [[ -f "$LEDGER" && ! -L "$LEDGER" && "$(file_mode "$LEDGER")" == "600" ]] || return 1
   }

   enter_hold_paused() {
     local PAUSE_DIR="" PAUSE_BODY="" PAUSE_STATUS=""
     printf '%s\n' 'STOP: use the provider Production pause control now; no CLI pause/resume command is supported.' >&2
     read -r -p 'After the provider pause is complete, press Enter: ' _ </dev/tty || return 1
     PAUSE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/production-pause-probe.XXXXXX")" || { printf '%s\n' 'PAUSE_REQUIRED: unable to create a private pause probe.' >&2; return 1; }
     PAUSE_BODY="$PAUSE_DIR/body"
     PAUSE_STATUS="$(curl --silent --show-error --output "$PAUSE_BODY" --write-out '%{http_code}' --connect-timeout 5 --max-time 15 -- "$CANONICAL_ORIGIN")" || { rm -f -- "$PAUSE_BODY"; rmdir -- "$PAUSE_DIR"; return 1; }
     if [[ "$PAUSE_STATUS" != "503" ]] || ! grep -Fq 'DEPLOYMENT_PAUSED' "$PAUSE_BODY"; then
       rm -f -- "$PAUSE_BODY"; rmdir -- "$PAUSE_DIR"
       printf '%s\n' 'PAUSE_REQUIRED: canonical 503 DEPLOYMENT_PAUSED was not verified; writers remain stopped.' >&2
       return 1
     fi
     rm -f -- "$PAUSE_BODY"; rmdir -- "$PAUSE_DIR" || return 1
     printf '%s\n' 'HOLD_PAUSED' >&2
     return 1
   }

   assert_canonical_unpaused() {
     local ORIGIN="${1:-}" HTTP_STATUS=""
     [[ "$ORIGIN" == "$CANONICAL_ORIGIN" ]] || return 1
     HTTP_STATUS="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --connect-timeout 5 --max-time 15 -- "$ORIGIN")" || return 1
     [[ "$HTTP_STATUS" != "000" && "$HTTP_STATUS" != "503" ]] || return 1
     [[ "$HTTP_STATUS" =~ ^(2[0-9]{2}|3[0-9]{2}|401)$ ]] || return 1
   }

   validate_evidence_root || enter_hold_paused
   [[ -n "${TARGET_SHA:-}" ]] || enter_hold_paused
   [[ "${APP_BASE_URL:-}" == "$CANONICAL_ORIGIN" ]] || enter_hold_paused
   jq -e --arg sha "$TARGET_SHA" --arg origin "$CANONICAL_ORIGIN" '
     .stage1 as $s |
     (.schemaVersion == 1) and
     ($s.deploymentId | type == "string" and test("^dpl_[A-Za-z0-9]+$")) and
     ($s.targetSha == $sha) and
     ($s.gates.identity == "1") and ($s.gates.writes == "0") and
     ($s.reviewedGateConfig.identity == "1") and ($s.reviewedGateConfig.writes == "0") and
     ($s.ready == true) and ($s.readyState == "READY") and
     ($s.readyEvidence.deploymentId == $s.deploymentId) and ($s.readyEvidence.state == "READY") and
     ($s.readyEvidence.observedAt | type == "string" and length > 0) and
     ($s.canonicalPromotionVerified == true) and
     ($s.canonicalPromotion.origin == $origin) and ($s.canonicalPromotion.deploymentId == $s.deploymentId) and
     ($s.canonicalPromotion.verified == true) and ($s.canonicalPromotion.verifiedAt | type == "string" and length > 0) and
     ($s.compatibilityVerified == true) and
     ($s.timestamps | type == "object") and
     ($s.timestamps.readyObservedAt | type == "string" and length > 0) and
     ($s.timestamps.canonicalPromotionVerifiedAt | type == "string" and length > 0)
   ' "$LEDGER" >/dev/null || enter_hold_paused
   STAGE_ONE_RECORD_ID="$(jq -er '.stage1.deploymentId' "$LEDGER")" || enter_hold_paused
   STAGE_ONE_INSPECT="$(vercel inspect "$STAGE_ONE_RECORD_ID" --wait --timeout 3m --format=json --no-color | jq -ce '{id,readyState,aliases}')" || enter_hold_paused
   jq -e --arg id "$STAGE_ONE_RECORD_ID" '(.id == $id) and (.readyState == "READY") and (.aliases | type == "array") and ((.aliases | length) == 0)' <<<"$STAGE_ONE_INSPECT" >/dev/null || enter_hold_paused
   STAGE_ONE_METADATA="$(vercel api "/v13/deployments/$STAGE_ONE_RECORD_ID" --raw | jq -ce 'if (.alias | type) == "array" then {id,readyState,target,githubCommitSha:.meta.githubCommitSha,aliases:(.alias//[])} else error("deployment alias shape is not an array") end')" || enter_hold_paused
   jq -e --arg id "$STAGE_ONE_RECORD_ID" --arg sha "$TARGET_SHA" '(.id == $id) and (.readyState == "READY") and (.target == "production") and (.githubCommitSha == $sha) and (.aliases | type == "array") and ((.aliases | length) == 0)' <<<"$STAGE_ONE_METADATA" >/dev/null || enter_hold_paused
   STAGE_ONE_CANONICAL="$(vercel inspect "$CANONICAL_ORIGIN" --format=json --no-color | jq -ce '{id}')" || enter_hold_paused
   jq -e --arg id "$STAGE_ONE_RECORD_ID" '.id == $id' <<<"$STAGE_ONE_CANONICAL" >/dev/null || enter_hold_paused
   # Normal PAUSED_AFTER_APPLY -> UNPAUSED_READONLY: prove the selector while
   # paused, then stop for the manual provider resume checkpoint.
   printf '%s\n' 'STOP: resume the recorded Stage 1 deployment with the provider manual/UI control, then press Enter.' >&2
   read -r -p 'After resume is complete, press Enter: ' _ </dev/tty || enter_hold_paused
   assert_canonical_unpaused "$CANONICAL_ORIGIN" || enter_hold_paused
   RESUMED_CANONICAL="$(vercel inspect "$CANONICAL_ORIGIN" --format=json --no-color | jq -ce '{id}')" || enter_hold_paused
   jq -e --arg id "$STAGE_ONE_RECORD_ID" '.id == $id' <<<"$RESUMED_CANONICAL" >/dev/null || enter_hold_paused
   [[ -n "${ROLLBACK_READ_TOKEN:-}" ]] || enter_hold_paused
   READONLY_STATUS="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --connect-timeout 5 --max-time 15 -H "Authorization: Bearer $ROLLBACK_READ_TOKEN" -- "$CANONICAL_ORIGIN/api/settings")" || enter_hold_paused
   [[ "$READONLY_STATUS" =~ ^2[0-9]{2}$ ]] || enter_hold_paused
   PRODUCTION_APP_URL="$CANONICAL_ORIGIN" PRODUCTION_APP_ACCESS_TOKEN="$ROLLBACK_READ_TOKEN" npm run check:production:writes-stopped >/dev/null || enter_hold_paused
   unset RESUMED_CANONICAL READONLY_STATUS
   validate_evidence_root || enter_hold_paused

   ROLLBACK_CANDIDATE_ID="$(stage_candidate "identity=1,writes=0")" || enter_hold_paused
   [[ "$ROLLBACK_CANDIDATE_ID" =~ ^dpl_[A-Za-z0-9]+$ ]] || enter_hold_paused
   sleep 60 || enter_hold_paused
   [[ -n "${ROLLBACK_READ_TOKEN:-}" ]] || enter_hold_paused
   READONLY_STATUS="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --connect-timeout 5 --max-time 15 -H "Authorization: Bearer $ROLLBACK_READ_TOKEN" -- "$CANONICAL_ORIGIN/api/settings")" || enter_hold_paused
   [[ "$READONLY_STATUS" =~ ^2[0-9]{2}$ ]] || enter_hold_paused
   NEGATIVE_STATUS="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --connect-timeout 5 --max-time 15 -- "$CANONICAL_ORIGIN/api/applications")" || enter_hold_paused
   [[ "$NEGATIVE_STATUS" == "401" ]] || enter_hold_paused
   unset ROLLBACK_READ_TOKEN STAGE_ONE_RECORD_ID STAGE_ONE_INSPECT STAGE_ONE_METADATA STAGE_ONE_CANONICAL ROLLBACK_CANDIDATE_ID READONLY_STATUS NEGATIVE_STATUS
   ```

9. After resume, stage the final `identity=1,writes=1` Ready Production
   candidate with the same exact TARGET_SHA, using the same canonical
   procedure while unpaused:

   ```bash
   vercel env add APPLICATION_WRITES_ENABLED production --value "1" --yes --force || exit 1
   FINAL_CANDIDATE_ID="$(stage_candidate "identity=1,writes=1")" || exit 1
   [[ "$FINAL_CANDIDATE_ID" =~ ^dpl_[A-Za-z0-9]+$ ]] || exit 1
   ```

   Record the new/staged deployment ID after the procedure proves its exact
   ID, `Ready` state, Production target, exact SHA, zero aliases, and no
   canonical alias. Do not
   create a new commit or deploy an unreviewed working tree. Run the
   authenticated `production monitor` only after Vercel is serving again and
   require its success. This remains the explicit `vercel --prod --skip-domain`
   operation, with promotion only while unpaused. The final candidate has no
   canonical alias before promotion. Require the production monitor to pass
   before beginning the bounded smoke sequence.
10. With Vercel online and ordinary, automated, and background Application
   writers remain stopped, only one explicitly authorized bounded smoke
   actor/session at a
   time may run. That actor runs the post-resume smoke sequence: authenticated UI
   create/read/delete cleanup, using unique smoke rows and immediate cleanup;
   then extension pairing/exchange/create and read using a one-time pairing
   code, unique smoke rows, and immediate cleanup. For the extension portion,
   follow the [exact revocation and consumed-code replay lifecycle](chrome-extension-smoke.md#revocation-and-consumed-code-replay-lifecycle): keep the paired
   popup/session available, revoke the ExtensionInstallation—the exact smoke
   installation—server-side, then verify replay rejection and 401 from the
   revoked credential. No other
   session, automation, background job, or writer may perform these operations,
   and these checks must not run while Vercel is paused.
11. After the final write-enabled promotion and successful smoke, perform
    ownership-limited cleanup from the private ledger. Delete only exact ledger-owned Application IDs through supported application paths—the supported Application deletion path; never
    search or delete by broad name, timestamp, origin, or user. Consume the
    recorded pre-stop unconsumed pairing grant exactly once, then prove replay
    rejection. Revoke every ledger-owned installation, then prove the exact
    stored credential returns `401`. Reconcile final counts and content hashes
    with the ledger and record each action, expected terminal state, timestamp,
    and observed result without recording private values.

    The ledger records the exact rollout SHA, staged candidate ID(s), promoted deployment ID values, canonical origin, exact owned Application IDs with
    pre- and post-probe hashes, whether the Settings singleton existed before the probe and its
    pre/post content hashes, the pre-stop unconsumed pairing grant and its
    pairing code/reference only inside the private ledger, the installed credential needed for the later
    `401` proof and its installation ID, and every Application, pairing grant,
    or installation created after resume before it is used. Keep credential,
    pairing code, URL, title, company, note, resume text, and raw row/body
    values only inside the private directory and ledger. Never make a second
    unrecorded credential attempt.

    The Stage 1 ledger record binds one exact deployment ID to the exact
    `TARGET_SHA`, reviewed gate configuration `identity=1,writes=0`, `Ready`
    evidence, canonical-promotion proof, compatibility proof, and timestamps.
    Resume and regression must read and validate this record; an environment
    variable or operator claim alone is never a target selector.

    The stopped-write Settings check is a syntactically valid
    `PUT /api/settings` containing only a private, non-production canary and no
    real provider credential. It must return the exact HTTP `503` stopped-write
    response while preserving unchanged Settings existence and content hash.
    Any unexpected response or hash/existence change stops the operation
    immediately; do not overwrite the row for cleanup. Record only sanitized
    statuses/counts/hashes. Delete `rollout-ledger.json` only after every
    ownership, replay, revocation, stopped-write, final-count, hash, and
    expected-terminal-state check succeeds; otherwise retain it. Finally,
    resume external writers last; `resume Application writers LAST` is the
    final action and occurs only after every cleanup check succeeds.
12. The final action is `resume Application writers LAST`; general Application
   writer resume is last and occurs only after every post-resume smoke pass
   succeeds. Retain only privacy-safe prepare/apply reports and approved
   backup evidence.

Record only non-sensitive operational evidence in the private rollout record:
the Git SHA; old, new, staged, and canonical deployment IDs; promotion time;
drain start/end; Production monitor and authenticated negative-probe run IDs;
backup, prepare, and apply workflow run IDs; safe artifact names and digests;
pause/resume evidence; and sanitized cleanup status. Leave unknown future IDs
blank until observed; never fabricate an ID or record a secret or private
Application field.

The rollback target is the recorded Ready `identity=1,writes=0` deployment.
Rollback and promotion are permitted only while Vercel is unpaused. If the
database apply occurred, never roll back to identity-unaware code; preserve
the gate and deployment state until a reviewed compatible rollback is ready.

Abort behavior is part of the procedure. A pre-resume failure leaves Vercel
paused with canonical `503`; preserve the actual current gate and deployment
state. Do not change either state absent a reviewed hosted rollback, and keep
ordinary, automated, background, and Application writers stopped. A
post-resume smoke failure leaves Application writers stopped; pause Vercel
again before any further hosted change, preserve sanitized evidence, and recover
through an isolated restore target and reviewed rollback. Any failure means
writers remain stopped continuously. Do not enable identity writes, resume
writers, or retry apply with a different commit or report. Do not run `prisma db
push`, `prisma db reset`, or `prisma migrate reset`, or use other destructive
shortcuts against Production.

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
