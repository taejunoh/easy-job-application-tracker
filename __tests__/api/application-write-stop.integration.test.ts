import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { canonicalizeApplicationUrl } from "@/lib/applications/identity";
import {
  createInstallationCredential,
  createPairingCredential,
  type IssuedInstallationCredential,
  type IssuedPairingCredential,
} from "@/lib/security/extension-credentials";
import { assertDatabaseTestSafety } from "./database-test-guard";
import {
  resetVerifiedIntegrationDatabase,
  verifyLiveDatabaseIdentity,
  type DatabaseTestIdentity,
  type LiveDatabaseIdentity,
} from "./database-test-preflight";

const DATABASE_INTEGRATION_REQUESTED =
  process.env.RUN_DATABASE_INTEGRATION === "1";
const DATABASE_TEST_IDENTITY = DATABASE_INTEGRATION_REQUESTED
  ? assertDatabaseTestSafety(process.env)
  : undefined;
if (DATABASE_TEST_IDENTITY !== undefined) {
  assertExactDatabaseName(DATABASE_TEST_IDENTITY);
}
const describeDatabase = DATABASE_INTEGRATION_REQUESTED
  ? describe
  : describe.skip;

const APP_ORIGIN = "https://jobtracker.test";
const EXTENSION_ORIGIN =
  "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const SEEDED_APPLICATION_ID = "018f9f72-f2e9-4c29-a6fc-001122334455";
const SEEDED_APPLICATION_URL = "https://jobs.example.test/seeded-role";
const SEEDED_AT = new Date("2026-01-01T00:00:00.000Z");
const EXPIRES_AT = new Date("2099-01-01T00:00:00.000Z");
const CONTAINER_POSTGRES_PORT = 5432;

type ApplicationsRoute = typeof import("@/app/api/applications/route");
type ApplicationDetailRoute =
  typeof import("@/app/api/applications/[id]/route");
type SettingsRoute = typeof import("@/app/api/settings/route");
type PairingRoute = typeof import("@/app/api/extension/pairing/route");
type PairRoute = typeof import("@/app/api/extension/pair/route");
type RevokeRoute = typeof import("@/app/api/extension/revoke/route");
type InstallationDetailRoute =
  typeof import("@/app/api/extension/installations/[id]/route");
type InstallationsRoute =
  typeof import("@/app/api/extension/installations/route");

type DurableSnapshot = Readonly<{
  applicationCount: number;
  applicationIdentityRelationCount: number;
  settingsCount: number;
  pairingGrantCount: number;
  installationCount: number;
  applicationDigest: string;
  settings: Readonly<{ id: string; contentHash: string }> | null;
  pairingGrants: readonly unknown[];
  installations: readonly unknown[];
}>;

let activeSessionCookie = "";
let activePairingCredential: IssuedPairingCredential;
let activeInstallationCredential: IssuedInstallationCredential;
let activePrisma: PrismaClient | undefined;

