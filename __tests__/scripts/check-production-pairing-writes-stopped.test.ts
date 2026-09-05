import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "../..");
const script = join(root, "scripts/check-production-pairing-writes-stopped.mjs");
const grantId = "018f9f72-f2e9-7c29-a6fc-001122334488";
const code = `jt_pair_v1.${grantId}.${"a".repeat(43)}`;
const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

async function listen(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function run(url: string, evidencePath: string, suppliedCode = code) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, PRODUCTION_APP_URL: url, PRESTOP_PAIRING_CODE: suppliedCode, PRESTOP_PAIRING_GRANT_ID: grantId, PRESTOP_PAIRING_ORIGIN: extensionOrigin, PAIRING_PROBE_RESPONSE_FILE: evidencePath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (value) => (stdout += value));
  child.stderr.setEncoding("utf8").on("data", (value) => (stderr += value));
  const [code] = (await once(child, "close")) as [number];
  return { code, stdout, stderr };
}

describe("grant-bound pairing write-stop probe", () => {
  it("sends the real canonical exchange and retains its raw 503 before reporting success", async () => {
    const privateRoot = mkdtempSync(join(tmpdir(), "pairing-probe-"));
    chmodSync(privateRoot, 0o700);
    const evidence = join(privateRoot, "pairing-response.json");
    const { server, url } = await listen(async (request, response) => {
      let body = ""; for await (const chunk of request) body += chunk;
      expect(request.method).toBe("POST"); expect(request.url).toBe("/api/extension/pair");
      expect(request.headers.origin).toBe(extensionOrigin); expect(JSON.parse(body)).toEqual({ code });
      response.writeHead(503, { "content-type": "application/json", "cache-control": "private, no-store", "retry-after": "60" });
      response.end(JSON.stringify({ error: "Application writes are temporarily disabled", code: "writes_stopped", retryable: true }));
    });
    try {
      expect(await run(url, evidence)).toEqual({ code: 0, stdout: "Pairing write-stop probe passed.\n", stderr: "" });
      expect(JSON.parse(readFileSync(evidence, "utf8"))).toMatchObject({ status: 503, body: { code: "writes_stopped" } });
    } finally { server.close(); await once(server, "close"); rmSync(privateRoot, { recursive: true, force: true }); }
  });

  it("retains an unexpected 201 response with its cleanup material before failing", async () => {
    const privateRoot = mkdtempSync(join(tmpdir(), "pairing-probe-")); chmodSync(privateRoot, 0o700);
    const evidence = join(privateRoot, "pairing-response.json");
    const token = `jt_install_v1.018f9f72-f2e9-7c29-a6fc-001122334499.${"b".repeat(43)}`;
    const { server, url } = await listen((_request, response) => { response.writeHead(201, { "content-type": "application/json" }); response.end(JSON.stringify({ installationId: "018f9f72-f2e9-7c29-a6fc-001122334499", token, expiresAt: "2026-09-05T12:00:00.000Z" })); });
    try {
      const result = await run(url, evidence);
      expect(result).toEqual({ code: 1, stdout: "", stderr: "Pairing write-stop probe failed.\n" });
      expect(readFileSync(evidence, "utf8")).toContain(token);
    } finally { server.close(); await once(server, "close"); rmSync(privateRoot, { recursive: true, force: true }); }
  });
});
