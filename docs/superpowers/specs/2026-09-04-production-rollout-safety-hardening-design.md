# Production Rollout Safety Hardening Design

## Status and scope

This approved supplemental design resolves the final review findings for
database timeouts, executable rollout documentation, staged candidate
binding, rollback identity, and production fixture cleanup. It complements
the [production write-stop rollout design](2026-09-04-production-write-stop-rollout-design.md);
it does not replace that design's application write-stop inventory or
evidence gates.

After implementation, the [production operations runbook](../../operations/production-runbook.md#application-identity-maintenance-rollout)
remains the sole source of executable production commands. This specification
defines the behavior, invariants, tests, and documentation contract that the
runbook must implement. It intentionally does not duplicate a copy-paste
production shell procedure.

The supplement is limited to:

- applying bounded PostgreSQL statement and lock timeouts to every connection
  owned by Prisma's `PrismaPg` pool;
- rejecting connection-string parameters that could override those bounds;
- binding a staged Production deployment to one inspected candidate ID and
  the exact reviewed Git SHA before promotion;
- making paused-after-apply rollback identity-aware and fail closed; and
- recording all disposable production fixtures in a private ledger with
  deterministic, ownership-limited cleanup.

The original review findings are all addressed here: timeout precedence and
runtime proof, raw deployment API secret exposure, ambiguous candidate
promotion, generic post-apply rollback language, incomplete fixture cleanup,
and the stale Settings GET documentation claim.

## Goals

1. Ensure every new Prisma PostgreSQL connection has a 25-second statement
   timeout and a 5-second lock timeout, with no connection-string override.
2. Preserve the existing protected-route error contract when a timeout occurs.
3. Make every staged-candidate promotion prove the exact deployment ID,
   Production target, `Ready` state, zero aliases, and exact `TARGET_SHA`.
4. Ensure every post-apply failure either remains paused or can resume only
   the recorded, identity-aware read-only deployment without redeploying.
5. Make disposable application, settings, pairing, and installation fixtures
   auditable and removable only when their ownership is recorded.
6. Keep operational commands in one authoritative runbook while making the
   design and tests strong enough to detect a drifted or incomplete runbook.

## Non-goals

- This supplement does not change the application identity algorithm,
  migration, backfill invariants, or write-stop route inventory.
- It does not add a retryable timeout API, a new status code, or a client retry
  contract. Timeout errors remain generic protected-route `500` responses
  with `code: "internal_error"` and `Cache-Control: no-store`.
- It does not configure a database role, alter provider-side defaults, or
  authorize ad-hoc production SQL, `prisma db push`, destructive reset, or a
  down migration.
- It does not build, deploy, alias, or promote a Vercel project while the
  project is paused.
- It does not retain raw Vercel API responses, database URLs, credentials,
  pairing codes, installation tokens, or private application fields in
  evidence.

## Success criteria

The implementation is complete only when all of the following are true:

- the timeout factory and its exact constants are used by the `PrismaPg`
  constructor;
- server-environment validation rejects every case-insensitive occurrence of
  `statement_timeout`, `lock_timeout`, and `options` in the database URL,
  including a single occurrence and duplicate occurrences, while preserving
  accepted `sslmode`, TLS, `schema`, and other parameters;
- a disposable digest-pinned PostgreSQL 17 test observes the expected values
  on all ten default pool slots concurrently and verifies distinct backend
  PIDs;
- the candidate deployment's inspected ID, `Ready` state, Production target,
  exact Git SHA, and zero aliases are verified before its exact ID is promoted
  while unpaused;
- the canonical origin proves that its deployment ID equals the promoted
  candidate ID;
- after apply, the state machine cannot resume an identity-unaware or
  pre-apply deployment, and a missing compatible candidate remains paused;
- fixture cleanup compares final counts, hashes, revocation, and credential
  rejection with the private ledger, retaining that ledger and stopped writers
  on any failure; and
- the runbook, README, and specifications contain no conflicting executable
  procedure or claim that authenticated `GET /api/settings` creates the row.

## 1. Runtime database timeout architecture

### Single factory and exact values

Add `src/lib/database-timeouts.ts`. It owns the only timeout values and
exports a pure factory with this contract:

```ts
export const POSTGRES_STATEMENT_TIMEOUT_MS = 25_000;
export const POSTGRES_LOCK_TIMEOUT_MS = 5_000;

export function createPrismaPgPoolConfig(
  connectionString: string,
): pg.PoolConfig {
  return {
    connectionString,
    statement_timeout: POSTGRES_STATEMENT_TIMEOUT_MS,
    lock_timeout: POSTGRES_LOCK_TIMEOUT_MS,
  };
}
```

The actual module may use a type-only `pg` import consistent with the
repository's TypeScript configuration, but the exported names, values, and
returned fields are exact. The function must be pure: it must not read
environment variables, connect to a database, mutate the URL, or perform a
post-connect query.

`src/lib/prisma.ts` must construct the adapter as:

```ts
new PrismaPg(createPrismaPgPoolConfig(getServerEnv().databaseUrl))
```

The `PrismaPg` adapter version in scope is 7.9.1 and its owned `pg` pool is
version 8.20. `pg` sends `statement_timeout` and `lock_timeout` as startup
parameters for every connection that the pool creates, including connections
opened to fill all default pool slots. The implementation must not replace
this with a `connect` hook or `SET`/`SET LOCAL` after connection. A
post-connect `SET` alternative can leave an interval before the bound applies
and is rejected by this design.

### URL precedence and server-environment validation

`pg` gives connection-string query parameters precedence over direct pool
configuration. Therefore a URL query parameter can otherwise defeat the
factory. Server-environment validation must inspect the parsed query keys
case-insensitively and fail startup if the URL contains one or more of any of
these reserved keys:

- `statement_timeout`;
- `lock_timeout`; or
- `options`.

The check rejects one key as well as duplicates (for example, two differently
cased `statement_timeout` keys). It must not silently strip a key, accept or
parse an `options` value, or normalize a conflicting URL into a usable one.
The error is a configuration failure before the deployment serves traffic.

All other supported connection parameters remain intact, including
`sslmode`, TLS settings, and `schema`. Validation must therefore reject only
the reserved keys and must have explicit tests proving that a URL containing
valid SSL/TLS and schema parameters is accepted.

### Timeout runtime semantics

PostgreSQL statement timeout is observed as SQLSTATE `57014`; lock timeout is
observed as SQLSTATE `55P03`. The existing protected-route error sanitizer
continues to map either failure to the generic HTTP `500` / `internal_error`
response with `Cache-Control: no-store`. No SQLSTATE is exposed to clients,
and no timeout-specific 503, retry header, or new API behavior is introduced.

When a timeout aborts a transaction, PostgreSQL rolls back that transaction.
This does not magically undo statements that committed in an earlier,
independent transaction, so the rollout evidence and cleanup must still
reason about each transaction boundary. The 25-second statement bound is not
a per-request deadline. Keep the existing mutation `maxDuration` of 30
seconds and drain for at least 60 seconds (or the runbook's larger verified
bound) before database maintenance.

### Required tests

The timeout test suite must include all of these proofs:

1. Server-environment tests reject reserved URL keys case-insensitively,
   reject a single key and duplicate keys, and accept `sslmode`, TLS, and
   `schema` parameters without stripping them.
2. A unit test calls the pure factory and asserts the exact direct config:
   `statement_timeout === 25_000` and `lock_timeout === 5_000`, along with the
   unchanged connection string.
3. A disposable, digest-pinned PostgreSQL 17 test reuses the repository's
   safety guard and preflight. It opens all ten default pool slots
   concurrently, proves the backend PIDs are distinct, and runs `SHOW
   statement_timeout` and `SHOW lock_timeout` on each connection, expecting
   `25s` and `5s` respectively. It must use no real production database.

The disposable test must clean up its container and temporary credentials on
success and failure. It proves startup-parameter behavior rather than merely
testing a mocked factory return value.

## 2. Executable staged-candidate binding

The locally verified Vercel CLI is version 50.40.0. It supports the staged
Production deployment operation with `--prod`, `--skip-domain`, `--yes`,
JSON output, and color suppression; inspection by exact deployment ID with
`--wait`, a three-minute timeout, JSON output, and color suppression; and
promotion by exact deployment ID with `--yes`. The exact invocations and
shell syntax belong only in the production runbook, not in this design.

### Candidate provenance contract

Every staged candidate is built from a clean checkout at exact `TARGET_SHA`.
The deployment command's JSON is captured only in a shell variable. A
machine-readable projection must require an ID matching the Vercel deployment
ID format (`dpl_...`) and a non-empty URL; missing or malformed values fail
closed. The raw JSON must never be stored, echoed, uploaded, or placed in a
ledger because it may contain environment fields.

The operator then inspects that exact candidate ID and waits for `Ready`.
Inspection output proves readiness and assignment metadata but is not enough
to prove Git provenance: verified CLI inspect JSON includes `id`,
`readyState`, `url`, and `aliases`, but no Git SHA.

The exact SHA comes only from the read-only Vercel deployments API endpoint for
that candidate ID, `/v13/deployments/$CANDIDATE_ID` (invoked by the runbook's
raw API-read operation). The raw response is piped directly through `jq` into
a shell variable, using the exact allow-listed projection expression
`{id,readyState,target,url,githubCommitSha:.meta.githubCommitSha,aliases:(.alias//[])}`
and nothing else:

```json
{
  "id": "dpl_...",
  "readyState": "READY",
  "target": "production",
  "url": "...",
  "githubCommitSha": "...",
  "aliases": []
}
```

The projection must be exactly limited to `id`, `readyState`, `target`,
`url`, `githubCommitSha` (from `.meta.githubCommitSha`), and aliases (from
`.alias`, defaulting to an empty array). Never store or echo the raw API JSON.
Validation fails closed when the SHA is missing, when the projected ID is not
the staged candidate ID, when `readyState` is not `READY`, when `target` is
not `production`, when the SHA is not exactly `TARGET_SHA`, or when aliases
are non-empty. A missing SHA is a failure, not permission to rely on an
environment-variable claim or a human assertion.

Promotion is allowed only for the exact inspected candidate ID and only while
the Vercel project is unpaused. After promotion, inspect the canonical origin
and prove that the deployment ID serving it equals that candidate ID. Do not
promote an alias, a remembered URL, an uninspected ID, or metadata that merely
claims a matching commit. A Preview deployment, Preview URL, or Preview-to-
Production build is not a candidate for this procedure.

### Candidate test contract

Documentation and rollout tests must extract and verify this transition as a
stateful sequence, not as independent keyword checks:

1. clean exact `TARGET_SHA` checkout;
2. staged Production deploy with no canonical assignment;
3. candidate ID and URL required from JSON only;
4. exact-ID `Ready` inspection;
5. direct safe API projection with non-secret fields only;
6. equality checks for candidate ID, Production target, `READY`, exact SHA,
   and zero aliases;
7. exact candidate-ID promotion while unpaused; and
8. canonical-origin deployment ID equality after promotion.

The test must also assert that no promotion step is reachable in the paused
state and that no raw API output is used as evidence.

## 3. Paused-after-apply rollback state machine

Rollback language is identity-aware and stateful. Generic references to an
unspecified hardened deployment are removed because they do not prove that
the runtime understands the applied identity schema.

The relevant states and allowed transitions are:

| State | Entry condition | Allowed action | Failure result |
| --- | --- | --- | --- |
| `PAUSED_AFTER_APPLY` | Apply completed, the project is paused, and the recorded Stage 1 `identity=1,writes=0` deployment is known Ready. | Review apply, migration, schema, identity, and private fixture evidence. | Any evidence failure transitions to `HOLD_PAUSED`; no build, deploy, alias, or promote. |
| `HOLD_PAUSED` | Evidence failed, candidate identity is missing/ambiguous, or cleanup cannot be proven. | Preserve evidence and investigate offline. | Remains paused with writers stopped. |
| `UNPAUSED_READONLY` | All evidence is approved and the recorded same-identity deployment is still assigned. | Resume without redeploying, then run read-only and negative probes. | Pause again and return to `HOLD_PAUSED`. |
| `UNPAUSED_READONLY` with regression | A read-only probe or monitor regresses after resume. | Select and stage only a Ready, inspected, identity-aware, `writes=0` compatible candidate; promote its exact ID while unpaused, then drain and probe again. | If no compatible candidate exists, pause and enter `HOLD_PAUSED`. |

Evidence approval resumes the recorded same-identity deployment with one
resume action and zero writes; it does not redeploy. After that point, a
regression may select only a candidate whose reviewed SHA proves
`identity=1,writes=0` compatibility and whose deployment is inspected as
Ready. An identity-unaware deployment, a pre-apply target, a remembered URL,
or a candidate justified only by environment values is never eligible.

No state in this machine permits promotion while paused. No transition turns
on writers merely to make a deployment reachable. If the compatible candidate
cannot be proven, the terminal action is `HOLD_PAUSED`, with external writers
stopped and the actual deployment/database state preserved.

## 4. Fixture ledger and cleanup

### Private storage and retention

The rollout creates a private fixture directory with mode `0700` and a ledger
file with mode `0600`. The ledger is retained until cleanup has been verified;
it is not disposable scratch output. The directory and ledger are never
committed or uploaded.

The private ledger records only the minimum operational evidence needed to
reconcile ownership and cleanup:

- rollout SHA, staged candidate ID(s), promoted deployment ID(s), and
  canonical origin;
- exact owned Application IDs and their pre- and post-probe hashes;
- whether the Settings singleton existed before the probe and its pre/post
  content hashes;
- the pre-stop unconsumed pairing grant and its code/reference, stored only
  in the private ledger;
- the installed credential's opaque identifier and installation ID;
- every Application, pairing grant, or installation created after resume;
- each action, expected terminal state, timestamp, and observed result.

The ledger must never be copied to logs, CI or Actions artifacts, pull
requests, specifications, README files, shell history, or deployment output.
No credential, pairing code, URL, title, company, note, resume text, or raw
row object may appear outside the private fixture directory. When a value is
needed for cleanup, read it from the private ledger without printing it.

### Settings probe wording and safety boundary

The settings probe is a syntactically valid `PUT /api/settings` request whose
body contains only private, non-production canary values. It must never carry
a real provider credential. While the write stop is active, the expected
result is the stopped-write response and unchanged Settings existence and
content hash. If the request does not return the expected stopped response,
or if existence/hash changes, stop immediately and never overwrite the row in
an attempt to clean up an unexplained mutation.

The README and related documentation must say that the Settings singleton is
created only on the first successful `PUT /api/settings`; an authenticated
`GET /api/settings` never creates the row. This removes the stale claim that
an authenticated GET creates a row and aligns the documentation with the
hidden-write fix in the base design.

### Ownership-limited cleanup

Cleanup is permitted only for objects whose exact IDs are in the ledger. It
must not search by a broad name, timestamp, origin, or current user and must
not delete a pre-existing object merely because its content resembles a
fixture.

After write resume, cleanup consumes the recorded pre-stop unconsumed pairing
grant exactly once, then verifies that it cannot be replayed. It revokes every
ledger-owned installation, verifies its credential receives `401`, and
removes only ledger-owned Application records through supported application
paths. It reconciles final counts and content hashes with the ledger and
records terminal state and timestamps without recording private values.

If any cleanup action, credential rejection, count, or hash comparison fails,
ordinary and external writers remain stopped, the project is returned to the
safe paused/read-only state as applicable, and the ledger is retained for
review. Cleanup failure never authorizes an unbounded delete or a second
unrecorded credential attempt.

## 5. Documentation and test contract

The production runbook is the sole executable command source. The README,
both rollout specifications, and the hosted implementation plan link to the
runbook and describe states, evidence, safety boundaries, and expected
outcomes without duplicating shell snippets. A command may be changed in one
place—the runbook—without leaving a conflicting executable copy elsewhere.

The documentation tests must parse and extract cross-document state
transitions and rollback constraints, rather than relying on keyword-only
locks. They must fail when any required transition or prohibition is missing.
The extracted contract includes:

- exact timeout constants and use of the pool factory;
- case-insensitive reserved-key rejection and preservation of SSL/TLS/schema
  parameters;
- concurrent ten-slot PostgreSQL 17 `SHOW` proof;
- candidate ID capture, exact-ID inspection, allow-listed API projection,
  SHA/target/readiness/alias validation, exact-ID promotion, and canonical ID
  proof;
- an explicit prohibition on build/deploy/alias/promote while paused;
- `PAUSED_AFTER_APPLY`, `HOLD_PAUSED`, and `UNPAUSED_READONLY` transitions,
  including identity-aware `writes=0` rollback selection;
- private ledger modes, required ownership fields, one-time grant use,
  installation revocation, credential `401`, final reconciliation, and
  failure retention;
- the syntactically valid private-canary Settings `PUT` wording and the
  expected stopped response with unchanged existence/hash; and
- the absence of the stale claim that an authenticated Settings GET creates a
  row.

These tests validate relationships and ordering—for example, a promotion
must consume the same candidate ID that passed inspection, and resumption
must name the same identity-aware deployment that was recorded before apply.
They must not pass because each phrase happens to occur in isolation.

## Rejected alternatives

- **Timeouts in the URL:** rejected because URL parameters take precedence over
  direct `pg.PoolConfig` values and can silently weaken the bound.
- **Silently stripping reserved URL keys:** rejected because it hides a
  misconfigured or potentially hostile connection string; startup must fail
  closed instead.
- **Accepting or parsing `options`:** rejected because PostgreSQL startup
  options can override timeout behavior and are not part of this contract.
- **Post-connect `SET` or `SET LOCAL`:** rejected because the bound would not
  cover connection startup and pool reuse consistently.
- **Database role-only configuration:** rejected because it is not owned by
  the application deployment and cannot prove the intended per-pool contract.
- **Mock-only timeout tests:** rejected because they do not prove startup
  parameters on real connections or distinct pool backends.
- **A shorter drain:** rejected because a 25-second statement timeout is not a
  request deadline; the existing 30-second `maxDuration` requires at least a
  60-second drain.
- **Alias or remembered-URL promotion:** rejected because neither binds the
  transition to the inspected candidate identity.
- **Identity-unaware rollback:** rejected because a pre-apply or legacy
  deployment may not understand the applied identity schema.
- **Special retryable 503 timeout mapping:** rejected because it would add a
  new API contract; protected-route timeout failures remain generic 500
  `internal_error` responses.

## Self-review checklist

Before committing this supplement, review it for:

- no unresolved placeholder, invented deployment ID, or unbounded “latest”
  reference;
- no contradiction between the 25-second statement timeout, 5-second lock
  timeout, 30-second route lifetime, and 60-second minimum drain;
- no ambiguity about runbook-only executable command ownership;
- no raw API JSON, secrets, credentials, pairing codes, or private fixture
  data in logs or artifacts; and
- no generic identity-blind rollback wording or stale Settings GET-created
  claim.
