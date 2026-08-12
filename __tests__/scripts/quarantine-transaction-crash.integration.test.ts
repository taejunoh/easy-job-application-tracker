import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createQuarantineFixture, type Fixture } from "../fixtures/quarantine/quarantine-test-harness";

const child = join(__dirname, "../fixtures/quarantine/quarantine-lifecycle-child.mjs");

function applyOptions(f: Fixture, transactionId: string, createdAt: string) {
  return {
    repoRoot: f.repoRoot,
    quarantineRoot: f.quarantineRoot,
    expectedBranch: f.branch,
    expectedHead: f.head,
    expectedCount: f.expectedCount,
    transactionId,
    createdAt,
    writersStopped: true,
  };
}

function runChild(operation: string, options: Record<string, unknown>, killAt?: string) {
  return spawnSync(process.execPath, [child], {
    env: {
      ...process.env,
      QUARANTINE_CHILD_REQUEST: JSON.stringify({ operation, options, killAt }),
    },
    encoding: "utf8",
    timeout: 30_000,
  });
}

function lockOwnerPid(lockPath: string) {
  const bytes = readFileSync(lockPath);
  const length = bytes.readUInt32BE(0);
  return JSON.parse(bytes.subarray(4, 4 + length).toString("utf8")).pid as number;
}

function expectDeadFixtureLock(lockPath: string) {
  expect(existsSync(lockPath)).toBe(true);
  const pid = lockOwnerPid(lockPath);
  expect(Number.isSafeInteger(pid)).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
}

function endpointSnapshot(path: string) {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  return stat.isFile()
    ? { kind: "file", bytes: readFileSync(path) }
    : { kind: "directory", dev: stat.dev, ino: stat.ino };
}

function recoveryOptions(fixture: Fixture, transactionId: string, action: "resume" | "rollback") {
  return {
    repoRoot: fixture.repoRoot,
    quarantineRoot: fixture.quarantineRoot,
    transactionId,
    action,
    writersStopped: true,
  };
}

function clearDeadFixtureLock(fixture: Fixture, transactionId: string) {
  const lockPath = join(fixture.quarantineRoot, transactionId, "journal.lock");
  expectDeadFixtureLock(lockPath);
  rmSync(lockPath);
  expect(existsSync(lockPath)).toBe(false);
}

