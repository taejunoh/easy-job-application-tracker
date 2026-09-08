import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFile = promisify(execFileCallback);
const REPOSITORY_ROOT = process.cwd();
let REVIEWED_PATHS: readonly string[];
let parseDenyList: (value: unknown) => unknown;
let parseManifest: (value: unknown) => unknown;
let preflight: (options: Record<string, unknown>) => Promise<unknown>;
let readPrivateJson: (path: string, expectedKind: string) => Promise<unknown>;
let realGit: (args: readonly string[]) => Promise<{ code: number | string; stdout: string; stderr: string }>;
const sha = "5e5610944698e18230c8e67378dda35d8eb311f8";
const manifest = {
  schemaVersion: 1, kind: "jobtracker-isolated-validation-manifest",
  environmentId: "4b76205d-6f41-4ed8-9b0f-2f31785a6f13", sourceSha: sha,
  vercelProjectId: "prj_isolated_preview", neonOrganizationId: "org_isolated_free",
  database: { projectId: "neon_isolated_project", branchId: "br_isolated_branch", endpointId: "ep_isolated_endpoint", host: "ep-isolated.example.neon.tech", port: 5432, database: "neondb" },
};
const denyList = {
  schemaVersion: 1, kind: "jobtracker-production-deny-list",
  vercelProjectIds: ["prj_production"], neonOrganizationIds: ["org_production"],
  neonProjectIds: ["neon_production"], databaseHosts: ["ep-production.example.neon.tech"],
};

async function temporary<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "isolated-preflight-"));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function privateJson(directory: string, name: string, value: unknown): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

async function fixtureRepository(directory: string, missingPath?: string) {
  const repository = join(directory, "repo");
  await execFile("git", ["init", "-q", repository]);
  await execFile("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  await execFile("git", ["-C", repository, "config", "user.name", "Isolated Test"]);
  for (const path of REVIEWED_PATHS) {
    if (path === missingPath) continue;
    const target = join(repository, path, path.endsWith("migrations") ? "20260908_init/migration.sql" : "");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "fixture\n");
  }
  const scriptPath = join(repository, "scripts/validate-isolated-preflight.mjs");
  await mkdir(dirname(scriptPath), { recursive: true });
  await copyFile(join(REPOSITORY_ROOT, "scripts/validate-isolated-preflight.mjs"), scriptPath);
  await execFile("git", ["-C", repository, "add", "."]);
  await execFile("git", ["-C", repository, "commit", "-qm", "fixture"]);
  const { stdout } = await execFile("git", ["-C", repository, "rev-parse", "HEAD"]);
  return { repository, scriptPath, sourceSha: stdout.trim() };
}

async function cliInputs(directory: string, sourceSha: string, candidate = manifest) {
  return {
    manifestPath: await privateJson(directory, "manifest.json", { ...candidate, sourceSha }),
    denyListPath: await privateJson(directory, "deny-list.json", denyList),
    reportPath: join(directory, "report.json"),
    sourceSha,
  };
}

async function runCli(scriptPath: string, repository: string, inputs: Awaited<ReturnType<typeof cliInputs>>) {
  return execFile("node", [scriptPath, "--manifest", inputs.manifestPath, "--deny-list", inputs.denyListPath, "--report", inputs.reportPath, "--source-sha", inputs.sourceSha], { cwd: repository }).catch((error) => error);
}

