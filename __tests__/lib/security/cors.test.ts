import {
  CORS_PREFLIGHT_MAX_AGE_SECONDS,
  corsHeaders,
  corsPreflight,
  decorateCorsResponse,
  type CorsAllowed,
} from "@/lib/security/cors";

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

const APP_ORIGIN = "https://jobs.example.com";
const EXTENSION_ORIGIN =
  "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

describe("corsHeaders", () => {
  it("allows the exact configured application origin with credentials", () => {
    const result = corsHeaders(actualRequest(APP_ORIGIN), ["GET", "POST"]);
    const allowed = expectAllowed(result);

    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(
      APP_ORIGIN,
    );
    expect(allowed.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true",
    );
    expect(allowed.headers.get("Vary")).toBe("Origin");
    expectActualHeadersOnly(allowed.headers);
    expectNoWildcard(allowed.headers);
  });

  it("allows the exact configured extension origin without credentials", () => {
    const result = corsHeaders(
      actualRequest(EXTENSION_ORIGIN, "POST"),
      ["POST"],
    );
    const allowed = expectAllowed(result);

    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(
      EXTENSION_ORIGIN,
    );
    expect(allowed.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(allowed.headers.get("Vary")).toBe("Origin");
    expectActualHeadersOnly(allowed.headers);
    expectNoWildcard(allowed.headers);
  });

  it.each([
    ["unknown", "https://evil.example.com"],
    ["opaque null", "null"],
    ["allowed-origin prefix", `${APP_ORIGIN}.evil.example`],
    ["allowed-origin suffix", `https://evil${new URL(APP_ORIGIN).hostname}`],
    ["subdomain", "https://api.jobs.example.com"],
    ["lookalike", "https://jobs-example.com"],
    ["path suffix", `${APP_ORIGIN}/api`],
  ])("rejects a present %s origin by exact comparison", async (_, origin) => {
    const result = corsHeaders(actualRequest(origin), ["GET"]);

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      throw new Error("Expected CORS rejection");
    }
    expect(result.response.status).toBe(403);
    await expect(result.response.json()).resolves.toEqual({
      error: "Origin not allowed",
      code: "origin_not_allowed",
    });
    expect(result.response.headers.get("Vary")).toBe("Origin");
    expect(result.response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expectNoWildcard(result.response.headers);
  });

  it("lets an actual request without Origin continue without allow-origin", () => {
    const result = corsHeaders(actualRequest(), ["GET"]);
    const allowed = expectAllowed(result);

    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(allowed.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(allowed.headers.get("Vary")).toBe("Origin");
    expectActualHeadersOnly(allowed.headers);
  });

  it("normalizes declared methods to uppercase and removes duplicates", () => {
    const result = corsHeaders(actualRequest(APP_ORIGIN, "DELETE"), [
      "get",
      "DELETE",
      "GET",
    ]);

    expect(expectAllowed(result).headers.get("Access-Control-Allow-Origin")).toBe(
      APP_ORIGIN,
    );
  });

  it("allows implicit HEAD when a Route Handler declares GET", () => {
    const result = corsHeaders(actualRequest(APP_ORIGIN, "HEAD"), ["GET"]);

    expect(result.allowed).toBe(true);
  });

  it("rejects an actual request whose method was not declared", async () => {
    const result = corsHeaders(actualRequest(APP_ORIGIN, "PATCH"), [
      "GET",
      "POST",
    ]);

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      throw new Error("Expected CORS rejection");
    }
    expect(result.response.status).toBe(403);
    await expect(result.response.json()).resolves.toEqual({
      error: "Origin not allowed",
      code: "origin_not_allowed",
    });
  });

  it.each([
    [[]],
    [[""]],
    [["GET,POST"]],
    [["GET POST"]],
    [["*"]],
    [["TRACE"]],
    [["CONNECT"]],
    [["CUSTOM"]],
  ])("throws for an invalid declared method list %j", (methods) => {
    expect(() => corsHeaders(actualRequest(APP_ORIGIN), methods)).toThrow(
      "Invalid CORS method policy",
    );
  });

  it("returns the rejection before guarded business logic runs", async () => {
    const businessLogic = jest.fn(() => Response.json({ ok: true }));

    const response = guardedActualResponse(
      actualRequest("https://evil.example.com"),
      businessLogic,
    );

    expect(businessLogic).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Origin not allowed",
      code: "origin_not_allowed",
    });
  });
});

