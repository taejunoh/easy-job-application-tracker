import { NextRequest } from "next/server";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { Prisma } from "@prisma/client";

import * as applicationsRoute from "@/app/api/applications/route";
import * as applicationDetailRoute from "@/app/api/applications/[id]/route";
import * as extractRoute from "@/app/api/extract/route";
import * as keywordAnalysisRoute from "@/app/api/keyword-analysis/route";
import * as parseResumeRoute from "@/app/api/parse-resume/route";
import * as settingsRoute from "@/app/api/settings/route";
import * as statsRoute from "@/app/api/stats/route";
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
} from "@/lib/security/auth";
import { createProtectedRoute } from "@/lib/security/protected-route";

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
      CORS_ALLOWED_ORIGINS:
        "https://jobs.example.com,chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    },
    "production",
  );

  return { ...actual, getServerEnv: () => config };
});

jest.mock("@/lib/prisma", () => ({
  prisma: {
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

jest.mock("@/lib/extract/meta-parser", () => ({
  parseMetaTags: jest.fn(),
}));

jest.mock("@/lib/extract/llm-provider", () => ({
  createProvider: jest.fn(() => ({ extract: jest.fn() })),
}));

jest.mock("@/lib/security/safe-fetch", () => {
  const actual = jest.requireActual<typeof import("@/lib/security/safe-fetch")>(
    "@/lib/security/safe-fetch",
  );
  return { ...actual, safeFetchJobUrl: jest.fn() };
});

jest.mock("@/lib/keyword-matcher", () => ({
  analyzeKeywordMatch: jest.fn(),
}));

jest.mock("@/lib/resume/pdf-worker-client", () => ({
  parsePdfInWorker: jest.fn(),
}));

jest.mock("@/lib/crypto", () => ({
  decrypt: jest.fn(() => "decrypted-key"),
  encrypt: jest.fn((value: string) => `encrypted:${value}`),
}));

import { prisma } from "@/lib/prisma";
import { createProvider } from "@/lib/extract/llm-provider";
import { parseMetaTags } from "@/lib/extract/meta-parser";
import { analyzeKeywordMatch } from "@/lib/keyword-matcher";
import {
  SafeFetchError,
  safeFetchJobUrl,
  type SafeFetchErrorCode,
} from "@/lib/security/safe-fetch";
import { parsePdfInWorker } from "@/lib/resume/pdf-worker-client";

const APP_ORIGIN = "https://jobs.example.com";
const EXTENSION_ORIGIN =
  "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const UNKNOWN_ORIGIN = "https://evil.example.com";
const ACCESS_TOKEN = "access-token-" + "a".repeat(32);
const SESSION_COOKIE = `${SESSION_COOKIE_NAME}=${createSessionToken()}`;

type RouteContext = { params: Promise<{ id: string }> };
type RouteHandler = (
  request: NextRequest,
  context?: RouteContext,
) => Response | Promise<Response>;
type RouteModule = Record<string, unknown>;

type ActualRouteCase = Readonly<{
  name: string;
  pathname: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  module: RouteModule;
  body?: "json" | "resume";
  successStatus: number;
  context?: () => RouteContext;
}>;

type PreflightCase = Readonly<{
  name: string;
  pathname: string;
  module: RouteModule;
  requestMethod: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  allowedMethods: string;
}>;

const actualRoutes: readonly ActualRouteCase[] = [
  {
    name: "applications GET",
    pathname: "/api/applications",
    method: "GET",
    module: applicationsRoute,
    successStatus: 200,
  },
  {
    name: "applications POST",
    pathname: "/api/applications",
    method: "POST",
    module: applicationsRoute,
    body: "json",
    successStatus: 201,
  },
  {
    name: "application detail GET",
    pathname: "/api/applications/app-1",
    method: "GET",
    module: applicationDetailRoute,
    successStatus: 200,
    context: detailContext,
  },
  {
    name: "application detail PATCH",
    pathname: "/api/applications/app-1",
    method: "PATCH",
    module: applicationDetailRoute,
    body: "json",
    successStatus: 200,
    context: detailContext,
  },
  {
    name: "application detail DELETE",
    pathname: "/api/applications/app-1",
    method: "DELETE",
    module: applicationDetailRoute,
    successStatus: 200,
    context: detailContext,
  },
  {
    name: "extract POST",
    pathname: "/api/extract",
    method: "POST",
    module: extractRoute,
    body: "json",
    successStatus: 200,
  },
  {
    name: "keyword analysis POST",
    pathname: "/api/keyword-analysis",
    method: "POST",
    module: keywordAnalysisRoute,
    body: "json",
    successStatus: 200,
  },
  {
    name: "parse resume POST",
    pathname: "/api/parse-resume",
    method: "POST",
    module: parseResumeRoute,
    body: "resume",
    successStatus: 200,
  },
  {
    name: "settings GET",
    pathname: "/api/settings?includeResume=true",
    method: "GET",
    module: settingsRoute,
    successStatus: 200,
  },
  {
    name: "settings PUT",
    pathname: "/api/settings",
    method: "PUT",
    module: settingsRoute,
    body: "json",
    successStatus: 200,
  },
  {
    name: "stats GET",
    pathname: "/api/stats",
    method: "GET",
    module: statsRoute,
    successStatus: 200,
  },
] as const;

const preflightRoutes: readonly PreflightCase[] = [
  {
    name: "applications OPTIONS",
    pathname: "/api/applications",
    module: applicationsRoute,
    requestMethod: "POST",
    allowedMethods: "GET, HEAD, POST",
  },
  {
    name: "application detail OPTIONS",
    pathname: "/api/applications/app-1",
    module: applicationDetailRoute,
    requestMethod: "PATCH",
    allowedMethods: "GET, HEAD, PATCH, DELETE",
  },
  {
    name: "extract OPTIONS",
    pathname: "/api/extract",
    module: extractRoute,
    requestMethod: "POST",
    allowedMethods: "POST",
  },
  {
    name: "keyword analysis OPTIONS",
    pathname: "/api/keyword-analysis",
    module: keywordAnalysisRoute,
    requestMethod: "POST",
    allowedMethods: "POST",
  },
  {
    name: "parse resume OPTIONS",
    pathname: "/api/parse-resume",
    module: parseResumeRoute,
    requestMethod: "POST",
    allowedMethods: "POST",
  },
  {
    name: "settings OPTIONS",
    pathname: "/api/settings",
    module: settingsRoute,
    requestMethod: "PUT",
    allowedMethods: "GET, HEAD, PUT",
  },
  {
    name: "stats OPTIONS",
    pathname: "/api/stats",
    module: statsRoute,
    requestMethod: "GET",
    allowedMethods: "GET, HEAD",
  },
] as const;

describe("protected product API actual requests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    arrangeSuccessfulBusinessLogic();
  });

  it.each(actualRoutes)(
    "$name returns 401 before request parsing or downstream work",
    async (route) => {
      const request = productRequest(route);
      const jsonSpy = jest.spyOn(request, "json");
      const formDataSpy = jest.spyOn(request, "formData");

      const response = await invokeActual(route, request);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "Authentication required",
        code: "unauthorized",
      });
      expect(jsonSpy).not.toHaveBeenCalled();
      expect(formDataSpy).not.toHaveBeenCalled();
      expectNoDownstreamWork();
    },
  );

  it.each(actualRoutes)(
    "$name rejects an unknown Origin with 403 before authentication or work",
    async (route) => {
      const response = await invokeActual(
        route,
        productRequest(route, { origin: UNKNOWN_ORIGIN }),
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Origin not allowed",
        code: "origin_not_allowed",
      });
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expectNoDownstreamWork();
    },
  );

  it.each(actualRoutes)(
    "$name exposes its anonymous 401 to the exact allowed extension Origin",
    async (route) => {
      const response = await invokeActual(
        route,
        productRequest(route, { origin: EXTENSION_ORIGIN }),
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "Authentication required",
        code: "unauthorized",
      });
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        EXTENSION_ORIGIN,
      );
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
      expect(response.headers.get("Vary")).toContain("Origin");
      expectNoDownstreamWork();
    },
  );

  it.each(actualRoutes)(
    "$name lets a valid extension Bearer request reach business logic",
    async (route) => {
      const response = await invokeActual(
        route,
        productRequest(route, {
          origin: EXTENSION_ORIGIN,
          authorization: `Bearer ${ACCESS_TOKEN}`,
        }),
      );

      expect(response.status).toBe(route.successStatus);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        EXTENSION_ORIGIN,
      );
      expectAnyDownstreamWork(route);
    },
  );

  it.each(actualRoutes)(
    "$name lets a valid same-origin web session reach business logic",
    async (route) => {
      const response = await invokeActual(
        route,
        productRequest(route, {
          origin: APP_ORIGIN,
          cookie: SESSION_COOKIE,
        }),
      );

      expect(response.status).toBe(route.successStatus);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        APP_ORIGIN,
      );
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
        "true",
      );
      expectAnyDownstreamWork(route);
    },
  );

  it.each([
    ["Bearer", { authorization: `Bearer ${ACCESS_TOKEN}` }],
    ["web session", { cookie: SESSION_COOKIE }],
  ])(
    "allows an authenticated %s GET without Origin and omits allow-origin",
    async (_name, authentication) => {
      const route = actualRoutes[0];
      const response = await invokeActual(
        route,
        productRequest(route, authentication),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(prisma.application.findMany).toHaveBeenCalled();
    },
  );

  it("decorates a handler-owned error for an allowed extension Origin", async () => {
    const route = actualRoutes.find(
      ({ name }) => name === "applications POST",
    ) as ActualRouteCase;
    const request = productRequest(route, {
      origin: EXTENSION_ORIGIN,
      authorization: `Bearer ${ACCESS_TOKEN}`,
    });
    jest.spyOn(request, "json").mockResolvedValue({});

    const response = await invokeActual(route, request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "url, jobTitle, and company are required",
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      EXTENSION_ORIGIN,
    );
  });

  it("converts an unexpected handler error to a stable, non-leaking response", async () => {
    const route = actualRoutes.find(
      ({ name }) => name === "stats GET",
    ) as ActualRouteCase;
    jest
      .mocked(prisma.application.count)
      .mockRejectedValueOnce(new Error("database password leaked"));
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await invokeActual(
      route,
      productRequest(route, {
        origin: EXTENSION_ORIGIN,
        authorization: `Bearer ${ACCESS_TOKEN}`,
      }),
    );

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: "Internal server error",
      code: "internal_error",
    });
    expect(text).not.toContain("database password leaked");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      EXTENSION_ORIGIN,
    );
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it.each([
    [
      "applications POST",
      () =>
        jest
          .mocked(prisma.application.create)
          .mockRejectedValueOnce(new Error("database detail")),
    ],
    [
      "extract POST",
      () =>
        jest
          .mocked(safeFetchJobUrl)
          .mockRejectedValueOnce(new Error("network detail")),
    ],
  ])(
    "normalizes an internally caught %s failure to internal_error",
    async (name, arrangeFailure) => {
      const route = actualRoutes.find(
        (candidate) => candidate.name === name,
      ) as ActualRouteCase;
      arrangeFailure();
      const consoleError = jest
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const response = await invokeActual(
        route,
        productRequest(route, {
          origin: EXTENSION_ORIGIN,
          authorization: `Bearer ${ACCESS_TOKEN}`,
        }),
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: "Internal server error",
        code: "internal_error",
      });
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        EXTENSION_ORIGIN,
      );
      consoleError.mockRestore();
    },
  );

  it.each([
    ["url_not_allowed", 422],
    ["upstream_timeout", 504],
    ["unsupported_upstream_type", 415],
    ["upstream_too_large", 413],
    ["upstream_failed", 422],
  ] as [SafeFetchErrorCode, number][])(
    "maps safe fetch failure %s without leaking upstream details",
    async (code, status) => {
      const route = actualRoutes.find(
        (candidate) => candidate.name === "extract POST",
      ) as ActualRouteCase;
      jest.mocked(safeFetchJobUrl).mockRejectedValueOnce(new SafeFetchError(code));

      const response = await invokeActual(
        route,
        productRequest(route, {
          origin: EXTENSION_ORIGIN,
          authorization: `Bearer ${ACCESS_TOKEN}`,
        }),
      );

      expect(response.status).toBe(status);
      const payload = await response.json();
      expect(payload).toEqual({ error: expect.any(String), code });
      expect(JSON.stringify(payload)).not.toContain("93.184.216.34");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        EXTENSION_ORIGIN,
      );
    },
  );

  it.each([
    ["ASCII", "a".repeat(4_001), "a".repeat(4_000)],
    [
      "surrogate pair boundary",
      `${"a".repeat(3_999)}😀b`,
      `${"a".repeat(3_999)}😀`,
    ],
  ])(
    "limits URL extraction LLM fallback to 4,000 Unicode code points for %s",
    async (_caseName, extractedText, expectedText) => {
      const route = actualRoutes.find(
        (candidate) => candidate.name === "extract POST",
      ) as ActualRouteCase;
      const extract = jest.fn().mockResolvedValue({
        jobTitle: "Engineer",
        company: "Example",
      });
      jest.mocked(createProvider).mockReturnValue({ extract });
      jest.mocked(parseMetaTags).mockReturnValue({
        jobTitle: null,
        company: null,
        location: null,
      });
      jest.mocked(safeFetchJobUrl).mockResolvedValue({
        html: `<main>${extractedText}</main>`,
        finalUrl: "https://example.com/jobs/1",
      });

      const response = await invokeActual(
        route,
        productRequest(route, {
          origin: EXTENSION_ORIGIN,
          authorization: `Bearer ${ACCESS_TOKEN}`,
        }),
      );

      expect(response.status).toBe(200);
      expect(extract).toHaveBeenCalledWith(expectedText);
      expect(Array.from(extract.mock.calls[0][0])).toHaveLength(4_000);
    },
  );

  it.each([
    ["redirect", () => redirect("/connect"), "NEXT_REDIRECT"],
    [
      "permanentRedirect",
      () => permanentRedirect("/connect"),
      "NEXT_REDIRECT",
    ],
    ["notFound", () => notFound(), "NEXT_HTTP_ERROR_FALLBACK;404"],
  ])(
    "rethrows the framework control flow from %s",
    async (_name, frameworkControlFlow, expectedDigest) => {
      const handler = createProtectedRoute(["GET"]).handler(
        async function frameworkHandler() {
          frameworkControlFlow();
          return new Response("unreachable");
        },
      );
      const consoleError = jest
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      await expect(
        handler(
          new NextRequest("https://jobs.example.com/api/framework", {
            headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
          }),
        ),
      ).rejects.toMatchObject({
        digest: expect.stringContaining(expectedDigest),
      });
      expect(consoleError).not.toHaveBeenCalled();
      consoleError.mockRestore();
    },
  );

  it.each(
    actualRoutes.filter((route) => route.body === "json"),
  )("$name returns invalid_request for authenticated malformed JSON", async (route) => {
    const request = new NextRequest(
      `https://jobs.example.com${route.pathname}`,
      {
        method: route.method,
        headers: {
          Origin: EXTENSION_ORIGIN,
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: "{",
      },
    );
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await invokeActual(route, request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid request",
      code: "invalid_request",
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      EXTENSION_ORIGIN,
    );
    expectNoDownstreamWork();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("parse resume returns invalid_request for authenticated malformed multipart", async () => {
    const route = actualRoutes.find(
      ({ name }) => name === "parse resume POST",
    ) as ActualRouteCase;
    const request = new NextRequest(
      "https://jobs.example.com/api/parse-resume",
      {
        method: "POST",
        headers: {
          Origin: EXTENSION_ORIGIN,
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "multipart/form-data",
        },
        body: "not-multipart",
      },
    );
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await invokeActual(route, request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid request",
      code: "invalid_request",
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      EXTENSION_ORIGIN,
    );
    expectNoDownstreamWork();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("parse resume is explicitly pinned to the Node.js runtime", () => {
    expect(parseResumeRoute.runtime).toBe("nodejs");
  });

  it("parse resume streams authenticated multipart data without formData buffering", async () => {
    const form = new FormData();
    form.set(
      "resume",
      new File(["%PDF-1.7"], "resume.pdf", { type: "application/pdf" }),
    );
    const request = authenticatedResumeRequest(form);
    const formData = jest.spyOn(request, "formData");

    const response = await parseResumeRoute.POST(request);

    expect(response.status).toBe(200);
    expect(formData).not.toHaveBeenCalled();
  });

  it.each([
    [
      "upload_too_large",
      413,
      () =>
        authenticatedResumeRequest(new FormData(), {
          "Content-Length": String(6 * 1024 * 1024 + 1),
        }),
    ],
    [
      "unsupported_resume_type",
      415,
      () => {
        const form = new FormData();
        form.set(
          "resume",
          new File(["not a pdf"], "resume.pdf", { type: "application/pdf" }),
        );
        return authenticatedResumeRequest(form);
      },
    ],
  ])("parse resume maps %s to %i", async (code, status, requestFactory) => {
    const response = await parseResumeRoute.POST(requestFactory());

    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({
      error: expect.any(String),
      code,
    });
  });

  it("parse resume maps corrupt PDFs to resume_parse_failed", async () => {
    jest
      .mocked(parsePdfInWorker)
      .mockRejectedValueOnce(new Error("private parser detail"));
    const form = new FormData();
    form.set(
      "resume",
      new File(["%PDF-corrupt"], "resume.pdf", { type: "application/pdf" }),
    );

    const response = await parseResumeRoute.POST(authenticatedResumeRequest(form));

    expect(response.status).toBe(422);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: expect.any(String),
      code: "resume_parse_failed",
    });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(text).not.toContain("private parser detail");
  });

  it("settings rejects resumeText above 500,000 Unicode code points", async () => {
    const request = new NextRequest("https://jobs.example.com/api/settings", {
      method: "PUT",
      headers: {
        Origin: EXTENSION_ORIGIN,
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ resumeText: `${"a".repeat(500_000)}😀` }),
    });

    const response = await settingsRoute.PUT(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid request",
      code: "invalid_request",
    });
    expect(prisma.settings.findFirst).not.toHaveBeenCalled();
  });

  it("settings accepts exactly 500,000 Unicode code points", async () => {
    const request = authenticatedSettingsRequest(
      JSON.stringify({ resumeText: `${"a".repeat(499_999)}😀` }),
    );

    const response = await settingsRoute.PUT(request);

    expect(response.status).toBe(200);
    expect(prisma.settings.findFirst).toHaveBeenCalled();
  });

  it.each([
    ["without Content-Length", undefined],
    ["with a lying Content-Length", "1"],
  ])(
    "settings rejects an actual JSON envelope above 6 MiB %s",
    async (_name, contentLength) => {
      const body = jsonEnvelopeOfSize(6 * 1024 * 1024 + 1);
      const response = await settingsRoute.PUT(
        authenticatedSettingsRequest(body, contentLength),
      );

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({
        error: "Request too large",
        code: "request_too_large",
      });
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect(prisma.settings.findFirst).not.toHaveBeenCalled();
    },
  );

  it("settings accepts an actual JSON envelope exactly at 6 MiB", async () => {
    const response = await settingsRoute.PUT(
      authenticatedSettingsRequest(jsonEnvelopeOfSize(6 * 1024 * 1024)),
    );

    expect(response.status).toBe(200);
    expect(prisma.settings.findFirst).toHaveBeenCalled();
  });

  it("settings rejects an oversized stream without awaiting reader cancellation", async () => {
    const cancel = jest.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6 * 1024 * 1024 + 1));
      },
      cancel,
    });
    const request = authenticatedSettingsStreamRequest(body);

    const outcome = await settleResponseWithin(settingsRoute.PUT(request), 200);

    expect(outcome.status).toBe("resolved");
    if (outcome.status !== "resolved") return;
    expect(outcome.response.status).toBe(413);
    expect(outcome.response.headers.get("Cache-Control")).toContain("no-store");
    expect(cancel).toHaveBeenCalled();
    expect(prisma.settings.findFirst).not.toHaveBeenCalled();
  });

  it.each(["application detail PATCH", "application detail DELETE"])(
    "%s maps Prisma P2025 to the existing 404",
    async (name) => {
      const route = actualRoutes.find(
        (candidate) => candidate.name === name,
      ) as ActualRouteCase;
      const operation =
        route.method === "PATCH"
          ? prisma.application.update
          : prisma.application.delete;
      jest.mocked(operation).mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("missing", {
          code: "P2025",
          clientVersion: "7.6.0",
        }) as never,
      );

      const response = await invokeActual(
        route,
        productRequest(route, {
          origin: EXTENSION_ORIGIN,
          authorization: `Bearer ${ACCESS_TOKEN}`,
        }),
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: "Application not found",
      });
    },
  );

  it.each(["application detail PATCH", "application detail DELETE"])(
    "%s rethrows a generic database error for stable internal_error mapping",
    async (name) => {
      const route = actualRoutes.find(
        (candidate) => candidate.name === name,
      ) as ActualRouteCase;
      const operation =
        route.method === "PATCH"
          ? prisma.application.update
          : prisma.application.delete;
      jest
        .mocked(operation)
        .mockRejectedValueOnce(new Error("database connection detail") as never);
      const consoleError = jest
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const response = await invokeActual(
        route,
        productRequest(route, {
          origin: EXTENSION_ORIGIN,
          authorization: `Bearer ${ACCESS_TOKEN}`,
        }),
      );

      expect(response.status).toBe(500);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({
        error: "Internal server error",
        code: "internal_error",
      });
      expect(text).not.toContain("database connection detail");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        EXTENSION_ORIGIN,
      );
      consoleError.mockRestore();
    },
  );
});

