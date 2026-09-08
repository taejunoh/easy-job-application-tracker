import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
const REPOSITORY_ROOT = process.cwd();
const REVIEWED_PATHS = [
  "prisma/schema.prisma", "prisma/migrations", "prisma.config.ts",
  "src/lib/applications/backfill.ts", "src/lib/applications/identity.ts",
] as const;
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

describe("isolated validation preflight", () => {
  it("runs the CLI against a real temporary Git checkout and reports malformed arguments without a stack", async () => {
    await temporary(async (directory) => {
      const { repository, scriptPath, sourceSha } = await fixtureRepository(directory);
      const inputs = await cliInputs(directory, sourceSha);
      const cli = await runCli(scriptPath, repository, inputs);
      expect(cli.stdout).toBe("Isolated validation preflight passed.\n");
      expect(cli.stderr).toBe("");
      expect(JSON.parse(await readFile(inputs.reportPath, "utf8")).sourceSha).toBe(sourceSha);
      expect((await lstat(inputs.reportPath)).mode & 0o777).toBe(0o600);
      const gitProbe = await execFile("node", ["--input-type=module", "-e", `import { realGit } from ${JSON.stringify(pathToFileURL(scriptPath).href)}; const result = await realGit(["rev-parse", "HEAD"]); process.stdout.write(result.stdout);`], { cwd: repository });
      expect(gitProbe.stdout).toBe(`${sourceSha}\n`);
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
      const deny = await cliInputs(directory, sourceSha, { ...manifest, vercelProjectId: "prj_production" });
      const denyResult = await runCli(scriptPath, repository, deny);
      expect(denyResult.code).toBe(1);
      expect(denyResult.stderr).toBe("Isolated validation preflight refused.\n");
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
