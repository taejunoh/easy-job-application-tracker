import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { invokeQuarantineWorker, prepareQuarantinedFixture, spawnLifecycleChild } from "../fixtures/quarantine/quarantine-test-harness";

function journalEvents(path: string) {
  const bytes = readFileSync(path);
  const events: string[] = [];
  for (let offset = 0; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    offset += 4;
    events.push(JSON.parse(bytes.subarray(offset, offset + length).toString("utf8")).event);
    offset += length;
  }
  return events;
}

function journalPayloads(path: string) {
  const bytes = readFileSync(path);
  const records: Array<{ event: string; payload: unknown }> = [];
  for (let offset = 0; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    offset += 4;
    records.push(JSON.parse(bytes.subarray(offset, offset + length).toString("utf8")));
    offset += length;
  }
  return records;
}

async function killThenReleaseFixtureLock(
  operation: "restoreQuarantine" | "recoverRestore",
  options: Record<string, unknown>,
  runRoot: string,
  killAt: string,
  expectedTrace: readonly string[],
) {
  const trace = join(runRoot, `trace-${killAt.replaceAll(/[^A-Za-z0-9]/gu, "-")}.log`);
  const crashed = await spawnLifecycleChild(operation, options, { killAt, phaseTracePath: trace });
  expect(crashed.signal).toBe("SIGKILL");
  expect(existsSync(trace)).toBe(true);
  expect(readFileSync(trace, "utf8").split("\n").filter(Boolean)).toEqual(expectedTrace);
  const lock = join(runRoot, "journal.lock");
  expect(lstatSync(lock).isFile()).toBe(true);
  return {
    release() { rmSync(lock); },
    lock,
  };
}

const NORMAL_RESTORE_PHASES = [
  "after-inventory:restore-active:generated-next",
  "after-inventory:restore-active:generated-node-modules",
  "after-event:RESTORE_PREPARED",
  "after-event:RESTORING",
  "after-event:RESTORE_INTENT:generated-next",
  "after-active-to-rollback-rename:generated-next",
  "after-rollback-tree-sync:generated-next",
  "after-rollback-destination-parent-sync:generated-next",
  "after-rollback-source-parent-sync:generated-next",
  "after-payload-to-active-rename:generated-next",
  "after-restored-payload-sync:generated-next",
  "after-restore-destination-parent-sync:generated-next",
  "after-restore-source-parent-sync:generated-next",
  "after-event:RESTORED_ENTRY:generated-next",
  "after-event:RESTORE_INTENT:generated-node-modules",
  "after-active-to-rollback-rename:generated-node-modules",
  "after-rollback-tree-sync:generated-node-modules",
  "after-rollback-destination-parent-sync:generated-node-modules",
  "after-rollback-source-parent-sync:generated-node-modules",
  "after-payload-to-active-rename:generated-node-modules",
  "after-restored-payload-sync:generated-node-modules",
  "after-restore-destination-parent-sync:generated-node-modules",
  "after-restore-source-parent-sync:generated-node-modules",
  "after-event:RESTORED_ENTRY:generated-node-modules",
  "after-event:RESTORE_INTENT:copy-0001",
  "after-payload-to-active-rename:copy-0001",
  "after-restored-payload-sync:copy-0001",
  "after-restore-destination-parent-sync:copy-0001",
  "after-restore-source-parent-sync:copy-0001",
  "after-event:RESTORED_ENTRY:copy-0001",
  "after-event:RESTORED",
  "before-lock-cleanup",
  "after-event:RESTORE_INTENT:generated-node-modules",
  "after-active-to-rollback-rename:generated-node-modules",
  "after-rollback-tree-sync:generated-node-modules",
  "after-rollback-destination-parent-sync:generated-node-modules",
  "after-rollback-source-parent-sync:generated-node-modules",
  "after-payload-to-active-rename:generated-node-modules",
  "after-restored-payload-sync:generated-node-modules",
  "after-restore-destination-parent-sync:generated-node-modules",
  "after-restore-source-parent-sync:generated-node-modules",
  "after-event:RESTORED_ENTRY:generated-node-modules",
  "after-event:RESTORE_INTENT:copy-0001",
  "after-payload-to-active-rename:copy-0001",
  "after-restored-payload-sync:copy-0001",
  "after-restore-destination-parent-sync:copy-0001",
  "after-restore-source-parent-sync:copy-0001",
  "after-event:RESTORED_ENTRY:copy-0001",
  "after-event:RESTORED",
  "before-lock-cleanup",
] as const;

