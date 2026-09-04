# Production Write-Stop Rollout Design

> This is a design-level summary of the approved constraints and evidence
> requirements, not a second operator procedure. The [production operations
> runbook](../../operations/production-runbook.md#application-identity-maintenance-rollout)
> is the sole source of executable commands and ordering.

## Status and decision

This design is approved for implementation. It revises the hosted identity
rollout after a Vercel project pause was shown to block a new production
deployment from reaching `Ready`. The revised safety boundary is an
application-level, fail-closed write stop. The Vercel project remains online
until that write stop is serving and verified. The project is then paused as a
second, independent containment layer while the database maintenance workflow
runs. The application gate supplies the durable writer exclusion; the pause
adds defense in depth and guarantees that resuming service returns to the
already-Ready read-only deployment.

The rollout uses staged Production deployments of the exact reviewed
commit. A Preview deployment is not evidence of a Production deployment and
must not be promoted as a substitute for a new Production build. The plan
does not build or promote while the project is paused. Every deployment needed
to enter or leave the maintenance window is Ready or is built after the project
has resumed into the verified read-only state.

## Background

The identity migration and deterministic backfill need a writer-free interval.
The previous plan obtained that interval by pausing Vercel and then attempted
to build the gate-enabled deployment while paused. Vercel accepted a request
but left the deployment in an unknown, non-Ready state, so the exact reviewed
commit had no verified gate-enabled Production assignment. Continuing to
prepare or apply under that evidence gap would have made the writer-stop
claim dependent on an unavailable deployment.

The application already has an identity-specific gate,
`APPLICATION_IDENTITY_WRITES_ENABLED`. That gate changes only the Application
create algorithm; it is not a general writer stop. The additional gate,
`APPLICATION_WRITES_ENABLED`, is a separate cross-cutting runtime boundary.
It must cover every durable mutation reachable from the web application and
the extension, including writes that are not obvious from the HTTP method.

The Vercel sequencing follows three documented platform properties:

- [`vercel --prod --skip-domain`](https://vercel.com/docs/cli/deploying-from-cli)
  creates a staged Production deployment without assigning the Production
  domains.
- The Vercel promotion operation ([platform documentation](https://vercel.com/docs/cli/promote))
  assigns an existing Production deployment, while promoting a Preview
  deployment can trigger a new Production build.
- [Environment variable changes](https://vercel.com/docs/environment-variables)
  apply only to new deployments, so the current canonical deployment retains
  its previous gate values until an explicit promotion.

## Goal

Provide a reversible, observable, and fail-closed way to keep the hosted
application readable while preventing all runtime durable writes during
identity `prepare` and `apply`, then enable identity-aware writes and ordinary
writes only after the exact post-migration evidence gates pass.

## Non-goals

- This design does not change the identity schema, identity key algorithm, or
  backfill report format.
- This design does not authorize destructive migration, `prisma db push`, a
  down migration, or ad-hoc production SQL repair.
- This design does not pause, resume, or otherwise control application writers
  outside the web runtime. Those processes still require an explicit operator
  stop and resume attestation.
- This design does not make authentication cookies durable application data.
  Cookie issuance and deletion remain authentication concerns, subject to the
  existing origin and authentication checks.
- This design does not place database credentials, access tokens, pairing
  codes, URLs, job titles, company names, notes, resume text, or API keys in
  reports, logs, Git, or deployment evidence.

## Terminology and configuration

`APPLICATION_WRITES_ENABLED` is a server-only Production environment
variable. Its value is binary and exact:

| Value | Effective runtime state |
| --- | --- |
| `"1"` | Durable application and extension writes are allowed, subject to authentication and route policy. |
| `"0"` | Runtime is read-only; every guarded durable mutation returns the write-stop response. |
| missing | Read-only/fail-closed compatibility default. Production evidence still requires an explicit value. |
| any other value | Invalid configuration. Environment validation fails before the deployment can serve traffic. |

The preferred operator configuration is explicit `"0"` or `"1"`; an omitted
value is tolerated only as a closed-by-default compatibility behavior during
local development. Production deployments must set the variable explicitly.
The value is read from the immutable deployment environment and is never
changed in process. Changing it requires a new reviewed Production
deployment, so a successful environment update without a corresponding Ready
deployment is not rollout evidence.

`APPLICATION_IDENTITY_WRITES_ENABLED` remains independent:

- `identity=0, writes=0`: read-only legacy-compatible runtime;
- `identity=0, writes=1`: temporary compatibility runtime used only before
  the identity maintenance window;
- `identity=1, writes=0`: read-only identity-aware runtime after apply;
- `identity=1, writes=1`: final runtime.

The final state is never reached by changing an environment variable in place;
it is reached only by assigning a Ready deployment built from the exact
reviewed commit with both values set to `"1"`.

The Settings singleton is created only on the first successful PUT /api/settings;
an authenticated GET /api/settings is read-only and does not create the row. The
complete candidate, rollback, fixture-ledger, and cleanup procedure is defined
in the [production operations runbook](../../operations/production-runbook.md#application-identity-maintenance-rollout).

## Fail-closed semantics

The implementation will expose one server-only guard used by every durable
mutation boundary. The guard is evaluated before request-body processing that
could trigger work and immediately before the persistence operation or
transaction. It must not be possible for a route to bypass the guard by using
a different Prisma method, raw SQL, an alternate principal, or a background
callback.

When the effective value is closed, a valid authenticated request to a guarded
mutation returns:

```json
{
  "error": "Application writes are temporarily disabled",
  "code": "writes_stopped",
  "retryable": true
}
```

The response contract is:

- HTTP `503 Service Unavailable`;
- `Content-Type: application/json`;
- `Cache-Control: private, no-store`;
- `Retry-After: 60`;
- the same CORS decoration as the route's normal response;
- no database error, request body, principal token, or private row data.

Authentication, origin, and installation authorization continue to run first
where the existing route requires them. Therefore an unauthenticated request
still receives the route's normal `401`, and a disallowed origin still
receives its normal `403`; a valid principal then receives `503` for a guarded
write. This prevents the maintenance state from becoming an authentication
oracle while preserving the existing security contract.

`OPTIONS` preflight remains a non-persistent `204` response with the existing
allow-list. `GET`, `HEAD`, and read-only `POST` operations continue when they
do not persist data. A client must treat `writes_stopped` as a
retryable maintenance response and must not retry in a tight loop or interpret
it as an authentication failure.

The guard must be checked again at the persistence boundary for operations
that perform asynchronous work between route entry and commit. If a request
observes the gate as open and the deployment is replaced while it is in
flight, the request may finish only within the bounded route lifetime. The
drain procedure below waits for that lifetime before maintenance SQL begins.
No new request routed to the closed deployment may pass the boundary.

## Persistent mutation surface

The following is the complete current application surface. The implementation
must maintain an inventory test so a newly added route with a durable write
cannot silently escape the gate.

| Endpoint or internal operation | Durable effect | Gate behavior |
| --- | --- | --- |
| `POST /api/applications` | Inserts an `Application`, using either the legacy create branch or the identity-aware atomic create branch. | Guard before parsing/processing and again immediately before insert/identity transaction. |
| `PATCH /api/applications/:id` | Updates any mutable Application fields. | Guard before update. |
| `DELETE /api/applications/:id` | Deletes an Application; the duplicate-preservation check is read-only but belongs to this guarded operation. | Guard before delete. A blocked request performs no count or delete query. |
| `PUT /api/settings` | Creates the singleton `Settings` row when absent or updates provider, encrypted API key, profile URLs, and resume text. | Guard before body processing and before create/update. |
| `GET /api/settings` when the singleton is absent | Current implementation has a hidden read-path write. | Change read behavior so it returns empty/default values without creating a row while closed. If creation remains supported while open, guard it explicitly. |
| `POST /api/extension/pairing` | Creates a one-time `ExtensionPairingGrant`. | Guard before grant creation. Session principal and origin validation remain required. |
| `POST /api/extension/pair` | Consumes a pairing grant and inserts an `ExtensionInstallation` in one transaction. | Guard before exchange and again around the transaction. A rejected exchange must not consume the grant or create an installation. |
| `DELETE /api/extension/installations/:id` | Revokes an installation by setting `revokedAt` and `updatedAt`. | Guard before revoke. |
| `POST /api/extension/revoke` | Revokes the authenticated extension installation. | Guard before revoke. |
| Installation authentication `touch` | Updates `ExtensionInstallation.lastUsedAt` and `updatedAt` on authenticated extension requests. | When closed, authenticate by read-only lookup and digest verification but do not call `touch`. When open, retain the current touch behavior. |
| Identity migration/backfill workflow | Adds schema objects and updates Application identity fields outside the request-serving runtime. | Not controlled by this HTTP gate. It requires its own `writers_stopped=true` attestation, exact SHA, and prepare/apply evidence gates. |

The following are not durable application writes and remain available in
read-only mode, subject to existing auth and rate/deadline controls:

- `GET /api/applications`, `GET /api/applications/:id`, and `GET /api/stats`;
- `GET /api/settings` after removing or guarding the hidden singleton create;
- `GET /api/extension/installations` and `GET /api/extension/profile`;
- `POST /api/extract`, `POST /api/keyword-analysis`, and
  `POST /api/parse-resume` when they only fetch, compute, call an LLM, or
  parse an upload without persisting a result;
- `POST` and `DELETE /api/auth/session`, which set or clear an HTTP-only
  session cookie but do not write the database;
- `POST /api/auth/verify`, which verifies an installation credential. Its
  authentication path must use the same no-touch behavior while closed.

An operation may not be classified as read-only merely because its route is a
`GET` or because its primary result is computed. Any new database insert,
update, delete, upsert, raw `INSERT`/`UPDATE`/`DELETE`, audit event, queue
enqueue, object-storage upload, or credential rotation is a persistent write
and must be added to the inventory and guarded before implementation is
merged.

## Staged Production deployment sequence

The sequence is deliberately deployment-led rather than pause-led. Stage 0
uses a direct Production deployment; later transitions use
`vercel --prod --skip-domain` to build without assignment and then explicitly
promote an existing Ready Production deployment. Every build uses the exact
reviewed commit. The operator records deployment ID, commit SHA, environment
gate values by name only, and Ready status. A Preview URL, Preview build, or
Preview-to-Production promote does not satisfy a stage because its environment
and build provenance are not the required new Production-build evidence.

### Stage 0: establish a gate-capable runtime and backup

1. Merge and verify the implementation commit through the normal PR checks.
2. Confirm the exact `ROLLOUT_SHA` and green CI.
3. Set Production `APPLICATION_IDENTITY_WRITES_ENABLED=0` and
   `APPLICATION_WRITES_ENABLED=1` for the initial gate-capable build.
4. Deploy the exact SHA directly to Production and wait for `Ready` and the
   canonical alias. Run the authenticated monitor, non-mutating reads, and the
   normal mutation regression smoke proving writes still work before the
   maintenance window.
5. Create a fresh encrypted backup from `ROLLOUT_SHA` and require its scratch
   restore fingerprint to match the manifest.
6. Do not begin database maintenance if this build is not Ready, if the
   canonical alias is not serving it, or if its source SHA cannot be verified.

The application is still writable during this initial deployment. No
writer-stop attestation is made until Stage 1 has completed.

### Stage 1: stage and activate the identity-aware write stop

1. Set Production `APPLICATION_IDENTITY_WRITES_ENABLED=1` and
   `APPLICATION_WRITES_ENABLED=0`. The existing immutable canonical deployment
   remains `identity=0,writes=1` until promotion.
2. Build the exact reviewed commit with `vercel --prod --skip-domain`. Require
   a Ready Production deployment and prove the canonical aliases still point
   at the prior deployment.
3. Promote that existing Ready Production deployment before pausing. Require
   the canonical aliases to serve the recorded `identity=1,writes=0`
   deployment. A Preview deployment is never promoted because that would
   trigger a new Production build.
4. Allow at least two times the configured mutation `maxDuration` after the
   assignment, and require a clean read-only monitor window. During this
   drain, no new mutation is accepted by the new deployment, while any request
   admitted by the prior deployment may finish only within its bounded
   lifetime.
5. Probe every route in the mutation inventory with a valid authenticated
   request. Require the stable `503` contract and prove that Application,
   Settings, ExtensionPairingGrant, and ExtensionInstallation counts and
   fingerprints are unchanged.
6. Pause the Vercel project and require the canonical origin to return
   `503 DEPLOYMENT_PAUSED`. Do not build, redeploy, alias, or promote while the
   project is paused.

The application-level negative evidence remains mandatory. The pause is a
second containment layer, not a substitute for proving that the deployment
which will resume is read-only.

### Stage 2: prepare and apply the identity change while paused

1. Stop ordinary, automated, extension, and background Application writers
   outside the web runtime. Record a fresh operator attestation that they are
   stopped. The Vercel project remains paused and its assigned runtime remains
   the Ready `identity=1,writes=0` deployment.
2. Dispatch `production-identity-maintenance.yml` `prepare` from `main` at
   `ROLLOUT_SHA` with `writers_stopped=true`.
3. Verify migration status, empty schema diff, and the privacy-safe dry-run
   report. Compare its before/after count, state totals, unique-index result,
   and opaque row plan with the fresh backup evidence.
4. Dispatch `apply` only with the approved numeric prepare run ID, the same
   exact SHA, and `writers_stopped=true`.
5. Verify the apply report's invariant projection and opaque row plan match
   the approved dry run. Verify migration status, schema diff, row counts,
   state totals, and the unique identity index.

The runtime is never switched to `APPLICATION_WRITES_ENABLED=1` during these
steps. The Stage 1 negative matrix, canonical `DEPLOYMENT_PAUSED` response,
and external writer-stop attestation are all required; none substitutes for
another.

### Stage 3: resume the identity-aware read-only Production runtime

1. Reconfirm that the paused project is assigned to the recorded Ready
   `identity=1,writes=0` Production deployment from Stage 1.
2. Resume the Vercel project without redeploying. Require the canonical aliases
   to serve that exact deployment.
3. Run read-only application, settings, stats, and extension-profile checks.
   Repeat the complete mutation-negative matrix and require no durable write.

If this stage fails, pause the project again and keep external writers stopped.
Do not resume writers merely to make a deployment reachable.

### Stage 4: stage, promote, and smoke-test ordinary writes

1. Confirm all prepare/apply evidence, the resumed identity-aware read-only
   deployment, and the read-only negative matrix are approved.
2. Set Production `APPLICATION_WRITES_ENABLED=1`, leaving the identity gate at
   `1`. The immutable canonical deployment remains read-only.
3. Build the exact reviewed SHA with `vercel --prod --skip-domain`, require the
   resulting Production deployment to reach Ready without canonical aliases,
   and promote it while the project is unpaused. The previous identity-aware
   read-only deployment remains the safe state until promotion.
4. Run the automated Production monitor, one authenticated web
   create/read/delete smoke, and the extension pairing, one-time exchange,
   authenticated read/create, revoke, and post-revoke `401` smoke. Use unique
   smoke identifiers and delete only records created by that smoke.
5. Resume external Application writers last. The final evidence must show the
   final deployment ID, exact SHA, both effective gate values, successful
   monitor, and successful cleanup.

The old identity gate-0 runtime is never restored merely because a new
deployment is delayed. After Stage 1, the safe live state is the recorded
Ready `identity=1,writes=0` Production deployment.

## Drain and request lifetime

Every guarded mutation route must declare a bounded `maxDuration`; the initial
implementation target is at most 30 seconds, subject to the project's
verified Vercel plan limit. Database lock and statement timeouts must be lower
than that bound, and handlers must not launch unawaited persistence work after
returning a response. The same bound applies to the extension credential
transaction and to Application identity creation.

The operator's drain interval is two times the deployed maximum mutation
duration, rounded up to a full minute. During the interval:

- the canonical endpoint must remain healthy for read requests;
- no new request may receive a successful mutation response;
- the monitor records only status, code, counts, hashes, deployment IDs, and
  timestamps;
- no maintenance SQL starts until the interval and the negative probe matrix
  both pass.

This is a bounded cooperative drain, not a claim that Vercel can cancel every
old serverless invocation at alias cutover. If a request exceeds the bound,
the deployment is treated as unhealthy and maintenance stops. The operator
does not infer quiescence from a quiet dashboard or from a successful deploy.

## Evidence gates

The following evidence is required before each irreversible or externally
visible transition:

| Transition | Required evidence |
| --- | --- |
| Gate-capable code deployment | Reviewed PR, exact `ROLLOUT_SHA`, green required CI, local scoped tests, and Ready direct Production deployment with canonical alias. |
| Write stop activation | Ready staged Production `identity=1,writes=0` deployment, successful pre-pause promotion, drain interval, authenticated mutation matrix returning the exact `503` contract, and unchanged durable-state fingerprints. |
| Prepare | Fresh encrypted backup with validated restore fingerprint, canonical `DEPLOYMENT_PAUSED`, current migration/schema checks, truthful external writer-stop attestation, and privacy-safe dry-run report. |
| Apply | Approved prepare run ID and report, same SHA, continued canonical `DEPLOYMENT_PAUSED`, second writer-stop attestation, and successful apply invariant comparison. |
| Identity read-only resume | The recorded Ready Production `identity=1,writes=0` deployment serving after resume, plus a passing read-only monitor and mutation matrix. |
| Final writes | Ready staged Production `identity=1,writes=1` deployment, successful promotion, monitor and bounded web/extension smoke success, and smoke cleanup. |

The artifact review accepts only schema-versioned reports containing counts,
state totals, hashes, booleans, and opaque row identifiers. It rejects any
report containing connection strings, credentials, API keys, pairing codes,
URLs, titles, companies, descriptions, notes, resume content, or raw row
objects.

## Rollback and failure handling

- Build, alias, or monitor failure before the write stop: do not claim a
  writer-free interval; keep the last known service state and retry only with
  the same reviewed SHA after diagnosis.
- Failure while activating the write stop: keep the last Ready
  gate-capable deployment or explicitly deploy its known-good `writes=0`
  configuration. Never fall back to a legacy deployment that does not enforce
  the global gate.
- Prepare failure: keep Vercel paused and `writes=0`, preserve the report and
  backup evidence, and do not apply or resume external writers.
- Apply failure or invariant mismatch: keep Vercel paused and `writes=0`,
  preserve the actual database and deployment state, and perform only isolated
  restore/recovery rehearsal. Do not run a destructive rollback in Production.
- Identity read-only resume failure after apply: pause the project again until
  the recorded `identity=1,writes=0` assignment is revalidated. If code
  rollback is required after resume, stage and promote a reviewed gate-capable
  Production commit with `writes=0`; do not enable legacy writes.
- Final smoke failure: immediately promote the recorded Ready
  `identity=1,writes=0` Production deployment and keep external writers
  stopped. Revoke any smoke installation, remove only smoke-created records
  through a supported path, and preserve all evidence for review.
- Evidence or secret-hygiene failure: stop, retain the original encrypted
  artifact, and do not copy the offending value into logs, GitHub artifacts,
  Vercel settings output, or the repository.

No rollback path uses a Preview promote, a paused-project build or promote, a
forced gate change without a new Ready deployment, `prisma db push`, an ad-hoc
SQL repair, or a destructive database reset.

## Testing and monitoring

### Automated tests

- Environment tests prove exact `0`/`1` parsing, closed behavior for missing or
  invalid values, and server-only access.
- Route contract tests enumerate the persistent mutation inventory and assert
  that every route returns the exact status, JSON code, cache, retry, and CORS
  contract when closed.
- Hidden-write tests prove `GET /api/settings` does not create a singleton in
  read-only mode and installation authentication does not update
  `lastUsedAt`/`updatedAt` while closed.
- Transaction tests prove blocked Application and extension operations perform
  no insert, update, delete, or grant consumption, including a concurrent
  request at the gate boundary.
- Open-mode tests retain existing authentication, identity collision, pairing
  one-time use, revoke, and cleanup behavior.
- CI runs the focused route/guard tests, typecheck, lint, build, existing
  backup and extension suites, and the production audit gate.

### Hosted checks

The Production monitor remains a read-only health check. A separate bounded
negative probe matrix exercises all guarded endpoints with sanitized,
syntactically valid requests while `writes=0`; it records status and code only.
The final positive smoke runs one actor at a time and removes only records it
created. Extension smoke also confirms one-time pairing replay fails and a
revoked credential receives `401`.

The operator polls deployment readiness and canonical assignment by deployment
ID, not by an arbitrary Preview URL. Evidence records run IDs, deployment IDs,
commit SHA, gate state, HTTP statuses/codes, counts, hashes, and timestamps.

## Secrets and evidence hygiene

Environment updates are performed through the authenticated Vercel/GitHub
interfaces without printing values. Shell tracing is disabled around secret
commands. Database credentials are supplied only through the existing
GitHub secret binding. Backup dumps remain encrypted; any private download,
decryption, restore rehearsal, or plaintext temporary file uses a mode-0700
directory, a mode-0600 key/file, and unconditional cleanup.

Logs and artifacts are reviewed for secret and private-field absence before
approval. The repository receives no generated report, decrypted dump,
pairing code, installation token, database URL, or smoke record data.

## Invariants

1. `APPLICATION_WRITES_ENABLED=0` implies zero durable runtime writes across
   Application, Settings, extension grants/installations/revocations, and
   installation last-used touches.
2. Every live Production deployment after Stage 0 contains the guard and the
   route-inventory tests for the exact commit being deployed.
3. A blocked request cannot consume a pairing grant, create a default
   Settings row, update an installation timestamp, or partially modify an
   Application.
4. Database `prepare` and `apply` run only while the runtime gate is closed,
   Vercel is paused, and the external writer-stop attestation is true.
5. A deployment environment change is not evidence until its exact SHA has a
   Ready direct Production deployment serving the canonical alias.
6. Preview deployment state and paused-project state never substitute for
   Ready staged Production evidence; no build or promotion occurs while paused.
7. `identity=1` is never combined with `writes=1` before migration, index,
   report, read-only deployment, and smoke gates pass.
8. Any failure leaves runtime writes disabled or leaves the previous verified
   state unchanged; no operator step silently resumes writers.
9. Evidence contains no secret or private Application field and is sufficient
   to reconstruct the state transition from hashes, IDs, statuses, and
   timestamps.

## Acceptance criteria

- A checked-in implementation exposes and uses the global fail-closed gate on
  every mutation in the persistent-surface inventory.
- Missing/invalid gate configuration cannot enable writes in Production.
- The settings read path and extension authentication path have no hidden
  writes while closed.
- All blocked mutation responses satisfy the `503` JSON, cache, retry, and
  CORS contract without leaking private data.
- Mutation routes have a bounded `maxDuration`, and the operator drain is at
  least two times that bound before maintenance SQL.
- A staged Production deployment with `identity=1,writes=0` reaches Ready and
  is promoted before the project is paused; its negative matrix and drain pass,
  and the canonical origin then returns `DEPLOYMENT_PAUSED` before prepare/apply.
- Prepare and apply run from the exact reviewed SHA with fresh backup,
  writer-stop, report, schema, count, and unique-index evidence.
- Resuming the project restores the exact recorded `identity=1,writes=0`
  deployment, which passes the full read-only negative matrix before any write
  is enabled.
- A staged Production deployment with both gates `1` reaches Ready, is
  promoted, the automated monitor passes, authenticated web and extension smoke
  passes, and smoke-created data/credentials are cleaned up.
- External Application writers resume only after the final evidence package is
  complete and reviewed.
