# Production Rollout Safety Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Bind every Prisma PostgreSQL connection to fail-closed statement and lock timeouts, prove staged Production deployment identity before promotion, make post-apply rollback identity-aware, and make disposable rollout fixtures auditable and ownership-limited.

**Architecture:** A pure createPrismaPgPoolConfig factory supplies the only PostgreSQL timeout values directly to the PrismaPg pool. Startup validation rejects case-insensitive URL keys that would override those values. The production runbook is the sole source of executable Vercel candidate, rollback, and fixture-ledger commands; other documents summarize constraints and link to it. Relationship-aware tests parse those documents as ordered state machines.

**Tech Stack:** Next.js 16.3, TypeScript 5, Prisma 7.9.1, @prisma/adapter-pg 7.9.1, pg 8.20, Jest 30, PostgreSQL 17 Alpine digest-pinned Docker integration, Vercel CLI, GitHub Actions, Bash, jq.

---

## File responsibility map

- Create src/lib/database-timeouts.ts: exact constants and pure pg.PoolConfig factory.
- Modify src/lib/prisma.ts: use the factory at the sole PrismaPg construction site.
- Modify src/lib/server-env-core.js: reject reserved query keys without rewriting valid URL parameters.
- Create __tests__/lib/database-timeouts.test.ts: factory value, purity, and unchanged URL tests.
- Modify __tests__/lib/prisma.test.ts: factory-to-Prisma wiring test.
- Modify __tests__/lib/server-env.test.ts: reserved-key case/duplicate rejection and SSL/TLS/schema preservation.
- Create __tests__/lib/prisma-timeouts.integration.test.ts: ten default pool connections, distinct backend PIDs, and PostgreSQL 17 SHOW proof.
- Modify __tests__/api/protected-routes.test.ts: generic 500 contract for SQLSTATE 57014 and 55P03.
- Modify docs/operations/production-runbook.md: only executable candidate binding, rollback state machine, private ledger, and cleanup procedure.
- Modify README.md and the three linked historical/design documents: state/evidence summary and runbook links without copied Vercel commands.
- Create __tests__/docs/production-rollout-safety-hardening-contract.test.ts: ordered cross-document and state-machine tests.

### Task 1: Add the pure PostgreSQL timeout factory

**Files:**
- Create: src/lib/database-timeouts.ts
- Create: __tests__/lib/database-timeouts.test.ts

- [ ] **Step 1: Write the failing unit tests**

~~~ts
import {
  createPrismaPgPoolConfig,
  POSTGRES_LOCK_TIMEOUT_MS,
  POSTGRES_STATEMENT_TIMEOUT_MS,
} from "@/lib/database-timeouts";

describe("Prisma PostgreSQL timeout factory", () => {
  it("returns exact settings and leaves the URL unchanged", () => {
    const connectionString =
      "postgresql://user:password@db.example.com:5432/jobtracker?sslmode=require&schema=public";

    expect(createPrismaPgPoolConfig(connectionString)).toEqual({
      connectionString,
      statement_timeout: 25_000,
      lock_timeout: 5_000,
    });
    expect(POSTGRES_STATEMENT_TIMEOUT_MS).toBe(25_000);
    expect(POSTGRES_LOCK_TIMEOUT_MS).toBe(5_000);
  });

  it("does not read process.env", () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL =
      "postgresql://wrong@127.0.0.1:5432/wrong_test";
    const connectionString =
      "postgresql://validated@127.0.0.1:5432/validated_test";

    expect(createPrismaPgPoolConfig(connectionString).connectionString).toBe(
      connectionString,
    );

    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  });
});
~~~

- [ ] **Step 2: Run the test to verify red**

Run:

~~~bash
npx jest --runInBand __tests__/lib/database-timeouts.test.ts
~~~

Expected: FAIL with a module-resolution error for @/lib/database-timeouts.

- [ ] **Step 3: Implement the minimal factory**

Create src/lib/database-timeouts.ts:

~~~ts
import type pg from "pg";

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
~~~

Do not read environment variables, mutate the URL, connect, or issue SET or SET LOCAL.

- [ ] **Step 4: Run unit test and typecheck**

~~~bash
npx jest --runInBand __tests__/lib/database-timeouts.test.ts
npx tsc --noEmit
~~~

Expected: 2 passing tests and TypeScript exit 0.

- [ ] **Step 5: Commit**

~~~bash
git add src/lib/database-timeouts.ts __tests__/lib/database-timeouts.test.ts
git commit -m "feat: add bounded PostgreSQL timeout factory"
~~~

### Task 2: Reject URL parameters that override the bounds

**Files:**
- Modify: src/lib/server-env-core.js in parseDatabaseUrl
- Modify: __tests__/lib/server-env.test.ts

- [ ] **Step 1: Add failing parser cases**

