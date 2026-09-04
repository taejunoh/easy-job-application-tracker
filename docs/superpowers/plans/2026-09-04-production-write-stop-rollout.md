# Production Write-Stop Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fail-closed application-wide persistent-write gate, prove that hidden and explicit writes stop, and replace the blocked pause-first identity rollout with staged Production deployments that resume into a verified read-only runtime.

**Architecture:** `APPLICATION_WRITES_ENABLED` is parsed once from the immutable deployment environment and defaults closed. Authenticated mutation routes use a common guard after CORS/authentication and before request processing, while persistence boundaries and extension authentication also enforce the closed state. The hosted rollout first promotes a Ready `identity=1,writes=0` Production deployment, drains in-flight requests, pauses only for prepare/apply, resumes the same read-only deployment, and finally promotes a separately staged `identity=1,writes=1` deployment.

**Tech Stack:** Next.js 16 route handlers, TypeScript, Jest, Prisma/PostgreSQL 17, GitHub Actions, Vercel CLI, Chrome MV3 extension.

---

## File responsibility map

- `src/lib/server-env-core.js`: parse the new binary flag and expose the immutable typed value.
- `src/lib/security/application-writes.ts`: own the stable write-stop predicate and `503` response contract.
- `src/lib/security/protected-route.ts`: enforce method-specific write policy after CORS/authentication and before handlers.
- `src/lib/security/auth.ts`: authenticate installation credentials without updating `lastUsedAt` while writes are closed.
- `src/lib/security/extension-installations.ts`: validate pairing codes without consuming them so invalid credentials remain `401` during write-stop.
- `src/app/api/**/route.ts`: declare persistent methods, bound mutation duration, and recheck immediately before persistence.
- `scripts/check-production-writes-stopped.mjs`: perform a bounded, sanitized hosted Application mutation probe.
- `.github/workflows/production-monitor.yml`: keep scheduled monitoring read-only and run mutation probing only on an explicit manual input.
- `docs/operations/production-runbook.md`: become the authoritative staged-deployment operator sequence.
- `docs/superpowers/plans/2026-09-03-hosted-production-rollout.md`: remove the invalid paused-build assumption and point execution at the verified write-stop sequence.

### Task 1: Parse the global flag and keep all test runtimes explicitly writable

**Files:**
- Modify: `src/lib/server-env-core.js`
- Modify: `__tests__/lib/server-env.test.ts`
- Modify: `scripts/verify-invalid-startup.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `__tests__/ci/workflow-contract.test.ts`

- [ ] **Step 1: Write the failing server-environment contract**

Add `APPLICATION_WRITES_ENABLED: "1"` to `productionSource`, require the returned value, and add the exact binary/default-closed matrix:

```ts
expect(config).toMatchObject({
  applicationIdentityWritesEnabled: true,
  applicationWritesEnabled: true,
});

it("defaults application writes off and accepts only exact binary values", () => {
  const missing = parseServerEnv(
    { ...productionSource, APPLICATION_WRITES_ENABLED: undefined },
    "production",
  );
  const disabled = parseServerEnv(
    { ...productionSource, APPLICATION_WRITES_ENABLED: "0" },
    "production",
  );
  const enabled = parseServerEnv(
    { ...productionSource, APPLICATION_WRITES_ENABLED: "1" },
    "production",
  );

  expect(missing.applicationWritesEnabled).toBe(false);
  expect(disabled.applicationWritesEnabled).toBe(false);
  expect(enabled.applicationWritesEnabled).toBe(true);
  for (const value of ["true", "yes", " 1", "1 ", "2", ""]) {
    expect(() =>
      parseServerEnv(
        { ...productionSource, APPLICATION_WRITES_ENABLED: value },
        "production",
      ),
    ).toThrow("APPLICATION_WRITES_ENABLED");
  }
});
```

- [ ] **Step 2: Run the focused test and verify the missing property fails**

Run:

```bash
npx jest --runInBand __tests__/lib/server-env.test.ts
```

Expected: FAIL because `applicationWritesEnabled` is absent.

- [ ] **Step 3: Implement the minimal parser change**

Extend the JSDoc type, parse with the existing exact binary helper, and return the value:

```js
/**
 * @typedef {Readonly<{
 *   databaseUrl: string,
 *   encryptionSecret: string,
 *   appAccessToken: string,
 *   appBaseUrl: string,
 *   appOrigin: string,
 *   corsAllowedOrigins: readonly string[],
 *   applicationIdentityWritesEnabled: boolean,
 *   applicationWritesEnabled: boolean,
 * }>} ServerEnv
 */

const applicationWritesEnabled = parseOptionalBinaryFlag(
  source,
  "APPLICATION_WRITES_ENABLED",
);