function git(events: string[], options: { diffCode?: number; status?: string; missingPath?: string } = {}) {
  return async (args: readonly string[]) => {
    events.push(args.join(" "));
    if (args[0] === "diff") return { code: options.diffCode ?? 0, stdout: "", stderr: "private-diff-sentinel" };
    if (args[0] === "status") return { code: 0, stdout: options.status ?? "", stderr: "" };
    if (args[0] === "cat-file" && args[1] === "-e" && args[2]?.includes(":")) {
      return { code: args[2].endsWith(`:${options.missingPath}`) ? 1 : 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("isolated validation preflight", () => {
  beforeAll(async () => {
    const loaded = await new Function("specifier", "return import(specifier)")("../../scripts/validate-isolated-preflight.mjs");
    REVIEWED_PATHS = loaded.REVIEWED_PATHS;
    parseDenyList = loaded.parseDenyList;
    parseManifest = loaded.parseManifest;
    preflight = loaded.preflight;
    readPrivateJson = loaded.readPrivateJson;
    realGit = loaded.realGit;
  });

  it("accepts a distinct manifest and writes only a redacted report", async () => {
    await temporary(async (directory) => {
      const events: string[] = [];
      const reportPath = join(directory, "report.json");
      await preflight({
        manifestPath: await privateJson(directory, "manifest.json", manifest),
        denyListPath: await privateJson(directory, "deny-list.json", denyList),
        reportPath, sourceSha: sha, git: git(events),
      });
      expect(events).toContain(`cat-file -e ${sha}^{commit}`);
      expect(events).toContain(`diff --quiet ${sha} -- ${REVIEWED_PATHS.join(" ")}`);
      expect(events).toContain(`status --porcelain=v1 --untracked-files=all -- ${REVIEWED_PATHS.join(" ")}`);
      expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual({
        schemaVersion: 1, kind: "jobtracker-isolated-validation-preflight-report",
        sourceSha: sha, manifestDigest: expect.stringMatching(/^[0-9a-f]{64}$/u), checkedPaths: REVIEWED_PATHS,
      });
      expect((await lstat(reportPath)).mode & 0o777).toBe(0o600);
    });
  });

  it("preserves stdout from successful real Git commands", async () => {
    const result = await realGit(["rev-parse", "--show-toplevel"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(REPOSITORY_ROOT);
  });

  it.each([
    ["Production Vercel project", { ...manifest, vercelProjectId: "prj_production" }],
    ["Production Neon organization", { ...manifest, neonOrganizationId: "org_production" }],
    ["Production Neon project", { ...manifest, database: { ...manifest.database, projectId: "neon_production" } }],
    ["Production database host", { ...manifest, database: { ...manifest.database, host: "ep-production.example.neon.tech" } }],
    ["unapproved SHA", { ...manifest, sourceSha: "f".repeat(40) }],
  ])("refuses %s before Git access", async (_, candidate) => {
    await temporary(async (directory) => {
      const events: string[] = [];
      await expect(preflight({
        manifestPath: await privateJson(directory, "manifest.json", candidate),
        denyListPath: await privateJson(directory, "deny-list.json", denyList),
        reportPath: join(directory, "report.json"), sourceSha: sha, git: git(events),
      })).rejects.toThrow("Isolated validation preflight refused");
      expect(events).toEqual([]);
    });
  });

  it("rejects extra fields in security-sensitive JSON", async () => {
    await expect(Promise.resolve().then(() => parseManifest({ ...manifest, secretSentinel: "do-not-leak" }))).rejects.toThrow("Isolated validation preflight refused");
    await expect(Promise.resolve().then(() => parseDenyList({ ...denyList, secretSentinel: "do-not-leak" }))).rejects.toThrow("Isolated validation preflight refused");
  });

  it("refuses symlinked, group-readable, and oversized input files", async () => {
    await temporary(async (directory) => {
      const privatePath = await privateJson(directory, "private.json", manifest);
      const linkPath = join(directory, "manifest-link.json");
      await symlink(privatePath, linkPath);
      await expect(readPrivateJson(linkPath, manifest.kind)).rejects.toThrow("Isolated validation preflight refused");
      await chmod(privatePath, 0o644);
      await expect(readPrivateJson(privatePath, manifest.kind)).rejects.toThrow("Isolated validation preflight refused");
      await writeFile(privatePath, `${JSON.stringify(manifest)}${"x".repeat(17 * 1024)}`);
      await chmod(privatePath, 0o600);
      await expect(readPrivateJson(privatePath, manifest.kind)).rejects.toThrow("Isolated validation preflight refused");
    });
  });

  it("refuses a private input whose symlinked parent resolves inside the repository", async () => {
    await temporary(async (directory) => {
      const linkParent = join(directory, "inside");
      await symlink(REPOSITORY_ROOT, linkParent);
      await expect(readPrivateJson(join(linkParent, "package.json"), "anything")).rejects.toThrow("Isolated validation preflight refused");
    });
  });

  it.each([
    ["a changed reviewed tree", { diffCode: 1 }],
    ["an unclean reviewed path", { status: " M prisma/schema.prisma\n" }],
    ["a missing reviewed path", { missingPath: "prisma.config.ts" }],
  ])("refuses %s without writing a report or leaking command output", async (_, options) => {
    await temporary(async (directory) => {
      const events: string[] = [];
      const reportPath = join(directory, "report.json");
      await expect(preflight({
        manifestPath: await privateJson(directory, "manifest.json", manifest),
        denyListPath: await privateJson(directory, "deny-list.json", denyList),
        reportPath, sourceSha: sha, git: git(events, options),
      })).rejects.toThrow("Isolated validation preflight refused");
      await expect(readFile(reportPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.stringify(events)).not.toContain("private-diff-sentinel");
    });
  });

  it("preserves an existing report when the preflight refuses", async () => {
    await temporary(async (directory) => {
      const reportPath = join(directory, "report.json");
      await writeFile(reportPath, "existing-report-secret", { mode: 0o644 });
      await expect(preflight({
        manifestPath: await privateJson(directory, "manifest.json", manifest),
        denyListPath: await privateJson(directory, "deny-list.json", denyList),
        reportPath, sourceSha: sha, git: git([], { diffCode: 1 }),
      })).rejects.toThrow("Isolated validation preflight refused");
      expect(await readFile(reportPath, "utf8")).toBe("existing-report-secret");
    });
  });

  it("runs the CLI against a real temporary Git checkout and reports malformed arguments without a stack", async () => {
    await temporary(async (directory) => {
      const { repository, scriptPath, sourceSha } = await fixtureRepository(directory);
      const inputs = await cliInputs(directory, sourceSha);
      const cli = await runCli(scriptPath, repository, inputs);
      expect(cli.stdout).toBe("Isolated validation preflight passed.\n");
      expect(cli.stderr).toBe("");
      expect(JSON.parse(await readFile(inputs.reportPath, "utf8")).sourceSha).toBe(sourceSha);
      expect((await lstat(inputs.reportPath)).mode & 0o777).toBe(0o600);
      await expect(execFile("node", [scriptPath, "--manifest"], { cwd: repository })).rejects.toMatchObject({ code: 1, stderr: "Isolated validation preflight refused.\n" });
    });
  });

  it.each([
    ["a missing reviewed path", "missing"],
    ["a changed reviewed path", "changed"],
    ["an untracked reviewed path", "untracked"],
  ])("refuses %s in a real temporary Git checkout", async (_, scenario) => {
    await temporary(async (directory) => {
      const { repository, scriptPath, sourceSha } = await fixtureRepository(directory, scenario === "missing" ? "prisma.config.ts" : undefined);
      if (scenario === "changed") await writeFile(join(repository, "prisma/schema.prisma"), "changed\n");
      if (scenario === "untracked") await writeFile(join(repository, "prisma/migrations/untracked/migration.sql"), "untracked\n").catch(async () => {
        await mkdir(join(repository, "prisma/migrations/untracked"), { recursive: true });
        await writeFile(join(repository, "prisma/migrations/untracked/migration.sql"), "untracked\n");
      });
      const inputs = await cliInputs(directory, sourceSha);
      const result = await runCli(scriptPath, repository, inputs);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Isolated validation preflight refused.\n");
      await expect(readFile(inputs.reportPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects extra and oversized security-sensitive inputs without leaking a sentinel", async () => {
    await temporary(async (directory) => {
      const { repository, scriptPath, sourceSha } = await fixtureRepository(directory);
      const extra = await cliInputs(directory, sourceSha, { ...manifest, secretSentinel: "do-not-leak" } as typeof manifest & { secretSentinel: string });
      const extraResult = await runCli(scriptPath, repository, extra);
      expect(extraResult.code).toBe(1);
      expect(extraResult.stderr).toBe("Isolated validation preflight refused.\n");
      expect(extraResult.stderr).not.toContain("do-not-leak");
      const oversizedManifestPath = join(directory, "oversized.json");
      await writeFile(oversizedManifestPath, `${JSON.stringify({ ...manifest, sourceSha })}${"x".repeat(17 * 1024)}`, { mode: 0o600 });
      const oversized = { ...extra, manifestPath: oversizedManifestPath };
      const oversizedResult = await runCli(scriptPath, repository, oversized);
      expect(oversizedResult.code).toBe(1);
      expect(oversizedResult.stderr).toBe("Isolated validation preflight refused.\n");
    });
  });

  it("preserves an existing report when a real CLI preflight refuses", async () => {
    await temporary(async (directory) => {
      const { repository, scriptPath, sourceSha } = await fixtureRepository(directory);
      const inputs = await cliInputs(directory, sourceSha);
      await writeFile(inputs.reportPath, "existing-report-secret", { mode: 0o644 });
      const result = await runCli(scriptPath, repository, inputs);
      expect(result.code).toBe(1);
      expect(await readFile(inputs.reportPath, "utf8")).toBe("existing-report-secret");
    });
  });

  it("refuses invocation from an unsupported cwd and canonical paths through a repository symlink", async () => {
    await temporary(async (directory) => {
      const { repository, scriptPath, sourceSha } = await fixtureRepository(directory);
      const inputs = await cliInputs(directory, sourceSha);
      const outsideResult = await runCli(scriptPath, directory, inputs);
      expect(outsideResult.code).toBe(1);
      const linkParent = join(directory, "repo-link");
      await symlink(repository, linkParent);
      const repositoryManifest = join(repository, "scripts/manifest-link.json");
      await writeFile(repositoryManifest, JSON.stringify({ ...manifest, sourceSha }), { mode: 0o600 });
      const linkedInputs = { ...inputs, manifestPath: join(linkParent, "scripts/manifest-link.json") };
      const linkedResult = await runCli(scriptPath, repository, linkedInputs);
      expect(linkedResult.code).toBe(1);
      expect(linkedResult.stderr).toBe("Isolated validation preflight refused.\n");
    });
  });
});
