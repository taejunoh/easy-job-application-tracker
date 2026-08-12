import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { prepareQuarantinedFixture, spawnLifecycleChild } from "../fixtures/quarantine/quarantine-test-harness";

describe("quarantine restore real SIGKILL recovery", () => {
  it.each([
    "after-active-to-rollback-rename:generated-next",
    "after-payload-to-active-rename:generated-next",
    "after-payload-to-active-rename:copy-0001",
  ])("continues a SIGKILL at %s", async (killAt) => {
    const prepared = prepareQuarantinedFixture();
    try {
      const options = { repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot, transactionId: prepared.transactionId, writersStopped: true };
      expect((await spawnLifecycleChild("restoreQuarantine", options, { killAt })).signal).toBe("SIGKILL");
      rmSync(join(prepared.runRoot, "journal.lock"));
      const continued = await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" });
      if (continued.code !== 0) throw new Error(JSON.stringify(continued));
      expect(JSON.parse(continued.stdout)).toMatchObject({ status: "RESTORED", action: "resume", reconciledEntries: 3 });
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  }, 60_000);

  it("resumes a durable restore intent only after fixture-owned stale lock cleanup", async () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const options = {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        writersStopped: true,
      };
      const crashed = await spawnLifecycleChild("restoreQuarantine", options, {
        killAt: "after-event:RESTORE_INTENT:generated-next",
      });
      expect(crashed.signal).toBe("SIGKILL");
      const journal = join(prepared.runRoot, "journal.log");
      const beforeRetry = readFileSync(journal);
      const rejected = await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" });
      expect(rejected.code).not.toBe(0);
      expect(readFileSync(journal)).toEqual(beforeRetry);
      const lock = join(prepared.runRoot, "journal.lock");
      expect(existsSync(lock)).toBe(true);
      rmSync(lock); // Fixtures own this dead SIGKILL residue.
      const resumed = await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" });
      if (resumed.code !== 0) throw new Error(JSON.stringify(resumed));
      expect(JSON.parse(resumed.stdout)).toMatchObject({ status: "RESTORED", action: "resume", reconciledEntries: 3 });
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  }, 60_000);

  it("rolls a completed-but-unsettled restore back to its prior quarantine state", async () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const options = {
        repoRoot: prepared.fixture.repoRoot,
        quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId,
        writersStopped: true,
      };
      expect((await spawnLifecycleChild("restoreQuarantine", options, {
        killAt: "after-event:RESTORED_ENTRY:copy-0001",
      })).signal).toBe("SIGKILL");
      rmSync(join(prepared.runRoot, "journal.lock"));
      const rolledBack = await spawnLifecycleChild("recoverRestore", { ...options, action: "rollback" });
      if (rolledBack.code !== 0) throw new Error(JSON.stringify(rolledBack));
      expect(JSON.parse(rolledBack.stdout)).toMatchObject({
        status: "QUARANTINED", action: "rollback", restoreAborted: true, reconciledEntries: 3,
      });
      expect(existsSync(join(prepared.fixture.repoRoot, "notes 2.txt"))).toBe(false);
      expect(existsSync(join(prepared.runRoot, "payload", "source-copies", "copy-0001"))).toBe(true);
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  }, 60_000);

  it("records a durable conflict without replacing changed payload evidence", async () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const options = { repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot, transactionId: prepared.transactionId, writersStopped: true };
      expect((await spawnLifecycleChild("restoreQuarantine", options, {
        killAt: "after-event:RESTORE_INTENT:copy-0001",
      })).signal).toBe("SIGKILL");
      const payload = join(prepared.runRoot, "payload", "source-copies", "copy-0001");
      writeFileSync(payload, "foreign\n");
      rmSync(join(prepared.runRoot, "journal.lock"));
      const conflict = await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" });
      if (conflict.code !== 0) throw new Error(JSON.stringify(conflict));
      expect(JSON.parse(conflict.stdout)).toMatchObject({ status: "INCOMPLETE_CONFLICT", action: "resume", conflictEntryIds: ["copy-0001"] });
      expect(readFileSync(payload, "utf8")).toBe("foreign\n");
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  }, 60_000);

  it("continues a rollback after the durable rollback-intent seam", async () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const options = { repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot, transactionId: prepared.transactionId, writersStopped: true };
      expect((await spawnLifecycleChild("restoreQuarantine", options, {
        killAt: "after-event:RESTORED_ENTRY:copy-0001",
      })).signal).toBe("SIGKILL");
      rmSync(join(prepared.runRoot, "journal.lock"));
      expect((await spawnLifecycleChild("recoverRestore", { ...options, action: "rollback" }, {
        killAt: "after-event:RESTORE_ROLLBACK_INTENT:copy-0001",
      })).signal).toBe("SIGKILL");
      rmSync(join(prepared.runRoot, "journal.lock"));
      const continued = await spawnLifecycleChild("recoverRestore", { ...options, action: "rollback" });
      if (continued.code !== 0) throw new Error(JSON.stringify(continued));
      expect(JSON.parse(continued.stdout)).toMatchObject({ status: "QUARANTINED", action: "rollback", restoreAborted: true });
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  }, 60_000);
});