return Object.freeze({
  databaseUrl,
  encryptionSecret,
  appAccessToken,
  appBaseUrl,
  appOrigin,
  corsAllowedOrigins,
  applicationIdentityWritesEnabled,
  applicationWritesEnabled,
});
```

- [ ] **Step 4: Make startup validation and CI explicit**

Add `APPLICATION_WRITES_ENABLED` to `MANAGED_ENV_NAMES` and set it to `"1"` in `VALID_ENV` inside `scripts/verify-invalid-startup.mjs`. Add this line to both the `verify.env` and `extension-e2e.env` maps in `.github/workflows/ci.yml`:

```yaml
APPLICATION_WRITES_ENABLED: "1"
```

Update the two exact environment objects in `__tests__/ci/workflow-contract.test.ts` with:

```ts
APPLICATION_WRITES_ENABLED: "1",
```

- [ ] **Step 5: Run environment, workflow, and startup tests**

Run:

```bash
npx jest --runInBand \
  __tests__/lib/server-env.test.ts \
  __tests__/ci/workflow-contract.test.ts
npm run check:startup-env
```

Expected: PASS; invalid values fail generically without printing their values.

- [ ] **Step 6: Commit the environment contract**

```bash
git add src/lib/server-env-core.js \
  __tests__/lib/server-env.test.ts \
  scripts/verify-invalid-startup.mjs \
  .github/workflows/ci.yml \
  __tests__/ci/workflow-contract.test.ts
git commit -m "feat: add fail-closed application write flag"
```

### Task 2: Add the stable response and protected-route guard

**Files:**
- Create: `src/lib/security/application-writes.ts`
- Modify: `src/lib/security/auth-response.ts`
- Modify: `src/lib/security/protected-route.ts`
- Modify: `__tests__/api/protected-routes.test.ts`

- [ ] **Step 1: Write failing common-guard tests**

Mock `getServerEnv()` with `applicationWritesEnabled: false`, build a route with `writeMethods: ["POST"]`, and assert authentication precedence, the exact response, and zero handler calls:

```ts
it("stops an authenticated persistent method before its handler", async () => {
  const config = getServerEnv();
  jest.mocked(getServerEnv).mockReturnValue({
    ...config,
    applicationWritesEnabled: false,
  });
  const handler = jest.fn(async () => Response.json({ created: true }));
  const route = createProtectedRoute(["GET", "POST"], {
    writeMethods: ["POST"],
  });
  const response = await route.handler(handler)(
    new NextRequest(`${APP_ORIGIN}/api/example`, {
      method: "POST",
      headers: { Origin: APP_ORIGIN, Cookie: SESSION_COOKIE },
      body: "private-body-must-not-be-read",
    }),
  );

  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({
    error: "Application writes are temporarily disabled",
    code: "writes_stopped",
    retryable: true,
  });
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Retry-After")).toBe("60");
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
  expect(handler).not.toHaveBeenCalled();
});
```

Add separate requests proving an unauthenticated write remains `401`, a bad origin remains `403`, `OPTIONS` remains `204`, and authenticated `GET` still reaches its handler.

- [ ] **Step 2: Run the test and verify the unknown option/200 response fails**

```bash
npx jest --runInBand __tests__/api/protected-routes.test.ts
```

Expected: FAIL because `writeMethods` and the `503` response do not exist.

- [ ] **Step 3: Create the write-stop primitive**

Create `src/lib/security/application-writes.ts` with this complete API:

```ts
import "server-only";

import { getServerEnv } from "../server-env";

export const WRITES_STOPPED = Object.freeze({
  error: "Application writes are temporarily disabled" as const,
  code: "writes_stopped" as const,
  retryable: true as const,
});

export function applicationWritesEnabled(): boolean {
  return getServerEnv().applicationWritesEnabled;
}

export function applicationWriteGuard(): Response | null {
  return applicationWritesEnabled() ? null : applicationWritesStoppedResponse();
}

export function applicationWritesStoppedResponse(): Response {
  return Response.json(WRITES_STOPPED, {
    status: 503,
    headers: {
      "Cache-Control": "private, no-store",
      Pragma: "no-cache",
      "Retry-After": "60",
    },
  });
}
```

Update `privateNoStore()` so the exact write-stop cache directive survives the
normal protected-response decorator while every other response keeps the
existing `no-store` value:

```ts
export function privateNoStore(response: Response): Response {
  if (response.headers.get("Cache-Control") !== "private, no-store") {
    response.headers.set("Cache-Control", "no-store");
  }
  response.headers.set("Pragma", "no-cache");
  return response;
}
```

- [ ] **Step 4: Enforce declared methods in `createProtectedRoute`**

Extend the option and normalize the set:

```ts
type ProtectedRouteOptions = Readonly<{
  installationMethods?: readonly string[];
  writeMethods?: readonly string[];
}>;

const writeMethods = new Set(
  (options.writeMethods ?? []).map((method) => method.toUpperCase()),
);
```

After successful authentication and installation-method authorization, but before building the principal or invoking the handler, add:

```ts
if (writeMethods.has(request.method.toUpperCase())) {
  const stopped = applicationWriteGuard();
  if (stopped) return decorateCorsResponse(stopped, cors);
}
```

Import `applicationWriteGuard` from `./application-writes`. Do not send this branch through `privateNoStore`, because the response already owns the exact `private, no-store` contract.

- [ ] **Step 5: Run the protected-route suite**

```bash
npx jest --runInBand __tests__/api/protected-routes.test.ts
```

Expected: PASS, including `401`/`403`/`204` precedence and handler non-invocation.

- [ ] **Step 6: Commit the common guard**

```bash
git add src/lib/security/application-writes.ts \
  src/lib/security/auth-response.ts \
  src/lib/security/protected-route.ts \
  __tests__/api/protected-routes.test.ts
