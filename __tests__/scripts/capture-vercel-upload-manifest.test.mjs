import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createServer } from "node:https";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const NODE = "/Users/taejunoh/.nvm/versions/node/v22.22.2/bin/node";
const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts/capture-vercel-upload-manifest.mjs");

async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), "preview-upload-capture-"));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function createCertificate(directory) {
  await execFile("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"), "-days", "1", "-nodes", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"]);
  return { key: await readFile(join(directory, "key.pem")), cert: await readFile(join(directory, "cert.pem")) };
}

async function fixture(directory) {
  const source = join(directory, "source");
  await mkdir(join(source, ".vercel"), { recursive: true });
  await writeFile(join(source, ".vercel", "project.json"), JSON.stringify({ projectId: "prj_fixture", orgId: "team_fixture", projectName: "fixture" }));
  await mkdir(join(source, "node_modules"), { recursive: true });
  await writeFile(join(source, "keep.txt"), "keep\n");
  await writeFile(join(source, ".env.example"), "EXAMPLE_ONLY=1\n");
  await writeFile(join(source, ".env.local"), "MUST_NOT_LEAK=1\n");
  await writeFile(join(source, "node_modules", "a.js"), "ignored\n");
  await writeFile(join(source, ".vercelignore"), "ignored-by-rule.txt\n");
  await writeFile(join(source, "ignored-by-rule.txt"), "ignored\n");
  await execFile("git", ["init", "-q", source]);
  await execFile("git", ["-C", source, "config", "user.email", "fixture@example.test"]);
  await execFile("git", ["-C", source, "config", "user.name", "Fixture"]);
  await execFile("git", ["-C", source, "add", "."]);
  await execFile("git", ["-C", source, "commit", "-qm", "fixture"]);
  const { stdout } = await execFile("git", ["-C", source, "rev-parse", "HEAD"]);
  return { source, sha: stdout.trim() };
}

async function fakeApi(directory, { capture = true, capturePath } = {}) {
  const certificate = await createCertificate(directory);
  const requests = [];
  let deployment;
  const server = createServer(certificate, async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url });
    if (request.method === "POST" && request.url?.startsWith("/v13/deployments")) {
      if (capture) {
        deployment = JSON.parse(body);
        await writeFile(capturePath, body, { mode: 0o600, flag: "wx" });
      }
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "capture_sentinel", message: "capture sentinel" } }));
      return;
    }
    const pathname = new URL(request.url, "https://fake.invalid").pathname;
    const payload = pathname === "/v2/user" ? { user: { id: "user_fixture", username: "fixture" } }
      : pathname === "/teams/team_fixture" ? { id: "team_fixture", slug: "fixture" }
      : pathname === "/v9/projects/prj_fixture" || pathname === "/v9/projects/fixture" ? { id: "prj_fixture", name: "fixture", accountId: "team_fixture", latestDeployments: [] }
      : { error: { code: "unexpected", message: "unexpected fake API request" } };
    response.writeHead(payload.error ? 500 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `https://127.0.0.1:${address.port}`,
    requests,
    deployment: () => deployment,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function invoke(args, cwd) {
  return execFile(NODE, [SCRIPT, ...args], {
    cwd,
    env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}` },
  }).catch((error) => error);
}

test("captures the installed CLI deployment files through a loopback-only API and binds each entry to local bytes", async () => {
  await temporary(async (directory) => {
    const { source, sha } = await fixture(directory);
    const privateDirectory = join(directory, "private");
    await mkdir(privateDirectory, { mode: 0o700 });
    await chmod(privateDirectory, 0o700);
    const report = join(privateDirectory, "upload-manifest.json");
    const capture = join(privateDirectory, "received-deployment.json");
    const api = await fakeApi(directory, { capturePath: capture });
    try {
      const result = await invoke(["--source-root", source, "--expected-sha", sha, "--private-dir", privateDirectory, "--report", report, "--capture-file", capture, "--fake-api", api.url], source);
      assert.equal(result.stdout, "Vercel upload manifest captured.\n");
      assert.equal(result.stderr, "");
      assert.ok(api.requests.length > 0, "the supplied loopback fake API must receive the CLI requests");
      assert.ok(api.deployment()?.files?.length > 0, "the real CLI must have posted a files array before the sentinel");
      const manifest = JSON.parse(await readFile(report, "utf8"));
      assert.equal((await (await import("node:fs/promises")).lstat(report)).mode & 0o777, 0o600);
      assert.equal(manifest.sourceSha, sha);
      assert.deepEqual(manifest.files.map((entry) => entry.path), manifest.files.map((entry) => entry.path).slice().sort());
      assert.equal(new Set(manifest.files.map((entry) => entry.path)).size, manifest.files.length);
      assert.deepEqual(manifest.files.map((entry) => [entry.path, entry.cliSha, entry.size, entry.cliMode]), api.deployment().files.map((entry) => [entry.file, entry.sha, entry.size, entry.mode]).sort((left, right) => left[0].localeCompare(right[0])));
      for (const entry of manifest.files) {
        assert.match(entry.path, /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+/u);
        assert.match(entry.sha256, /^[0-9a-f]{64}$/u);
        assert.match(entry.cliSha, /\S/u);
        assert.ok(Number.isFinite(entry.size) && entry.size >= 0);
        assert.ok(Number.isFinite(entry.cliMode));
      }
      assert.equal(JSON.stringify(manifest).includes("MUST_NOT_LEAK"), false);
    } finally { await api.close(); }
  });
});

test("refuses before writing a report when the deployment POST is absent", async () => {
  await temporary(async (directory) => {
    const { source, sha } = await fixture(directory);
    const privateDirectory = join(directory, "private");
    await mkdir(privateDirectory, { mode: 0o700 });
    await chmod(privateDirectory, 0o700);
    const report = join(privateDirectory, "upload-manifest.json");
    const capture = join(privateDirectory, "received-deployment.json");
    const api = await fakeApi(directory, { capture: false, capturePath: capture });
    try {
      const result = await invoke(["--source-root", source, "--expected-sha", sha, "--private-dir", privateDirectory, "--report", report, "--capture-file", capture, "--fake-api", api.url], source);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "Vercel upload manifest capture refused.\n");
      await assert.rejects(readFile(report, "utf8"));
    } finally { await api.close(); }
  });
});