~~~ts
describe("DATABASE_URL timeout override protection", () => {
  it.each([
    "statement_timeout=1",
    "STATEMENT_TIMEOUT=1",
    "lock_timeout=1",
    "LOCK_TIMEOUT=1",
    "options=-c%20statement_timeout%3D0",
    "OPTIONS=-c%20lock_timeout%3D0",
    "statement_timeout=1&statement_timeout=2",
    "Statement_Timeout=1&statement_timeout=2",
    "lock_timeout=1&lock_timeout=2",
    "Lock_Timeout=1&lock_timeout=2",
    "options=one&options=two",
    "Options=one&options=two",
  ])("rejects reserved URL query %s", (query) => {
    const databaseUrl =
      "postgresql://jobtracker:database-password@db.example.com:5432/jobtracker?" +
      query;
    expect(() =>
      parseServerEnv({ ...productionSource, DATABASE_URL: databaseUrl }, "production"),
    ).toThrow(
      "DATABASE_URL must not contain reserved PostgreSQL timeout parameters",
    );
  });

  it("accepts and preserves SSL/TLS/schema parameters", () => {
    const databaseUrl =
      "postgresql://jobtracker:database-password@db.example.com:5432/jobtracker?sslmode=require&sslcert=client-cert.pem&sslkey=client-key.pem&sslrootcert=ca.pem&schema=public&application_name=jobtracker";
    expect(
      parseServerEnv({ ...productionSource, DATABASE_URL: databaseUrl }, "production")
        .databaseUrl,
    ).toBe(databaseUrl);
  });
});
~~~

- [ ] **Step 2: Run the parser tests to verify red**

~~~bash
npx jest --runInBand __tests__/lib/server-env.test.ts
~~~

Expected: the new reserved-key cases fail because the current parser accepts those query keys.

- [ ] **Step 3: Implement fail-closed key inspection**

Add to src/lib/server-env-core.js:

~~~js
const RESERVED_DATABASE_URL_KEYS = new Set([
  "statement_timeout",
  "lock_timeout",
  "options",
]);

function rejectReservedDatabaseUrlKeys(url) {
  for (const key of url.searchParams.keys()) {
    if (RESERVED_DATABASE_URL_KEYS.has(key.toLowerCase())) {
      invalid(
        "DATABASE_URL",
        "must not contain reserved PostgreSQL timeout parameters",
      );
    }
  }
}
~~~

Call rejectReservedDatabaseUrlKeys(url) immediately after new URL(value) succeeds. Return the original value unchanged. Do not strip, normalize, parse, or silently accept a reserved key; the loop naturally rejects duplicates and case variants.

- [ ] **Step 4: Run parser and startup checks**

~~~bash
npx jest --runInBand __tests__/lib/server-env.test.ts
npm run check:startup-env
~~~

Expected: all server-env tests pass, startup validation exits 0, and no URL or secret is printed.

- [ ] **Step 5: Commit**

~~~bash
git add src/lib/server-env-core.js __tests__/lib/server-env.test.ts
git commit -m "fix: reject PostgreSQL timeout URL overrides"
~~~

### Task 3: Wire the factory and preserve generic timeout errors

**Files:**
- Modify: src/lib/prisma.ts
- Modify: __tests__/lib/prisma.test.ts
- Modify: __tests__/api/protected-routes.test.ts

- [ ] **Step 1: Make the Prisma test assert the factory call**

Mock the module in __tests__/lib/prisma.test.ts:

~~~ts
const mockPoolConfig = {
  connectionString:
    "postgresql://validated@127.0.0.1:5432/jobtracker_test",
  statement_timeout: 25_000,
  lock_timeout: 5_000,
};
const mockCreatePrismaPgPoolConfig = jest.fn(() => mockPoolConfig);

jest.mock("@/lib/database-timeouts", () => ({
  createPrismaPgPoolConfig: mockCreatePrismaPgPoolConfig,
}));
~~~

After importing the Prisma module, assert:

~~~ts
expect(mockCreatePrismaPgPoolConfig).toHaveBeenCalledWith(
  "postgresql://validated@127.0.0.1:5432/jobtracker_test",
);
expect(mockAdapter).toHaveBeenCalledWith(mockPoolConfig);
~~~

- [ ] **Step 2: Run the wiring test to verify red**

~~~bash
npx jest --runInBand __tests__/lib/prisma.test.ts
~~~

Expected: FAIL because prisma.ts currently builds a connectionString-only object.

- [ ] **Step 3: Update the only PrismaPg construction**

Replace the constructor body in src/lib/prisma.ts with:

~~~ts
import { createPrismaPgPoolConfig } from "./database-timeouts";

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg(
    createPrismaPgPoolConfig(getServerEnv().databaseUrl),
  );
  return new PrismaClient({ adapter });
}
~~~

Keep the existing global Prisma reuse and server-only environment validation unchanged.

- [ ] **Step 4: Add SQLSTATE regression cases**

In the existing generic database-error section of __tests__/api/protected-routes.test.ts, use its current authenticated applications route/request helpers:

~~~ts
it.each(["57014", "55P03"])(
  "returns generic protected-route 500 for PostgreSQL timeout SQLSTATE %s",
  async (code) => {
    const route = actualRoutes.find(
      ({ name }) => name === "stats GET",
    ) as ActualRouteCase;
    jest.mocked(prisma.application.count).mockRejectedValueOnce(
      Object.assign(new Error("private database timeout detail"), { code }),
    );
    const logged = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const response = await invokeActual(
      route,
      productRequest(route, {
        origin: APP_ORIGIN,
        cookie: SESSION_COOKIE,
      }),
    );

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      error: "Internal server error",
      code: "internal_error",
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(body).not.toContain(code);
    logged.mockRestore();
  },
);
~~~

If the neighboring test uses different local names, substitute only those existing names; do not create a second mock harness.

- [ ] **Step 5: Run focused runtime checks**

~~~bash
npx jest --runInBand __tests__/lib/prisma.test.ts __tests__/api/protected-routes.test.ts
npx tsc --noEmit
~~~

Expected: both suites pass, timeout failures remain 500 internal_error, and no SQLSTATE is exposed.

- [ ] **Step 6: Commit**

~~~bash
git add src/lib/prisma.ts __tests__/lib/prisma.test.ts __tests__/api/protected-routes.test.ts
git commit -m "feat: apply PostgreSQL timeout factory to Prisma"
~~~

### Task 4: Prove all ten PostgreSQL 17 pool slots

**Files:**
- Create: __tests__/lib/prisma-timeouts.integration.test.ts

- [ ] **Step 1: Create the guarded real-connection test**

~~~ts
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { createPrismaPgPoolConfig } from "@/lib/database-timeouts";
import { assertDatabaseTestSafety } from "../api/database-test-guard";

const requested = process.env.RUN_DATABASE_INTEGRATION === "1";
const identity = requested ? assertDatabaseTestSafety(process.env) : undefined;
const describeDatabase = requested ? describe : describe.skip;

