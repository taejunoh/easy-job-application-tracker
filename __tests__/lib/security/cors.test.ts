import {
  CORS_PREFLIGHT_MAX_AGE_SECONDS,
  corsHeaders,
  corsPreflight,
  decorateCorsResponse,
  type CorsAllowed,
  type CorsConfig,
  type CorsMethod,
} from "@/lib/security/cors";

const APP_ORIGIN = "https://jobs.example.com";
const EXTENSION_ORIGIN =
  "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

const config: CorsConfig = {
  appOrigin: APP_ORIGIN,
  corsAllowedOrigins: [APP_ORIGIN, EXTENSION_ORIGIN],
};

describe("corsHeaders", () => {
  it("allows the exact configured application origin with credentials", () => {
    const result = corsHeaders(actualRequest(APP_ORIGIN), ["GET", "POST"], {
      config,
    });
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
    const result = corsHeaders(actualRequest(EXTENSION_ORIGIN), ["POST"], {
      config,
    });
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
    const result = corsHeaders(actualRequest(origin), ["GET"], { config });

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
    const result = corsHeaders(actualRequest(), ["GET"], { config });
    const allowed = expectAllowed(result);

    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(allowed.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(allowed.headers.get("Vary")).toBe("Origin");
    expectActualHeadersOnly(allowed.headers);
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
  it("adds allowed-origin headers while merging Vary without duplicates", () => {
    const allowed = expectAllowed(
      corsHeaders(actualRequest(APP_ORIGIN), ["GET"], { config }),
    );
    const response = new Response("ok", {
      headers: { Vary: "Accept-Encoding, origin", "X-Result": "preserved" },
    });

    const decorated = decorateCorsResponse(response, allowed);

    expect(decorated).toBe(response);
    expect(decorated.headers.get("Vary")).toBe("Accept-Encoding, origin");
    expect(decorated.headers.get("Access-Control-Allow-Origin")).toBe(
      APP_ORIGIN,
    );
    expect(decorated.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true",
    );
    expect(decorated.headers.get("X-Result")).toBe("preserved");
  });

  it("preserves CORS headers on an allowed-origin error response", async () => {
    const allowed = expectAllowed(
      corsHeaders(actualRequest(EXTENSION_ORIGIN), ["POST"], { config }),
    );
    const response = Response.json(
      { error: "Invalid request", code: "invalid_request" },
      { status: 422 },
    );

    decorateCorsResponse(response, allowed);

    expect(response.status).toBe(422);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      EXTENSION_ORIGIN,
    );
    expect(response.headers.get("Vary")).toBe("Origin");
    await expect(response.json()).resolves.toEqual({
      error: "Invalid request",
      code: "invalid_request",
    });
  });

  it("appends Origin when Vary does not already contain it", () => {
    const allowed = expectAllowed(
      corsHeaders(actualRequest(EXTENSION_ORIGIN), ["GET"], { config }),
    );
    const response = new Response(null, {
      headers: { Vary: "Accept-Encoding" },
    });

    decorateCorsResponse(response, allowed);

    expect(response.headers.get("Vary")).toBe("Accept-Encoding, Origin");
  });
});

describe("corsPreflight", () => {
  it("allows an exact extension origin with only caller-specified methods", () => {
    const response = corsPreflight(preflightRequest(EXTENSION_ORIGIN, "POST"), [
      "GET",
      "POST",
    ], { config });

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      EXTENSION_ORIGIN,
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST",
    );
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
      "Authorization, Content-Type",
    );
    expect(response.headers.get("Access-Control-Max-Age")).toBe(
      String(CORS_PREFLIGHT_MAX_AGE_SECONDS),
    );
    expect(CORS_PREFLIGHT_MAX_AGE_SECONDS).toBe(600);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(response.headers.get("Vary")).toBe("Origin");
    expectNoWildcard(response.headers);
  });

  it("allows the application origin with credentials", () => {
    const response = corsPreflight(preflightRequest(APP_ORIGIN, "DELETE"), [
      "DELETE",
    ], { config });

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
    ], { config });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Origin not allowed",
      code: "origin_not_allowed",
    });
    expect(response.headers.get("Vary")).toBe("Origin");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Methods")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Headers")).toBeNull();
    expect(response.headers.get("Access-Control-Max-Age")).toBeNull();
    expectNoWildcard(response.headers);
  });

  it("never emits a wildcard even when passed an invalid runtime method", () => {
    expect(() =>
      corsPreflight(preflightRequest(APP_ORIGIN, "POST"), [
        "*" as CorsMethod,
      ], { config }),
    ).toThrow("Unsupported CORS method");
  });
});

function actualRequest(origin?: string): Request {
  return new Request("https://jobs.example.com/api/applications", {
    method: "POST",
    headers: origin === undefined ? undefined : { Origin: origin },
  });
}

function preflightRequest(origin: string | undefined, method: string): Request {
  return new Request("https://jobs.example.com/api/applications", {
    method: "OPTIONS",
    headers: {
      ...(origin === undefined ? {} : { Origin: origin }),
      "Access-Control-Request-Method": method,
      "Access-Control-Request-Headers": "authorization, content-type",
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
  const cors = corsHeaders(request, ["POST"], { config });
  if (!cors.allowed) {
    return cors.response;
  }

  return decorateCorsResponse(businessLogic(), cors);
}
