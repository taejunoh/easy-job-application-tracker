import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const coreUrl = pathToFileURL(join(__dirname, "../../scripts/local-setup-core.mjs")).href;
const cliUrl = pathToFileURL(join(__dirname, "../../scripts/local-setup.mjs")).href;
const directories: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jobtracker-setup-"));
  directories.push(root);
  return { root, configDir: join(root, ".jobtracker") };
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function run(code: string, input: unknown = {}) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import * as core from ${JSON.stringify(coreUrl)};
    import { runLocalCommand } from ${JSON.stringify(cliUrl)};
    const chunks = []; for await (const c of process.stdin) chunks.push(c);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    try { ${code} } catch (error) { process.stdout.write(JSON.stringify({ error: error.message })); }
  `], { input: JSON.stringify(input), encoding: "utf8" });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}
function create(configDir: string, port?: number) {
  return run("process.stdout.write(JSON.stringify(core.ensureLocalConfig({ configDir: input.configDir, port: input.port })));", { configDir, port });
}

describe("managed local configuration", () => {
  it("creates a private, isolated identity and reuses exactly the same bytes", () => {
    const { root, configDir } = fixture();
    writeFileSync(join(root, ".env"), "DATABASE_URL=do-not-read-or-change\n");
    const first = create(configDir, 3107);
    expect(first.error).toBeUndefined();
    expect(first.config.JOBTRACKER_PROJECT_NAME).toMatch(/^jobtracker-[0-9a-f]{12}$/);
    expect(first.config.APP_BASE_URL).toBe("http://127.0.0.1:3107");
    expect(first.config.DATABASE_URL).toBe(`postgresql://jobtracker:${first.config.POSTGRES_PASSWORD}@db:5432/jobtracker`);
    expect(first.config.APPLICATION_WRITES_ENABLED).toBe("1");
    expect(first.config.APPLICATION_IDENTITY_WRITES_ENABLED).toBe("0");
    expect(first.config.VALIDATION_MANUAL_ENTRY_ENABLED).toBe("0");
    const secrets = [first.config.ENCRYPTION_SECRET, first.config.APP_ACCESS_TOKEN, first.config.POSTGRES_PASSWORD];
    secrets.forEach(value => expect(value).toMatch(/^[a-f0-9]{64}$/));
    expect(new Set(secrets).size).toBe(3);
    const bytes = readFileSync(join(configDir, "local.env"));
    expect(create(configDir).config).toEqual(first.config);
    expect(readFileSync(join(configDir, "local.env"))).toEqual(bytes);
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("DATABASE_URL=do-not-read-or-change\n");
    if (process.platform !== "win32") {
      expect(statSync(configDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(configDir, "local.env")).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects changing a persisted port without changing any bytes", () => {
    const { configDir } = fixture(); create(configDir, 3107);
    const before = readFileSync(join(configDir, "local.env"));
    expect(create(configDir, 3108).error).toMatch(/port/i);
    expect(readFileSync(join(configDir, "local.env"))).toEqual(before);
  });

  it.each(["extra", "duplicate", "external-db", "wrong-password", "query", "weak", "gates"])("fails closed on malformed existing config: %s", (kind) => {
    const { configDir } = fixture(); const { config } = create(configDir);
    const file = join(configDir, "local.env");
    let contents = readFileSync(file, "utf8");
    if (kind === "extra") contents += "UNTRUSTED_KEY=x\n";
    if (kind === "duplicate") contents += "APP_ACCESS_TOKEN=" + config.APP_ACCESS_TOKEN + "\n";
    if (kind === "external-db") contents = contents.replace("@db:5432", "@remote.example:5432");
    if (kind === "wrong-password") contents = contents.replace("postgresql://jobtracker:" + config.POSTGRES_PASSWORD, "postgresql://jobtracker:" + "c".repeat(64));
    if (kind === "query") contents = contents.replace("@db:5432/jobtracker", "@db:5432/jobtracker?schema=other");
    if (kind === "weak") contents = contents.replace("APP_ACCESS_TOKEN=" + config.APP_ACCESS_TOKEN, "APP_ACCESS_TOKEN=weak");
    if (kind === "gates") contents = contents.replace("APPLICATION_IDENTITY_WRITES_ENABLED=0", "APPLICATION_IDENTITY_WRITES_ENABLED=1");
    writeFileSync(file, contents);
    const result = create(configDir);
    expect(result.error).toMatch(/local configuration/i);
    expect(result.error).not.toContain(config.POSTGRES_PASSWORD);
    expect(readFileSync(file, "utf8")).toBe(contents);
  });

  it.each(["directory", "file"])("rejects a symlinked %s", (kind) => {
    const { root, configDir } = fixture();
    if (kind === "directory") { mkdirSync(join(root, "target")); symlinkSync(join(root, "target"), configDir); }
    else { mkdirSync(configDir, { mode: 0o700 }); writeFileSync(join(root, "target"), "untouched"); symlinkSync(join(root, "target"), join(configDir, "local.env")); }
    expect(create(configDir).error).toMatch(/local configuration/i);
  });

  it("does not rotate secrets while concurrent creators race", async () => {
    const { configDir } = fixture();
    const script = `import { ensureLocalConfig } from ${JSON.stringify(coreUrl)}; process.stdout.write(JSON.stringify(ensureLocalConfig({ configDir: ${JSON.stringify(configDir)} }).config));`;
    const results = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script]);
      let output = ""; let error = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk; });
      child.stderr.on("data", (chunk: Buffer) => { error += chunk; });
      child.on("close", (status: number) => status === 0 ? resolve(output) : reject(new Error(error)));
    })));
    expect(new Set(results).size).toBe(1);
  });

  it.each([0, -1, 65536, 3.2, "03000", "3000x", "", "1e3"])("rejects invalid port %s", (port) => {
    const { configDir } = fixture();
    expect(run("process.stdout.write(JSON.stringify({ value: core.parsePort(input.port) }));", { configDir, port }).error).toMatch(/port/i);
  });

  it("adds one exact extension origin idempotently without rotating credentials", () => {
    const { configDir } = fixture(); const first = create(configDir);
    const id = "abcdefghijklmnopabcdefghijklmnop";
    const add = () => run("process.stdout.write(JSON.stringify(core.addLocalExtension({ configDir: input.configDir, extensionId: input.id })));", { configDir, id });
    expect(add().config.CORS_ALLOWED_ORIGINS).toBe("http://127.0.0.1:3000,chrome-extension://" + id);
    const bytes = readFileSync(join(configDir, "local.env"));
    expect(add().config.APP_ACCESS_TOKEN).toBe(first.config.APP_ACCESS_TOKEN);
    expect(readFileSync(join(configDir, "local.env"))).toEqual(bytes);
    for (const invalid of ["a".repeat(31), "q".repeat(32), "A".repeat(32), "chrome-extension://" + id]) {
      expect(run("core.addLocalExtension({ configDir: input.configDir, extensionId: input.id });", { configDir, id: invalid }).error).toMatch(/extension/i);
    }
  });
});

