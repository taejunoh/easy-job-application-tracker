import { createServer, type RequestListener, type Server } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";

const root = join(__dirname, "../..");
const script = join(root, "scripts/check-production-writes-stopped.mjs");
const secretToken = "writes-stop-monitor-token-never-print";
const secretBody = "synthetic-response-secret-never-print";
const redirectLocation = "http://redirect.example.test/leak";

const validRecentApplication = {
  id: "application-1",
  url: "https://jobs.example.test/1",
  jobTitle: "Engineer",
  company: "Example",
  status: "Applied",
  appliedDate: "2026-07-14T12:00:00.000Z",
  description: null,
  notes: "Follow up",
  salary: null,
  location: "Remote",
  jobType: "Full-time",
  createdAt: "2026-07-14T12:00:00.000Z",
  updatedAt: "2026-07-14T12:00:00.000Z",
};

const validStats = {
  total: 7,
  applied: 2,
  interview: 1,
  offer: 1,
  rejected: 3,
  weeklyCount: 4,
  monthlyCount: 7,
  recentApplications: [validRecentApplication],
};

type MonitorResult = Readonly<{
  code: number | null;
  stdout: string;
  stderr: string;
}>;

async function listen(
  handler: RequestListener,
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
}

async function runMonitor(
  url: string,
  timeoutMs?: string,
  token = secretToken,
): Promise<MonitorResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, PRODUCTION_APP_URL: url };
  if (token === "") delete env.PRODUCTION_APP_ACCESS_TOKEN;
  else env.PRODUCTION_APP_ACCESS_TOKEN = token;
  if (timeoutMs === undefined) delete env.PRODUCTION_MONITOR_TIMEOUT_MS;
  else env.PRODUCTION_MONITOR_TIMEOUT_MS = timeoutMs;
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const [code] = (await once(child, "close")) as [number | null];
  return { code, stdout, stderr };
}

function expectSanitized(
  result: MonitorResult,
  configuredUrl?: string,
  capturedValues: readonly string[] = [],
): void {
  const output = `${result.stdout}${result.stderr}`;
  expect(output).not.toContain(secretToken);
  expect(output).not.toContain(secretBody);
  if (configuredUrl) expect(output).not.toContain(configuredUrl);
  expect(output).not.toContain("/api/applications");
  expect(output).not.toContain(redirectLocation);
  expect(output).not.toContain("server exploded");
  expect(output).not.toContain("550e8400-e29b-41d4-a716-446655440000");
  for (const value of capturedValues) expect(output).not.toContain(value);
}

function expectGenericFailure(
  result: MonitorResult,
  configuredUrl?: string,
  capturedValues: readonly string[] = [],
): void {
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("Production write-stop probe failed.\n");
  expectSanitized(result, configuredUrl, capturedValues);
}

async function readRequestBody(request: import("node:http").IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += chunk.toString();
  return body;
}

async function observeResponseClose(
  response: import("node:http").ServerResponse | undefined,
): Promise<boolean> {
  if (!response || response.destroyed) return true;
  const socket = response.socket;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      response.off("close", onClose);
      socket?.off("close", onClose);
      resolve(false);
    }, 100);
    const onClose = () => {
      clearTimeout(timer);
      socket?.off("close", onClose);
      resolve(true);
    };
    response.once("close", onClose);
    socket?.once("close", onClose);
  });
}

type PredicateCase = Readonly<{
  name: string;
  body: string;
  sentinels: readonly string[];
}>;

const canonicalError = "Application writes are temporarily disabled";
const exactPredicateCases: readonly PredicateCase[] = [
  {
    name: "wrong canonical error",
    body: JSON.stringify({ code: "writes_stopped", error: "wrong-error-sentinel", retryable: true }),
    sentinels: ["wrong-error-sentinel"],
  },
  {
    name: "retryable false",
    body: '{"code":"writes_stopped","error":"\\u0041pplication writes are temporarily disabled","retryable":false}',
    sentinels: ["\\u0041"],
  },
  {
    name: "missing error key",
    body: JSON.stringify({ code: "writes_stopped", retryable: true, missing_error_sentinel: "missing-error-sentinel" }),
    sentinels: ["missing-error-sentinel"],
  },
  {
    name: "extra key",
    body: JSON.stringify({ code: "writes_stopped", error: canonicalError, retryable: true, extra: "extra-key-sentinel" }),
    sentinels: ["extra-key-sentinel"],
  },
  { name: "primitive string", body: JSON.stringify("primitive-string-sentinel"), sentinels: ["primitive-string-sentinel"] },
  { name: "primitive number", body: "987654321", sentinels: ["987654321"] },
  { name: "primitive boolean", body: "false", sentinels: ["false"] },
  { name: "null", body: "null", sentinels: ["null"] },
];

