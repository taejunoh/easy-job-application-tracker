import type { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { generatedPdf } from "../fixtures/resume/generated-pdf";
import { assertDatabaseTestSafety } from "./database-test-guard";
import {
  resetVerifiedIntegrationDatabase,
  type LiveDatabaseIdentity,
} from "./database-test-preflight";
import {
  createInstallationCredential,
  type IssuedInstallationCredential,
} from "@/lib/security/extension-credentials";

jest.mock("@/lib/extract/llm-provider", () => ({
  createProvider: jest.fn(() => {
    throw new Error("External LLM access is forbidden in integration tests");
  }),
}));

jest.mock("@/lib/security/safe-fetch", () => {
  const actual = jest.requireActual<
    typeof import("@/lib/security/safe-fetch")
  >("@/lib/security/safe-fetch");

  return {
    ...actual,
    safeFetchJobUrl: jest.fn(async (rawUrl: string) => {
      if (rawUrl === "https://jobs.example.test/open-role") {
        return {
          finalUrl: rawUrl,
          html: `
            <html><head>
              <meta property="og:title" content="Platform Engineer" />
              <meta property="og:site_name" content="Fixture Careers" />
            </head><body>offline fixture</body></html>
          `,
        };
      }

      actual.validateJobUrl(rawUrl);
      throw new Error(`Unexpected external fetch in integration test: ${rawUrl}`);
    }),
  };
});

import { createProvider } from "@/lib/extract/llm-provider";

const DATABASE_INTEGRATION_REQUESTED =
  process.env.RUN_DATABASE_INTEGRATION !== undefined;
const DATABASE_TEST_IDENTITY = DATABASE_INTEGRATION_REQUESTED
  ? assertDatabaseTestSafety(process.env)
  : undefined;
const describeDatabase = DATABASE_INTEGRATION_REQUESTED
  ? describe
  : describe.skip;

const APP_ORIGIN = "https://jobtracker.test";
const EXTENSION_ORIGIN =
  "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
let installationCredentialForRequest: IssuedInstallationCredential | undefined;

type ApplicationsRoute = typeof import("@/app/api/applications/route");
type ApplicationDetailRoute =
  typeof import("@/app/api/applications/[id]/route");
type AuthSessionRoute = typeof import("@/app/api/auth/session/route");
type ExtractRoute = typeof import("@/app/api/extract/route");
type KeywordAnalysisRoute = typeof import("@/app/api/keyword-analysis/route");
type ParseResumeRoute = typeof import("@/app/api/parse-resume/route");
type SettingsRoute = typeof import("@/app/api/settings/route");
type StatsRoute = typeof import("@/app/api/stats/route");

describeDatabase("hosted deployment against PostgreSQL", () => {
  let prisma: PrismaClient;
  let applications: ApplicationsRoute;
  let applicationDetail: ApplicationDetailRoute;
  let authSession: AuthSessionRoute;
  let extract: ExtractRoute;
  let keywordAnalysis: KeywordAnalysisRoute;
  let parseResume: ParseResumeRoute;
  let settings: SettingsRoute;
  let stats: StatsRoute;
  let liveDatabaseIdentity: LiveDatabaseIdentity;

  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toMatch(/^postgres(?:ql)?:\/\//u);
    expect(process.env.APP_BASE_URL).toBe(APP_ORIGIN);
    expect(process.env.CORS_ALLOWED_ORIGINS?.split(",")).toEqual(
      expect.arrayContaining([APP_ORIGIN, EXTENSION_ORIGIN]),
    );
    expect(Buffer.byteLength(accessToken(), "utf8")).toBeGreaterThanOrEqual(32);

    ({ prisma } = await import("@/lib/prisma"));
    [
      applications,
      applicationDetail,
      authSession,
      extract,
      keywordAnalysis,
      parseResume,
      settings,
      stats,
    ] = await Promise.all([
      import("@/app/api/applications/route"),
      import("@/app/api/applications/[id]/route"),
      import("@/app/api/auth/session/route"),
      import("@/app/api/extract/route"),
      import("@/app/api/keyword-analysis/route"),
      import("@/app/api/parse-resume/route"),
      import("@/app/api/settings/route"),
      import("@/app/api/stats/route"),
    ]);

    liveDatabaseIdentity = await resetVerifiedIntegrationDatabase(
      prisma,
      requiredDatabaseIdentity(),
    );

    installationCredentialForRequest = createInstallationCredential({
      encryptionSecret: requiredEncryptionSecret(),
      origin: EXTENSION_ORIGIN,
    });
    await prisma.extensionInstallation.create({
      data: {
        id: installationCredentialForRequest.selector,
        origin: EXTENSION_ORIGIN,
        tokenDigest: installationCredentialForRequest.digest,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  });

  afterAll(async () => {
    if (prisma) {
      try {
        if (installationCredentialForRequest) {
          await prisma.extensionInstallation.deleteMany({
            where: { id: installationCredentialForRequest.selector },
          });
        }
        await resetVerifiedIntegrationDatabase(
          prisma,
          requiredDatabaseIdentity(),
        );
      } finally {
        await prisma.$disconnect();
      }
    }
  });

  it("preflights the live PostgreSQL identity before destructive mutations", () => {
    expect(liveDatabaseIdentity).toEqual({
      database: requiredDatabaseIdentity().database,
      address: requiredDatabaseIdentity().serverAddress,
      port: requiredDatabaseIdentity().port,
      schema: "public",
    });
  });

  it("enforces exact CORS and authentication before database access", async () => {
    const unauthorized = await applications.GET(
      request("/api/applications", { origin: EXTENSION_ORIGIN }),
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("access-control-allow-origin")).toBe(
      EXTENSION_ORIGIN,
    );

    const rootBearerDenied = await applications.GET(
      request("/api/applications", {
        origin: EXTENSION_ORIGIN,
        auth: "root",
      }),
    );
    expect(rootBearerDenied.status).toBe(401);

    const denied = await applications.GET(
      request("/api/applications", {
        origin: "https://attacker.test",
        auth: "root",
      }),
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("persists authenticated CRUD and reports real statistics", async () => {
    const createdResponse = await applications.POST(
      request("/api/applications", {
        method: "POST",
        origin: EXTENSION_ORIGIN,
        auth: "installation",
        json: {
          url: "https://example.test/jobs/ci-fixture",
          jobTitle: "CI Engineer",
          company: "Fixture Labs",
          status: "Applied",
          location: "Remote",
        },
      }),
    );
    expect(createdResponse.status).toBe(201);
    expect(createdResponse.headers.get("access-control-allow-origin")).toBe(
      EXTENSION_ORIGIN,
    );
    const created = (await createdResponse.json()) as { id: string };

    const listResponse = await applications.GET(
      request("/api/applications", { auth: "root" }),
    );
    const list = (await listResponse.json()) as Array<{ id: string }>;
    expect(list.map(({ id }) => id)).toContain(created.id);

    const updatedResponse = await applicationDetail.PATCH(
      request(`/api/applications/${created.id}`, {
        method: "PATCH",
        origin: APP_ORIGIN,
        auth: "root",
        json: { status: "Interview", notes: "CI fixture" },
      }),
      detailContext(created.id),
    );
    expect(updatedResponse.status).toBe(200);
    await expect(updatedResponse.json()).resolves.toMatchObject({
      id: created.id,
      status: "Interview",
      notes: "CI fixture",
    });

    const statsResponse = await stats.GET(
      request("/api/stats", { auth: "root" }),
    );
    await expect(statsResponse.json()).resolves.toMatchObject({
      total: 1,
      interview: 1,
    });

    const deletedResponse = await applicationDetail.DELETE(
      request(`/api/applications/${created.id}`, {
        method: "DELETE",
        origin: APP_ORIGIN,
        auth: "root",
      }),
      detailContext(created.id),
    );
    expect(deletedResponse.status).toBe(200);
    await expect(deletedResponse.json()).resolves.toEqual({ success: true });
  });

  it("creates one row for 20 concurrent identical POSTs without mutating retries", async () => {
    const version = await prisma.$queryRawUnsafe<Array<{ server_version_num: string }>>(
      "SHOW server_version_num",
    );
    expect(Number(version[0]?.server_version_num)).toBeGreaterThanOrEqual(170_000);
    expect(Number(version[0]?.server_version_num)).toBeLessThan(180_000);
    await prisma.application.deleteMany();
    const payload = {
      url: "https://example.test/jobs/concurrent?utm_source=ci&job=42",
      jobTitle: "Concurrency Engineer",
      company: "Fixture Labs",
      status: "Applied",
      notes: "Original notes",
    };

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        applications.POST(
          request("/api/applications", {
            method: "POST",
            origin: APP_ORIGIN,
            auth: "root",
            json: payload,
          }),
        ),
      ),
    );
    const bodies = await Promise.all(responses.map((response) => response.json()));

    expect(responses.filter(({ status }) => status === 201)).toHaveLength(1);
    expect(responses.filter(({ status }) => status === 200)).toHaveLength(19);
    expect(bodies.filter(({ result }) => result === "created")).toHaveLength(1);
    expect(bodies.filter(({ result }) => result === "existing")).toHaveLength(19);
    expect(new Set(bodies.map(({ id }) => id)).size).toBe(1);

    const retry = await applications.POST(
      request("/api/applications", {
        method: "POST",
        origin: APP_ORIGIN,
        auth: "root",
        json: { ...payload, status: "Offer", notes: "Replacement notes" },
      }),
    );
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ result: "existing" });

    const stored = await prisma.application.findMany({
      where: { canonicalUrl: "https://example.test/jobs/concurrent?job=42" },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ status: "Applied", notes: "Original notes" });
    await prisma.application.deleteMany();
  });

  it("backfills legacy rows losslessly and idempotently with private reports", async () => {
    await prisma.application.deleteMany();
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const winnerId = "00000000-0000-4000-8000-000000000001";
    const duplicateId = "00000000-0000-4000-8000-000000000002";
    const unresolvedId = "00000000-0000-4000-8000-000000000003";
    await prisma.application.createMany({
      data: [
        {
          id: duplicateId,
          url: "https://example.test/jobs/legacy?utm_source=feed",
          jobTitle: "Private duplicate title",
          company: "Private duplicate company",
          createdAt,
        },
        {
          id: winnerId,
          url: "https://example.test/jobs/legacy",
          jobTitle: "Private winner title",
          company: "Private winner company",
          createdAt,
        },
        {
          id: unresolvedId,
          url: "legacy invalid url",
          jobTitle: "Private unresolved title",
          company: "Private unresolved company",
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
        },
      ],
    });
    const directory = await mkdtemp(join(tmpdir(), "application-backfill-integration-"));
    const dryRunPath = join(directory, "dry-run.json");
    const applyPath = join(directory, "apply.json");
    const rerunPath = join(directory, "rerun.json");

    expect((await runBackfill(["--report", dryRunPath])).code).toBe(0);
    expect((await runBackfill(["--apply", "--writers-stopped", "--report", applyPath])).code).toBe(0);
    expect((await runBackfill(["--apply", "--writers-stopped", "--report", rerunPath])).code).toBe(0);

    const stored = await prisma.application.findMany({ orderBy: { id: "asc" } });
    expect(stored).toHaveLength(3);
    expect(stored[0]).toMatchObject({
      id: winnerId,
      identityState: "canonical",
      canonicalUrl: "https://example.test/jobs/legacy",
      duplicateOfId: null,
    });
    expect(stored[0].identityKey).toMatch(/^url-v1:[0-9a-f]{64}$/u);
    expect(stored[1]).toMatchObject({
      id: duplicateId,
      identityState: "legacy_duplicate",
      identityKey: null,
      canonicalUrl: "https://example.test/jobs/legacy",
      duplicateOfId: winnerId,
    });
    expect(stored[2]).toMatchObject({
      id: unresolvedId,
      identityState: "legacy_unresolved",
      identityKey: null,
      canonicalUrl: null,
      duplicateOfId: null,
    });
    const protectedDelete = await applicationDetail.DELETE(
      request(`/api/applications/${winnerId}`, {
        method: "DELETE",
        origin: APP_ORIGIN,
        auth: "root",
      }),
      detailContext(winnerId),
    );
    expect(protectedDelete.status).toBe(409);
    await expect(protectedDelete.json()).resolves.toMatchObject({
      code: "identity_has_duplicates",
    });
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Application" SET "identityKey" = NULL, "duplicateOfId" = "id", "identityState" = 'legacy_duplicate' WHERE "id" = '${winnerId}'`,
      ),
    ).rejects.toBeDefined();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Application" SET "identityState" = 'unknown' WHERE "id" = '${unresolvedId}'`,
      ),
    ).rejects.toBeDefined();

    const reportText = await readFile(applyPath, "utf8");
    expect((await stat(applyPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(reportText)).toMatchObject({
      rowCountBefore: 3,
      rowCountAfter: 3,
      stateTotals: { canonical: 1, legacy_duplicate: 1, legacy_unresolved: 1 },
      uniqueIndexVerified: true,
    });
    for (const privateValue of [
      winnerId,
      duplicateId,
      unresolvedId,
      "https://example.test/jobs/legacy",
      "Private winner title",
      process.env.DATABASE_URL ?? "postgresql://",
    ]) {
      expect(reportText).not.toContain(privateValue);
    }
    await prisma.application.deleteMany();
  });

  it("persists settings and accepts the signed web session", async () => {
    const settingsResponse = await settings.PUT(
      request("/api/settings", {
        method: "PUT",
        origin: APP_ORIGIN,
        auth: "root",
        json: {
          llmProvider: "openai",
          apiKey: "disposable-ci-provider-key",
          linkedinUrl: "https://www.linkedin.com/in/ci-fixture",
          resumeText: "TypeScript PostgreSQL security",
        },
      }),
    );
    expect(settingsResponse.status).toBe(200);
    await expect(settingsResponse.json()).resolves.toMatchObject({
      hasApiKey: true,
      resumeText: "TypeScript PostgreSQL security",
    });

    const loginResponse = await authSession.POST(
      request("/api/auth/session", {
        method: "POST",
        origin: APP_ORIGIN,
        json: { token: accessToken() },
      }),
    );
    expect(loginResponse.status).toBe(200);
    const cookie = loginResponse.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeDefined();

    const readResponse = await settings.GET(
      request("/api/settings?includeResume=true", { cookie }),
    );
    expect(readResponse.status).toBe(200);
    await expect(readResponse.json()).resolves.toMatchObject({
      hasApiKey: true,
      linkedinUrl: "https://www.linkedin.com/in/ci-fixture",
      resumeText: "TypeScript PostgreSQL security",
    });
  });

  it("extracts a deterministic fetched job through the real route parser", async () => {
    const response = await extract.POST(
      request("/api/extract", {
        method: "POST",
        origin: EXTENSION_ORIGIN,
        auth: "installation",
        json: { url: "https://jobs.example.test/open-role" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      EXTENSION_ORIGIN,
    );
    await expect(response.json()).resolves.toEqual({
      jobTitle: "Platform Engineer",
      company: "Fixture Careers",
      location: "",
      url: "https://jobs.example.test/open-role",
    });
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("matches keywords from resume text stored in the real database", async () => {
    await prisma.settings.upsert({
      where: { id: "singleton" },
      update: { resumeText: "TypeScript PostgreSQL security" },
      create: {
        id: "singleton",
        resumeText: "TypeScript PostgreSQL security",
      },
    });

    const response = await keywordAnalysis.POST(
      request("/api/keyword-analysis", {
        method: "POST",
        origin: APP_ORIGIN,
        auth: "root",
        json: { description: "TypeScript PostgreSQL AWS" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      matchPercentage: 67,
      totalJobKeywords: 3,
      matchedKeywords: [
        { keyword: "TypeScript", category: "Programming Languages" },
        { keyword: "PostgreSQL", category: "Databases" },
      ],
      missingKeywords: [{ keyword: "AWS", category: "Cloud & DevOps" }],
    });
  });

  it("parses a real small text multipart upload", async () => {
    const form = new FormData();
    form.append(
      "resume",
      new Blob(["TypeScript\nPostgreSQL\nSecurity"], { type: "text/plain" }),
      "resume.txt",
    );

    const response = await parseResume.POST(
      new NextRequest(`${APP_ORIGIN}/api/parse-resume`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken()}`,
          Origin: APP_ORIGIN,
        },
        body: form,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      text: "TypeScript\nPostgreSQL\nSecurity",
    });
  });

  it("parses a generated small PDF multipart upload", async () => {
    const form = new FormData();
    form.append(
      "resume",
      new Blob([new Uint8Array(generatedPdf(["PDF Resume"]))], {
        type: "application/pdf",
      }),
      "resume.pdf",
    );

    const response = await parseResume.POST(
      new NextRequest(`${APP_ORIGIN}/api/parse-resume`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken()}`,
          Origin: APP_ORIGIN,
        },
        body: form,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: "PDF Resume" });
  });

  it("rejects representative SSRF and oversized resume inputs offline", async () => {
    const ssrfResponse = await extract.POST(
      request("/api/extract", {
        method: "POST",
        origin: APP_ORIGIN,
        auth: "root",
        json: { url: "http://127.0.0.1/internal" },
      }),
    );
    expect(ssrfResponse.status).toBe(422);
    await expect(ssrfResponse.json()).resolves.toMatchObject({
      code: "url_not_allowed",
    });

    const resumeResponse = await parseResume.POST(
      new NextRequest(`${APP_ORIGIN}/api/parse-resume`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken()}`,
          Origin: APP_ORIGIN,
          "Content-Type": "multipart/form-data; boundary=ci-boundary",
          "Content-Length": String(6 * 1024 * 1024 + 1),
        },
        body: new Uint8Array([0]),
      }),
    );
    expect(resumeResponse.status).toBe(413);
    await expect(resumeResponse.json()).resolves.toMatchObject({
      code: "upload_too_large",
    });
  });
});

function request(
  path: string,
  options: Readonly<{
    method?: string;
    origin?: string;
    auth?: "root" | "installation";
    cookie?: string;
    json?: unknown;
  }> = {},
): NextRequest {
  const headers = new Headers();
  if (options.origin) headers.set("Origin", options.origin);
  if (options.auth === "root") {
    headers.set("Authorization", `Bearer ${accessToken()}`);
  } else if (options.auth === "installation") {
    headers.set("Authorization", `Bearer ${installationToken()}`);
  }
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.json !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  return new NextRequest(`${APP_ORIGIN}${path}`, {
    method: options.method ?? "GET",
    headers,
    body:
      options.json === undefined ? undefined : JSON.stringify(options.json),
  });
}

function accessToken(): string {
  return process.env.APP_ACCESS_TOKEN ?? "";
}

function requiredEncryptionSecret(): string {
  const value = process.env.ENCRYPTION_SECRET;
  if (!value) throw new Error("ENCRYPTION_SECRET is required");
  return value;
}

function installationToken(): string {
  if (!installationCredentialForRequest) {
    throw new Error("Installation credential was not seeded");
  }
  return installationCredentialForRequest.token;
}

function requiredDatabaseIdentity() {
  if (DATABASE_TEST_IDENTITY === undefined) {
    throw new Error("Database integration identity was not validated");
  }
  return DATABASE_TEST_IDENTITY;
}

function detailContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function runBackfill(args: readonly string[]): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, [
    join(process.cwd(), "scripts/backfill-application-identities.mjs"),
    ...args,
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const [code] = (await once(child, "close")) as [number | null];
  return { code, stdout, stderr };
}