describeDatabase("Prisma PostgreSQL startup timeout parameters", () => {
  let factory: PrismaPg;
  let adapter: Awaited<ReturnType<PrismaPg["connect"]>> | undefined;
  let pool: pg.Pool;

  beforeAll(async () => {
    if (!identity) throw new Error("database identity was not preflighted");
    factory = new PrismaPg(
      createPrismaPgPoolConfig(process.env.DATABASE_URL ?? ""),
    );
    adapter = await factory.connect();
    pool = adapter.underlyingDriver();
    expect(pool.options.max).toBe(10);
    const version = await pool.query<{ server_version_num: string }>(
      "SHOW server_version_num",
    );
    expect(Number(version.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(
      170_000,
    );
    expect(Number(version.rows[0]?.server_version_num)).toBeLessThan(180_000);
  });

  afterAll(async () => {
    if (adapter) await adapter.dispose();
  });

  it("sets 25s and 5s on ten distinct backends", async () => {
    const clients = await Promise.all(
      Array.from({ length: 10 }, () => pool.connect()),
    );
    try {
      const observations = await Promise.all(
        clients.map(async (client) => {
          const pid = await client.query<{ pid: number }>(
            "SELECT pg_backend_pid() AS pid",
          );
          const statement = await client.query<{ value: string }>(
            "SHOW statement_timeout",
          );
          const lock = await client.query<{ value: string }>(
            "SHOW lock_timeout",
          );
          return {
            pid: pid.rows[0]?.pid,
            statement: statement.rows[0]?.value,
            lock: lock.rows[0]?.value,
          };
        }),
      );
      expect(new Set(observations.map(({ pid }) => pid)).size).toBe(10);
      for (const observation of observations) {
        expect(observation).toEqual({
          pid: expect.any(Number),
          statement: "25s",
          lock: "5s",
        });
      }
    } finally {
      clients.forEach((client) => client.release());
    }
  });
});
~~~

The test must retain the existing sentinel, loopback address, canonical _ci/_test database-name, and PostgreSQL-version safety guard. It must never use a Production URL. The existing .github/workflows/ci.yml starts the digest-pinned PostgreSQL 17 service, exports RUN_DATABASE_INTEGRATION=1, ALLOW_DESTRUCTIVE_DATABASE_TESTS, DATABASE_URL, and EXPECTED_DATABASE_SERVER_ADDRESS, and runs npm run test:ci, which matches this file; no workflow change is needed.

- [ ] **Step 2: Verify safe skip without integration variables**

~~~bash
env -u RUN_DATABASE_INTEGRATION -u ALLOW_DESTRUCTIVE_DATABASE_TESTS npx jest --runInBand __tests__/lib/prisma-timeouts.integration.test.ts
~~~

Expected: the suite is skipped and no connection is attempted.

- [ ] **Step 3: Run with the repository's pinned PostgreSQL 17 image**

~~~bash
set -euo pipefail
export PG17_IMAGE="docker.io/library/postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193"
export PG17_CONTAINER="jobtracker-prisma-timeouts-test"
export PG17_PORT="55434"
docker rm -f "$PG17_CONTAINER" >/dev/null 2>&1 || true
trap 'docker rm -f "$PG17_CONTAINER" >/dev/null 2>&1 || true' EXIT
docker run --detach --name "$PG17_CONTAINER" --publish "$PG17_PORT:5432" --env POSTGRES_PASSWORD=postgres --env POSTGRES_DB=jobtracker_prisma_timeout_test "$PG17_IMAGE" >/dev/null
until docker exec "$PG17_CONTAINER" pg_isready --username postgres --dbname jobtracker_prisma_timeout_test >/dev/null 2>&1; do sleep 1; done
RUN_DATABASE_INTEGRATION=1 \
ALLOW_DESTRUCTIVE_DATABASE_TESTS=jobtracker-ci-delete-all \
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:$PG17_PORT/jobtracker_prisma_timeout_test" \
EXPECTED_DATABASE_SERVER_ADDRESS=127.0.0.1 \
npx jest --runInBand __tests__/lib/prisma-timeouts.integration.test.ts
~~~

Expected: one passing integration test, major version 17, ten distinct backend PIDs, ten SHOW observations of 25s and 5s from the PrismaPg-owned pool, adapter.dispose() closes the pool, and cleanup removes only the named container.

- [ ] **Step 4: Commit**

~~~bash
git add __tests__/lib/prisma-timeouts.integration.test.ts
git commit -m "test: prove PostgreSQL pool timeout startup parameters"
~~~

### Task 5: Add relationship-aware documentation tests and candidate binding

**Files:**
- Create: __tests__/docs/production-rollout-safety-hardening-contract.test.ts
- Modify: docs/operations/production-runbook.md

- [ ] **Step 1: Write the failing candidate transition test**

~~~ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "../..");
const readRunbook = () =>
  readFileSync(join(root, "docs/operations/production-runbook.md"), "utf8");

function between(document: string, start: string, end: string): string {
  const startAt = document.indexOf(start);
  const endAt = document.indexOf(end, startAt + start.length);
  if (startAt < 0 || endAt <= startAt) {
    throw new Error("required section missing");
  }
  return document.slice(startAt, endAt);
}

function assertOrdered(document: string, terms: readonly string[]): void {
  let cursor = -1;
  for (const term of terms) {
    const next = document.indexOf(term, cursor + 1);
    expect(next).toBeGreaterThan(cursor);
    cursor = next;
  }
}

describe("production rollout safety hardening", () => {
  it("binds one candidate through inspection, provenance, promotion, and canonical proof", () => {
    const section = between(
      readRunbook(),
      "## Application identity maintenance rollout",
      "## Backup and restore",
    );
    assertOrdered(section, [
      "git status --porcelain",
      "git rev-parse HEAD",
      "CANDIDATE_JSON=",
      "vercel deploy . --prod --skip-domain --yes --format=json --no-color",
      "CANDIDATE_ID=",
      "vercel inspect \"$CANDIDATE_ID\" --wait --timeout 3m --format=json --no-color",
      "((.aliases // []) | length) == 0",
      "/v13/deployments/$CANDIDATE_ID",
      "githubCommitSha:.meta.githubCommitSha",
      ".readyState == \"READY\"",
      ".target == \"production\"",
      "((.aliases | length) == 0)",
      "vercel promote \"$CANDIDATE_ID\" --yes",
      "canonical origin",
      ".id == $CANDIDATE_ID",
    ]);
    expect(section).toContain("TARGET_SHA");
    expect(section).toMatch(
      /raw API response[^.]{0,120}(?:never|must not)[^.]{0,120}(?:stored|echoed|uploaded)/iu,
    );
  });
});
~~~

- [ ] **Step 2: Run the test to verify red**

~~~bash
npx jest --runInBand __tests__/docs/production-rollout-safety-hardening-contract.test.ts
~~~

Expected: FAIL because the current runbook does not capture one candidate ID through the allow-listed deployment API projection.

- [ ] **Step 3: Add the executable binding block to the runbook**

For Stage 1 and final candidates, use the same block, changing only the gate assignment and stage label:

~~~bash
set -euo pipefail
TARGET_SHA="$(git rev-parse origin/main)"
[[ -z "$(git status --porcelain)" ]]
[[ "$(git rev-parse HEAD)" == "$TARGET_SHA" ]]
CANDIDATE_JSON="$(vercel deploy . --prod --skip-domain --yes --format=json --no-color)"
CANDIDATE_ID="$(jq -er 'select(.id | test("^dpl_[A-Za-z0-9]+$")) | .id' <<<"$CANDIDATE_JSON")"
CANDIDATE_URL="$(jq -er --arg id "$CANDIDATE_ID" 'select(.id == $id and (.url | type == "string") and (.url | length > 0)) | .url' <<<"$CANDIDATE_JSON")"
unset CANDIDATE_JSON
[[ "$CANDIDATE_ID" =~ ^dpl_[A-Za-z0-9]+$ ]]
[[ "$CANDIDATE_URL" =~ ^https://[^[:space:]]+$ ]]

CANDIDATE_INSPECT="$(vercel inspect "$CANDIDATE_ID" --wait --timeout 3m --format=json --no-color)"
jq -e --arg id "$CANDIDATE_ID" '.id == $id and .readyState == "READY" and ((.aliases // []) | length) == 0' <<<"$CANDIDATE_INSPECT" >/dev/null
unset CANDIDATE_INSPECT

CANDIDATE_METADATA="$(vercel api "/v13/deployments/$CANDIDATE_ID" --raw | jq -ce '{id,readyState,target,url,githubCommitSha:.meta.githubCommitSha,aliases:(.alias//[])}')"
jq -e --arg id "$CANDIDATE_ID" --arg sha "$TARGET_SHA" '(.id == $id) and (.readyState == "READY") and (.target == "production") and (.url | type == "string") and (.url | length > 0) and (.githubCommitSha == $sha) and ((.aliases | length) == 0)' <<<"$CANDIDATE_METADATA" >/dev/null
unset CANDIDATE_METADATA

vercel promote "$CANDIDATE_ID" --yes
CANONICAL_METADATA="$(vercel inspect "$APP_BASE_URL" --format=json --no-color)"
jq -e --arg id "$CANDIDATE_ID" '.id == $id' <<<"$CANONICAL_METADATA" >/dev/null
unset CANONICAL_METADATA
~~~

The raw API response must flow directly to the exact projection
{id,readyState,target,url,githubCommitSha:.meta.githubCommitSha,aliases:(.alias//[])} and must never be stored, echoed, uploaded, or entered in the ledger. Require exact ID, READY state, Production target, non-empty URL, exact TARGET_SHA, and zero aliases before promotion. Promotion is valid only while unpaused. The paused interval contains no build, deploy, alias, or promote command.

- [ ] **Step 4: Syntax-check the block and run the test**

~~~bash
npx jest --runInBand __tests__/docs/production-rollout-safety-hardening-contract.test.ts
sed -n '/CANDIDATE_JSON=/,/unset CANONICAL_METADATA/p' docs/operations/production-runbook.md | bash -n
~~~

Expected: test passes and bash -n exits 0 without executing Vercel.

- [ ] **Step 5: Commit**

~~~bash
git add docs/operations/production-runbook.md __tests__/docs/production-rollout-safety-hardening-contract.test.ts
git commit -m "docs: bind staged rollout to inspected deployment IDs"
~~~

### Task 6: Add identity-aware rollback and private fixture ledger

**Files:**
- Modify: docs/operations/production-runbook.md
- Modify: __tests__/docs/production-rollout-safety-hardening-contract.test.ts

- [ ] **Step 1: Add failing state and ledger tests**

~~~ts
it("extracts identity-aware paused rollback transitions", () => {
  const section = between(
    readRunbook(),
    "## Application identity maintenance rollout",
    "## Backup and restore",
  );
  assertOrdered(section, [
    "PAUSED_AFTER_APPLY",
    "HOLD_PAUSED",
    "no build, deploy, alias, or promote",
    "UNPAUSED_READONLY",
    "recorded same-identity deployment",
    "without redeploying",
    "identity=1,writes=0",
    "Ready",
    "exact ID",
    "HOLD_PAUSED",
  ]);
  expect(section).toMatch(
    /candidate[^.]{0,100}(?:missing|ambiguous)[^.]{0,100}HOLD_PAUSED/iu,
  );
  expect(section).toMatch(
    /after (?:database )?apply[^.]{0,140}never[^.]{0,100}identity-unaware/iu,
  );
});

it("extracts private ledger ownership and retention", () => {
  const section = between(
    readRunbook(),
    "## Application identity maintenance rollout",
    "## Backup and restore",
  );
  for (const text of [
    "mode 0700",
    "mode 0600",
    "retained until cleanup has been verified",
    "exact owned Application IDs",
    "pre-stop unconsumed pairing grant",
    "pairing code/reference only inside the private ledger",
    "every Application, pairing grant, or installation created after resume",
    "consume the recorded pre-stop unconsumed pairing grant exactly once",
    "credential receives 401",
    "final counts and content hashes",
    "failed cleanup",
    "writers remain stopped",
    "Settings singleton is created only on the first successful PUT /api/settings",
  ]) {
    expect(section).toContain(text);
  }
  expect(section).not.toMatch(/GET \\/api\\/settings[^.]{0,100}creates the row/iu);
});
~~~

- [ ] **Step 2: Run tests to verify red**

~~~bash
npx jest --runInBand __tests__/docs/production-rollout-safety-hardening-contract.test.ts
~~~

Expected: FAIL because the current runbook has generic rollback language and an incomplete fixture ledger contract.

- [ ] **Step 3: Add the paused state machine to the runbook**

Add this section after apply evidence review:

~~~markdown
### Paused-after-apply rollback state machine

PAUSED_AFTER_APPLY means apply finished, Production is paused, the canonical
origin returns 503 DEPLOYMENT_PAUSED, and the recorded Stage 1 identity=1,writes=0
deployment was inspected Ready before apply. Review migration, identity,
schema, fixture, and sanitized evidence only.

Any failed evidence, missing or ambiguous candidate, or failed cleanup enters
HOLD_PAUSED. Keep Production paused, keep every Application writer stopped,
preserve evidence, and perform no build, deploy, alias assignment, or promotion.

When evidence is approved, enter UNPAUSED_READONLY by resuming the recorded
same-identity identity=1,writes=0 deployment without redeploying. Run only
read-only and negative probes while writers remain stopped.

If a read-only probe regresses, stage only a Ready Production candidate whose
reviewed SHA proves identity=1,writes=0 compatibility. Verify its exact ID,
target, Ready state, SHA, and zero aliases, then promote that exact ID while
unpaused. If no compatible candidate is proven, pause and enter HOLD_PAUSED.
After database apply, never resume identity-unaware, pre-apply, or
remembered-URL code.
~~~

Use these provider commands only outside the paused interval:

~~~bash
vercel project pause "$VERCEL_PROJECT"
curl --fail-with-body --silent --show-error --max-time 15 "$APP_BASE_URL/api/stats" >/dev/null && exit 1 || true
vercel project resume "$VERCEL_PROJECT"
vercel inspect "$RECORDED_READONLY_DEPLOYMENT_ID" --wait --timeout 3m --format=json --no-color
~~~

The paused curl is an observation of the provider pause page, not a successful authenticated application probe. Resume names the exact recorded deployment ID and is not paired with build, deploy, alias, or promotion.

- [ ] **Step 4: Add private ledger setup and bounded cleanup wording**

Add:

~~~bash
set -euo pipefail
export EVIDENCE_ROOT="\${EVIDENCE_ROOT:?set a private path outside the repository}"
install -d -m 0700 "$EVIDENCE_ROOT"
umask 077
export FIXTURE_LEDGER="$EVIDENCE_ROOT/fixture-ledger.json"
touch "$FIXTURE_LEDGER"
chmod 0600 "$FIXTURE_LEDGER"
~~~

State explicitly that the private fixture directory has mode 0700, the ledger
has mode 0600, and the ledger is retained until cleanup has been verified.
The ledger records only rollout SHA, staged/promoted deployment IDs,
canonical origin, exact owned row IDs and pre/post hashes, Settings existence
and hash, the pre-stop unconsumed grant pairing code/reference only inside the
private ledger, opaque installation IDs, every Application, pairing grant, or
installation created after resume, actions, expected terminal states, timestamps, and
sanitized results. It never records installation credentials or other secrets;
the pre-stop pairing code/reference is confined to this private ledger. It
never records URLs, titles,
companies, notes, resume text, raw rows, database URLs, or request/response
bodies; it is never copied to logs, Actions artifacts, pull requests,
specifications, README, shell history, or deployment output.

Cleanup reads exact IDs from the ledger only. It consumes the recorded grant
once and verifies replay rejection, revokes each ledger-owned installation and
verifies the credential receives 401, removes only ledger-owned Applications through
supported paths, and compares final counts and content hashes. A failed cleanup
is a failure state, not permission to broaden ownership. The Settings singleton
is created only on the first successful PUT /api/settings; an authenticated GET
/api/settings never creates the row. The settings
probe is a syntactically valid PUT /api/settings with private non-production
canary values and no real provider credential; while stopped it must return the
stopped response with unchanged Settings existence and hash. Any mismatch
stops the procedure, retains the ledger, keeps writers stopped, returns to the
safe paused/read-only state as applicable, and forbids unbounded deletion or
an unrecorded credential attempt. Delete the ledger only after every check
passes.

- [ ] **Step 5: Run relationship and privacy checks**

~~~bash
npx jest --runInBand __tests__/docs/production-rollout-safety-hardening-contract.test.ts
rg -n "raw API response|provider credential|pairing code/reference|private ledger" docs/operations/production-runbook.md
if rg -n "Bearer [^[:space:]]+|raw row object|postgresql://[^[:space:]]+@|GET /api/settings[^.]{0,100}creates the row" docs/operations/production-runbook.md; then
  exit 1
fi
~~~

Expected: suite passes; the first scan positively finds the required privacy-boundary wording, and the second scan produces no output and exits 0.

- [ ] **Step 6: Commit**

~~~bash
git add docs/operations/production-runbook.md __tests__/docs/production-rollout-safety-hardening-contract.test.ts
git commit -m "docs: make rollout rollback and fixture cleanup fail closed"
~~~

### Task 7: Align README, linked documents, and complete verification

**Files:**
- Modify: README.md
- Modify: docs/superpowers/specs/2026-09-04-production-write-stop-rollout-design.md
- Modify: docs/superpowers/specs/2026-09-03-production-recovery-and-identity-rollout-design.md
- Modify: docs/superpowers/plans/2026-09-03-hosted-production-rollout.md
- Modify: __tests__/docs/production-rollout-safety-hardening-contract.test.ts

- [ ] **Step 1: Add failing cross-document test**

~~~ts
it("keeps non-runbook documents design-level and fixes Settings wording", () => {
  const files = [
    "README.md",
    "docs/superpowers/specs/2026-09-04-production-write-stop-rollout-design.md",
    "docs/superpowers/specs/2026-09-03-production-recovery-and-identity-rollout-design.md",
    "docs/superpowers/plans/2026-09-03-hosted-production-rollout.md",
  ];
  for (const file of files) {
    const document = readFileSync(join(root, file), "utf8");
    expect(document).toContain("docs/operations/production-runbook.md");
    expect(document).toContain("first successful PUT /api/settings");
    expect(document).not.toContain("authenticated GET /api/settings creates");
    expect(document).not.toMatch(/vercel api \\/v13\\/deployments\\//u);
    expect(document).not.toMatch(/vercel promote \\"\\$CANDIDATE_ID\\"/u);
  }
});
~~~

- [ ] **Step 2: Run red test**

~~~bash
npx jest --runInBand __tests__/docs/production-rollout-safety-hardening-contract.test.ts __tests__/docs/operations-docs-contract.test.ts
~~~

Expected: FAIL until all four documents use corrected wording and only the runbook owns executable Vercel commands.

- [ ] **Step 3: Correct README**

Use this text in the README Production identity maintenance section:

~~~markdown
The Settings singleton is created only on the first successful PUT /api/settings; an authenticated GET /api/settings is read-only and never creates the row. The complete staged candidate, rollback, fixture-ledger, and cleanup procedure is the production operations runbook at docs/operations/production-runbook.md#application-identity-maintenance-rollout.
~~~

Keep state/evidence summaries and links, but do not copy vercel deploy, vercel api, vercel inspect, vercel promote, or cleanup shell snippets into README.

- [ ] **Step 4: Align historical/design documents**

In each of the three linked documents, retain its historical/superseded status and add:

~~~markdown
The production operations runbook is the sole source of executable commands and ordering. This document summarizes design constraints and evidence requirements; it is not a second operator procedure. See the production operations runbook for the application identity maintenance rollout.
~~~

Remove copied candidate API/promotion command blocks, preserve state/evidence requirements, link to the runbook using the correct relative path, and state that Settings is created only on the first successful PUT /api/settings.

- [ ] **Step 5: Run document tests and duplication scan**

~~~bash
npx jest --runInBand __tests__/docs/production-rollout-safety-hardening-contract.test.ts __tests__/docs/operations-docs-contract.test.ts __tests__/docs/readme-user-guide.test.ts
rg -n "vercel (deploy|api|inspect|promote)|GET /api/settings.*creates" README.md docs/superpowers/specs/2026-09-04-production-write-stop-rollout-design.md docs/superpowers/specs/2026-09-03-production-recovery-and-identity-rollout-design.md docs/superpowers/plans/2026-09-03-hosted-production-rollout.md
~~~

Expected: all suites pass; only docs/operations/production-runbook.md contains executable candidate commands, and no stale Settings claim remains.

- [ ] **Step 6: Commit**

~~~bash
git add README.md \
  docs/superpowers/specs/2026-09-04-production-write-stop-rollout-design.md \
  docs/superpowers/specs/2026-09-03-production-recovery-and-identity-rollout-design.md \
  docs/superpowers/plans/2026-09-03-hosted-production-rollout.md \
  __tests__/docs/production-rollout-safety-hardening-contract.test.ts
git commit -m "docs: align rollout references with authoritative runbook"
~~~

**Final verification steps:**

**Files:**
- Verify: src/lib/database-timeouts.ts
- Verify: src/lib/prisma.ts
- Verify: src/lib/server-env-core.js
- Verify: __tests__/lib/database-timeouts.test.ts
- Verify: __tests__/lib/prisma.test.ts
- Verify: __tests__/lib/server-env.test.ts
- Verify: __tests__/lib/prisma-timeouts.integration.test.ts
- Verify: __tests__/api/protected-routes.test.ts
- Verify: __tests__/docs/production-rollout-safety-hardening-contract.test.ts
- Verify: docs/operations/production-runbook.md
- Verify: README.md and the three linked historical/design documents
- Verify: package.json, .github/workflows/ci.yml, and existing database guards.

- [ ] **Step 1: Review diff and scan for unsafe artifacts**

~~~bash
git diff --check -- \
  src/lib/database-timeouts.ts src/lib/prisma.ts src/lib/server-env-core.js \
  __tests__/lib/database-timeouts.test.ts __tests__/lib/prisma.test.ts \
  __tests__/lib/server-env.test.ts __tests__/lib/prisma-timeouts.integration.test.ts \
  __tests__/api/protected-routes.test.ts \
  __tests__/docs/production-rollout-safety-hardening-contract.test.ts \
  docs/operations/production-runbook.md README.md \
  docs/superpowers/specs/2026-09-04-production-write-stop-rollout-design.md \
  docs/superpowers/specs/2026-09-03-production-recovery-and-identity-rollout-design.md \
  docs/superpowers/plans/2026-09-03-hosted-production-rollout.md
git status --short
git diff --stat -- \
  src/lib/database-timeouts.ts src/lib/prisma.ts src/lib/server-env-core.js \
  __tests__/lib/database-timeouts.test.ts __tests__/lib/prisma.test.ts \
  __tests__/lib/server-env.test.ts __tests__/lib/prisma-timeouts.integration.test.ts \
  __tests__/api/protected-routes.test.ts \
  __tests__/docs/production-rollout-safety-hardening-contract.test.ts \
  docs/operations/production-runbook.md README.md \
  docs/superpowers/specs/2026-09-04-production-write-stop-rollout-design.md \
  docs/superpowers/specs/2026-09-03-production-recovery-and-identity-rollout-design.md \
  docs/superpowers/plans/2026-09-03-hosted-production-rollout.md
rg -n "raw API|provider credential|pairing code/reference|statement_timeout|lock_timeout|PAUSED_AFTER_APPLY|HOLD_PAUSED|UNPAUSED_READONLY" README.md docs/operations/production-runbook.md docs/superpowers/specs/2026-09-04-production-write-stop-rollout-design.md docs/superpowers/specs/2026-09-03-production-recovery-and-identity-rollout-design.md docs/superpowers/plans/2026-09-03-hosted-production-rollout.md
for marker in "T""BD" "TO""DO"; do
  if rg -n "$marker|Bearer [^[:space:]]+|raw API JSON|postgresql://[^[:space:]]+@|GET /api/settings[^.]{0,100}creates the row" README.md docs/operations/production-runbook.md docs/superpowers/specs/2026-09-04-production-write-stop-rollout-design.md docs/superpowers/specs/2026-09-03-production-recovery-and-identity-rollout-design.md docs/superpowers/plans/2026-09-03-hosted-production-rollout.md; then
    exit 1
  fi
done
  exit 1
fi
~~~

Expected: diff check exits 0, only intended files are changed, and no fixture ledger, raw Vercel JSON, private evidence, or unresolved marker exists.

- [ ] **Step 2: Run focused runtime and document suites**

~~~bash
npx jest --runInBand \
  __tests__/lib/database-timeouts.test.ts \
  __tests__/lib/prisma.test.ts \
  __tests__/lib/server-env.test.ts \
  __tests__/api/protected-routes.test.ts \
  __tests__/docs/production-rollout-safety-hardening-contract.test.ts \
  __tests__/docs/operations-docs-contract.test.ts \
  __tests__/docs/readme-user-guide.test.ts
~~~

Expected: every selected suite passes and all ordering/error contracts are green.

- [ ] **Step 3: Run repository checks without touching Production**

~~~bash
npm run typecheck
npm run lint
npm run check:extension
npm run check:audit
npm run check:startup-env
~~~

Expected: every command exits 0; no Vercel, GitHub, Neon, or Production database command runs.

- [ ] **Step 4: Repeat the disposable PostgreSQL 17 integration**

Repeat Task 4 Step 3 with a fresh unused loopback port and the same image digest. Confirm one passing test, ten distinct PIDs, statement_timeout 25s, lock_timeout 5s, and removal of only the named container.

- [ ] **Step 5: Run complete Jest with open-handle detection**

~~~bash
npm test -- --runInBand --detectOpenHandles
~~~

Expected: all enabled suites pass, guarded integration suites skip without explicit credentials, and Jest exits without open-handle warnings.

- [ ] **Step 6: Verify clean handoff**

~~~bash
git status --short
git log --oneline -8
~~~

Expected: no ledger, dump, environment file, raw API response, or private evidence is present. Preserve each focused commit from Tasks 1–7 and do not amend unrelated user changes.

## Final handoff

After the complete verification gate passes, request the two-stage spec and quality review required by superpowers:subagent-driven-development. The implementation branch is not ready for Production or merge until reviewers verify the timeout factory, reserved-key rejection, ten-slot PostgreSQL proof, candidate ID/SHA binding, paused rollback state machine, private ledger cleanup, and cross-document ordering. Production remains untouched during this plan; deployment and database maintenance follow the authoritative runbook only after branch review and merge.
