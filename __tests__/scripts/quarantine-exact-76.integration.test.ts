import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { git, invokeQuarantineWorker, privateDirectory } from "../fixtures/quarantine/quarantine-test-harness";

type ExactFixture = {
  base: string;
  repoRoot: string;
  quarantineRoot: string;
  branch: string;
  head: string;
  numberedPaths: string[];
  tempPaths: string[];
};

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function alphaNumericSuffix(index: number) {
  return index.toString(36).toUpperCase().padStart(6, "0");
}

function createExactFixture(): ExactFixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "quarantine-exact-76-")));
  chmodSync(base, 0o700);
  bases.push(base);
  const repoRoot = join(base, "repo");
  const quarantineRoot = join(base, "quarantine");
  privateDirectory(repoRoot);
  privateDirectory(quarantineRoot);
  git(repoRoot, "init", "-b", "release-proof");
  git(repoRoot, "config", "user.name", "Release Proof");
  git(repoRoot, "config", "user.email", "release-proof@example.invalid");
  writeFileSync(join(repoRoot, ".gitignore"), ".next/\nnode_modules/\n");

  const numberedPaths: string[] = [];
  for (let index = 1; index <= 37; index += 1) {
    const directory = `slice-${String(Math.ceil(index / 10)).padStart(2, "0")}`;
    const canonical = `${directory}/artifact-${String(index).padStart(2, "0")}.txt`;
    const numbered = `${directory}/artifact-${String(index).padStart(2, "0")} 2.txt`;
    mkdirSync(dirname(join(repoRoot, canonical)), { recursive: true });
    writeFileSync(join(repoRoot, canonical), `original-${index}\n`);
    numberedPaths.push(numbered);
  }
  git(repoRoot, "add", ".gitignore", "slice-01", "slice-02", "slice-03", "slice-04");
  git(repoRoot, "commit", "-m", "canonical fixture");
  for (let index = 34; index <= 37; index += 1) {
    const directory = `slice-${String(Math.ceil(index / 10)).padStart(2, "0")}`;
    const canonical = `${directory}/artifact-${String(index).padStart(2, "0")}.txt`;
    writeFileSync(join(repoRoot, canonical), `current-${index}\n`);
  }
  git(repoRoot, "add", "slice-04");
  git(repoRoot, "commit", "-m", "diverge four canonical files");
  for (let index = 1; index <= 37; index += 1) {
    const numbered = numberedPaths[index - 1];
    writeFileSync(join(repoRoot, numbered), `original-${index}\n`);
  }

  const tempPaths: string[] = [];
  for (let index = 1; index <= 39; index += 1) {
    const relativePath = `temp-${String(Math.ceil(index / 10)).padStart(2, "0")}/.BC.T_${alphaNumericSuffix(index)}`;
    mkdirSync(dirname(join(repoRoot, relativePath)), { recursive: true });
    writeFileSync(join(repoRoot, relativePath), "", { mode: 0o600 });
    chmodSync(join(repoRoot, relativePath), 0o600);
    tempPaths.push(relativePath);
  }
  privateDirectory(join(repoRoot, ".next"));
  privateDirectory(join(repoRoot, "node_modules"));
  writeFileSync(join(repoRoot, ".next", "build"), "original-build\n");
  writeFileSync(join(repoRoot, "node_modules", "package"), "original-dependency\n");
  return {
    base,
    repoRoot,
    quarantineRoot,
    branch: git(repoRoot, "symbolic-ref", "--short", "HEAD"),
    head: git(repoRoot, "rev-parse", "HEAD"),
    numberedPaths,
    tempPaths,
  };
}

