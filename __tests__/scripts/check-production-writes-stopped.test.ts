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

describe("authenticated production write-stop probe", () => {
  it("performs authenticated stats, a valid negative POST, and unchanged stats", async () => {
    const requests: { method: string; path: string; headers: import("node:http").IncomingHttpHeaders; body: string }[] = [];
    const { server, url } = await listen(async (request, response) => {
      const body = request.method === "POST" ? await readRequestBody(request) : "";
      requests.push({ method: request.method ?? "", path: request.url ?? "", headers: request.headers, body });
      if (requests.length === 1 || requests.length === 3) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(validStats));
        return;
      }
      expect(request.method).toBe("POST");
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
    const methods: string[] = [];
    const postedBodies: string[] = [];
    const { server, url } = await listen(async (request, response) => {
      methods.push(request.method ?? "");
      if (request.method === "POST") postedBodies.push(await readRequestBody(request));
      if (methods.length === 1 || methods.length === 3) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(validStats));
        return;
      }
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
      expect(methods).not.toContain("DELETE");
    } finally {
      await close(server);
    }
  });

  it("fails when before and after stats differ", async () => {
    let statsReads = 0;
    const { server, url } = await listen(async (request, response) => {
      if (request.method === "POST") {
        await readRequestBody(request);
        response.writeHead(503, { "content-type": "application/json", "cache-control": "private, no-store", "retry-after": "60" });
        response.end(JSON.stringify({ code: "writes_stopped", error: "Application writes are temporarily disabled", retryable: true }));
        return;
      }
      statsReads += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(statsReads === 1 ? validStats : { ...validStats, total: 8, recentApplications: [] }));
    });
    try {
      expectGenericFailure(await runMonitor(url), url);
    } finally {
      await close(server);
    }
  });

  it("fails generically on redirects, refusal, and timeout", async () => {
    const redirect = await listen((_request, response) => {
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

    const timeout = await listen(() => undefined);
    try {
      expectGenericFailure(await runMonitor(timeout.url, "50"), timeout.url);
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