describe("decorateCorsResponse", () => {
  it("adds allowed-origin headers on a new response without mutating the handler response", async () => {
    const allowed = expectAllowed(
      corsHeaders(actualRequest(APP_ORIGIN), ["GET"]),
    );
    const response = new Response("ok", {
      headers: { Vary: "Accept-Encoding, origin", "X-Result": "preserved" },
    });

    const decorated = decorateCorsResponse(response, allowed);

    expect(decorated).not.toBe(response);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(decorated.headers.get("Vary")).toBe("Accept-Encoding, origin");
    expect(decorated.headers.get("Access-Control-Allow-Origin")).toBe(
      APP_ORIGIN,
    );
    expect(decorated.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true",
    );
    expect(decorated.headers.get("X-Result")).toBe("preserved");
    await expect(decorated.text()).resolves.toBe("ok");
    await expect(response.text()).resolves.toBe("ok");
  });

  it("preserves CORS headers on an allowed-origin error response", async () => {
    const allowed = expectAllowed(
      corsHeaders(actualRequest(EXTENSION_ORIGIN, "POST"), ["POST"]),
    );
    const response = Response.json(
      { error: "Invalid request", code: "invalid_request" },
      { status: 422 },
    );

    const decorated = decorateCorsResponse(response, allowed);

    expect(decorated.status).toBe(422);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(decorated.headers.get("Access-Control-Allow-Origin")).toBe(
      EXTENSION_ORIGIN,
    );
    expect(decorated.headers.get("Vary")).toBe("Origin");
    await expect(decorated.json()).resolves.toEqual({
      error: "Invalid request",
      code: "invalid_request",
    });
  });

  it("appends Origin when Vary does not already contain it", () => {
    const allowed = expectAllowed(
      corsHeaders(actualRequest(EXTENSION_ORIGIN), ["GET"]),
    );
    const response = new Response(null, {
      headers: { Vary: "Accept-Encoding" },
    });

    const decorated = decorateCorsResponse(response, allowed);

    expect(decorated.headers.get("Vary")).toBe("Accept-Encoding, Origin");
  });

  it.each([
    ["extension", actualRequest(EXTENSION_ORIGIN), EXTENSION_ORIGIN, null],
    ["application", actualRequest(APP_ORIGIN), APP_ORIGIN, "true"],
    ["origin-absent", actualRequest(), null, null],
  ])(
    "clears stale managed CORS headers for an %s response",
    (_, request, expectedOrigin, expectedCredentials) => {
      const allowed = expectAllowed(corsHeaders(request, ["GET"]));
      const response = new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "https://stale.example.com",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "PUT, DELETE",
          "Access-Control-Allow-Headers": "X-Stale",
          "Access-Control-Max-Age": "999999",
        },
      });

      const decorated = decorateCorsResponse(response, allowed);

      expect(decorated.headers.get("Access-Control-Allow-Origin")).toBe(
        expectedOrigin,
      );
      expect(decorated.headers.get("Access-Control-Allow-Credentials")).toBe(
        expectedCredentials,
      );
      expect(decorated.headers.get("Access-Control-Allow-Methods")).toBeNull();
      expect(decorated.headers.get("Access-Control-Allow-Headers")).toBeNull();
      expect(decorated.headers.get("Access-Control-Max-Age")).toBeNull();
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://stale.example.com",
      );
    },
  );

  it("preserves a wildcard Vary value instead of appending Origin", () => {
    const allowed = expectAllowed(
      corsHeaders(actualRequest(APP_ORIGIN), ["GET"]),
    );
    const response = new Response(null, { headers: { Vary: "Accept, *" } });

    const decorated = decorateCorsResponse(response, allowed);

    expect(decorated.headers.get("Vary")).toBe("*");
  });

  it("decorates a native immutable redirect while preserving redirect metadata", () => {
    const allowed = expectAllowed(
      corsHeaders(actualRequest(EXTENSION_ORIGIN), ["GET"]),
    );
    const response = Response.redirect("https://jobs.example.com/connect", 307);

    const decorated = decorateCorsResponse(response, allowed);

    expect(decorated).not.toBe(response);
    expect(decorated.status).toBe(307);
    expect(decorated.statusText).toBe(response.statusText);
    expect(decorated.headers.get("Location")).toBe(
      "https://jobs.example.com/connect",
    );
    expect(decorated.headers.get("Access-Control-Allow-Origin")).toBe(
      EXTENSION_ORIGIN,
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("decorates an immutable fetched response while preserving its body and headers", async () => {
    const allowed = expectAllowed(
      corsHeaders(actualRequest(EXTENSION_ORIGIN), ["GET"]),
    );
    const response = await fetch("data:text/plain;charset=utf-8,immutable-body");

    expect(() => response.headers.set("X-Test", "blocked")).toThrow();
    const decorated = decorateCorsResponse(response, allowed);

    expect(decorated.status).toBe(response.status);
    expect(decorated.statusText).toBe(response.statusText);
    expect(decorated.headers.get("Content-Type")).toBe(
      "text/plain;charset=utf-8",
    );
    expect(decorated.headers.get("Access-Control-Allow-Origin")).toBe(
      EXTENSION_ORIGIN,
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    await expect(response.text()).resolves.toBe("immutable-body");
    await expect(decorated.text()).resolves.toBe("immutable-body");
  });

  it("preserves multiple Set-Cookie values when reconstructing a response", () => {
    const allowed = expectAllowed(
      corsHeaders(actualRequest(APP_ORIGIN), ["GET"]),
    );
    const headers = new Headers({ "X-Result": "preserved" });
    headers.append("Set-Cookie", "first=one; Path=/");
    headers.append("Set-Cookie", "second=two; Path=/");
    const response = new Response(null, {
      status: 201,
      statusText: "Created",
      headers,
    });

    const decorated = decorateCorsResponse(response, allowed);

    expect(decorated.status).toBe(201);
    expect(decorated.statusText).toBe("Created");
    expect(decorated.headers.getSetCookie()).toEqual([
      "first=one; Path=/",
      "second=two; Path=/",
    ]);
    expect(decorated.headers.get("X-Result")).toBe("preserved");
  });
});

describe("corsPreflight", () => {
  it("allows an exact extension origin with only caller-specified methods", () => {
    const response = corsPreflight(preflightRequest(EXTENSION_ORIGIN, "POST"), [
      "get",
      "POST",
      "GET",
    ]);

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      EXTENSION_ORIGIN,
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, HEAD, POST",
    );
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
      "Authorization, Content-Type",
    );
    expect(response.headers.get("Access-Control-Max-Age")).toBe(
      String(CORS_PREFLIGHT_MAX_AGE_SECONDS),
    );
    expect(CORS_PREFLIGHT_MAX_AGE_SECONDS).toBe(600);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(response.headers.get("Vary")).toBe(
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    );
    expectNoWildcard(response.headers);
  });

  it("allows the application origin with credentials", () => {
    const response = corsPreflight(preflightRequest(APP_ORIGIN, "DELETE"), [
      "DELETE",
    ]);

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      APP_ORIGIN,
    );
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true",
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "DELETE",
    );
  });

  it.each([
    ["unknown", "https://evil.example.com"],
    ["opaque null", "null"],
    ["missing", undefined],
  ])("rejects a %s preflight without allow headers", async (_, origin) => {
    const response = corsPreflight(preflightRequest(origin, "POST"), [
      "POST",
    ]);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Origin not allowed",
      code: "origin_not_allowed",
    });
    expect(response.headers.get("Vary")).toBe(
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Methods")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Headers")).toBeNull();
    expect(response.headers.get("Access-Control-Max-Age")).toBeNull();
    expectNoWildcard(response.headers);
  });

  it.each([
    ["non-OPTIONS request", "POST", "POST"],
    ["missing requested method", "OPTIONS", undefined],
    ["empty requested method", "OPTIONS", ""],
    ["duplicate requested method", "OPTIONS", "POST, POST"],
    ["malformed requested method", "OPTIONS", "POST DELETE"],
    ["undeclared requested method", "OPTIONS", "DELETE"],
  ])(
    "rejects a %s",
    async (_, requestMethod, requestedMethod) => {
      const response = corsPreflight(
        preflightRequest(
          APP_ORIGIN,
          requestedMethod,
          "authorization, content-type",
          requestMethod,
        ),
        ["POST"],
      );

      await expectRejectedPreflight(response);
    },
  );

  it.each([
    ["empty", ""],
    ["empty member", "Authorization,,Content-Type"],
    ["duplicate", "Authorization, authorization"],
    ["malformed", "Authorization Content-Type"],
    ["unsupported", "X-Admin"],
  ])("rejects %s requested headers", async (_, requestedHeaders) => {
    const response = corsPreflight(
      preflightRequest(APP_ORIGIN, "POST", requestedHeaders),
      ["POST"],
    );

    await expectRejectedPreflight(response);
  });

  it("accepts supported requested headers case-insensitively", () => {
    const response = corsPreflight(
      preflightRequest(
        EXTENSION_ORIGIN,
        "post",
        "authorization, CONTENT-TYPE",
      ),
      ["POST"],
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
      "Authorization, Content-Type",
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST");
  });

  it("accepts a preflight without optional requested headers", () => {
    const response = corsPreflight(
      preflightRequest(EXTENSION_ORIGIN, "GET", null),
      ["GET"],
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, HEAD",
    );
  });

  it("accepts HEAD through the implicit GET policy", () => {
    const response = corsPreflight(
      preflightRequest(EXTENSION_ORIGIN, "HEAD", null),
      ["GET"],
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, HEAD",
    );
  });

  it("never emits a wildcard from an invalid declared method", () => {
    expect(() =>
      corsPreflight(preflightRequest(APP_ORIGIN, "POST"), ["*"]),
    ).toThrow("Invalid CORS method policy");
  });
});