describe("local CLI isolation", () => {
  it("pins all later calls to the verified daemon even if the active context changes", () => {
    const { root, configDir } = fixture();
    const result = run(`
      let currentEndpoint = "unix:///verified/docker.sock";
      const targets = [], errors = [];
      const status = await runLocalCommand({ argv: ["setup"], configDir: input.configDir,
        repoRoot: input.root, nodeVersion: "22.22.2",
        env: { DOCKER_CONTEXT: "local", DOCKER_HOST: "unix:///other/docker.sock" },
        stdout: () => {}, stderr: value => errors.push(value),
        run: (command, args, options) => {
          if (args[0] === "context") {
            currentEndpoint = "ssh://remote.example";
            return { status: 0, stdout: JSON.stringify("unix:///verified/docker.sock") };
          }
          const target = args[0] === "--host" ? args[1] : currentEndpoint;
          targets.push({ target, host: options.env.DOCKER_HOST, context: options.env.DOCKER_CONTEXT });
          return { status: 0, stdout: args.includes("--help") ? "--wait --wait-timeout" : "ok" };
        } });
      process.stdout.write(JSON.stringify({ status, targets, errors }));
    `, { root, configDir });
    expect(result.status).toBe(0);
    expect(result.targets.length).toBeGreaterThanOrEqual(3);
    for (const target of result.targets) expect(target).toEqual({ target: "unix:///verified/docker.sock" });
  });

  function cli(configDir: string, scenario: Record<string, unknown> = {}) {
    return run(`
      const calls = [], output = [], errors = [];
      const status = await runLocalCommand({ argv: input.argv ?? ["setup"], configDir: input.configDir,
        repoRoot: input.repoRoot, nodeVersion: input.nodeVersion ?? "22.22.2", env: input.env ?? {},
        stdout: value => output.push(value), stderr: value => errors.push(value),
        run: (command, args, options) => {
          if (args[0] === "--host") args = args.slice(2);
          calls.push({ command, args, env: options.env });
          if (input.fail && args.includes(input.fail) && (!input.payload || args.includes("--build"))) return { status: 1, stdout: input.payload ?? "", stderr: "RAW_SECRET_DATABASE_URL" };
          if (args[0] === "context") return { status: 0, stdout: JSON.stringify(input.endpoint ?? "unix:///var/run/docker.sock") };
          if (args.includes("--help")) return { status: 0, stdout: input.noWait ? "" : "--wait --wait-timeout" };
          return { status: 0, stdout: "ok" };
        } });
      process.stdout.write(JSON.stringify({ status, calls, output, errors }));
    `, { configDir, repoRoot: join(configDir, ".."), ...scenario });
  }

  it("isolates every Compose call and only prints the URL and token instruction", () => {
    const { configDir } = fixture();
    const result = cli(configDir, { argv: ["setup", "--port", "3107"], env: { COMPOSE_FILE: "hostile.yaml", COMPOSE_PROJECT_NAME: "production", DATABASE_URL: "private-external", APP_ACCESS_TOKEN: "ambient-secret", POSTGRES_PASSWORD: "ambient-password", KEEP_ME: "yes" } });
    expect(result.status).toBe(0);
    expect(result.output.slice(-2)).toEqual(["http://127.0.0.1:3107", "npm run local:token"]);
    expect(result.output.join("\n")).not.toMatch(/ambient-secret|ambient-password|private-external/);
    const composeCalls = result.calls.filter((call: { args: string[] }) => call.args[0] === "compose");
    expect(composeCalls.length).toBeGreaterThan(0);
    for (const call of composeCalls) {
      expect(call.args.slice(1, 5)).toEqual(["--file", join(configDir, "../compose.yaml"), "--env-file", join(configDir, "local.env")]);
      expect(call.args[5]).toBe("--project-name");
      expect(call.args[6]).toMatch(/^jobtracker-[a-f0-9]{12}$/);
      expect(call.env).toEqual({ KEEP_ME: "yes", BUILDX_BUILDER: "default" });
    }
    expect(composeCalls.at(-1).args.slice(7)).toEqual(["up", "--build", "--wait", "--wait-timeout", "180"]);
  });

  it("forces every Docker call to use the local default Buildx builder", () => {
    const { configDir } = fixture();
    const result = cli(configDir, { env: {
      BUILDX_BUILDER: "remote-cloud", BUILDX_CONFIG: "/private/buildx", BUILDKIT_HOST: "tcp://remote.example:1234",
      KEEP_ME: "yes",
    } });
    expect(result.status).toBe(0);
    expect(result.calls.length).toBeGreaterThan(0);
    for (const call of result.calls) {
      expect(call.env.BUILDX_BUILDER).toBe("default");
      expect(call.env.BUILDX_CONFIG).toBeUndefined();
      expect(call.env.BUILDKIT_HOST).toBeUndefined();
      expect(call.env.KEEP_ME).toBe("yes");
    }
  });

  it.each(["21.9.0", "22.22.1", "23.0.0", "24.0.0"])("rejects unsupported Node %s before Docker or file creation", (nodeVersion) => {
    const { configDir } = fixture(); const result = cli(configDir, { nodeVersion });
    expect(result.status).toBe(1); expect(result.calls).toEqual([]); expect(result.errors.join()).toMatch(/22\.22\.2/);
  });

  it.each([
    { env: { DOCKER_HOST: "tcp://remote.example:2375" } },
    { endpoint: "ssh://remote.example" },
    { noWait: true },
    { fail: "info" },
    { fail: "up" },
  ])("sanitizes tool and locality failure diagnostics: %j", (scenario) => {
    const { configDir } = fixture(); const result = cli(configDir, scenario);
    expect(result.status).toBe(1);
    expect(result.output.join()).not.toMatch(/http:\/\/127\.0\.0\.1|RAW_SECRET|remote\.example/);
    expect(result.errors.join()).not.toMatch(/RAW_SECRET|remote\.example/);
    expect(result.errors.join().length).toBeGreaterThan(10);
  });

  it("reports bounded Docker failure context after removing managed secrets", () => {
    const { configDir } = fixture(); const { config } = create(configDir);
    const dbUrl = config.DATABASE_URL;
    const payload = `${"ordinary output ".repeat(500)}${config.APP_ACCESS_TOKEN} ${config.ENCRYPTION_SECRET} ${config.POSTGRES_PASSWORD} ${dbUrl}\nhttps://:synthetic-password@example.invalid/build\nhttps://user%3Aencoded-password@example.invalid/encoded\nhttps://user:raw-password@leftover-password@example.invalid/raw\nNo space left on device\u001b[31m`;
    const result = cli(configDir, { fail: "up", payload });
    expect(result.status).toBe(1);
    const diagnostic = result.errors.join("\n");
    for (const secret of [config.APP_ACCESS_TOKEN, config.ENCRYPTION_SECRET, config.POSTGRES_PASSWORD, dbUrl]) {
      expect(diagnostic).not.toContain(secret);
    }
    for (const secret of ["synthetic-password", "encoded-password", "raw-password", "leftover-password"]) {
      expect(diagnostic).not.toContain(secret);
    }
    expect(diagnostic).toContain("https://[REDACTED]@example.invalid/build");
    expect(diagnostic).toContain("https://[REDACTED]@example.invalid/encoded");
    expect(diagnostic).toContain("https://[REDACTED]@example.invalid/raw");
    expect(diagnostic).toContain("exit code 1");
    expect(diagnostic).toContain("No space left on device");
    expect(diagnostic).not.toContain("\u001b");
    expect(diagnostic.length).toBeLessThan(5000);
  });

  it("keeps failed setup configuration byte-identical on retry", () => {
    const { configDir } = fixture(); expect(cli(configDir, { fail: "up" }).status).toBe(1);
    const before = readFileSync(join(configDir, "local.env"));
    expect(cli(configDir).status).toBe(0);
    expect(readFileSync(join(configDir, "local.env"))).toEqual(before);
  });

  it("only token explicitly reveals a secret and stop never removes a volume", () => {
    const { configDir } = fixture(); const { config } = create(configDir);
    const token = cli(configDir, { argv: ["token"] });
    expect(token.output).toEqual([config.APP_ACCESS_TOKEN]); expect(token.calls).toEqual([]);
    const stop = cli(configDir, { argv: ["stop"] });
    expect(stop.status).toBe(0); expect(stop.calls.at(-1).args.slice(7)).toEqual(["stop"]);
    const extension = cli(configDir, { argv: ["extension", "a".repeat(32)] });
    expect(extension.status).toBe(0);
    expect(extension.calls.at(-1).args.slice(7)).toEqual(["up", "--detach", "--no-deps", "--force-recreate", "--wait", "--wait-timeout", "180", "app"]);
  });
});