git commit -m "feat: guard authenticated persistent routes"
```

### Task 3: Remove installation-authentication timestamp writes while closed

**Files:**
- Modify: `src/lib/security/auth.ts`
- Modify: `__tests__/lib/security/auth.test.ts`
- Modify: `__tests__/api/auth.test.ts`

- [ ] **Step 1: Write the failing no-touch authentication test**

Add `applicationWritesEnabled: true` to the shared `AuthConfig` fixture. Add this closed-mode case beside the existing successful installation test:

```ts
it("authenticates a valid installation without touching it while writes are stopped", async () => {
  const installationStore = validInstallationStore();
  const result = await authenticateApiRequestAsync(installationRequest(), {
    config: { ...config, applicationWritesEnabled: false },
    now: NOW,
    installationStore,
  });

  expect(result).toEqual({
    authenticated: true,
    via: "installation",
    principal: {
      kind: "installation",
      installationId: INSTALLATION.selector,
      origin: EXTENSION_ORIGIN,
    },
  });
  expect(installationStore.touch).not.toHaveBeenCalled();
});
```

In `__tests__/api/auth.test.ts`, set the mocked server configuration to `APPLICATION_WRITES_ENABLED: "0"`, call the valid installation `/api/auth/verify` request, require `200`, and require `extensionInstallationAuthenticationStore.touch` not to run.

- [ ] **Step 2: Run the auth suites and observe the timestamp write**

```bash
npx jest --runInBand \
  __tests__/lib/security/auth.test.ts \
  __tests__/api/auth.test.ts
```

Expected: FAIL because valid installation authentication always calls `touch()`.

- [ ] **Step 3: Make the write state an explicit authentication dependency**

Make the field required so test-only configurations cannot silently choose a mode:

```ts
export type AuthConfig = Readonly<{
  appAccessToken: string;
  encryptionSecret: string;
  appOrigin: string;
  corsAllowedOrigins?: readonly string[];
  applicationWritesEnabled: boolean;
}>;
```

After credential digest verification, separate verification from the optional touch:

```ts
if (!verifyCredentialDigest(record.tokenDigest, digest)) {
  return UNAUTHORIZED;
}
if (
  config.applicationWritesEnabled &&
  !(await store.touch(record.id, new Date(now * 1000)))
) {
  return UNAUTHORIZED;
}
```

Update the shared literal `AuthConfig` in
`__tests__/lib/security/auth.test.ts` with
`applicationWritesEnabled: true`; closed tests override it to `false`.

- [ ] **Step 4: Prove open mode still touches and closed mode does not**

```bash
npx jest --runInBand \
  __tests__/lib/security/auth.test.ts \
  __tests__/api/auth.test.ts \
  __tests__/api/extension-installation-routes.test.ts
```

Expected: PASS. The existing open-mode test calls `touch` exactly once; the new closed-mode tests authenticate successfully with zero touches.

- [ ] **Step 5: Commit the hidden-write fix**

```bash
git add src/lib/security/auth.ts \
  __tests__/lib/security/auth.test.ts \
  __tests__/api/auth.test.ts \
  __tests__/api/extension-installation-routes.test.ts
git commit -m "fix: skip installation touch during write stop"
```

### Task 4: Gate Application and Settings persistence and remove the hidden GET write

**Files:**
- Create: `__tests__/api/application-write-stop.test.ts`
- Modify: `src/app/api/applications/route.ts`
- Modify: `src/app/api/applications/[id]/route.ts`
- Modify: `src/app/api/settings/route.ts`
- Modify: `__tests__/api/protected-routes.test.ts`

- [ ] **Step 1: Write the failing Application and Settings matrix**

Create `__tests__/api/application-write-stop.test.ts` using the existing `server-env`, Prisma, session, and request mocks. The table must contain these exact cases:

```ts
const webMutationCases = [
  ["application create", applicationsRoute.POST, applicationPostRequest(), prisma.$queryRaw],
  ["application update", applicationDetailRoute.PATCH, applicationPatchRequest(), prisma.application.update],
  ["application delete", applicationDetailRoute.DELETE, applicationDeleteRequest(), prisma.application.delete],
  ["settings update", settingsRoute.PUT, settingsPutRequest(), prisma.settings.findFirst],
] as const;
```

For every case, set `applicationWritesEnabled: false`, invoke with a valid session and origin, pass the detail route context where required, and assert the exact `503` body/headers plus zero calls to every Prisma mutation, `$queryRaw`, request parser, encryption helper, and duplicate-count query.

Add the missing-settings read test:

```ts
it("returns defaults without creating Settings when the singleton is absent", async () => {
  jest.mocked(prisma.settings.findFirst).mockResolvedValue(null);
  const response = await settingsRoute.GET(authenticatedSettingsGetRequest());

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    llmProvider: "openai",
    hasApiKey: false,
    linkedinUrl: "",
    githubUrl: "",
  });
  expect(prisma.settings.create).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the new test and verify current mutations reach Prisma**

```bash
npx jest --runInBand __tests__/api/application-write-stop.test.ts
```

Expected: FAIL with non-503 responses and the current Settings `create()` call.