function actualRequest(origin?: string, method = "GET"): Request {
  return new Request("https://jobs.example.com/api/applications", {
    method,
    headers: origin === undefined ? undefined : { Origin: origin },
  });
}

function preflightRequest(
  origin: string | undefined,
  requestedMethod: string | undefined,
  requestedHeaders: string | null = "authorization, content-type",
  requestMethod = "OPTIONS",
): Request {
  return new Request("https://jobs.example.com/api/applications", {
    method: requestMethod,
    headers: {
      ...(origin === undefined ? {} : { Origin: origin }),
      ...(requestedMethod === undefined
        ? {}
        : { "Access-Control-Request-Method": requestedMethod }),
      ...(requestedHeaders === null
        ? {}
        : { "Access-Control-Request-Headers": requestedHeaders }),
    },
  });
}

function expectAllowed(
  result: ReturnType<typeof corsHeaders>,
): CorsAllowed {
  expect(result.allowed).toBe(true);
  if (!result.allowed) {
    throw new Error("Expected CORS allowance");
  }
  return result;
}

function expectActualHeadersOnly(headers: Headers): void {
  expect(headers.get("Access-Control-Allow-Methods")).toBeNull();
  expect(headers.get("Access-Control-Allow-Headers")).toBeNull();
  expect(headers.get("Access-Control-Max-Age")).toBeNull();
}

function expectNoWildcard(headers: Headers): void {
  for (const value of headers.values()) {
    expect(value).not.toContain("*");
  }
}

function guardedActualResponse(
  request: Request,
  businessLogic: () => Response,
): Response {
  const cors = corsHeaders(request, ["GET"]);
  if (!cors.allowed) {
    return cors.response;
  }

  return decorateCorsResponse(businessLogic(), cors);
}

async function expectRejectedPreflight(response: Response): Promise<void> {
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toEqual({
    error: "Origin not allowed",
    code: "origin_not_allowed",
  });
  expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  expect(response.headers.get("Access-Control-Allow-Methods")).toBeNull();
  expect(response.headers.get("Access-Control-Allow-Headers")).toBeNull();
  expect(response.headers.get("Access-Control-Max-Age")).toBeNull();
  expect(response.headers.get("Vary")).toBe(
    "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
  );
}