describeDatabase("application write-stop PostgreSQL invariants", () => {
  let prisma: PrismaClient | undefined;
  let applications: ApplicationsRoute;
  let applicationDetail: ApplicationDetailRoute;
  let settings: SettingsRoute;
  let pairing: PairingRoute;
  let pair: PairRoute;
  let revoke: RevokeRoute;
  let installationDetail: InstallationDetailRoute;
  let installations: InstallationsRoute;
  let before: DurableSnapshot;
  let liveDatabaseIdentity: LiveDatabaseIdentity;
  const previousApplicationWritesEnabled =
    process.env.APPLICATION_WRITES_ENABLED;

  beforeAll(async () => {
    process.env.APPLICATION_WRITES_ENABLED = "0";

    const [{ prisma: database }, routeModules, authModule, cryptoModule] =
      await Promise.all([
        import("@/lib/prisma"),
        Promise.all([
          import("@/app/api/applications/route"),
          import("@/app/api/applications/[id]/route"),
          import("@/app/api/settings/route"),
          import("@/app/api/extension/pairing/route"),
          import("@/app/api/extension/pair/route"),
          import("@/app/api/extension/revoke/route"),
          import("@/app/api/extension/installations/[id]/route"),
          import("@/app/api/extension/installations/route"),
        ]),
        import("@/lib/security/auth"),
        import("@/lib/crypto"),
      ]);
    prisma = database;
    activePrisma = database;
    [
      applications,
      applicationDetail,
      settings,
      pairing,
      pair,
      revoke,
      installationDetail,
      installations,
    ] = routeModules;

    expect(authModule).toBeDefined();
    expect(cryptoModule).toBeDefined();
    expect(process.env.APP_BASE_URL).toBe(APP_ORIGIN);
    expect(process.env.CORS_ALLOWED_ORIGINS?.split(",")).toEqual(
      expect.arrayContaining([APP_ORIGIN, EXTENSION_ORIGIN]),
    );

    const expectedIdentity = requiredLiveDatabaseIdentity();
    liveDatabaseIdentity = await verifyLiveDatabaseIdentity(
      prisma,
      expectedIdentity,
    );
    const version = await prisma.$queryRawUnsafe<
      Array<{ server_version_num: string }>
    >("SHOW server_version_num");
    expect(Number(version[0]?.server_version_num)).toBeGreaterThanOrEqual(
      170_000,
    );
    expect(Number(version[0]?.server_version_num)).toBeLessThan(180_000);
    const requiredTables = await prisma.$queryRawUnsafe<
      Array<{ table_name: string }>
    >(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (
           'Application', 'Settings', 'ExtensionPairingGrant',
           'ExtensionInstallation', '_prisma_migrations'
         )
       ORDER BY table_name`,
    );
    expect(requiredTables.map(({ table_name }) => table_name)).toEqual([
      "Application",
      "ExtensionInstallation",
      "ExtensionPairingGrant",
      "Settings",
      "_prisma_migrations",
    ]);
    const migrationRows = await prisma.$queryRawUnsafe<
      Array<{ migration_count: bigint }>
    >(
      `SELECT COUNT(*) AS migration_count
       FROM "_prisma_migrations"
       WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`,
    );
    expect(Number(migrationRows[0]?.migration_count)).toBeGreaterThan(0);

    await resetVerifiedIntegrationDatabase(prisma, expectedIdentity);
    await prisma.extensionPairingGrant.deleteMany();
    await prisma.extensionInstallation.deleteMany();

    const applicationIdentity = canonicalizeApplicationUrl(
      SEEDED_APPLICATION_URL,
    );
    await prisma.application.create({
      data: {
        id: SEEDED_APPLICATION_ID,
        url: SEEDED_APPLICATION_URL,
        jobTitle: "Platform Engineer",
        company: "Fixture Labs",
        status: "Applied",
        appliedDate: SEEDED_AT,
        description: "Seeded application for write-stop verification",
        notes: "Keep this durable state unchanged",
        salary: "$180000",
        location: "Remote",
        jobType: "Full-time",
        createdAt: SEEDED_AT,
        updatedAt: SEEDED_AT,
        identityKey: applicationIdentity.identityKey,
        canonicalUrl: applicationIdentity.canonicalUrl,
        duplicateOfId: null,
        identityState: "canonical",
      },
    });

    const encryptionSecret = requiredEncryptionSecret();
    const { encrypt } = cryptoModule;
    await prisma.settings.create({
      data: {
        id: "singleton",
        llmProvider: "openai",
        apiKey: encrypt("ci-private-provider-key"),
        linkedinUrl: "https://www.linkedin.com/in/fixture",
        githubUrl: "https://github.com/fixture",
        resumeText: "TypeScript PostgreSQL security",
      },
    });

    activePairingCredential = createPairingCredential({
      encryptionSecret,
      origin: EXTENSION_ORIGIN,
    });
    await prisma.extensionPairingGrant.create({
      data: {
        id: activePairingCredential.selector,
        origin: EXTENSION_ORIGIN,
        codeDigest: activePairingCredential.digest,
        expiresAt: EXPIRES_AT,
        consumedAt: null,
        installationId: null,
        createdAt: SEEDED_AT,
      },
    });

    activeInstallationCredential = createInstallationCredential({
      encryptionSecret,
      origin: EXTENSION_ORIGIN,
    });
    await prisma.extensionInstallation.create({
      data: {
        id: activeInstallationCredential.selector,
        origin: EXTENSION_ORIGIN,
        tokenDigest: activeInstallationCredential.digest,
        expiresAt: EXPIRES_AT,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: SEEDED_AT,
        updatedAt: SEEDED_AT,
      },
    });

    activeSessionCookie = `${authModule.SESSION_COOKIE_NAME}=${authModule.createSessionToken()}`;
    before = await snapshotDurableState(prisma);
  });

  afterAll(async () => {
    if (prisma) {
      try {
        await resetVerifiedIntegrationDatabase(
          prisma,
          requiredLiveDatabaseIdentity(),
        );
        await prisma.extensionPairingGrant.deleteMany();
        await prisma.extensionInstallation.deleteMany();
      } finally {
        await prisma.$disconnect();
      }
    }
    if (previousApplicationWritesEnabled === undefined) {
      delete process.env.APPLICATION_WRITES_ENABLED;
    } else {
      process.env.APPLICATION_WRITES_ENABLED =
        previousApplicationWritesEnabled;
    }
  });

  it("preflights the exact disposable PostgreSQL 17 identity", () => {
    expect(liveDatabaseIdentity).toEqual({
      database: requiredDatabaseIdentity().database,
      address: requiredDatabaseIdentity().serverAddress,
      port: CONTAINER_POSTGRES_PORT,
      schema: "public",
    });
  });

  it("keeps authenticated reads functional while writers are stopped", async () => {
    expect(
      (
        await applications.GET(
          request("/api/applications", { origin: APP_ORIGIN }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await settings.GET(request("/api/settings?includeResume=true", { origin: APP_ORIGIN }))
      ).status,
    ).toBe(200);
    expect(
      (
        await installations.GET(
          request("/api/extension/installations", { origin: APP_ORIGIN }),
        )
      ).status,
    ).toBe(200);
  });

  it("returns the canonical stop response for every persistent mutation", async () => {
    const responses = [
      await applications.POST(
        request("/api/applications", {
          method: "POST",
          origin: APP_ORIGIN,
          json: {
            url: "https://jobs.example.test/new-role",
            jobTitle: "Staff Engineer",
            company: "New Fixture Labs",
            status: "Applied",
          },
        }),
      ),
      await applicationDetail.PATCH(
        request(`/api/applications/${SEEDED_APPLICATION_ID}`, {
          method: "PATCH",
          origin: APP_ORIGIN,
          json: { status: "Interview" },
        }),
        detailContext(SEEDED_APPLICATION_ID),
      ),
      await applicationDetail.DELETE(
        request(`/api/applications/${SEEDED_APPLICATION_ID}`, {
          method: "DELETE",
          origin: APP_ORIGIN,
        }),
        detailContext(SEEDED_APPLICATION_ID),
      ),
      await settings.PUT(
        request("/api/settings", {
          method: "PUT",
          origin: APP_ORIGIN,
          json: {
            llmProvider: "anthropic",
            apiKey: "must-not-persist",
            resumeText: "must-not-persist",
          },
        }),
      ),
      await pairing.POST(
        request("/api/extension/pairing", {
          method: "POST",
          origin: APP_ORIGIN,
          json: { origin: EXTENSION_ORIGIN },
        }),
      ),
      await pair.POST(
        request("/api/extension/pair", {
          method: "POST",
          origin: EXTENSION_ORIGIN,
          json: { code: activePairingCredential.code },
        }),
      ),
      await revoke.POST(
        request("/api/extension/revoke", {
          method: "POST",
          origin: EXTENSION_ORIGIN,
          auth: "installation",
        }),
      ),
      await installationDetail.DELETE(
          request(`/api/extension/installations/${activeInstallationCredential.selector}`, {
          method: "DELETE",
          origin: APP_ORIGIN,
        }),
        detailContext(activeInstallationCredential.selector),
      ),
    ];

    expect(responses.map(({ status }) => status)).toEqual(
      Array(responses.length).fill(503),
    );
    const expectedBody = {
      error: "Application writes are temporarily disabled",
      code: "writes_stopped",
      retryable: true,
    };
    for (const [index, response] of responses.entries()) {
      await expect(response.json()).resolves.toEqual(expectedBody);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("Pragma")).toBe("no-cache");
      expect(response.headers.get("Retry-After")).toBe("60");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        [APP_ORIGIN, APP_ORIGIN, APP_ORIGIN, APP_ORIGIN, APP_ORIGIN, EXTENSION_ORIGIN, EXTENSION_ORIGIN, APP_ORIGIN][index],
      );
    }
    expect(await snapshotDurableState(requiredPrisma())).toEqual(before);
  });
});

async function snapshotDurableState(
  database: PrismaClient,
): Promise<DurableSnapshot> {
  const [applicationCount, applicationIdentityRelationCount, applicationRows,
    settingsCount, settingsRow, pairingGrantCount, pairingGrantRows,
    installationCount, installationRows] = await Promise.all([
    database.application.count(),
    database.application.count({ where: { duplicateOfId: { not: null } } }),
    database.application.findMany({ orderBy: { id: "asc" } }),
    database.settings.count(),
    database.settings.findUnique({ where: { id: "singleton" } }),
    database.extensionPairingGrant.count(),
    database.extensionPairingGrant.findMany({ orderBy: { id: "asc" } }),
    database.extensionInstallation.count(),
    database.extensionInstallation.findMany({ orderBy: { id: "asc" } }),
  ]);

  return {
    applicationCount,
    applicationIdentityRelationCount,
    settingsCount,
    pairingGrantCount,
    installationCount,
    applicationDigest: createHash("sha256")
      .update(
        JSON.stringify(
          applicationRows
            .map((row) => ({
      id: row.id,
      url: row.url,
      jobTitle: row.jobTitle,
      company: row.company,
      status: row.status,
      appliedDate: row.appliedDate.toISOString(),
      description: row.description,
      notes: row.notes,
      salary: row.salary,
      location: row.location,
      jobType: row.jobType,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      identityKey: row.identityKey,
      canonicalUrl: row.canonicalUrl,
      duplicateOfId: row.duplicateOfId,
      identityState: row.identityState,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        ),
        "utf8",
      )
      .digest("hex"),
    settings:
      settingsRow === null
        ? null
        : {
            id: settingsRow.id,
            contentHash: createHash("sha256")
              .update(
                JSON.stringify({
                  llmProvider: settingsRow.llmProvider,
                  apiKey: settingsRow.apiKey,
                  linkedinUrl: settingsRow.linkedinUrl,
                  githubUrl: settingsRow.githubUrl,
                  resumeText: settingsRow.resumeText,
                }),
                "utf8",
              )
              .digest("hex"),
          },
    pairingGrants: pairingGrantRows.map((row) => ({
      id: row.id,
      origin: row.origin,
      expiresAt: row.expiresAt.toISOString(),
      consumedAt: row.consumedAt?.toISOString() ?? null,
      installationId: row.installationId,
      createdAt: row.createdAt.toISOString(),
    })),
    installations: installationRows.map((row) => ({
      id: row.id,
      origin: row.origin,
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

function request(
  path: string,
  options: Readonly<{
    method?: string;
    origin: string;
    auth?: "installation";
    json?: unknown;
  }>,
): NextRequest {
  const headers = new Headers({ Origin: options.origin });
  if (options.auth === "installation") {
    headers.set("Authorization", `Bearer ${activeInstallationCredential.token}`);
  } else {
    headers.set("Cookie", activeSessionCookie);
  }
  if (options.json !== undefined) headers.set("Content-Type", "application/json");
  return new NextRequest(`${APP_ORIGIN}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.json === undefined ? undefined : JSON.stringify(options.json),
  });
}

function detailContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function requiredDatabaseIdentity(): DatabaseTestIdentity {
  if (DATABASE_TEST_IDENTITY === undefined) {
    throw new Error("Database integration identity was not validated");
  }
  return DATABASE_TEST_IDENTITY;
}

function assertExactDatabaseName(identity: DatabaseTestIdentity): void {
  if (identity.database !== "jobtracker_ci") {
    throw new Error(
      "Refusing destructive database integration tests: exact database target required",
    );
  }
}

function requiredLiveDatabaseIdentity(): DatabaseTestIdentity {
  return {
    ...requiredDatabaseIdentity(),
    port: CONTAINER_POSTGRES_PORT,
  };
}

function requiredEncryptionSecret(): string {
  const value = process.env.ENCRYPTION_SECRET;
  if (!value) throw new Error("ENCRYPTION_SECRET is required");
  return value;
}

function requiredPrisma(): PrismaClient {
  if (!activePrisma) {
    throw new Error("Prisma client was not initialized");
  }
  return activePrisma;
}