- [ ] **Step 3: Declare guarded methods and bounded duration**

Use these exact declarations:

```ts
// src/app/api/applications/route.ts
export const maxDuration = 30;
const route = createProtectedRoute(["GET", "POST"], {
  installationMethods: ["POST"],
  writeMethods: ["POST"],
});

// src/app/api/applications/[id]/route.ts
export const maxDuration = 30;
const route = createProtectedRoute(["GET", "PATCH", "DELETE"], {
  writeMethods: ["PATCH", "DELETE"],
});

// src/app/api/settings/route.ts
export const maxDuration = 30;
const route = createProtectedRoute(["GET", "PUT"], {
  writeMethods: ["PUT"],
});
```

Immediately before each `prisma.application.create`, `createApplicationAtomically`, `prisma.application.update`, `prisma.application.delete`, `prisma.settings.create`, and `prisma.settings.update`, recheck:

```ts
const stopped = applicationWriteGuard();
if (stopped) return stopped;
```

Import the helper from `@/lib/security/application-writes`.

- [ ] **Step 4: Make Settings GET permanently read-only**

Replace singleton creation with nullable defaults:

```ts
const settings = await prisma.settings.findFirst();
const { searchParams } = new URL(request.url);
const includeResume = searchParams.get("includeResume") === "true";
const response: Record<string, unknown> = {
  llmProvider: settings?.llmProvider ?? "openai",
  hasApiKey: Boolean(settings?.apiKey),
  linkedinUrl: settings?.linkedinUrl ?? "",
  githubUrl: settings?.githubUrl ?? "",
};
if (includeResume) response.resumeText = settings?.resumeText ?? "";
return NextResponse.json(response);
```

Remove only the `GET`-side `prisma.settings.create`. Keep PUT upsert behavior under the guard.

- [ ] **Step 5: Run web route and contract tests**

```bash
npx jest --runInBand \
  __tests__/api/application-write-stop.test.ts \
  __tests__/api/protected-routes.test.ts
```

Expected: PASS; read routes still return `200`, all four web mutations stop before body/Prisma work, and absent Settings performs no write.

- [ ] **Step 6: Commit the web mutation coverage**

```bash
git add __tests__/api/application-write-stop.test.ts \
  src/app/api/applications/route.ts \
  'src/app/api/applications/[id]/route.ts' \
  src/app/api/settings/route.ts \
  __tests__/api/protected-routes.test.ts
git commit -m "feat: stop application and settings writes"
```

### Task 5: Gate the extension lifecycle without turning pairing validity into an oracle

**Files:**
- Modify: `src/lib/security/extension-installations.ts`
- Modify: `src/app/api/extension/pairing/route.ts`
- Modify: `src/app/api/extension/pair/route.ts`
- Modify: `src/app/api/extension/revoke/route.ts`
- Modify: `src/app/api/extension/installations/[id]/route.ts`
- Modify: `__tests__/lib/security/extension-installations.test.ts`
- Modify: `__tests__/api/extension-installation-routes.test.ts`
- Modify: `__tests__/api/application-write-stop.test.ts`

- [ ] **Step 1: Write the failing read-only pairing-validation test**

Add this service contract:

```ts
it("validates a pairing code without consuming it", async () => {
  const store = memoryStore();
  const service = serviceFor(store);
  const grant = await service.createPairingGrant(ORIGIN);

  await expect(service.validatePairingCode(grant.code, ORIGIN)).resolves.toBe(true);
  await expect(service.validatePairingCode("bad", ORIGIN)).resolves.toBe(false);
  expect(store.grants.get(grant.id)?.consumedAt).toBeNull();
  expect(store.installations.size).toBe(0);
});
```

- [ ] **Step 2: Add the failing extension route matrix**

Cover `POST /api/extension/pairing`, a valid `POST /api/extension/pair`, `POST /api/extension/revoke`, and `DELETE /api/extension/installations/:id`. Require valid principals/codes to receive the exact `503`; invalid or unauthorized principals/codes retain `401`/`403`; grant consumption, installation insertion, revoke, and auth touch mocks remain uncalled.

For pair, explicitly require a valid code to remain reusable after the stopped request:

```ts
expect(extensionCredentialStore.consumePairingGrant).not.toHaveBeenCalled();
expect(await service.validatePairingCode(validCode, EXTENSION_ORIGIN)).toBe(true);
```

- [ ] **Step 3: Run extension tests and observe current writes**

```bash
npx jest --runInBand \
  __tests__/lib/security/extension-installations.test.ts \
  __tests__/api/extension-installation-routes.test.ts \
  __tests__/api/application-write-stop.test.ts
```

Expected: FAIL because no read-only validation API or route guards exist.

- [ ] **Step 4: Add read-only pairing validation and reuse it in exchange**

Inside `createExtensionInstallationService`, add a private validator and public boolean method:

```ts
async function validPairingGrant(code: unknown, origin: string) {
  if (!allowedOrigin(origin)) return null;
  const parsed = parsePairingCode(code);
  if (parsed === null) return null;
  const grant = await options.store.findPairingGrant(parsed.selector);
  const observedAt = new Date(now());
  if (
    grant === null ||
    grant.origin !== origin ||
    grant.consumedAt !== null ||
    grant.expiresAt.getTime() <= observedAt.getTime()
  ) return null;
  const digest = digestPairingSecret(
    parsed.selector,
    parsed.secret,
    origin,
    options.encryptionSecret,
  );
  return verifyCredentialDigest(grant.codeDigest, digest)
    ? { grant, observedAt }
    : null;
}

async validatePairingCode(code: unknown, origin: string) {
  return (await validPairingGrant(code, origin)) !== null;
},
```

Refactor `exchangePairingCode` to call `validPairingGrant`, then create the installation and call `consumePairingGrant` exactly as it does now. The store transaction remains the final one-time-use authority.

- [ ] **Step 5: Guard extension routes at both boundaries**

Use these declarations and module bounds:

```ts
export const maxDuration = 30;
const route = createProtectedRoute(["POST"], { writeMethods: ["POST"] });
```

Apply it to pairing. Apply `writeMethods: ["POST"]` to self-revoke and `writeMethods: ["DELETE"]` to installation deletion. Before each `createPairingGrant()` or `revoke()` call, recheck `applicationWriteGuard()`.

For the custom pair route, keep CORS and extension-origin validation first, parse the code, and then preserve credential semantics:

```ts
const service = configuredExtensionInstallationService();
if (!applicationWritesEnabled()) {
  const valid = await service.validatePairingCode(code, origin);
  const response = valid
    ? applicationWritesStoppedResponse()
    : privateNoStore(Response.json(UNAUTHORIZED, { status: 401 }));
  return decorateCorsResponse(response, cors);
}
const installed = await service.exchangePairingCode(code, origin);
```

This returns `401` for an invalid/expired/wrong-origin code, returns `503` only for a valid unconsumed code, and never consumes the valid code while closed. Add `export const maxDuration = 30` to pair, pairing, revoke, and installation-delete modules.

- [ ] **Step 6: Run extension and auth regression tests**

```bash
npx jest --runInBand \
  __tests__/lib/security/extension-installations.test.ts \
  __tests__/lib/security/auth.test.ts \
  __tests__/api/auth.test.ts \
  __tests__/api/extension-installation-routes.test.ts \
  __tests__/api/application-write-stop.test.ts
```

Expected: PASS. Open mode still completes pairing once and revoke; closed mode authenticates reads without touch and blocks every extension mutation.

- [ ] **Step 7: Commit extension write-stop behavior**

```bash
git add src/lib/security/extension-installations.ts \
  src/app/api/extension/pairing/route.ts \
  src/app/api/extension/pair/route.ts \
  src/app/api/extension/revoke/route.ts \
  'src/app/api/extension/installations/[id]/route.ts' \
  __tests__/lib/security/extension-installations.test.ts \
  __tests__/api/extension-installation-routes.test.ts \
  __tests__/api/application-write-stop.test.ts
git commit -m "feat: stop extension credential writes"
```

### Task 6: Prove the complete inventory and PostgreSQL state invariants

**Files:**
- Create: `__tests__/api/application-write-inventory.test.ts`
- Create: `__tests__/api/application-write-stop.integration.test.ts`
- Reuse: `__tests__/api/database-test-guard.ts`
- Reuse: `__tests__/api/database-test-preflight.ts`

- [ ] **Step 1: Write a static inventory test that fails on undeclared writers**

Declare the complete route inventory and mutation markers:

```ts
const inventory = [
  ["src/app/api/applications/route.ts", ["POST"]],
  ["src/app/api/applications/[id]/route.ts", ["PATCH", "DELETE"]],
  ["src/app/api/settings/route.ts", ["PUT"]],
  ["src/app/api/extension/pairing/route.ts", ["POST"]],
  ["src/app/api/extension/pair/route.ts", ["POST"]],
  ["src/app/api/extension/revoke/route.ts", ["POST"]],
  ["src/app/api/extension/installations/[id]/route.ts", ["DELETE"]],
] as const;

const persistencePattern =
  /\.(?:create|createMany|update|updateMany|delete|deleteMany|upsert|createPairingGrant|exchangePairingCode|consumePairingGrant|revoke)\s*\(|\$executeRaw|\$transaction/u;
```

Read every `src/app/api/**/route.ts`, collect files matching the persistence pattern, and require their set to equal the inventory set. For protected routes, require the exact `writeMethods` methods; for custom pair, require `applicationWritesEnabled()` and `applicationWritesStoppedResponse()`; require `export const maxDuration = 30` in every inventory file. Also assert `src/lib/security/auth.ts` contains the closed-mode no-touch branch.

- [ ] **Step 2: Run the inventory test**

```bash
npx jest --runInBand __tests__/api/application-write-inventory.test.ts
```

Expected: PASS only when all current route writers are declared and bounded. If the regex finds a genuine read-only false positive, narrow the regex to the called service name rather than removing that file from inspection.

- [ ] **Step 3: Write the PostgreSQL integration proof**

Create `__tests__/api/application-write-stop.integration.test.ts`. Guard it with the same `RUN_DATABASE_INTEGRATION`, destructive sentinel, database-name, loopback-address, PostgreSQL 17, and schema preflight used by `deployment.integration.test.ts`. In `beforeAll`, set `APPLICATION_WRITES_ENABLED="0"` before dynamically importing routes, seed one Application, Settings row, valid pairing grant, and valid installation directly through Prisma, and capture:

```ts
const before = await snapshotDurableState(prisma);
```

The snapshot must contain sorted Application identity/state fields, Settings content hash, pairing grant `consumedAt`/`installationId`, installation `revokedAt`/`lastUsedAt`/`updatedAt`, and row counts. Invoke authenticated reads plus all eight persistent route mutations with syntactically valid bodies and credentials. Then require:

```ts
expect(await snapshotDurableState(prisma)).toEqual(before);
expect(responses.map(({ status }) => status)).toEqual(
  Array(responses.length).fill(503),
);
```

Use `afterAll` for the existing guarded database reset and `$disconnect()`. Never print snapshots, credentials, bodies, URLs, or row values.

- [ ] **Step 4: Run the integration proof only against a disposable PostgreSQL 17 database**

Start a digest-pinned disposable database, apply migrations, and run the test
with the same safety identity used by CI:

```bash
docker run --rm -d \
  --name jobtracker-write-stop-test \
  -e POSTGRES_USER=jobtracker \
  -e POSTGRES_PASSWORD=jobtracker \
  -e POSTGRES_DB=jobtracker_ci \
  -p 127.0.0.1:55432:5432 \
  docker.io/library/postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193
trap 'docker rm -f jobtracker-write-stop-test >/dev/null 2>&1 || true' EXIT
for attempt in {1..30}; do
  if docker exec jobtracker-write-stop-test pg_isready -U jobtracker -d jobtracker_ci >/dev/null; then
    break
  fi
  test "$attempt" -lt 30
  sleep 1
done
export DATABASE_URL=postgresql://jobtracker:jobtracker@127.0.0.1:55432/jobtracker_ci
export EXPECTED_DATABASE_SERVER_ADDRESS="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' jobtracker-write-stop-test)"
export ENCRYPTION_SECRET=ci-encryption-secret-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
export APP_ACCESS_TOKEN=ci-access-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export APP_BASE_URL=https://jobtracker.test
export CORS_ALLOWED_ORIGINS=https://jobtracker.test,chrome-extension://abcdefghijklmnopabcdefghijklmnop
export APPLICATION_IDENTITY_WRITES_ENABLED=1
export APPLICATION_WRITES_ENABLED=0
export RUN_DATABASE_INTEGRATION=1
export ALLOW_DESTRUCTIVE_DATABASE_TESTS=jobtracker-ci-delete-all
npx prisma migrate deploy
npx jest --runInBand __tests__/api/application-write-stop.integration.test.ts
```

Expected: PASS with PostgreSQL major 17 and an identical before/after snapshot. Without the disposable database identity and sentinel, expected result is a safety refusal, not an attempted test.

- [ ] **Step 5: Commit inventory and integration evidence**

```bash
git add __tests__/api/application-write-inventory.test.ts \
  __tests__/api/application-write-stop.integration.test.ts
git commit -m "test: prove write-stop persistence invariants"
```

### Task 7: Add an explicit, bounded Production write-stop probe

**Files:**
- Create: `scripts/check-production-writes-stopped.mjs`
- Create: `__tests__/scripts/check-production-writes-stopped.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/production-monitor.yml`
- Modify: `__tests__/ci/production-monitor-workflow-contract.test.ts`

- [ ] **Step 1: Write the failing CLI contract tests**

Use a loopback HTTP server and spawned Node process, following `check-production-stats.test.ts`. Require:

```ts
expect(result).toEqual({
  code: 0,
  stdout: "Production write-stop probe passed.\n",
  stderr: "",
});
```

The server must observe an authenticated GET `/api/stats`, a syntactically valid POST `/api/applications`, and a second GET `/api/stats`. The POST response must be exactly `503`, `code: "writes_stopped"`, `retryable: true`, `Cache-Control: private, no-store`, and `Retry-After: 60`; before/after stats must be identical. Add generic-failure cases for `200/201`, malformed JSON, wrong code/headers, changed counts, redirect, refusal, and timeout. Assert combined stdout/stderr never contains the token, origin, request URL, synthetic record fields, or response body.

- [ ] **Step 2: Run the new test and verify the script is missing**

```bash
npx jest --runInBand __tests__/scripts/check-production-writes-stopped.test.ts
```

Expected: FAIL because the script does not exist.

- [ ] **Step 3: Implement the sanitized probe**

The script must validate an HTTPS origin except for loopback tests, require the existing monitor token, bound each fetch to at most 30 seconds, and never print caught error details. Its core flow is:

```js
const before = await authenticatedStats();
const response = await fetch(new URL("/api/applications", origin), {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    origin: origin.origin,
    "content-type": "application/json",
    accept: "application/json",
  },
  body: JSON.stringify(syntheticApplication()),
  redirect: "error",
  signal: AbortSignal.timeout(timeoutMs),
});
if (response.status !== 503) throw new Error("Unexpected status");
if (response.headers.get("cache-control") !== "private, no-store") {
  throw new Error("Unexpected cache policy");
}
if (response.headers.get("retry-after") !== "60") {
  throw new Error("Unexpected retry policy");
}
const body = await response.json();
if (
  body?.code !== "writes_stopped" ||
  body?.retryable !== true ||
  Object.keys(body).sort().join(",") !== "code,error,retryable"
) throw new Error("Unexpected response");
const after = await authenticatedStats();
if (JSON.stringify(after) !== JSON.stringify(before)) {
  throw new Error("Unexpected state change");
}
```