describe("quarantine transaction real SIGKILL recovery", () => {
  it("recovers a durable move intent after SIGKILL at RECOVERY_REQUIRED", () => {
    const fixture = createQuarantineFixture();
    const transactionId = "tx-real-recovery-required";
    const apply = applyOptions(fixture, transactionId, "2026-07-17T00:00:00.000Z");

    const crashed = runChild("quarantineWorkspace", apply, "after-event:MOVE_INTENT:copy-0001");
    expect(crashed.signal).toBe("SIGKILL");

    const options = recoveryOptions(fixture, transactionId, "resume");
    const recovery = runChild("recoverQuarantine", options, "after-event:RECOVERY_REQUIRED");
    expect(recovery.signal).toBe("SIGKILL");

    const lockPath = join(fixture.quarantineRoot, transactionId, "journal.lock");
    expectDeadFixtureLock(lockPath);
    const beforeImmediate = readFileSync(join(fixture.quarantineRoot, transactionId, "journal.log"));
    const immediate = runChild("recoverQuarantine", options);
    expect(immediate.status).not.toBe(0);
    expect(readFileSync(join(fixture.quarantineRoot, transactionId, "journal.log"))).toEqual(beforeImmediate);
    clearDeadFixtureLock(fixture, transactionId);

    const resumed = runChild("recoverQuarantine", options);
    expect(resumed.status).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ status: "QUARANTINED", action: "resume" });
    expect(existsSync(join(fixture.repoRoot, "notes 2.txt"))).toBe(false);
  });

  it.each([
    "after-event:RECOVERY_REQUIRED",
    "after-event:ROLLING_BACK",
    "after-event:ROLLBACK_INTENT:copy-0001",
    "after-rollback-rename:copy-0001",
    "after-rollback-payload-sync:copy-0001",
    "after-rollback-destination-parent-sync:copy-0001",
    "after-rollback-source-parent-sync:copy-0001",
    "after-event:ROLLED_BACK_ENTRY:copy-0001",
    "after-event:ROLLED_BACK",
  ])("continues a rollback after SIGKILL at %s without retry mutation", (killAt) => {
    const fixture = createQuarantineFixture();
    const transactionId = `tx-rollback-${killAt.replace(/[^a-z0-9]/giu, "-")}`;
    const options = applyOptions(fixture, transactionId, "2026-07-17T00:00:02.000Z");
    expect(runChild("quarantineWorkspace", options, "after-rename:copy-0001").signal).toBe("SIGKILL");

    const rollback = recoveryOptions(fixture, transactionId, "rollback");
    expect(runChild("recoverQuarantine", rollback, killAt).signal).toBe("SIGKILL");
    const runRoot = join(fixture.quarantineRoot, transactionId);
    const source = join(fixture.repoRoot, "notes 2.txt");
    const payload = join(runRoot, "payload/source-copies/copy-0001");
    const journal = join(runRoot, "journal.log");
    const beforeImmediate = {
      journal: readFileSync(journal),
      payload: endpointSnapshot(payload),
      source: endpointSnapshot(source),
    };
    const immediate = runChild("recoverQuarantine", rollback);
    if (killAt === "after-event:ROLLED_BACK") expect(immediate.status).toBe(0);
    else expect(immediate.status).not.toBe(0);
    expect({
      journal: readFileSync(journal),
      payload: endpointSnapshot(payload),
      source: endpointSnapshot(source),
    }).toEqual(beforeImmediate);
    clearDeadFixtureLock(fixture, transactionId);

    const continued = runChild("recoverQuarantine", rollback);
    expect(continued.stderr).toBe("");
    expect(continued.status).toBe(0);
    expect(JSON.parse(continued.stdout)).toMatchObject({ status: "ROLLED_BACK", action: "rollback" });
    expect(existsSync(source)).toBe(true);
    expect(existsSync(payload)).toBe(false);
  });

  it("persists and returns a conflict after SIGKILL at INCOMPLETE_CONFLICT", () => {
    const fixture = createQuarantineFixture();
    const transactionId = "tx-conflict-crash";
    const options = applyOptions(fixture, transactionId, "2026-07-17T00:00:03.000Z");
    expect(runChild("quarantineWorkspace", options, "after-event:MOVE_INTENT:copy-0001").signal).toBe("SIGKILL");
    const payload = join(fixture.quarantineRoot, transactionId, "payload/source-copies/copy-0001");
    writeFileSync(payload, "canonical\n");
    const resume = recoveryOptions(fixture, transactionId, "resume");
    expect(runChild("recoverQuarantine", resume, "after-event:INCOMPLETE_CONFLICT").signal).toBe("SIGKILL");
    const beforeImmediate = [readFileSync(join(fixture.repoRoot, "notes 2.txt")), readFileSync(payload)];
    expect(runChild("recoverQuarantine", resume).status).toBe(0);
    expect([readFileSync(join(fixture.repoRoot, "notes 2.txt")), readFileSync(payload)]).toEqual(beforeImmediate);
    clearDeadFixtureLock(fixture, transactionId);
    const conflict = runChild("recoverQuarantine", resume);
    expect(conflict.status).toBe(0);
    expect(JSON.parse(conflict.stdout)).toEqual({
      transactionId,
      status: "INCOMPLETE_CONFLICT",
      action: "resume",
      conflictEntryIds: ["copy-0001"],
    });
  });

  it.each([
    "after-layout-sync",
    "after-pre-inventories",
    "after-prepared-generation",
  ])("reruns apply after pre-PREPARED SIGKILL at %s", (killAt) => {
    const fixture = createQuarantineFixture();
    const options = applyOptions(fixture, `tx-pre-${killAt.slice(6, 12)}`, "2026-07-17T00:00:01.000Z");
    const crashed = runChild("quarantineWorkspace", options, killAt);
    expect(crashed.signal).toBe("SIGKILL");
    const rerun = runChild("quarantineWorkspace", options);
    expect(rerun.status).toBe(0);
    expect(JSON.parse(rerun.stdout)).toMatchObject({ status: "QUARANTINED" });
  });

  it.each([
    ["after-divergent-diff:copy-0001", "rerun"],
    ["after-event:PREPARED", "resume"],
    ["after-event:MOVING", "resume"],
    ["after-event:MOVE_INTENT:copy-0001", "resume"],
    ["after-rename:copy-0001", "resume"],
    ["after-payload-sync:copy-0001", "resume"],
    ["after-destination-parent-sync:copy-0001", "resume"],
    ["after-source-parent-sync:copy-0001", "resume"],
    ["after-inventory:moved-pass-1:copy-0001", "resume"],
    ["after-event:MOVED:copy-0001", "resume"],
    ["after-event:VERIFYING", "resume"],
    ["after-inventory:moved-pass-2:copy-0001", "resume"],
    ["after-event:QUARANTINED", "resume"],
    ["before-lock-cleanup", "resume"],
  ] as const)("reaches QUARANTINED after an apply SIGKILL at %s", (killAt, recovery) => {
    const fixture = createQuarantineFixture({
      divergent: killAt === "after-divergent-diff:copy-0001",
    });
    const transactionId = `tx-apply-${killAt.replace(/[^a-z0-9]/giu, "-")}`;
    const options = applyOptions(fixture, transactionId, "2026-07-17T00:00:04.000Z");
    expect(runChild("quarantineWorkspace", options, killAt).signal).toBe("SIGKILL");

    let result;
    if (recovery === "rerun") {
      result = runChild("quarantineWorkspace", options);
    } else {
      const resume = recoveryOptions(fixture, transactionId, "resume");
      const runRoot = join(fixture.quarantineRoot, transactionId);
      const immediate = runChild("recoverQuarantine", resume);
      if (killAt === "after-event:QUARANTINED" || killAt === "before-lock-cleanup") {
        expect(immediate.status).toBe(0);
        expectDeadFixtureLock(join(runRoot, "journal.lock"));
        clearDeadFixtureLock(fixture, transactionId);
        result = runChild("recoverQuarantine", resume);
      } else {
        expect(immediate.status).toBe(0);
        result = immediate;
      }
    }

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "QUARANTINED" });
    const runRoot = join(fixture.quarantineRoot, transactionId);
    expect(existsSync(join(fixture.repoRoot, "notes 2.txt"))).toBe(false);
    expect(existsSync(join(runRoot, "payload/source-copies/copy-0001"))).toBe(true);
    expect(existsSync(join(runRoot, "payload/generated/.next"))).toBe(true);
    expect(existsSync(join(runRoot, "payload/generated/node_modules"))).toBe(true);
  });

});
