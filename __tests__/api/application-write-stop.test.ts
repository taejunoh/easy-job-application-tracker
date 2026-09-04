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
});