Generate the synthetic URL/title/company in memory from `crypto.randomUUID()` and never emit them. On any unexpected successful POST, do not delete by an unverified ID and do not claim writer-stop; fail generically so the operator pauses Vercel and follows the runbook's bounded cleanup procedure.

- [ ] **Step 4: Add the package command and manual workflow input**

Add:

```json
"check:production:writes-stopped": "node scripts/check-production-writes-stopped.mjs"
```

Change only manual dispatch behavior:

```yaml
workflow_dispatch:
  inputs:
    expect_writes_stopped:
      description: Require the authenticated write-stop probe
      required: true
      type: boolean
      default: false
```

Keep the scheduled stats step unchanged. Add the conditional step:

```yaml
- name: Check authenticated production write stop
  if: inputs.expect_writes_stopped == true
  env:
    PRODUCTION_APP_URL: ${{ vars.PRODUCTION_APP_URL }}
    PRODUCTION_APP_ACCESS_TOKEN: ${{ secrets.PRODUCTION_APP_ACCESS_TOKEN }}
  run: npm run check:production:writes-stopped
```

- [ ] **Step 5: Update the exact workflow contract and run tests**

Assert the boolean input object, the unchanged hourly schedule/read-only stats step, the exact conditional step, secret scope only on the two check steps, and absence of `curl`, response-body printing, or `set -x`.

```bash
npx jest --runInBand \
  __tests__/scripts/check-production-writes-stopped.test.ts \
  __tests__/scripts/check-production-stats.test.ts \
  __tests__/ci/production-monitor-workflow-contract.test.ts
```

Expected: PASS. Scheduled runs execute only stats; manual `expect_writes_stopped=true` runs stats and the negative probe.

- [ ] **Step 6: Commit the Production probe**

```bash
git add scripts/check-production-writes-stopped.mjs \
  __tests__/scripts/check-production-writes-stopped.test.ts \
  package.json \
  .github/workflows/production-monitor.yml \
  __tests__/ci/production-monitor-workflow-contract.test.ts
git commit -m "feat: add production write-stop monitor"
```

### Task 8: Align operator documentation and replace the paused-build sequence

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/operations/production-runbook.md`
- Modify: `docs/superpowers/plans/2026-09-03-hosted-production-rollout.md`
- Modify: `__tests__/docs/operations-docs-contract.test.ts`
- Modify: `__tests__/docs/readme-user-guide.test.ts`

- [ ] **Step 1: Write failing documentation contracts**

Require exactly one closed default in `.env.example`:

```ts
expect(envExample.match(/^APPLICATION_WRITES_ENABLED="0"$/gmu)).toEqual([
  'APPLICATION_WRITES_ENABLED="0"',
]);
```

Require README and runbook to contain both gate states, `vercel --prod --skip-domain`, pre-pause promotion, bounded drain, `503 DEPLOYMENT_PAUSED` before prepare/apply, no build/promotion while paused, read-only resume, staged final promotion, and external writer resume last. Require them not to contain the old instruction to deploy gate-enabled code while paused.

- [ ] **Step 2: Run documentation tests and observe the missing contract**

```bash
npx jest --runInBand \
  __tests__/docs/operations-docs-contract.test.ts \
  __tests__/docs/readme-user-guide.test.ts
```

Expected: FAIL because the new gate and revised sequence are undocumented.

- [ ] **Step 3: Add the closed example and user-facing configuration**

Add this adjacent to the identity gate:

```dotenv
APPLICATION_IDENTITY_WRITES_ENABLED="0"
APPLICATION_WRITES_ENABLED="0"
```

Document the new variable as server-only, exact `0|1`, missing defaults closed, invalid values fail validation, and Production must set it explicitly. State that normal local/CI use requires `"1"`; maintenance uses `"0"`.

- [ ] **Step 4: Replace the runbook rollout section with the approved stages**

The authoritative sequence must contain these exact state transitions:

```text
identity=0,writes=1 Ready canonical
identity=1,writes=0 Ready staged Production (--skip-domain)
promote while unpaused
wait at least 2 × maxDuration and pass the negative probes
pause and require DEPLOYMENT_PAUSED
prepare, review, apply while paused
resume the recorded identity=1,writes=0 deployment
identity=1,writes=1 Ready staged Production (--skip-domain)
promote while unpaused, smoke, cleanup, resume external writers last
```

Include the exact `503` JSON/header contract, the Settings GET and installation-touch hidden-write checks, deployment/run IDs to record, privacy restrictions, and the rollback target: the recorded Ready `identity=1,writes=0` deployment.

Before Stage 1 promotion, require one disposable Application, one installed
extension credential, and a second unconsumed pairing grant created through the
supported authenticated flows. Keep their URL, IDs, tokens, and pairing codes
only in the operator's private mode-0700 workspace. After promotion, use those
fixtures to prove Application POST/PATCH/DELETE, Settings PUT, pairing creation,
valid pair exchange, installation deletion, and self-revoke all return
`writes_stopped`; prove Settings GET and installation-authenticated reads do
not create/touch rows. Compare sanitized counts and hashes before/after. After
the final write-enabled promotion, delete the disposable Application, consume
the unconsumed grant once, revoke both disposable installations, and record
only sanitized cleanup status.

- [ ] **Step 5: Rewrite Tasks 3–6 of the hosted rollout plan**

Remove the architecture statement that a deployment is built while paused. Require `--skip-domain` Production candidates, explicit inspection proving Ready/exact SHA/no canonical alias before promotion, promotion only while unpaused, the pause only across prepare/apply, resume without redeploying, and final staged promotion. Preserve already completed source-control and encrypted-backup evidence while marking the prior paused-build attempt as superseded rather than successful.

- [ ] **Step 6: Run documentation contracts**

```bash
npx jest --runInBand \
  __tests__/docs/operations-docs-contract.test.ts \
  __tests__/docs/readme-user-guide.test.ts