describe("authenticated production write-stop probe", () => {
  it("performs authenticated stats, a valid negative POST, and unchanged stats", async () => {
    const requests: { method: string; path: string; headers: import("node:http").IncomingHttpHeaders; body: string }[] = [];
    const { server, url } = await listen(async (request, response) => {
      const body = request.method === "POST" ? await readRequestBody(request) : "";
      requests.push({ method: request.method ?? "", path: request.url ?? "", headers: request.headers, body });
      const isStatsRead = request.method === "GET" && request.url === "/api/stats";
      const isApplicationPost = request.method === "POST" && request.url === "/api/applications";
      if (isStatsRead && (requests.length === 1 || requests.length === 3)) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(validStats));
        return;
      }
      if (!isApplicationPost || requests.length !== 2) {
        response.writeHead(404);
        response.end();
        return;
      }
      const posted = JSON.parse(body) as Record<string, unknown>;
      expect(Object.keys(posted).sort()).toEqual([
        "appliedDate", "company", "description", "jobTitle", "jobType", "location", "notes", "salary", "status", "url",
      ]);
      expect(typeof posted.url).toBe("string");
      expect(() => new URL(posted.url as string)).not.toThrow();
      expect(posted.url).not.toBe(validRecentApplication.url);
      expect(typeof posted.jobTitle).toBe("string");
      expect((posted.jobTitle as string).length).toBeGreaterThan(0);
      expect(typeof posted.company).toBe("string");
      expect((posted.company as string).length).toBeGreaterThan(0);
      response.writeHead(503, {
        "content-type": "application/json",
        "cache-control": "private, no-store",
        "retry-after": "60",
      });
      response.end(JSON.stringify({
        code: "writes_stopped",
        error: "Application writes are temporarily disabled",
        retryable: true,
      }));
    });

    try {
      const result = await runMonitor(url);
      expect(result).toEqual({ code: 0, stdout: "Production write-stop probe passed.\n", stderr: "" });
      expect(requests.map(({ method, path }) => [method, path])).toEqual([
        ["GET", "/api/stats"], ["POST", "/api/applications"], ["GET", "/api/stats"],
      ]);
      for (const request of requests) {
        expect(request.headers.authorization).toBe(`Bearer ${secretToken}`);
        expect(request.headers.accept).toBe("application/json");
      }
      expect(requests[1].headers.origin).toBe(url);
      expect(requests[1].headers["content-type"]).toBe("application/json");
      expect(requests.some(({ method }) => method === "DELETE")).toBe(false);
      expect(`${result.stdout}${result.stderr}`).not.toContain(JSON.stringify(validStats));
    } finally {
      await close(server);
    }
  });

  it("fails generically when the write-stop response body stalls", async () => {
    const sentinel = "stalled-body-sentinel-never-print";
    const requests: string[] = [];
    let postedBody = "";
    let stalledResponse: import("node:http").ServerResponse | undefined;
    const { server, url } = await listen(async (request, response) => {
      requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
      if (request.method === "GET" && request.url === "/api/stats") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(validStats));
        return;
      }
      if (request.method !== "POST" || request.url !== "/api/applications") {
        response.writeHead(404);
        response.end();
        return;
      }
      postedBody = await readRequestBody(request);
      stalledResponse = response;
      response.writeHead(503, {
        "content-type": "application/json",
        "cache-control": "private, no-store",
        "retry-after": "60",
      });
      response.write(`{"code":"writes_stopped","error":"${sentinel}`);
    });

    try {
      const result = await runMonitor(url, "50");
      const posted = JSON.parse(postedBody) as Record<string, unknown>;
      const syntheticValues = [posted.url, posted.jobTitle, posted.company].filter(
        (value): value is string => typeof value === "string",
      );
      expectGenericFailure(result, url, [sentinel, ...syntheticValues]);
      expect(requests).toEqual(["GET /api/stats", "POST /api/applications"]);
      expect(posted.url).toEqual(expect.any(String));
      expect(posted.jobTitle).toEqual(expect.any(String));
      expect(posted.company).toEqual(expect.any(String));
      expect(await observeResponseClose(stalledResponse)).toBe(true);
    } finally {
      stalledResponse?.destroy();
      await close(server);
    }
  });

  it("fails generically and cancels an oversized write-stop response body", async () => {
    const sentinel = "oversized-body-sentinel-never-print";
    const requests: string[] = [];
    let postedBody = "";
    let oversizedResponse: import("node:http").ServerResponse | undefined;
    const oversizedBody = `${"x".repeat(256 * 1024)}${sentinel}`;
    const { server, url } = await listen(async (request, response) => {
      requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
      if (request.method === "GET" && request.url === "/api/stats") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(validStats));
        return;
      }
      if (request.method === "POST" && request.url === "/api/applications") {
        postedBody = await readRequestBody(request);
        oversizedResponse = response;
        response.writeHead(503, {
          "content-type": "application/json",
          "cache-control": "private, no-store",
          "retry-after": "60",
        });
        response.end(oversizedBody);
        return;
      }
      response.writeHead(404);
      response.end();
    });

    try {
      const result = await runMonitor(url, "500");
      const posted = JSON.parse(postedBody) as Record<string, unknown>;
      const syntheticValues = [posted.url, posted.jobTitle, posted.company].filter(
        (value): value is string => typeof value === "string",
      );
      expectGenericFailure(result, url, [sentinel, ...syntheticValues]);
      expect(requests).toEqual(["GET /api/stats", "POST /api/applications"]);
      expect(requests).not.toContain("DELETE /api/applications");
      expect(posted.url).toEqual(expect.any(String));
      expect(posted.jobTitle).toEqual(expect.any(String));
      expect(posted.company).toEqual(expect.any(String));
      expect(await observeResponseClose(oversizedResponse)).toBe(true);
    } finally {
      oversizedResponse?.destroy();
      await close(server);
    }
  });

  it.each([
    ["unexpected 200", 200, JSON.stringify({ id: "550e8400-e29b-41d4-a716-446655440000", error: secretBody })],
    ["unexpected 201", 201, JSON.stringify({ id: "550e8400-e29b-41d4-a716-446655440000", error: secretBody })],
    ["malformed JSON", 503, `{\"error\":\"${secretBody}`],
    ["wrong code", 503, JSON.stringify({ code: "not_writes_stopped", error: "canonical", retryable: true })],
    ["wrong cache header", 503, JSON.stringify({ code: "writes_stopped", error: "Application writes are temporarily disabled", retryable: true }), { "cache-control": "no-store" }],
    ["missing cache header", 503, JSON.stringify({ code: "writes_stopped", error: "Application writes are temporarily disabled", retryable: true })],
    ["wrong retry header", 503, JSON.stringify({ code: "writes_stopped", error: "Application writes are temporarily disabled", retryable: true }), { "retry-after": "1" }],
    ["missing retry header", 503, JSON.stringify({ code: "writes_stopped", error: "Application writes are temporarily disabled", retryable: true }), {}],
  ])("fails generically on %s without cleanup or response leaks", async (_, status, body, headers = {}) => {
    const requests: string[] = [];
    const postedBodies: string[] = [];
    const { server, url } = await listen(async (request, response) => {
      requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
      const isStatsRead = request.method === "GET" && request.url === "/api/stats";
      const isApplicationPost = request.method === "POST" && request.url === "/api/applications";
      if (isStatsRead && (requests.length === 1 || requests.length === 3)) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(validStats));
        return;
      }
      if (!isApplicationPost || requests.length !== 2) {
        response.writeHead(404);
        response.end();
        return;
      }
      postedBodies.push(await readRequestBody(request));
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(body);
    });
    try {
      const result = await runMonitor(url);
      const posted = JSON.parse(postedBodies[0]) as Record<string, unknown>;
      const capturedValues = [posted.url, posted.jobTitle, posted.company].filter(
        (value): value is string => typeof value === "string",
      );
      expectGenericFailure(result, url, capturedValues);
      expect(requests).not.toContain("DELETE /api/applications");
    } finally {
      await close(server);
    }
  });

  it.each(exactPredicateCases)("fails generically on exact response predicate case: $name", async ({ body, sentinels }) => {
    const requests: string[] = [];
    const postedBodies: string[] = [];
    const { server, url } = await listen(async (request, response) => {
      requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
      if (request.method === "GET" && request.url === "/api/stats") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(validStats));
        return;
      }
      if (request.method === "POST" && request.url === "/api/applications") {
        postedBodies.push(await readRequestBody(request));
        response.writeHead(503, {
          "content-type": "application/json",
          "cache-control": "private, no-store",
          "retry-after": "60",
        });
        response.end(body);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    try {
      const result = await runMonitor(url);
      const posted = JSON.parse(postedBodies[0]) as Record<string, unknown>;
      const syntheticValues = [posted.url, posted.jobTitle, posted.company].filter(
        (value): value is string => typeof value === "string",
      );
      expectGenericFailure(result, url, [...sentinels, ...syntheticValues]);
      expect(requests).toEqual(["GET /api/stats", "POST /api/applications"]);
    } finally {
      await close(server);
    }
  });

  it("fails when before and after stats differ", async () => {
    let statsReads = 0;
    const requests: string[] = [];
    let postedBody = "";
    const { server, url } = await listen(async (request, response) => {
      requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
      if (request.method === "POST" && request.url === "/api/applications") {
        postedBody = await readRequestBody(request);
        response.writeHead(503, { "content-type": "application/json", "cache-control": "private, no-store", "retry-after": "60" });
        response.end(JSON.stringify({ code: "writes_stopped", error: "Application writes are temporarily disabled", retryable: true }));
        return;
      }
      if (request.method !== "GET" || request.url !== "/api/stats") {
        response.writeHead(404);
        response.end();
        return;
      }
      statsReads += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(statsReads === 1 ? validStats : { ...validStats, total: 8, recentApplications: [] }));
    });
    try {
      const result = await runMonitor(url);
      const posted = JSON.parse(postedBody) as Record<string, unknown>;
      const syntheticValues = [posted.url, posted.jobTitle, posted.company].filter(
        (value): value is string => typeof value === "string",
      );
      expectGenericFailure(result, url, syntheticValues);
      expect(requests).toEqual(["GET /api/stats", "POST /api/applications", "GET /api/stats"]);
    } finally {
      await close(server);
    }
  });

  it("fails generically on redirects, refusal, and timeout", async () => {
    const redirect = await listen((request, response) => {
      if (request.method !== "GET" || request.url !== "/api/stats") {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(302, { location: redirectLocation });
      response.end(secretBody);
    });
    try {
      expectGenericFailure(await runMonitor(redirect.url), redirect.url);
    } finally {
      await close(redirect.server);
    }

    const refused = await listen((_request, response) => response.end());
    await close(refused.server);
    expectGenericFailure(await runMonitor(refused.url), refused.url);

    const timeoutRequests: string[] = [];
    const timeout = await listen((request) => {
      timeoutRequests.push(`${request.method ?? ""} ${request.url ?? ""}`);
    });
    try {
      expectGenericFailure(await runMonitor(timeout.url, "50"), timeout.url);
      expect(timeoutRequests).toEqual(["GET /api/stats"]);
    } finally {
      await close(timeout.server);
    }
  });

  it.each([
    ["non-loopback HTTP", "http://example.invalid"],
    ["credentials", "http://user:password@127.0.0.1:1234"],
    ["query", "http://127.0.0.1:1234/?secret=leak"],
    ["hash", "http://127.0.0.1:1234/#secret"],
    ["path", "http://127.0.0.1:1234/base"],
    ["malformed URL", "not a URL"],
  ])("rejects %s without leaking configuration", async (_, invalidUrl) => {
    expectGenericFailure(await runMonitor(invalidUrl), invalidUrl);
  });

  it("rejects missing and blank credentials", async () => {
    expectGenericFailure(await runMonitor("http://127.0.0.1:1234", undefined, ""));
    expectGenericFailure(await runMonitor("http://127.0.0.1:1234", undefined, "   "));
  });

  it("uses the default timeout and rejects values above the safe cap", async () => {
    const { server, url } = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(validStats));
    });
    try {
      const defaultResult = await runMonitor(url);
      expect(defaultResult).toEqual({ code: 1, stdout: "", stderr: "Production write-stop probe failed.\n" });
      expectSanitized(defaultResult, url);
      expectGenericFailure(await runMonitor(url, "30001"), url);
    } finally {
      await close(server);
    }
  });
});
