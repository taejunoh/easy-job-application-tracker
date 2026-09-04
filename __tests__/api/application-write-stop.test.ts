import { NextRequest } from "next/server";

import * as applicationsRoute from "@/app/api/applications/route";
import * as applicationDetailRoute from "@/app/api/applications/[id]/route";
import * as settingsRoute from "@/app/api/settings/route";
import { prisma } from "@/lib/prisma";
import { getServerEnv } from "@/lib/server-env";
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
} from "@/lib/security/auth";
import { parseCreateApplicationRequest, parseUpdateApplicationRequest } from "@/lib/applications/contract";
import { readBoundedJsonBody } from "@/lib/security/request-body";
import { encrypt } from "@/lib/crypto";

jest.mock("@/lib/server-env", () => {
  const actual = jest.requireActual<typeof import("@/lib/server-env")>(
    "@/lib/server-env",
  );
  const config = actual.parseServerEnv(
    {
      DATABASE_URL: "postgresql://user:password@db.example.com:5432/jobtracker",
      ENCRYPTION_SECRET: "encryption-secret-" + "e".repeat(32),
      APP_ACCESS_TOKEN: "access-token-" + "a".repeat(32),
      APP_BASE_URL: "https://jobs.example.com",
      CORS_ALLOWED_ORIGINS: "https://jobs.example.com",
      APPLICATION_WRITES_ENABLED: "0",
      APPLICATION_IDENTITY_WRITES_ENABLED: "1",
    },
    "production",
  );

  return { ...actual, getServerEnv: jest.fn(() => config) };
});

jest.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: jest.fn(),
    application: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    settings: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    },
  },
}));

jest.mock("@/lib/applications/contract", () => {
  const actual = jest.requireActual<typeof import("@/lib/applications/contract")>(
    "@/lib/applications/contract",
  );
  return {
    ...actual,
    parseCreateApplicationRequest: jest.fn(actual.parseCreateApplicationRequest),
    parseUpdateApplicationRequest: jest.fn(actual.parseUpdateApplicationRequest),
  };
});

jest.mock("@/lib/security/request-body", () => {
  const actual = jest.requireActual<typeof import("@/lib/security/request-body")>(
    "@/lib/security/request-body",
  );
  return {
    ...actual,
    readBoundedJsonBody: jest.fn(actual.readBoundedJsonBody),
  };
});

jest.mock("@/lib/crypto", () => ({
  encrypt: jest.fn((value: string) => `encrypted:${value}`),
}));

const APP_ORIGIN = "https://jobs.example.com";
const APPLICATION_ID = "018f9f72-f2e9-7c29-a6fc-001122334455";
const SESSION_COOKIE = `${SESSION_COOKIE_NAME}=${createSessionToken()}`;
const BASE_ENV = getServerEnv();

type RouteContext = { params: Promise<{ id: string }> };
type RouteHandler = (
  request: NextRequest,
  context?: RouteContext,
) => Response | Promise<Response>;

function applicationPostRequest(): NextRequest {
  return new NextRequest(`${APP_ORIGIN}/api/applications`, {
    method: "POST",
    headers: {
      Origin: APP_ORIGIN,
      Cookie: SESSION_COOKIE,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: "https://example.com/jobs/1",
      jobTitle: "Engineer",
      company: "Example",
    }),
  });
}

function applicationPatchRequest(): NextRequest {
  return new NextRequest(`${APP_ORIGIN}/api/applications/${APPLICATION_ID}`, {
    method: "PATCH",
    headers: {
      Origin: APP_ORIGIN,
      Cookie: SESSION_COOKIE,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status: "Interview" }),
  });
}

function applicationDeleteRequest(): NextRequest {
  return new NextRequest(`${APP_ORIGIN}/api/applications/${APPLICATION_ID}`, {
    method: "DELETE",
    headers: { Origin: APP_ORIGIN, Cookie: SESSION_COOKIE },
  });
}

