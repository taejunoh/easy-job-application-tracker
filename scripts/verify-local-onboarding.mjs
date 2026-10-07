import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedDockerEnv, readLocalConfig, validateOwnedDatabase } from "./local-setup-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function commandFailureCategory(stderr) {
  for (const [pattern, category] of [
    [/invalid reference format/iu, "invalid-image-reference"],
    [/no space left on device/iu, "disk-full"],
    [/OCI runtime|runc|failed to create task|resource temporarily unavailable/iu, "container-runtime-failure"],
    [/pull access denied|unable to find image|no such image/iu, "image-unavailable"],
    [/port is already allocated|address already in use/iu, "port-conflict"],
    [/cannot connect to the Docker daemon|error during connect|dial unix/iu, "daemon-unavailable"],
    [/executable file not found|failed to resolve reference/iu, "runtime-command-unavailable"],
    [/unknown flag|invalid argument/iu, "invalid-command"],
    [/operation not permitted|permission denied/iu, "permission-denied"],
  ]) if (pattern.test(stderr)) return category;
  return "command-failed";
}

// Inspect results stay in memory: Docker inspection contains runtime credentials.
export function assertRuntimeIsolation(containers, project, port) {
  assert.match(project, /^jobtracker-[a-f0-9]{12}$/u);
  assert.equal(containers.length, 2);
  const services = new Set();
  for (const container of containers) {
    assert.equal(container.Config.Labels["com.docker.compose.project"], project);
    const service = container.Config.Labels["com.docker.compose.service"];
    assert.ok(["app", "db"].includes(service) && !services.has(service));
    services.add(service);
    assert.equal(container.State.Running, true);
    assert.equal(container.State.Health.Status, "healthy");
    const published = Object.entries(container.NetworkSettings.Ports ?? {})
      .flatMap(([containerPort, bindings]) => (bindings ?? []).map(binding => ({ containerPort, ...binding })));
    assert.deepEqual(published, service === "app"
      ? [{ containerPort: "3000/tcp", HostIp: "127.0.0.1", HostPort: String(port) }]
      : []);
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
  const port = server.address().port;
  await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
  return port;
}

export async function verifyLocalOnboarding() {
  const report = { sourceRevision: null, checks: [], stage: "prerequisites", passed: false, cleanup: false };
  let temporary, checkout, managed, originalConfig, browser, context, activeChild, dockerHost;
  let interrupted = false;
  let failure = false;
  const env = isolatedDockerEnv(process.env);
  const terminateChild = () => {
    if (!activeChild) return;
    try {
      if (process.platform === "win32") activeChild.kill("SIGTERM");
      else process.kill(-activeChild.pid, "SIGTERM");
    } catch { /* The child may already have exited. */ }
  };
  const signal = () => { interrupted = true; terminateChild(); };
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, signal);
  const step = name => { report.stage = name; process.stdout.write(`[onboarding] ${name}\n`); };
  const checked = name => report.checks.push(name);
  const run = (command, args, cwd = checkout ?? root, { input, timeout = 15 * 60_000, cleanup = false } = {}) => new Promise((accept, reject) => {
    if (interrupted && !cleanup) return reject(new Error("interrupted"));
    const child = spawn(command, args, { cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    activeChild = child;
    const output = [];
    const errors = [];
    let size = 0, tooLarge = false;
    // Never emit raw subprocess output: setup/inspection may contain sensitive values.
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size <= 32 * 1024 * 1024) output.push(chunk);
      else { tooLarge = true; terminateChild(); }
    });
    let errorSize = 0;
    child.stderr.on("data", chunk => {
      errorSize += chunk.length;
      if (errorSize <= 256 * 1024) errors.push(chunk);
    });
    const timer = setTimeout(terminateChild, timeout);
    child.once("error", () => { clearTimeout(timer); reject(new Error("command unavailable")); });
    child.once("close", status => {
      clearTimeout(timer);
      activeChild = null;
      if (status !== 0 || tooLarge || (interrupted && !cleanup)) {
        report.commandExitStatus = Number.isInteger(status) ? status : null;
        report.commandFailureCategory = commandFailureCategory(Buffer.concat(errors).toString());
        reject(new Error("command failed"));
      } else accept(Buffer.concat(output));
    });
    child.stdin.end(input);
  });
  const docker = (args, options) => run("docker", [...(dockerHost ? ["--host", dockerHost] : []), ...args], checkout ?? root, options);
  const discoverManaged = () => {
    const found = readLocalConfig({ configDir: join(checkout, ".jobtracker") });
    validateOwnedDatabase(found.config);
    assert.ok(!existingProjects.has(found.config.JOBTRACKER_PROJECT_NAME));
    managed = found;
  };
  const compose = (args, options) => {
    assert.ok(managed && checkout?.startsWith(temporary + "/"));
    return docker(["compose", "--file", join(checkout, "compose.yaml"), "--env-file", managed.path,
      "--project-name", managed.config.JOBTRACKER_PROJECT_NAME, ...args], options);
  };
  const inspectRuntime = async () => {
    const ids = (await compose(["ps", "--all", "--quiet"])).toString().trim().split(/\s+/u).filter(Boolean);
    assert.equal(ids.length, 2);
    const inspected = JSON.parse((await docker(["inspect", ...ids])).toString());
    assertRuntimeIsolation(inspected, managed.config.JOBTRACKER_PROJECT_NAME, Number(managed.config.JOBTRACKER_PORT));
    return inspected;
  };
  const existingProjects = new Set();
  try {
    const [major, minor, patch] = process.versions.node.split(".").map(Number);
    assert.ok(major === 22 && (minor > 22 || (minor === 22 && patch >= 2)));
    const { chromium, request } = await import("playwright");
    // launch() supports CI's --only-shell Chromium install; executablePath() points at the full browser instead.
    browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    const localEndpoint = endpoint => typeof endpoint === "string" && (/^unix:\/\/\//u.test(endpoint) || /^npipe:\/\/\/\/\.\/pipe\//u.test(endpoint));
    assert.ok(!process.env.DOCKER_HOST || localEndpoint(process.env.DOCKER_HOST));
    const selected = JSON.parse((await docker(["context", "inspect", ...(process.env.DOCKER_CONTEXT ? [process.env.DOCKER_CONTEXT] : []), "--format", "{{json .Endpoints.docker.Host}}"])).toString());
    dockerHost = process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT ? process.env.DOCKER_HOST : selected;
    assert.ok(localEndpoint(dockerHost));
    // Pin both our explicit Docker calls and the exported npm setup CLI to this endpoint.
    delete env.DOCKER_CONTEXT;
    delete env.DOCKER_TLS_VERIFY;
    delete env.DOCKER_CERT_PATH;
    env.DOCKER_HOST = dockerHost;
    await docker(["info", "--format", "{{.ServerVersion}}"]);
    for (const args of [["ps", "--all"], ["volume", "ls"], ["network", "ls"]]) {
      const projects = (await docker([...args, "--format", "{{.Label \"com.docker.compose.project\"}}"])).toString();
      projects.trim().split(/\s+/u).filter(Boolean).forEach(project => existingProjects.add(project));
    }

    step("export tracked HEAD into a dependency-free disposable checkout");
    report.sourceRevision = (await run("git", ["rev-parse", "HEAD"], root)).toString().trim();
    temporary = await mkdtemp(join(tmpdir(), "jobtracker-onboarding-"));
    checkout = join(temporary, "checkout");
    await mkdir(checkout);
    const archive = await run("git", ["archive", "--format=tar", report.sourceRevision], root);
    await run("tar", ["-xf", "-", "-C", checkout], root, { input: archive });
    await assert.rejects(access(join(checkout, "node_modules")));
    const sentinel = `JOBTRACKER_ONBOARDING_SYNTHETIC_PRIVATE_NOT_A_SECRET_${randomUUID()}`;
    const rootEnv = `DATABASE_URL=postgresql://synthetic.invalid/do-not-use\nAPP_ACCESS_TOKEN=${sentinel}\n`;
    await writeFile(join(checkout, ".env"), rootEnv, { mode: 0o600 });
    await writeFile(join(checkout, "private.pem"), sentinel, { mode: 0o600 });
    await writeFile(join(checkout, "private.key"), sentinel, { mode: 0o600 });
    checked("fresh tracked checkout has no host dependencies");

    step("run first-time npm setup with a random loopback port");
    const port = await freePort();
    try { await run("npm", ["run", "setup", "--", "--port", String(port)]); }
    finally { discoverManaged(); }
    originalConfig = await readFile(managed.path);
    assert.equal(await readFile(join(checkout, ".env"), "utf8"), rootEnv);
    await inspectRuntime();
    checked("fresh setup: healthy app/database, loopback-only web, unpublished database, root .env unchanged");

    step("repeat setup without changing credentials or configuration");
    await run("npm", ["run", "setup"]);
    assert.deepEqual(await readFile(managed.path), originalConfig);
    assert.equal(await readFile(join(checkout, ".env"), "utf8"), rootEnv);
    await inspectRuntime();
    step("verify the built runtime image excludes local private material");
    // Inspect the exact live app image, without relying on tags/digests moved by the repeat build.
    await compose(["exec", "--no-TTY", "app", "node", "-e", `
      const fs = require('node:fs'); const path = require('node:path');
      function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.name === '.jobtracker' || entry.name === '.env' || entry.name.startsWith('.env.') || /\\.(pem|key)$/i.test(entry.name)) process.exit(1);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && fs.readFileSync(file).includes(${JSON.stringify(sentinel)})) process.exit(1);
      } } walk('/app');
    `]);
    checked("repeat setup preserves exact config bytes; runtime image excludes synthetic local private files");

    const origin = managed.config.APP_BASE_URL;
    const token = managed.config.APP_ACCESS_TOKEN;
    step("verify unauthenticated writes are denied");
    const unauthenticated = await request.newContext({ baseURL: origin });
    try {
      const denied = await unauthenticated.post("/api/applications", { headers: { Origin: origin }, data: {} });
      assert.ok([401, 403].includes(denied.status()));
    } finally { await unauthenticated.dispose(); }
    checked("unauthenticated writes are denied");

    step("log in and save a synthetic extracted job through the real browser UI");
    context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(`${origin}/connect`);
    await page.getByLabel("Access token", { exact: true }).fill(token);
    const login = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/session" && response.request().method() === "POST");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    assert.equal((await login).status(), 200);
    await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
    const fixture = { url: "https://example.com/jobs/onboarding-synthetic", jobTitle: "Synthetic Onboarding Engineer", company: "Synthetic Acceptance Company" };
    let extracted = 0;
    // This is the only intercepted endpoint. Auth, application CRUD, and PostgreSQL remain real.
    await page.route(`${origin}/api/extract`, async route => {
      assert.equal(route.request().method(), "POST");
      assert.deepEqual(route.request().postDataJSON(), { url: fixture.url });
      extracted += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) });
    });
    await page.getByLabel("Job URL", { exact: true }).fill(fixture.url);
    await page.getByRole("button", { name: "+ Add", exact: true }).click();
    assert.equal(await page.getByLabel("Job Title", { exact: true }).inputValue(), fixture.jobTitle);
    assert.equal(await page.getByLabel("Company", { exact: true }).inputValue(), fixture.company);
    const savedResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/applications" && response.request().method() === "POST");
    await page.getByRole("button", { name: "Save Application", exact: true }).click();
    const saved = await savedResponse;
    assert.equal(saved.status(), 201);
    const application = await saved.json();
    assert.equal(extracted, 1);
    assert.ok(typeof application.id === "string" && application.id.length > 0);
    await page.getByText("Application saved.", { exact: true }).waitFor();
    const applicationPath = `/api/applications/${encodeURIComponent(application.id)}`;
    const verifySaved = async status => {
      const result = await context.request.get(origin + applicationPath);
      assert.equal(result.status(), 200);
      const actual = await result.json();
      assert.equal(actual.id, application.id);
      assert.equal(actual.url, fixture.url);
      assert.equal(actual.jobTitle, fixture.jobTitle);
      assert.equal(actual.company, fixture.company);
      assert.equal(actual.status, status);
    };
    await verifySaved("Applied");
    const patched = await context.request.patch(origin + applicationPath, { headers: { Origin: origin }, data: { status: "Interview" } });
    assert.equal(patched.status(), 200);
    await verifySaved("Interview");
    checked("real UI session and save, real GET/PATCH, only extraction uses a synthetic fixture");

    step("stop/start and recreate containers while retaining the same saved application");
    await run("npm", ["run", "local:stop"]);
    await run("npm", ["run", "local:start"]);
    await verifySaved("Interview");
    await compose(["down"]); // Deliberately preserve the database volume here.
    await compose(["up", "--detach", "--wait", "--wait-timeout", "180"]);
    await inspectRuntime();
    const renewed = await context.request.post(`${origin}/api/auth/session`, { headers: { Origin: origin }, data: { token } });
    assert.equal(renewed.status(), 200);
    await verifySaved("Interview");
    assert.deepEqual(await readFile(managed.path), originalConfig);
    checked("same application ID/data persists after stop/start and container recreation; original token still authenticates");

    step("add the extension origin twice and verify runtime CORS without rotating credentials");
    const extensionId = "abcdefghijklmnopabcdefghijklmnop";
    const extensionOrigin = `chrome-extension://${extensionId}`;
    await run("npm", ["run", "local:extension", "--", extensionId]);
    const extensionConfig = await readFile(managed.path);
    const afterExtension = readLocalConfig({ configDir: join(checkout, ".jobtracker") }).config;
    for (const key of Object.keys(managed.config).filter(key => key !== "CORS_ALLOWED_ORIGINS")) assert.equal(afterExtension[key], managed.config[key]);
    assert.equal(afterExtension.CORS_ALLOWED_ORIGINS, `${origin},${extensionOrigin}`);
    await run("npm", ["run", "local:extension", "--", extensionId]);
    assert.deepEqual(await readFile(managed.path), extensionConfig);
    const preflight = await context.request.fetch(`${origin}/api/applications`, {
      method: "OPTIONS", headers: { Origin: extensionOrigin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" },
    });
    assert.equal(preflight.status(), 204);
    assert.equal(preflight.headers()["access-control-allow-origin"], extensionOrigin);
    assert.ok(preflight.headers()["access-control-allow-methods"].includes("POST"));
    assert.equal((await context.request.post(`${origin}/api/auth/session`, { headers: { Origin: origin }, data: { token } })).status(), 200);
    await verifySaved("Interview");
    await inspectRuntime();
    assert.equal(await readFile(join(checkout, ".env"), "utf8"), rootEnv);
    checked("extension command idempotent, runtime CORS valid, original credentials/session/data preserved");
    report.passed = true;
  } catch {
    // Assertion messages can contain config, cookies, or response bodies. Persist only safe stage/status metadata.
    failure = true;
    process.stderr.write(`[onboarding] Failed at: ${report.stage}. Raw subprocess and assertion details suppressed.\n`);
  } finally {
    try { await browser?.close(); } catch { failure = true; }
    try {
      if (managed) {
        await compose(["down", "--volumes", "--remove-orphans"], { cleanup: true, timeout: 120_000 });
        const remaining = (await docker(["ps", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${managed.config.JOBTRACKER_PROJECT_NAME}`], { cleanup: true })).toString().trim();
        const volumes = (await docker(["volume", "ls", "--quiet", "--filter", `label=com.docker.compose.project=${managed.config.JOBTRACKER_PROJECT_NAME}`], { cleanup: true })).toString().trim();
        assert.equal(remaining, ""); assert.equal(volumes, "");
      }
      report.cleanup = true;
    } catch { failure = true; process.stderr.write("[onboarding] Owned-resource cleanup failed; inspect the recorded project only.\n"); }
    if (managed) report.ownedProject = managed.config.JOBTRACKER_PROJECT_NAME;
    if (temporary) await rm(temporary, { recursive: true, force: true });
    if (failure || interrupted) report.passed = false;
    report.interrupted = interrupted;
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(name, signal);
    const diagnostics = join(root, ".artifacts", "onboarding", `${Date.now()}.json`);
    await mkdir(dirname(diagnostics), { recursive: true });
    await writeFile(diagnostics, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    process.stdout.write(`[onboarding] Redacted report: ${diagnostics}\n`);
  }
  if (failure || interrupted) return 1;
  process.stdout.write(`[onboarding] Passed ${report.checks.length} checks; disposable resources removed.\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await verifyLocalOnboarding();
}
