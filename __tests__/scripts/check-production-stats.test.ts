import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";

const root = join(__dirname, "../..");
const script = join(root, "scripts/check-production-stats.mjs");
const secretToken = "monitor-test-token-never-print";
const secretBody = "monitor-test-body-never-print";

const validStats = {
  total: 7,
  applied: 2,
  interview: 1,
  offer: 1,
  rejected: 3,
  weeklyCount: 4,
  monthlyCount: 7,
  recentApplications: [],
};

type MonitorResult = Readonly<{
  code: number | null;
  stdout: string;
  stderr: string;
}>;

async function listen(
  handler: Parameters<typeof createServer>[0],
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
  timeoutMs = "500",
): Promise<MonitorResult> {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: {
      ...process.env,
      PRODUCTION_APP_URL: url,
      PRODUCTION_APP_ACCESS_TOKEN: secretToken,
      PRODUCTION_MONITOR_TIMEOUT_MS: timeoutMs,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const [code] = (await once(child, "close")) as [number | null];
  return { code, stdout, stderr };
}

function expectSanitized(result: MonitorResult): void {
  const output = `${result.stdout}${result.stderr}`;
  expect(output).not.toContain(secretToken);
  expect(output).not.toContain(secretBody);
  expect(output).not.toContain("127.0.0.1");
  expect(output).not.toContain("http://");
}

describe("authenticated production stats monitor", () => {
  it("succeeds only for an authenticated exact 200 stats response", async () => {
    const { server, url } = await listen((request, response) => {
      expect(request.url).toBe("/api/stats");
      expect(request.headers.authorization).toBe(`Bearer ${secretToken}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(validStats));
    });

    try {
      const result = await runMonitor(url);
      expect(result).toEqual({
        code: 0,
        stdout: "Production monitor passed.\n",
        stderr: "",
      });
    } finally {
      await close(server);
    }
  });

  it.each([
    ["401", 401, JSON.stringify({ error: secretBody })],
    ["500", 500, secretBody],
    ["malformed JSON", 200, `{\"${secretBody}\"`],
    ["wrong shape", 200, JSON.stringify({ ...validStats, total: "7" })],
    ["extra response field", 200, JSON.stringify({ ...validStats, extra: 1 })],
  ])("fails generically on %s without leaking response data", async (_, status, body) => {
    const { server, url } = await listen((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    });

    try {
      const result = await runMonitor(url);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Production monitor failed.\n");
      expectSanitized(result);
    } finally {
      await close(server);
    }
  });

  it("fails generically when the connection is refused", async () => {
    const { server, url } = await listen((_request, response) => response.end());
    await close(server);
    const result = await runMonitor(url);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("Production monitor failed.\n");
    expectSanitized(result);
  });

  it("fails generically when the request times out", async () => {
    const { server, url } = await listen(() => undefined);
    try {
      const result = await runMonitor(url, "50");
      expect(result.code).toBe(1);
      expect(result.stderr).toBe("Production monitor failed.\n");
      expectSanitized(result);
    } finally {
      await close(server);
    }
  });

  it("requires HTTPS except for a loopback test server", async () => {
    const result = await runMonitor("http://example.invalid");
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("Production monitor failed.\n");
    expectSanitized(result);
  });
});
