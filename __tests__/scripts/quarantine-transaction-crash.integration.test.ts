import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
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

describe("quarantine transaction real SIGKILL recovery", () => {
  it("recovers a durable move intent after SIGKILL at RECOVERY_REQUIRED", () => {
    const fixture = createQuarantineFixture();
    const transactionId = "tx-real-recovery-required";
    const options = applyOptions(fixture, transactionId, "2026-07-17T00:00:00.000Z");

    const apply = runChild("quarantineWorkspace", options, "after-event:MOVE_INTENT:copy-0001");
    expect(apply.signal).toBe("SIGKILL");

    const recoveryOptions = {
      repoRoot: fixture.repoRoot,
      quarantineRoot: fixture.quarantineRoot,
      transactionId,
      action: "resume",
      writersStopped: true,
    };
    const recovery = runChild("recoverQuarantine", recoveryOptions, "after-event:RECOVERY_REQUIRED");
    expect(recovery.signal).toBe("SIGKILL");

    const lockPath = join(fixture.quarantineRoot, transactionId, "journal.lock");
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath).length).toBeGreaterThan(0);
    const immediate = runChild("recoverQuarantine", recoveryOptions);
    expect(immediate.status).not.toBe(0);
    expect(readFileSync(lockPath).length).toBeGreaterThan(0);
    rmSync(lockPath);

    const resumed = runChild("recoverQuarantine", recoveryOptions);
    expect(resumed.status).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ status: "QUARANTINED", action: "resume" });
    expect(existsSync(join(fixture.repoRoot, "notes 2.txt"))).toBe(false);
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

});