function runCli(args: string[]) {
  const env = { ...process.env };
  delete env.npm_config_loglevel;
  const result = spawnSync("npm", ["run", "cleanup:quarantine", "--", ...args], {
    cwd: join(__dirname, "../.."),
    encoding: "utf8",
    env,
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

function discoveryArgs(fixture: ExactFixture, command: "inspect" | "apply") {
  return [
    command,
    "--repo-root", fixture.repoRoot,
    "--quarantine-root", fixture.quarantineRoot,
    "--expected-branch", fixture.branch,
    "--expected-head", fixture.head,
    "--expected-count", "76",
  ];
}

function lifecycleArgs(
  fixture: ExactFixture,
  command: "mark-validated" | "reconcile" | "restore",
) {
  return [
    command,
    "--repo-root", fixture.repoRoot,
    "--quarantine-root", fixture.quarantineRoot,
    "--transaction-id", "release-proof-76",
    "--writers-stopped",
  ];
}

function regenerateStableRoots(fixture: ExactFixture) {
  privateDirectory(join(fixture.repoRoot, ".next"));
  privateDirectory(join(fixture.repoRoot, "node_modules"));
  writeFileSync(join(fixture.repoRoot, ".next", "build"), "regenerated-build-is-byte-different\n");
  writeFileSync(join(fixture.repoRoot, "node_modules", "package"), "regenerated-dependency-is-byte-different\n");
}

describe("exact disposable 76-record quarantine proof", () => {
  it("inspects, applies, validates stable regenerated roots, resumes, and restores all 78 entries", () => {
    const fixture = createExactFixture();
    expect(git(fixture.repoRoot, "status", "--porcelain=v1", "--untracked-files=all")
      .split("\n").filter(Boolean)).toHaveLength(76);

    const inspected = runCli(discoveryArgs(fixture, "inspect"));
    if (inspected.status !== 0) throw new Error(inspected.stderr);
    expect(inspected.status).toBe(0);
    expect(JSON.parse(inspected.stdout)).toEqual({
      ok: true,
      command: "inspect",
      status: "INSPECTED",
      schemaVersion: 2,
      sourceCopies: 37,
      tempResidues: 39,
      generatedRoots: 2,
      identicalCopies: 33,
      divergentCopies: 4,
    });

    const applied = runCli([
      ...discoveryArgs(fixture, "apply"),
      "--transaction-id", "release-proof-76",
      "--writers-stopped",
    ]);
    expect(applied.status).toBe(0);
    const applyRecords = applied.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(applyRecords).toEqual([
      { ok: true, command: "apply", status: "STARTING", schemaVersion: 2, transactionId: "release-proof-76" },
      {
        ok: true,
        command: "apply",
        status: "QUARANTINED",
        schemaVersion: 2,
        transactionId: "release-proof-76",
        movedEntries: 78,
        manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    ]);
    expect(fixture.numberedPaths.every((path) => !existsSync(join(fixture.repoRoot, path)))).toBe(true);
    expect(fixture.tempPaths.every((path) => !existsSync(join(fixture.repoRoot, path)))).toBe(true);

    const quarantinedReconcile = runCli(lifecycleArgs(fixture, "reconcile"));
    expect(quarantinedReconcile.status).toBe(0);
    expect(JSON.parse(quarantinedReconcile.stdout)).toEqual({
      ok: true,
      command: "reconcile",
      schemaVersion: 1,
      state: "QUARANTINED",
      complete: false,
      nextAction: "mark_validated",
    });

    regenerateStableRoots(fixture);
    const validated = runCli(lifecycleArgs(fixture, "mark-validated"));
    expect(validated.status).toBe(0);
    const validationRecord = JSON.parse(validated.stdout);
    expect(validationRecord).toMatchObject({
      ok: true,
      command: "mark-validated",
      status: "VALIDATED",
      schemaVersion: 2,
      transactionId: "release-proof-76",
      deletionRequiresConfirmation: true,
    });
    expect(Date.parse(validationRecord.deleteAfter) - Date.parse(validationRecord.validatedAt))
      .toBe(4 * 24 * 60 * 60 * 1000);

    const runRoot = join(fixture.quarantineRoot, "release-proof-76");
    const manifest = JSON.parse(readFileSync(
      join(runRoot, "manifests", `${validationRecord.manifestSha256}.json`),
      "utf8",
    ));
    expect(manifest).toMatchObject({ schemaVersion: 2, state: "VALIDATED", retentionDays: 4 });
    expect(manifest.entries).toHaveLength(78);
    expect(manifest.validationAttempt).toMatch(/^attempt-[0-9a-f-]{36}$/u);
    expect(Object.keys(manifest.regeneratedEvidence).sort()).toEqual([
      "generated-next",
      "generated-node-modules",
    ]);

    const validatedReconcile = runCli(lifecycleArgs(fixture, "reconcile"));
    expect(validatedReconcile.status).toBe(0);
    expect(JSON.parse(validatedReconcile.stdout)).toEqual({
      ok: true,
      command: "reconcile",
      schemaVersion: 1,
      state: "VALIDATED",
      complete: false,
      nextAction: "retain_and_review",
    });

    const resumed = runCli([
      "recover",
      "--repo-root", fixture.repoRoot,
      "--quarantine-root", fixture.quarantineRoot,
      "--transaction-id", "release-proof-76",
      "--action", "resume",
      "--writers-stopped",
    ]);
    if (resumed.status !== 0) throw new Error(resumed.stderr);
    expect(resumed.status).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      ok: true,
      command: "recover",
      result: { schemaVersion: 2, status: "VALIDATED", action: "resume", reconciledEntries: 0 },
    });

    const restored = runCli(lifecycleArgs(fixture, "restore"));
    expect(restored.status).toBe(0);
    expect(JSON.parse(restored.stdout)).toMatchObject({
      ok: true,
      command: "restore",
      status: "RESTORED",
      schemaVersion: 2,
      restoredEntries: 78,
    });
    expect(fixture.numberedPaths.every((path) => existsSync(join(fixture.repoRoot, path)))).toBe(true);
    for (const path of fixture.tempPaths) {
      expect(readFileSync(join(fixture.repoRoot, path))).toHaveLength(0);
      expect(statSync(join(fixture.repoRoot, path)).mode & 0o7777).toBe(0o600);
    }
    expect(readFileSync(join(fixture.repoRoot, ".next", "build"), "utf8")).toBe("original-build\n");
    expect(readFileSync(join(fixture.repoRoot, "node_modules", "package"), "utf8"))
      .toBe("original-dependency\n");

    const restoredReconcile = runCli(lifecycleArgs(fixture, "reconcile"));
    expect(restoredReconcile.status).toBe(0);
    expect(JSON.parse(restoredReconcile.stdout)).toEqual({
      ok: true,
      command: "reconcile",
      schemaVersion: 1,
      state: "RESTORED",
      complete: true,
      nextAction: "none",
    });
  }, 120_000);

  it("rolls back an interrupted exact 78-entry v2 manifest through the public CLI", () => {
    const fixture = createExactFixture();
    const interrupted = invokeQuarantineWorker("apply-stop", {
      repoRoot: fixture.repoRoot,
      quarantineRoot: fixture.quarantineRoot,
      expectedBranch: fixture.branch,
      expectedHead: fixture.head,
      expectedCount: 76,
      transactionId: "release-proof-76",
      createdAt: "2026-08-13T00:00:00.000Z",
      writersStopped: true,
      stopPhase: "after-event:MOVE_INTENT:generated-next",
    }, {}, 60_000);
    if (interrupted.error?.name !== "RangeError") throw new Error(JSON.stringify(interrupted.error));
    expect(interrupted).toMatchObject({ ok: false, error: { name: "RangeError" } });

    const rolledBack = runCli([
      "recover",
      "--repo-root", fixture.repoRoot,
      "--quarantine-root", fixture.quarantineRoot,
      "--transaction-id", "release-proof-76",
      "--action", "rollback",
      "--writers-stopped",
    ]);
    expect(rolledBack.status).toBe(0);
    expect(JSON.parse(rolledBack.stdout)).toMatchObject({
      ok: true,
      command: "recover",
      result: { schemaVersion: 2, status: "ROLLED_BACK", action: "rollback" },
    });
    expect(fixture.numberedPaths.every((path) => existsSync(join(fixture.repoRoot, path)))).toBe(true);
    expect(fixture.tempPaths.every((path) => existsSync(join(fixture.repoRoot, path)))).toBe(true);
    expect(readdirSync(join(fixture.quarantineRoot, "release-proof-76", "payload", "temp-residues")))
      .toEqual([]);
  }, 120_000);
});