const RECOVERY_RESUME_PHASES = [
  "after-event:RECOVERY_REQUIRED",
  "after-event:RESTORING",
  "after-active-to-rollback-rename:generated-next",
  "after-rollback-tree-sync:generated-next",
  "after-rollback-destination-parent-sync:generated-next",
  "after-rollback-source-parent-sync:generated-next",
  "after-payload-to-active-rename:generated-next",
  "after-restored-payload-sync:generated-next",
  "after-restore-destination-parent-sync:generated-next",
  "after-restore-source-parent-sync:generated-next",
  "after-event:RESTORED_ENTRY:generated-next",
] as const;

const RECOVERY_ROLLBACK_PHASES = [
  "after-event:RECOVERY_REQUIRED",
  "after-event:RESTORE_ROLLING_BACK",
  "after-event:RESTORE_ROLLBACK_INTENT:copy-0001",
  "after-original-active-to-payload-rename:copy-0001",
  "after-original-payload-sync:copy-0001",
  "after-original-payload-parent-sync:copy-0001",
  "after-original-active-parent-sync:copy-0001",
  "after-event:RESTORE_ROLLED_BACK_ENTRY:copy-0001",
  "after-event:RESTORE_ROLLBACK_INTENT:generated-node-modules",
  "after-original-active-to-payload-rename:generated-node-modules",
  "after-original-payload-sync:generated-node-modules",
  "after-original-payload-parent-sync:generated-node-modules",
  "after-original-active-parent-sync:generated-node-modules",
  "after-regenerated-rollback-to-active-rename:generated-node-modules",
  "after-regenerated-active-tree-sync:generated-node-modules",
  "after-regenerated-active-parent-sync:generated-node-modules",
  "after-regenerated-rollback-parent-sync:generated-node-modules",
  "after-event:RESTORE_ROLLED_BACK_ENTRY:generated-node-modules",
  "after-event:RESTORE_ROLLBACK_INTENT:generated-next",
  "after-original-active-to-payload-rename:generated-next",
  "after-original-payload-sync:generated-next",
  "after-original-payload-parent-sync:generated-next",
  "after-original-active-parent-sync:generated-next",
  "after-regenerated-rollback-to-active-rename:generated-next",
  "after-regenerated-active-tree-sync:generated-next",
  "after-regenerated-active-parent-sync:generated-next",
  "after-regenerated-rollback-parent-sync:generated-next",
  "after-event:RESTORE_ROLLED_BACK_ENTRY:generated-next",
  "after-event:RESTORE_ABORTED_TO_QUARANTINED",
  "before-lock-cleanup",
] as const;

function validatePriorState(prepared: ReturnType<typeof prepareQuarantinedFixture>) {
  const validated = invokeQuarantineWorker("mark-validated", {
    repoRoot: prepared.fixture.repoRoot,
    quarantineRoot: prepared.fixture.quarantineRoot,
    transactionId: prepared.transactionId,
    validatedAt: "2026-08-11T00:00:00.000Z",
    writersStopped: true,
  });
  if (!validated.ok) throw new Error(JSON.stringify(validated));
}