function settingsPutRequest(): NextRequest {
  return new NextRequest(`${APP_ORIGIN}/api/settings`, {
    method: "PUT",
    headers: {
      Origin: APP_ORIGIN,
      Cookie: SESSION_COOKIE,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ llmProvider: "openai" }),
  });
}

const webMutationCases = [
  ["application create", applicationsRoute.POST, applicationPostRequest(), prisma.$queryRaw],
  ["application update", applicationDetailRoute.PATCH, applicationPatchRequest(), prisma.application.update],
  ["application delete", applicationDetailRoute.DELETE, applicationDeleteRequest(), prisma.application.delete],
  ["settings update", settingsRoute.PUT, settingsPutRequest(), prisma.settings.findFirst],
] as const;

describe("application write stop for web mutations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getServerEnv).mockReturnValue({
      ...BASE_ENV,
      applicationWritesEnabled: false,
    });
  });

  it.each(webMutationCases)(
    "%s returns the stable stop response before parsing or persistence",
    async (name, handler, request, _persistence) => {
      const response = await (handler as RouteHandler)(
        request,
        name === "application update" || name === "application delete"
          ? { params: Promise.resolve({ id: APPLICATION_ID }) }
          : undefined,
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "Application writes are temporarily disabled",
        code: "writes_stopped",
        retryable: true,
      });
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("Pragma")).toBe("no-cache");
      expect(response.headers.get("Retry-After")).toBe("60");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
      expect(_persistence).not.toHaveBeenCalled();

      for (const mock of [
        prisma.$queryRaw,
        prisma.application.findMany,
        prisma.application.findUnique,
        prisma.application.create,
        prisma.application.update,
        prisma.application.delete,
        prisma.application.count,
        prisma.settings.findFirst,
        prisma.settings.create,
        prisma.settings.update,
        prisma.settings.upsert,
        parseCreateApplicationRequest,
        parseUpdateApplicationRequest,
        readBoundedJsonBody,
        encrypt,
      ]) {
        expect(mock).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps missing Settings GET read-only with nullable defaults", async () => {
    jest.mocked(prisma.settings.findFirst).mockResolvedValue(null);

    const response = await settingsRoute.GET(
      new NextRequest(`${APP_ORIGIN}/api/settings`, {
        headers: { Origin: APP_ORIGIN, Cookie: SESSION_COOKIE },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      llmProvider: "openai",
      hasApiKey: false,
      linkedinUrl: "",
      githubUrl: "",
    });
    expect(prisma.settings.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.settings.create).not.toHaveBeenCalled();
  });

  it("returns an empty resume field when includeResume is requested without Settings", async () => {
    jest.mocked(prisma.settings.findFirst).mockResolvedValue(null);

    const response = await settingsRoute.GET(
      new NextRequest(`${APP_ORIGIN}/api/settings?includeResume=true`, {
        headers: { Origin: APP_ORIGIN, Cookie: SESSION_COOKIE },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      llmProvider: "openai",
      hasApiKey: false,
      linkedinUrl: "",
      githubUrl: "",
      resumeText: "",
    });
    expect(prisma.settings.create).not.toHaveBeenCalled();
  });

  it("uses atomic upsert for simultaneous pristine Settings PUTs", async () => {
    jest.mocked(getServerEnv).mockReturnValue({
      ...BASE_ENV,
      applicationWritesEnabled: true,
    });
    jest
      .mocked(prisma.settings.upsert)
      .mockResolvedValue(settingsFixture() as never);

    const [first, second] = await Promise.all([
      settingsRoute.PUT(settingsPutRequest()),
      settingsRoute.PUT(settingsPutRequest()),
    ]);

    for (const response of [first, second]) {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        llmProvider: "openai",
        hasApiKey: true,
      });
    }
    expect(prisma.settings.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.settings.upsert).toHaveBeenCalledWith({
      where: { id: "singleton" },
      create: { llmProvider: "openai", id: "singleton" },
      update: { llmProvider: "openai" },
    });
    expect(prisma.settings.findFirst).not.toHaveBeenCalled();
    expect(prisma.settings.create).not.toHaveBeenCalled();
    expect(prisma.settings.update).not.toHaveBeenCalled();
  });

  describe("persistence-time write rechecks", () => {
    it.each([
      ["legacy Application POST", false],
      ["identity Application POST", true],
    ])("stops %s before persistence", async (name, identityWritesEnabled) => {
      const getEnvCalls = configurePersistenceRecheck(identityWritesEnabled);
      jest.mocked(prisma.application.create).mockResolvedValue({} as never);

      const response = await applicationsRoute.POST(applicationPostRequest());

      await expectStopped(response);
      expect(parseCreateApplicationRequest).toHaveBeenCalledTimes(1);
      expect(getEnvCalls()).toBe(6);
      expect(prisma.application.create).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it("stops Application PATCH before update", async () => {
      const getEnvCalls = configurePersistenceRecheck();

      const response = await applicationDetailRoute.PATCH(
        applicationPatchRequest(),
        { params: Promise.resolve({ id: APPLICATION_ID }) },
      );

      await expectStopped(response);
      expect(parseUpdateApplicationRequest).toHaveBeenCalledTimes(1);
      expect(getEnvCalls()).toBe(5);
      expect(prisma.application.update).not.toHaveBeenCalled();
    });

    it("stops Application DELETE before delete", async () => {
      const getEnvCalls = configurePersistenceRecheck();

      const response = await applicationDetailRoute.DELETE(
        applicationDeleteRequest(),
        { params: Promise.resolve({ id: APPLICATION_ID }) },
      );

      await expectStopped(response);
      expect(getEnvCalls()).toBe(5);
      expect(prisma.application.delete).not.toHaveBeenCalled();
      expect(prisma.application.count).not.toHaveBeenCalled();
    });

    it.each([
      ["pristine/create", null],
      ["existing/update", settingsFixture()],
    ])(
      "stops Settings PUT %s semantics before atomic upsert",
      async (_name, existingSettings) => {
        const getEnvCalls = configurePersistenceRecheck();
        jest
          .mocked(prisma.settings.findFirst)
          .mockResolvedValue(existingSettings as never);

        const response = await settingsRoute.PUT(settingsPutRequest());

        await expectStopped(response);
        expect(readBoundedJsonBody).toHaveBeenCalledTimes(1);
        expect(getEnvCalls()).toBe(5);
        expect(prisma.settings.findFirst).not.toHaveBeenCalled();
        expect(prisma.settings.upsert).not.toHaveBeenCalled();
      },
    );
  });
});

function settingsFixture() {
  return {
    id: "singleton",
    llmProvider: "openai",
    apiKey: "encrypted-key",
    linkedinUrl: "",
    githubUrl: "",
    resumeText: "",
  };
}

function configurePersistenceRecheck(
  applicationIdentityWritesEnabled?: boolean,
): () => number {
  const enabled = {
    ...BASE_ENV,
    applicationWritesEnabled: true,
    ...(applicationIdentityWritesEnabled === undefined
      ? {}
      : { applicationIdentityWritesEnabled }),
  };
  const disabled = { ...enabled, applicationWritesEnabled: false };
  let calls = 0;
  jest.mocked(getServerEnv).mockImplementation(() => {
    calls += 1;
    if (calls <= 4) return enabled;
    if (applicationIdentityWritesEnabled !== undefined && calls === 5) {
      return enabled;
    }
    return disabled;
  });
  return () => calls;
}

async function expectStopped(response: Response): Promise<void> {
  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({
    error: "Application writes are temporarily disabled",
    code: "writes_stopped",
    retryable: true,
  });
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Pragma")).toBe("no-cache");
  expect(response.headers.get("Retry-After")).toBe("60");
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
}