```

Expected: PASS; README, `.env.example`, runbook, and hosted plan describe the same two-gate sequence.

- [ ] **Step 7: Commit documentation alignment**

```bash
git add .env.example README.md \
  docs/operations/production-runbook.md \
  docs/superpowers/plans/2026-09-03-hosted-production-rollout.md \
  __tests__/docs/operations-docs-contract.test.ts \
  __tests__/docs/readme-user-guide.test.ts
git commit -m "docs: revise identity rollout for staged write stop"
```

### Task 9: Run complete verification and prepare the reviewed branch

**Files:**
- Verify all files changed by Tasks 1–8
- Do not modify Production state in this task

- [ ] **Step 1: Run focused write-stop tests**

```bash
npx jest --runInBand \
  __tests__/lib/server-env.test.ts \
  __tests__/lib/security/auth.test.ts \
  __tests__/lib/security/extension-installations.test.ts \
  __tests__/api/auth.test.ts \
  __tests__/api/protected-routes.test.ts \
  __tests__/api/extension-installation-routes.test.ts \
  __tests__/api/application-write-stop.test.ts \
  __tests__/api/application-write-inventory.test.ts \
  __tests__/scripts/check-production-writes-stopped.test.ts \
  __tests__/ci/production-monitor-workflow-contract.test.ts \
  __tests__/ci/workflow-contract.test.ts \
  __tests__/docs/operations-docs-contract.test.ts \
  __tests__/docs/readme-user-guide.test.ts
```

Expected: PASS with no leaked synthetic data or credentials.

- [ ] **Step 2: Run the full repository gates**

```bash
npm run test:ci
npm run lint
npm run typecheck
npm run build
npm run check:startup-env
npm run check:extension
npm run check:audit
git diff --check main...HEAD
```

Expected: every command exits `0`. If the dependency audit is run, a valid vulnerability report still fails on policy findings; transient registry acquisition failure must not be described as a clean audit.

- [ ] **Step 3: Run the safe extension journey in open mode**

```bash
APPLICATION_WRITES_ENABLED=1 npm run test:extension:e2e:local
```

Expected: the disposable local wrapper completes pairing, save, analysis, revoke, and cleanup. Do not run the lower-level destructive extension script directly.

- [ ] **Step 4: Inspect the branch for scope and secret hygiene**

```bash
git status --short --branch
git diff --stat main...HEAD
git diff --check main...HEAD
git log --oneline --decorate main..HEAD
```

Expected: only the approved write-stop implementation, tests, workflow, and documentation; no `.env*` secrets, dumps, reports, pairing codes, tokens, URLs containing private data, `.vercel`, or generated build artifacts.

- [ ] **Step 5: Resolve verification failures in their owning task**

If a command demonstrates a defect, return to the task that owns that file,
add a failing regression test, make the minimal fix, rerun that task's focused
command and this full gate, and amend only that task through a new focused
`fix:` commit. If no correction is required, make no empty commit.

- [ ] **Step 6: Push the implementation and request code review**

```bash
git push -u origin codex/production-write-stop-rollout
gh pr create \
  --base main \
  --head codex/production-write-stop-rollout \
  --title "Add a safe production write-stop rollout" \
  --body "Adds the fail-closed persistent-write gate, hidden-write coverage, staged-deployment monitor, and revised production identity runbook."
gh pr checks --watch
```

Expected: `verify`, `backup-interruption`, and `extension-e2e` succeed on the
exact branch SHA. Do not change Vercel gates, pause state, or production data
from this implementation task.

- [ ] **Step 7: Merge only after review and record the rollout SHA**

```bash
gh pr merge --merge --delete-branch
git switch main
git pull --ff-only origin main
git rev-parse HEAD
```

Expected: the printed SHA is the merged `ROLLOUT_SHA` used for every later
backup, staged deployment, monitor, prepare, and apply run.

After integration, execute the revised `docs/superpowers/plans/2026-09-03-hosted-production-rollout.md` from its first incomplete gate. The rollout must obtain a fresh exact-SHA backup and a Ready staged `identity=1,writes=0` Production deployment before any new `prepare` or `apply` run.