describe("quarantine restore real SIGKILL recovery", () => {
  it.each(["payload", "active", "both"] as const)("preserves every conflicting source endpoint byte-for-byte and is idempotent: %s", async (mutation) => {
    const prepared = prepareQuarantinedFixture();
    try {
      const options = {
        repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId, writersStopped: true,
      };
      expect((await spawnLifecycleChild("restoreQuarantine", options, {
        killAt: "after-event:RESTORE_INTENT:copy-0001",
      })).signal).toBe("SIGKILL");
      const payload = join(prepared.runRoot, "payload", "source-copies", "copy-0001");
      const active = join(prepared.fixture.repoRoot, "notes 2.txt");
      if (mutation === "payload" || mutation === "both") writeFileSync(payload, "foreign payload\n");
      if (mutation === "active" || mutation === "both") writeFileSync(active, "foreign active\n");
      rmSync(join(prepared.runRoot, "journal.lock"));
      const journal = join(prepared.runRoot, "journal.log");
      const first = await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" });
      if (first.code !== 0) throw new Error(JSON.stringify(first));
      expect(JSON.parse(first.stdout)).toMatchObject({ status: "INCOMPLETE_CONFLICT", action: "resume", conflictEntryIds: ["copy-0001"] });
      const afterFirst = readFileSync(journal);
      if (mutation === "payload" || mutation === "both") expect(readFileSync(payload, "utf8")).toBe("foreign payload\n");
      if (mutation === "active" || mutation === "both") expect(readFileSync(active, "utf8")).toBe("foreign active\n");
      const second = await spawnLifecycleChild("recoverRestore", { ...options, action: "rollback" });
      if (second.code !== 0) throw new Error(JSON.stringify(second));
      expect(JSON.parse(second.stdout)).toMatchObject({ status: "INCOMPLETE_CONFLICT", action: "rollback", conflictEntryIds: ["copy-0001"] });
      expect(readFileSync(journal)).toEqual(afterFirst);
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  }, 60_000);

  it("treats missing restore evidence as fatal without appending a recovery decision", async () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const options = {
        repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId, writersStopped: true,
      };
      expect((await spawnLifecycleChild("restoreQuarantine", options, {
        killAt: "after-event:RESTORE_INTENT:copy-0001",
      })).signal).toBe("SIGKILL");
      rmSync(join(prepared.runRoot, "payload", "source-copies", "copy-0001"));
      rmSync(join(prepared.runRoot, "journal.lock"));
      const journal = join(prepared.runRoot, "journal.log");
      const before = readFileSync(journal);
      const recovery = await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" });
      expect(recovery.code).not.toBe(0);
      expect(readFileSync(journal)).toEqual(before);
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  }, 60_000);

  it("refuses to undo a terminal RESTORED run without mutating its journal", async () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const options = {
        repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId, writersStopped: true,
      };
      const restored = await spawnLifecycleChild("restoreQuarantine", options);
      if (restored.code !== 0) throw new Error(JSON.stringify(restored));
      const journal = join(prepared.runRoot, "journal.log");
      const before = readFileSync(journal);
      const recovery = await spawnLifecycleChild("recoverRestore", { ...options, action: "rollback" });
      expect(recovery.code).not.toBe(0);
      expect(readFileSync(journal)).toEqual(before);
      expect(journalEvents(journal).at(-1)).toBe("RESTORED");
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  }, 60_000);

  it.each(["QUARANTINED", "VALIDATED"] as const)(
    "resumes the mixed generated/source prefix with exact durable recovery records from %s",
    async (prior) => {
      const prepared = prepareQuarantinedFixture();
      try {
        if (prior === "VALIDATED") validatePriorState(prepared);
        const options = {
          repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
          transactionId: prepared.transactionId, writersStopped: true,
        };
        expect((await spawnLifecycleChild("restoreQuarantine", options, {
          killAt: "after-event:RESTORE_INTENT:copy-0001",
        })).signal).toBe("SIGKILL");
        rmSync(join(prepared.runRoot, "journal.lock"));
        const resumed = await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" });
        if (resumed.code !== 0) throw new Error(JSON.stringify(resumed));
        expect(JSON.parse(resumed.stdout)).toEqual(expect.objectContaining({
          transactionId: prepared.transactionId, status: "RESTORED", action: "resume", reconciledEntries: 3,
        }));
        const records = journalPayloads(join(prepared.runRoot, "journal.log"));
        expect(records.slice(-4).map(({ event, payload }) => ({ event, payload }))).toEqual([
          { event: "RECOVERY_REQUIRED", payload: { entryIds: ["generated-next", "generated-node-modules", "copy-0001"] } },
          { event: "RESTORING", payload: {} },
          { event: "RESTORED_ENTRY", payload: { id: "copy-0001" } },
          { event: "RESTORED", payload: {} },
        ]);
        expect(readFileSync(join(prepared.fixture.repoRoot, "notes 2.txt"), "utf8")).toBe("canonical\n");
        expect(readFileSync(join(prepared.fixture.repoRoot, ".next", "build"), "utf8")).toBe("ignored");
        expect(readFileSync(join(prepared.fixture.repoRoot, "node_modules", "package"), "utf8")).toBe("ignored");
        const rollback = join(prepared.runRoot, "rollback", "regenerated-before-restore");
        expect(readFileSync(join(rollback, JSON.parse(resumed.stdout).restoreId, ".next", "build"), "utf8")).toBe("ignored");
        expect(readFileSync(join(rollback, JSON.parse(resumed.stdout).restoreId, "node_modules", "package"), "utf8")).toBe("ignored");
      } finally {
        rmSync(prepared.fixture.base, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it.each(["QUARANTINED", "VALIDATED"] as const)(
    "rolls the mixed generated/source prefix back to exact %s endpoint roles",
    async (prior) => {
      const prepared = prepareQuarantinedFixture();
      try {
        if (prior === "VALIDATED") validatePriorState(prepared);
        const options = {
          repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
          transactionId: prepared.transactionId, writersStopped: true,
        };
        expect((await spawnLifecycleChild("restoreQuarantine", options, {
          killAt: "after-event:RESTORE_INTENT:copy-0001",
        })).signal).toBe("SIGKILL");
        rmSync(join(prepared.runRoot, "journal.lock"));
        const rollback = await spawnLifecycleChild("recoverRestore", { ...options, action: "rollback" });
        if (rollback.code !== 0) throw new Error(JSON.stringify(rollback));
        expect(JSON.parse(rollback.stdout)).toEqual(expect.objectContaining({
          transactionId: prepared.transactionId, status: prior, action: "rollback", reconciledEntries: 3, restoreAborted: true,
        }));
        const restoreId = JSON.parse(rollback.stdout).restoreId;
        const records = journalPayloads(join(prepared.runRoot, "journal.log"));
        expect(records.slice(-9).map(({ event, payload }) => ({ event, payload }))).toEqual([
          { event: "RECOVERY_REQUIRED", payload: { entryIds: ["generated-next", "generated-node-modules", "copy-0001"] } },
          { event: "RESTORE_ROLLING_BACK", payload: {} },
          { event: "RESTORE_ROLLBACK_INTENT", payload: { id: "copy-0001" } },
          { event: "RESTORE_ROLLED_BACK_ENTRY", payload: { id: "copy-0001" } },
          { event: "RESTORE_ROLLBACK_INTENT", payload: { id: "generated-node-modules" } },
          { event: "RESTORE_ROLLED_BACK_ENTRY", payload: { id: "generated-node-modules" } },
          { event: "RESTORE_ROLLBACK_INTENT", payload: { id: "generated-next" } },
          { event: "RESTORE_ROLLED_BACK_ENTRY", payload: { id: "generated-next" } },
          { event: prior === "VALIDATED" ? "RESTORE_ABORTED_TO_VALIDATED" : "RESTORE_ABORTED_TO_QUARANTINED", payload: {} },
        ]);
        expect(existsSync(join(prepared.fixture.repoRoot, "notes 2.txt"))).toBe(false);
        expect(readFileSync(join(prepared.runRoot, "payload", "source-copies", "copy-0001"), "utf8")).toBe("canonical\n");
        expect(readFileSync(join(prepared.fixture.repoRoot, ".next", "build"), "utf8")).toBe("ignored");
        expect(readFileSync(join(prepared.fixture.repoRoot, "node_modules", "package"), "utf8")).toBe("ignored");
        expect(readFileSync(join(prepared.runRoot, "payload", "generated", ".next", "build"), "utf8")).toBe("ignored");
        expect(readFileSync(join(prepared.runRoot, "payload", "generated", "node_modules", "package"), "utf8")).toBe("ignored");
        expect(existsSync(join(prepared.runRoot, "rollback", "regenerated-before-restore", restoreId, ".next"))).toBe(false);
        expect(existsSync(join(prepared.runRoot, "rollback", "regenerated-before-restore", restoreId, "node_modules"))).toBe(false);
      } finally {
        rmSync(prepared.fixture.base, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it.each(RECOVERY_RESUME_PHASES)("continues every forward recovery seam after SIGKILL: %s", async (killAt) => {
    const prepared = prepareQuarantinedFixture();
    try {
      const options = {
        repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId, writersStopped: true,
      };
      const initial = await spawnLifecycleChild("restoreQuarantine", options, {
        killAt: "after-event:RESTORE_INTENT:generated-next",
      });
      expect(initial.signal).toBe("SIGKILL");
      rmSync(join(prepared.runRoot, "journal.lock"));
      const index = RECOVERY_RESUME_PHASES.indexOf(killAt);
      const { release } = await killThenReleaseFixtureLock(
        "recoverRestore", { ...options, action: "resume" }, prepared.runRoot, killAt,
        RECOVERY_RESUME_PHASES.slice(0, index + 1),
      );
      const journal = join(prepared.runRoot, "journal.log");
      const beforeStaleRetry = readFileSync(journal);
      const staleRetry = await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" });
      expect(staleRetry.code).not.toBe(0);
      expect(readFileSync(journal)).toEqual(beforeStaleRetry);
      release();
      const resumed = await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" });
      if (killAt === "after-event:RESTORED" || killAt === "before-lock-cleanup") {
        expect(resumed.code).not.toBe(0);
      } else {
        if (resumed.code !== 0) throw new Error(JSON.stringify(resumed));
        expect(JSON.parse(resumed.stdout)).toMatchObject({ status: "RESTORED", action: "resume", reconciledEntries: 3 });
      }
      expect(journalEvents(journal).at(-1)).toBe("RESTORED");
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  }, 600_000);

  it.each(RECOVERY_ROLLBACK_PHASES)("continues every reverse recovery seam after SIGKILL: %s", async (killAt) => {
    const prepared = prepareQuarantinedFixture();
    try {
      const options = {
        repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId, writersStopped: true,
      };
      const initial = await spawnLifecycleChild("restoreQuarantine", options, {
        killAt: "after-event:RESTORED_ENTRY:copy-0001",
      });
      expect(initial.signal).toBe("SIGKILL");
      rmSync(join(prepared.runRoot, "journal.lock"));
      const index = RECOVERY_ROLLBACK_PHASES.indexOf(killAt);
      const { release } = await killThenReleaseFixtureLock(
        "recoverRestore", { ...options, action: "rollback" }, prepared.runRoot, killAt,
        RECOVERY_ROLLBACK_PHASES.slice(0, index + 1),
      );
      const journal = join(prepared.runRoot, "journal.log");
      const beforeStaleRetry = readFileSync(journal);
      const staleRetry = await spawnLifecycleChild("recoverRestore", { ...options, action: "rollback" });
      expect(staleRetry.code).not.toBe(0);
      expect(readFileSync(journal)).toEqual(beforeStaleRetry);
      release();
      const rolledBack = await spawnLifecycleChild("recoverRestore", { ...options, action: "rollback" });
      if (killAt === "after-event:RESTORE_ABORTED_TO_QUARANTINED" || killAt === "before-lock-cleanup") {
        expect(rolledBack.code).not.toBe(0);
      } else {
        if (rolledBack.code !== 0) throw new Error(JSON.stringify(rolledBack));
        expect(JSON.parse(rolledBack.stdout)).toMatchObject({ status: "QUARANTINED", action: "rollback", restoreAborted: true });
      }
      expect(journalEvents(journal).at(-1)).toBe("RESTORE_ABORTED_TO_QUARANTINED");
    } finally {
      rmSync(prepared.fixture.base, { recursive: true, force: true });
    }
  }, 600_000);

  it.each((["QUARANTINED", "VALIDATED"] as const).flatMap((prior) =>
    NORMAL_RESTORE_PHASES.slice(2).map((phase) => [prior, phase] as const),
  ))(
    "leaves exactly the durable restore prefix after SIGKILL from %s at every post-prepare normal phase: %s",
    async (prior, killAt) => {
      const prepared = prepareQuarantinedFixture();
      try {
        if (prior === "VALIDATED") validatePriorState(prepared);
        const options = {
          repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
          transactionId: prepared.transactionId, writersStopped: true,
        };
        const index = NORMAL_RESTORE_PHASES.indexOf(killAt);
        const { release } = await killThenReleaseFixtureLock(
          "restoreQuarantine", options, prepared.runRoot, killAt, NORMAL_RESTORE_PHASES.slice(0, index + 1),
        );
        const journal = join(prepared.runRoot, "journal.log");
        const beforeStaleRetry = readFileSync(journal);
        const staleRetry = await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" });
        expect(staleRetry.code).not.toBe(0);
        expect(readFileSync(journal)).toEqual(beforeStaleRetry);
        release(); // This fixture owns the lock created by the verified dead child above.

        if (killAt === "after-event:RESTORED" || killAt === "before-lock-cleanup") {
          const completed = await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" });
          expect(completed.code).not.toBe(0);
          expect(journalEvents(journal).at(-1)).toBe("RESTORED");
        } else {
          const continued = await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" });
          if (continued.code !== 0) throw new Error(JSON.stringify(continued));
          expect(JSON.parse(continued.stdout)).toMatchObject({
            status: "RESTORED", action: "resume", reconciledEntries: 3,
          });
          expect(journalEvents(journal).at(-1)).toBe("RESTORED");
        }
      } finally {
        rmSync(prepared.fixture.base, { recursive: true, force: true });
      }
    },
    600_000,
  );

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