describe("protected product API preflights", () => {
  it.each(preflightRoutes)(
    "$name succeeds without authentication for its exact extension Origin",
    async (route) => {
      const response = await invokeOptions(
        route,
        preflightRequest(route, EXTENSION_ORIGIN),
      );

      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        EXTENSION_ORIGIN,
      );
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
        route.allowedMethods,
      );
      expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
        "Authorization, Content-Type",
      );
    },
  );

  it.each(preflightRoutes)("$name rejects an unknown Origin", async (route) => {
    const response = await invokeOptions(
      route,
      preflightRequest(route, UNKNOWN_ORIGIN),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Origin not allowed",
      code: "origin_not_allowed",
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

function detailContext(): RouteContext {
  return { params: Promise.resolve({ id: "app-1" }) };
}

function productRequest(
  route: ActualRouteCase,
  authentication: {
    origin?: string;
    authorization?: string;
    cookie?: string;
  } = {},
): NextRequest {
  const headers = new Headers();
  if (authentication.origin !== undefined) {
    headers.set("Origin", authentication.origin);
  }
  if (authentication.authorization !== undefined) {
    headers.set("Authorization", authentication.authorization);
  }
  if (authentication.cookie !== undefined) {
    headers.set("Cookie", authentication.cookie);
  }

  let body: BodyInit | undefined;
  if (route.body === "json") {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(jsonBody(route));
  } else if (route.body === "resume") {
    const form = new FormData();
    form.set(
      "resume",
      new File(["%PDF-resume pdf"], "resume.pdf", { type: "application/pdf" }),
    );
    body = form;
  }

  return new NextRequest(`https://jobs.example.com${route.pathname}`, {
    method: route.method,
    headers,
    body,
  });
}

function authenticatedResumeRequest(
  form: FormData,
  extraHeaders?: HeadersInit,
): NextRequest {
  const headers = new Headers(extraHeaders);
  headers.set("Origin", EXTENSION_ORIGIN);
  headers.set("Authorization", `Bearer ${ACCESS_TOKEN}`);
  return new NextRequest("https://jobs.example.com/api/parse-resume", {
    method: "POST",
    headers,
    body: form,
  });
}

function authenticatedSettingsRequest(
  body: string,
  contentLength?: string,
): NextRequest {
  const headers = new Headers({
    Origin: EXTENSION_ORIGIN,
    Authorization: `Bearer ${ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  });
  if (contentLength !== undefined) headers.set("Content-Length", contentLength);
  return new NextRequest("https://jobs.example.com/api/settings", {
    method: "PUT",
    headers,
    body,
  });
}

function authenticatedSettingsStreamRequest(
  body: ReadableStream<Uint8Array>,
): NextRequest {
  return new NextRequest("https://jobs.example.com/api/settings", {
    method: "PUT",
    headers: {
      Origin: EXTENSION_ORIGIN,
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body,
    duplex: "half",
  } as never);
}

function jsonEnvelopeOfSize(byteLength: number): string {
  const prefix = '{"padding":"';
  const suffix = '"}';
  return `${prefix}${"x".repeat(byteLength - prefix.length - suffix.length)}${suffix}`;
}

async function settleResponseWithin(
  promise: Promise<Response>,
  timeoutMs: number,
): Promise<
  | { status: "resolved"; response: Response }
  | { status: "rejected"; reason: unknown }
  | { status: "pending" }
> {
  return Promise.race([
    promise.then(
      (response) => ({ status: "resolved" as const, response }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    ),
    new Promise<{ status: "pending" }>((resolve) => {
      setTimeout(() => resolve({ status: "pending" }), timeoutMs);
    }),
  ]);
}

function jsonBody(route: ActualRouteCase): Record<string, string> {
  switch (route.name) {
    case "applications POST":
      return {
        url: "https://example.com/jobs/1",
        jobTitle: "Engineer",
        company: "Example",
      };
    case "application detail PATCH":
      return { status: "Interview" };
    case "extract POST":
      return { url: "https://example.com/jobs/1" };
    case "keyword analysis POST":
      return { description: "TypeScript and PostgreSQL" };
    case "settings PUT":
      return { llmProvider: "openai" };
    default:
      return {};
  }
}

function preflightRequest(route: PreflightCase, origin: string): NextRequest {
  return new NextRequest(`https://jobs.example.com${route.pathname}`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": route.requestMethod,
      "Access-Control-Request-Headers": "Authorization, Content-Type",
    },
  });
}

async function invokeActual(
  route: ActualRouteCase,
  request: NextRequest,
): Promise<Response> {
  const handler = route.module[route.method];
  expect(handler).toEqual(expect.any(Function));
  return (handler as RouteHandler)(request, route.context?.());
}

async function invokeOptions(
  route: PreflightCase,
  request: NextRequest,
): Promise<Response> {
  const handler = route.module.OPTIONS;
  expect(handler).toEqual(expect.any(Function));
  return (handler as RouteHandler)(request);
}

function arrangeSuccessfulBusinessLogic(): void {
  const application = {
    id: "app-1",
    url: "https://example.com/jobs/1",
    jobTitle: "Engineer",
    company: "Example",
    status: "Applied",
  };
  jest.mocked(prisma.application.findMany).mockResolvedValue([]);
  jest.mocked(prisma.application.findUnique).mockResolvedValue(application as never);
  jest.mocked(prisma.application.create).mockResolvedValue(application as never);
  jest.mocked(prisma.application.update).mockResolvedValue(application as never);
  jest.mocked(prisma.application.delete).mockResolvedValue(application as never);
  jest.mocked(prisma.application.count).mockResolvedValue(0);

  const settings = {
    id: "singleton",
    llmProvider: "openai",
    apiKey: "encrypted-key",
    linkedinUrl: "",
    githubUrl: "",
    resumeText: "TypeScript PostgreSQL",
  };
  jest.mocked(prisma.settings.findFirst).mockResolvedValue(settings as never);
  jest.mocked(prisma.settings.create).mockResolvedValue(settings as never);
  jest.mocked(prisma.settings.update).mockResolvedValue(settings as never);

  jest.mocked(parseMetaTags).mockReturnValue({
    jobTitle: "Engineer",
    company: "Example",
    location: "Remote",
  });
  jest.mocked(createProvider).mockReturnValue({
    extract: jest.fn().mockResolvedValue({
      jobTitle: "Engineer",
      company: "Example",
    }),
  });
  jest.mocked(analyzeKeywordMatch).mockReturnValue({
    matchPercentage: 100,
    matchedKeywords: [],
    missingKeywords: [],
    totalJobKeywords: 0,
  });
  jest.mocked(safeFetchJobUrl).mockResolvedValue({
    html: "<html><title>Engineer</title></html>",
    finalUrl: "https://example.com/jobs/1",
  });
  jest.mocked(parsePdfInWorker).mockResolvedValue("resume text");
}

function expectNoDownstreamWork(): void {
  for (const mock of downstreamMocks()) {
    expect(mock).not.toHaveBeenCalled();
  }
}

function expectAnyDownstreamWork(route: ActualRouteCase): void {
  const expected = expectedDownstream(route);
  expect(expected).toHaveBeenCalled();
}

function expectedDownstream(route: ActualRouteCase): jest.Mock {
  switch (route.name) {
    case "applications GET":
      return jest.mocked(prisma.application.findMany);
    case "applications POST":
      return jest.mocked(prisma.application.create);
    case "application detail GET":
      return jest.mocked(prisma.application.findUnique);
    case "application detail PATCH":
      return jest.mocked(prisma.application.update);
    case "application detail DELETE":
      return jest.mocked(prisma.application.delete);
    case "extract POST":
      return jest.mocked(safeFetchJobUrl);
    case "keyword analysis POST":
      return jest.mocked(analyzeKeywordMatch);
    case "parse resume POST":
      return jest.mocked(parsePdfInWorker);
    case "settings GET":
    case "settings PUT":
      return jest.mocked(prisma.settings.findFirst);
    case "stats GET":
      return jest.mocked(prisma.application.count);
    default:
      throw new Error(`Unhandled route: ${route.name}`);
  }
}

function downstreamMocks(): jest.Mock[] {
  return [
    jest.mocked(prisma.application.findMany),
    jest.mocked(prisma.application.findUnique),
    jest.mocked(prisma.application.create),
    jest.mocked(prisma.application.update),
    jest.mocked(prisma.application.delete),
    jest.mocked(prisma.application.count),
    jest.mocked(prisma.settings.findFirst),
    jest.mocked(prisma.settings.create),
    jest.mocked(prisma.settings.update),
    jest.mocked(parseMetaTags),
    jest.mocked(createProvider),
    jest.mocked(analyzeKeywordMatch),
    jest.mocked(safeFetchJobUrl),
    jest.mocked(parsePdfInWorker),
  ];
}
