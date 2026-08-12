import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createQuarantineFixture,
  prepareQuarantinedFixture,
  spawnLifecycleChild,
} from "../fixtures/quarantine/quarantine-test-harness";

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function run(args: string[]) {
  return spawnSync("npm", ["run", "cleanup:quarantine", "--", ...args], {
    cwd: join(__dirname, "../.."), encoding: "utf8",
    env: { ...process.env, npm_config_loglevel: "silent" },
  });
}

function inspectArgs(fixture: ReturnType<typeof createQuarantineFixture>) {
  return [
    "inspect", "--repo-root", fixture.repoRoot, "--quarantine-root", fixture.quarantineRoot,
    "--expected-branch", fixture.branch, "--expected-head", fixture.head,
    "--expected-count", String(fixture.expectedCount),
  ];
}

function applyArgs(fixture: ReturnType<typeof createQuarantineFixture>) {
  return [...inspectArgs(fixture).map((value) => value === "inspect" ? "apply" : value), "--writers-stopped"];
}

describe("quarantine cleanup CLI", () => {
  it("runs the canonical inspect npm form and emits its exact public record", () => {
    const fixture = createQuarantineFixture();
    bases.push(fixture.base);

    const result = run(inspectArgs(fixture));

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.match(/\n/g)).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true, command: "inspect", status: "INSPECTED", sourceCopies: 1,
      generatedRoots: 2, identicalCopies: 1, divergentCopies: 0,
    });
  });

  it("runs apply then mark-validated through their canonical npm forms", () => {
    const fixture = createQuarantineFixture();
    bases.push(fixture.base);

    const applied = run(applyArgs(fixture));
    const records = applied.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(applied.status).toBe(0);
    expect(applied.stderr).toBe("");
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(expect.objectContaining({ ok: true, command: "apply", status: "STARTING" }));
    expect(records[0].transactionId).toMatch(/^cli-[0-9a-f-]{36}$/u);
    expect(records[1]).toEqual(expect.objectContaining({
      ok: true, command: "apply", status: "QUARANTINED", transactionId: records[0].transactionId,
      movedEntries: 3,
    }));
    mkdirSync(join(fixture.repoRoot, ".next"), { mode: 0o700 });
    mkdirSync(join(fixture.repoRoot, "node_modules"), { mode: 0o700 });
    writeFileSync(join(fixture.repoRoot, ".next", "build"), "ignored");
    writeFileSync(join(fixture.repoRoot, "node_modules", "package"), "ignored");

    const validated = run([
      "mark-validated", "--repo-root", fixture.repoRoot, "--quarantine-root", fixture.quarantineRoot,
      "--transaction-id", records[0].transactionId, "--writers-stopped",
    ]);
    expect(validated.status).toBe(0);
    expect(validated.stderr).toBe("");
    expect(JSON.parse(validated.stdout)).toEqual(expect.objectContaining({
      ok: true, command: "mark-validated", status: "VALIDATED", transactionId: records[0].transactionId,
      deletionRequiresConfirmation: true,
    }));
  });

  it("runs restore through its canonical npm form", () => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);

    const result = run([
      "restore", "--repo-root", prepared.fixture.repoRoot, "--quarantine-root", prepared.fixture.quarantineRoot,
      "--transaction-id", prepared.transactionId, "--writers-stopped",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      ok: true, command: "restore", status: "RESTORED", transactionId: prepared.transactionId,
      restoredEntries: 3,
    }));
  });

  it.each(["resume", "rollback"] as const)("runs recover %s through its canonical npm form", (action) => {
    const prepared = prepareQuarantinedFixture({ regenerate: false });
    bases.push(prepared.fixture.base);

    const result = run([
      "recover", "--repo-root", prepared.fixture.repoRoot, "--quarantine-root", prepared.fixture.quarantineRoot,
      "--transaction-id", prepared.transactionId, "--action", action, "--writers-stopped",
    ]);

    expect(result.status).toBe(action === "resume" ? 0 : 2);
    if (action === "resume") {
      expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
        ok: true, command: "recover", result: expect.objectContaining({ status: "QUARANTINED", action: "resume" }),
      }));
      expect(result.stderr).toBe("");
    } else {
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toEqual({ ok: false, command: "recover", code: "ERR_USAGE", message: "Invalid quarantine request." });
    }
  });

  it("routes an interrupted restore recovery through the canonical npm form", async () => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);
    const options = {
      repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
      transactionId: prepared.transactionId, writersStopped: true,
    };
    expect((await spawnLifecycleChild("restoreQuarantine", options, {
      killAt: "after-event:RESTORE_PREPARED",
    })).signal).toBe("SIGKILL");
    rmSync(join(prepared.runRoot, "journal.lock"));

    const result = run([
      "recover", "--repo-root", prepared.fixture.repoRoot, "--quarantine-root", prepared.fixture.quarantineRoot,
      "--transaction-id", prepared.transactionId, "--action", "resume", "--writers-stopped",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      ok: true, command: "recover", result: expect.objectContaining({ status: "RESTORED", action: "resume" }),
    }));
  });

  it("converts recovery conflicts to ERR_CONFLICT without exposing entry identifiers", async () => {
    const prepared = prepareQuarantinedFixture();
    bases.push(prepared.fixture.base);
    const options = {
      repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
      transactionId: prepared.transactionId, writersStopped: true,
    };
    expect((await spawnLifecycleChild("restoreQuarantine", options, {
      killAt: "after-event:RESTORE_INTENT:copy-0001",
    })).signal).toBe("SIGKILL");
    rmSync(join(prepared.runRoot, "journal.lock"));
    writeFileSync(join(prepared.fixture.repoRoot, "notes 2.txt"), "canonical\n");

    const result = run([
      "recover", "--repo-root", prepared.fixture.repoRoot, "--quarantine-root", prepared.fixture.quarantineRoot,
      "--transaction-id", prepared.transactionId, "--action", "resume", "--writers-stopped",
    ]);

    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false, command: "recover", code: "ERR_CONFLICT", message: "Quarantine recovery has unresolved conflicts.",
    });
    expect(result.stderr).not.toContain("copy-0001");
  });

  it("rejects malformed commands and invalid parser inputs without leaking raw tokens", () => {
    const fixture = createQuarantineFixture();
    bases.push(fixture.base);
    const sensitive = "https://user:secret@example.invalid/path?authorization=Bearer+raw";
    const cases = [
      ["unknown", sensitive],
      [...inspectArgs(fixture), "--expected-count", "2"],
      [...inspectArgs(fixture), "--writers-stopped"],
      ["inspect", "--repo-root", "relative", "--quarantine-root", fixture.quarantineRoot, "--expected-branch", fixture.branch, "--expected-head", fixture.head, "--expected-count", "1"],
      ["recover", "--repo-root", fixture.repoRoot, "--quarantine-root", fixture.quarantineRoot, "--transaction-id", "550e8400-e29b-41d4-a716-446655440000", "--action", "resume", "--writers-stopped"],
    ];
    for (const args of cases) {
      const result = run(args);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      const failure = JSON.parse(result.stderr);
      expect(failure).toMatchObject({ ok: false, code: "ERR_USAGE", message: "Invalid quarantine request." });
      expect(result.stderr).not.toContain(sensitive);
      if (args[0] === "unknown") expect(failure.command).toBeNull();
    }
  });

  it("requires writers-stopped for every mutating command", () => {
    const fixture = createQuarantineFixture();
    bases.push(fixture.base);
    const missingAttestation = [
      applyArgs(fixture).slice(0, -1),
      ["recover", "--repo-root", fixture.repoRoot, "--quarantine-root", fixture.quarantineRoot, "--transaction-id", "tx-1", "--action", "resume"],
      ["mark-validated", "--repo-root", fixture.repoRoot, "--quarantine-root", fixture.quarantineRoot, "--transaction-id", "tx-1"],
      ["restore", "--repo-root", fixture.repoRoot, "--quarantine-root", fixture.quarantineRoot, "--transaction-id", "tx-1"],
    ];
    for (const args of missingAttestation) {
      const result = run(args);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "ERR_USAGE" });
    }
  });

  it("uses direct node execution only in this internal harness", () => {
    const fixture = createQuarantineFixture();
    bases.push(fixture.base);
    const result = spawnSync(process.execPath, ["scripts/quarantine-numbered-copies.mjs", ...inspectArgs(fixture)], {
      cwd: join(__dirname, "../.."), encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, command: "inspect" });
    expect(existsSync(fixture.quarantineRoot)).toBe(true);
  });
});
