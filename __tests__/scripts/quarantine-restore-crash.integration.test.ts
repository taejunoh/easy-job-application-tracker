import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function lockBytesForOwner(pid: number, ownerToken = "11111111-1111-4111-8111-111111111111") {
  const version = 1;
  const checksum = createHash("sha256").update(JSON.stringify({ version, ownerToken, pid })).digest("hex");
  const body = Buffer.from(JSON.stringify({ version, ownerToken, pid, checksum }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
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

async function crashRestoreWithProof(
  prepared: ReturnType<typeof prepareQuarantinedFixture>,
  options: Record<string, unknown>,
  killAt: string,
) {
  const trace = join(prepared.runRoot, `matrix-${killAt.replaceAll(/[^A-Za-z0-9]/gu, "-")}.log`);
  const crashed = await spawnLifecycleChild("restoreQuarantine", options, { killAt, phaseTracePath: trace });
  expect(crashed.signal).toBe("SIGKILL");
  expect(readFileSync(trace, "utf8").split("\n").filter(Boolean).at(-1)).toBe(killAt);
  const lock = join(prepared.runRoot, "journal.lock");
  expect(lstatSync(lock).isFile()).toBe(true);
  rmSync(lock); // This test owns only the dead child residue it just proved.
}

const GENERATED_ENDPOINT_ROWS = [
  ["active initial (P,A)", true, "after-event:RESTORE_INTENT:generated-next", [true, true, false]],
  ["active staged (P,R)", true, "after-active-to-rollback-rename:generated-next", [true, false, true]],
  ["active final (A,R)", true, "after-event:RESTORED_ENTRY:generated-next", [false, true, true]],
  ["no-active initial (P)", false, "after-event:RESTORE_INTENT:generated-next", [true, false, false]],
  ["no-active final (A)", false, "after-event:RESTORED_ENTRY:generated-next", [false, true, false]],
] as const;

function endpointPresence(prepared: ReturnType<typeof prepareQuarantinedFixture>, restoreId: string) {
  const paths = [
    join(prepared.runRoot, "payload", "generated", ".next"),
    join(prepared.fixture.repoRoot, ".next"),
    join(prepared.runRoot, "rollback", "regenerated-before-restore", restoreId, ".next"),
  ];
  return paths.map((path) => existsSync(path)) as [boolean, boolean, boolean];
}

function endpointIdentity(path: string) {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  return { dev: stat.dev, ino: stat.ino, type: stat.isDirectory() ? "directory" : "file" };
}

function generatedEndpointPaths(prepared: ReturnType<typeof prepareQuarantinedFixture>, restoreId: string) {
  return [
    join(prepared.runRoot, "payload", "generated", ".next"),
    join(prepared.fixture.repoRoot, ".next"),
    join(prepared.runRoot, "rollback", "regenerated-before-restore", restoreId, ".next"),
  ] as const;
}

function exactResultShape(keys: string[]) {
  return {
    prototype: "null",
    keys,
    frozen: true,
    extensible: false,
    mutationStable: true,
    descriptors: Object.fromEntries(keys.map((key) => [key, {
      enumerable: true, configurable: false, writable: false, callable: false,
    }])),
  };
}

function durableRecoveryEvidence(prepared: ReturnType<typeof prepareQuarantinedFixture>, paths: string[]) {
  const pointer = join(prepared.fixture.quarantineRoot, "current");
  const manifestDirectory = join(prepared.runRoot, "manifests");
  const endpoint = (path: string) => {
    try {
      const stat = lstatSync(path);
      return {
        dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777,
        type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file",
        link: stat.isSymbolicLink() ? readlinkSync(path) : null,
        build: stat.isDirectory() && existsSync(join(path, "build")) ? readFileSync(join(path, "build")).toString("base64") : null,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  return {
    journal: readFileSync(join(prepared.runRoot, "journal.log")).toString("base64"),
    pointer: existsSync(pointer) ? readFileSync(pointer).toString("base64") : null,
    generations: Object.fromEntries(readdirSync(manifestDirectory).sort().map((name) => [name, readFileSync(join(manifestDirectory, name)).toString("base64")])),
    endpoints: paths.map(endpoint),
  };
}

describe("quarantine restore real SIGKILL recovery", () => {
  it("public recoverRestore reclaims the dead restore journal lock", async () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const options = {
        repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId, writersStopped: true,
      };
      const crashed = await spawnLifecycleChild("restoreQuarantine", options, {
        killAt: "after-event:RESTORE_INTENT:generated-next",
      });
      expect(crashed.signal).toBe("SIGKILL");
      expect(lstatSync(join(prepared.runRoot, "journal.lock")).isFile()).toBe(true);

      const recovered = await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" });

      if (recovered.code !== 0) throw new Error(JSON.stringify(recovered));
      expect(JSON.parse(recovered.stdout)).toEqual({
        schemaVersion: 2, transactionId: prepared.transactionId,
        restoreId: "restore-c3624475-87d7-4886-b0bf-68a5061663d2",
        status: "RESTORED", action: "resume", reconciledEntries: 3,
      });
      expect(existsSync(join(prepared.runRoot, "journal.lock"))).toBe(false);
    } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
  }, 60_000);

  it("public recoverRestore preserves a live journal lock", async () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const options = {
        repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId, writersStopped: true,
      };
      expect((await spawnLifecycleChild("restoreQuarantine", options, {
        killAt: "after-event:RESTORE_INTENT:generated-next",
      })).signal).toBe("SIGKILL");
      const lockPath = join(prepared.runRoot, "journal.lock");
      const journalPath = join(prepared.runRoot, "journal.log");
      const liveLock = lockBytesForOwner(process.pid);
      rmSync(lockPath);
      writeFileSync(lockPath, liveLock, { mode: 0o600 });
      const journalBefore = readFileSync(journalPath);

      const recovered = await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" });

      expect(recovered.code).not.toBe(0);
      expect(recovered.stderr).toContain("refuses a live owner");
      expect(readFileSync(lockPath)).toEqual(liveLock);
      expect(readFileSync(journalPath)).toEqual(journalBefore);
      expect(journalEvents(journalPath).at(-1)).toBe("RESTORE_INTENT");
    } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
  }, 60_000);

  it("public recoverRestore preserves an inaccessible or live foreign owner lock", async () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const options = {
        repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId, writersStopped: true,
      };
      expect((await spawnLifecycleChild("restoreQuarantine", options, {
        killAt: "after-event:RESTORE_INTENT:generated-next",
      })).signal).toBe("SIGKILL");
      const lockPath = join(prepared.runRoot, "journal.lock");
      const journalPath = join(prepared.runRoot, "journal.log");
      const foreignLock = lockBytesForOwner(1, "22222222-2222-4222-8222-222222222222");
      rmSync(lockPath);
      writeFileSync(lockPath, foreignLock, { mode: 0o600 });
      const journalBefore = readFileSync(journalPath);

      const recovered = await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" });

      expect(recovered.code).not.toBe(0);
      expect(recovered.stderr).toMatch(/refuses a live owner|cannot verify owner liveness/u);
      expect(readFileSync(lockPath)).toEqual(foreignLock);
      expect(readFileSync(journalPath)).toEqual(journalBefore);
    } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
  }, 60_000);

  it("public recoverRestore preserves a malformed foreign lock replacement", async () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const options = {
        repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId, writersStopped: true,
      };
      expect((await spawnLifecycleChild("restoreQuarantine", options, {
        killAt: "after-event:RESTORE_INTENT:generated-next",
      })).signal).toBe("SIGKILL");
      const lockPath = join(prepared.runRoot, "journal.lock");
      const journalPath = join(prepared.runRoot, "journal.log");
      const foreignLock = Buffer.from("foreign replacement lock\n");
      rmSync(lockPath);
      writeFileSync(lockPath, foreignLock, { mode: 0o600 });
      const journalBefore = readFileSync(journalPath);

      const recovered = await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" });

      expect(recovered.code).not.toBe(0);
      expect(readFileSync(lockPath)).toEqual(foreignLock);
      expect(readFileSync(journalPath)).toEqual(journalBefore);
    } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
  }, 60_000);

  it.each(([
    "QUARANTINED",
    "VALIDATED",
  ] as const).flatMap((prior) => GENERATED_ENDPOINT_ROWS.flatMap(([row, regenerate, killAt, presence]) =>
    (["resume", "rollback"] as const).map((action) => [prior, row, regenerate, killAt, presence, action] as const),
  ))) (
    "public recoverRestore handles generated P/A/R row %s from %s by %s",
    async (prior, _row, regenerate, killAt, expectedPresence, action) => {
      // Validation verifies a real regenerated workspace.  The no-active
      // rows are then the legitimate post-validation absence variant, not a
      // shortcut around validation evidence.
      const prepared = prepareQuarantinedFixture({ regenerate: prior === "VALIDATED" ? true : regenerate });
      try {
        if (prior === "VALIDATED") {
          validatePriorState(prepared);
          if (!regenerate) {
            rmSync(join(prepared.fixture.repoRoot, ".next"), { recursive: true, force: true });
            rmSync(join(prepared.fixture.repoRoot, "node_modules"), { recursive: true, force: true });
          }
        }
        const options = {
          repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
          transactionId: prepared.transactionId, writersStopped: true,
        };
        await crashRestoreWithProof(prepared, options, killAt);
        const restoreId = "restore-c3624475-87d7-4886-b0bf-68a5061663d2";
        const [payload, active, rollback] = generatedEndpointPaths(prepared, restoreId);
        expect(endpointPresence(prepared, restoreId)).toEqual(expectedPresence);
        const before = [endpointIdentity(payload), endpointIdentity(active), endpointIdentity(rollback)];
        const recovered = await spawnLifecycleChild("recoverRestore", { ...options, action });
        if (recovered.code !== 0) throw new Error(JSON.stringify(recovered));
        expect(JSON.parse(recovered.stdout)).toEqual(action === "resume"
          ? { schemaVersion: 2, transactionId: prepared.transactionId, restoreId, status: "RESTORED", action: "resume", reconciledEntries: 3 }
          : { schemaVersion: 2, transactionId: prepared.transactionId, restoreId, status: prior, action: "rollback", reconciledEntries: 1, restoreAborted: true });
        expect(journalEvents(join(prepared.runRoot, "journal.log")).at(-1)).toBe(action === "resume"
          ? "RESTORED"
          : prior === "VALIDATED" ? "RESTORE_ABORTED_TO_VALIDATED" : "RESTORE_ABORTED_TO_QUARANTINED");
        const after = [endpointIdentity(payload), endpointIdentity(active), endpointIdentity(rollback)];
        const original = before[0] ?? before[1];
        const generated = regenerate ? (before[2] ?? before[1]) : null;
        expect(after).toEqual(action === "resume"
          ? [null, original, generated]
          : [original, generated, null]);
      } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
    },
    60_000,
  );

  it.each((["QUARANTINED", "VALIDATED"] as const).flatMap((prior) =>
    (["resume", "rollback"] as const).map((action) => [prior, action] as const),
  ))("public recoverRestore handles no-intent %s provenance by %s", async (prior, action) => {
    const prepared = prepareQuarantinedFixture();
    try {
      if (prior === "VALIDATED") validatePriorState(prepared);
      const options = { repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot, transactionId: prepared.transactionId, writersStopped: true };
      await crashRestoreWithProof(prepared, options, "after-event:RESTORE_PREPARED");
      const result = await spawnLifecycleChild("recoverRestore", { ...options, action });
      if (result.code !== 0) throw new Error(JSON.stringify(result));
      expect(JSON.parse(result.stdout)).toEqual(action === "resume"
        ? { schemaVersion: 2, transactionId: prepared.transactionId, restoreId: "restore-c3624475-87d7-4886-b0bf-68a5061663d2", status: "RESTORED", action: "resume", reconciledEntries: 3 }
        : { schemaVersion: 2, transactionId: prepared.transactionId, restoreId: "restore-c3624475-87d7-4886-b0bf-68a5061663d2", status: prior, action: "rollback", reconciledEntries: 0, restoreAborted: true });
    } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
  }, 60_000);

  it("uses endpoint role and inode, rather than equal generated bytes, for public recovery", async () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const options = { repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot, transactionId: prepared.transactionId, writersStopped: true };
      await crashRestoreWithProof(prepared, options, "after-event:RESTORE_INTENT:generated-next");
      const payload = join(prepared.runRoot, "payload", "generated", ".next");
      const active = join(prepared.fixture.repoRoot, ".next");
      expect(readFileSync(join(payload, "build"))).toEqual(readFileSync(join(active, "build")));
      expect(lstatSync(payload).ino).not.toBe(lstatSync(active).ino);
      const result = await spawnLifecycleChild("recoverRestore", { ...options, action: "rollback" });
      if (result.code !== 0) throw new Error(JSON.stringify(result));
      expect(JSON.parse(result.stdout)).toEqual({ schemaVersion: 2, transactionId: prepared.transactionId, restoreId: "restore-c3624475-87d7-4886-b0bf-68a5061663d2", status: "QUARANTINED", action: "rollback", reconciledEntries: 1, restoreAborted: true });
      expect(lstatSync(join(prepared.fixture.repoRoot, ".next")).ino).toBe(lstatSync(active).ino);
      expect(lstatSync(join(prepared.runRoot, "payload", "generated", ".next")).ino).toBe(lstatSync(payload).ino);
    } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
  }, 60_000);

  it.each([
    ["resume", "RESTORED", ["schemaVersion", "transactionId", "restoreId", "status", "action", "reconciledEntries"]],
    ["rollback", "QUARANTINED", ["schemaVersion", "transactionId", "restoreId", "status", "action", "reconciledEntries", "restoreAborted"]],
  ] as const)("returns an exact immutable public %s result record", async (action, _status, keys) => {
    const prepared = prepareQuarantinedFixture();
    try {
      const options = { repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot, transactionId: prepared.transactionId, writersStopped: true };
      await crashRestoreWithProof(prepared, options, "after-event:RESTORE_INTENT:generated-next");
      const observed = invokeQuarantineWorker("recover-restore-shape", { ...options, action }) as unknown as { ok: boolean; result: Record<string, unknown>; shape: ReturnType<typeof exactResultShape> };
      expect(observed.ok).toBe(true);
      expect(observed.result).toEqual(expect.objectContaining({ transactionId: prepared.transactionId, restoreId: "restore-c3624475-87d7-4886-b0bf-68a5061663d2", status: _status, action }));
      expect(observed.shape).toEqual(exactResultShape([...keys]));
    } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
  }, 60_000);

  it("classifies a completed entry before public resume and preserves a foreign replacement", async () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const options = { repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot, transactionId: prepared.transactionId, writersStopped: true };
      await crashRestoreWithProof(prepared, options, "after-event:RESTORED_ENTRY:generated-next");
      const active = join(prepared.fixture.repoRoot, ".next");
      writeFileSync(join(active, "foreign"), "foreign completed endpoint\n");
      const paths = [join(prepared.runRoot, "payload", "generated", ".next"), active];
      const before = durableRecoveryEvidence(prepared, paths);
      const result = await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" });
      if (result.code !== 0) throw new Error(JSON.stringify(result));
      expect(JSON.parse(result.stdout)).toEqual({
        schemaVersion: 2,
        transactionId: prepared.transactionId, restoreId: "restore-c3624475-87d7-4886-b0bf-68a5061663d2",
        status: "INCOMPLETE_CONFLICT", action: "resume", conflictEntryIds: ["generated-next"],
      });
      const after = durableRecoveryEvidence(prepared, paths);
      expect(after.endpoints).toEqual(before.endpoints);
      expect(after.pointer).toBe(before.pointer);
      expect(after.generations).toEqual(before.generations);
      expect(readFileSync(join(active, "foreign"), "utf8")).toBe("foreign completed endpoint\n");
    } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
  }, 60_000);

  it("rejects a valid-digest completed entry reversed to its initial endpoint roles", async () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const options = { repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot, transactionId: prepared.transactionId, writersStopped: true };
      await crashRestoreWithProof(prepared, options, "after-event:RESTORED_ENTRY:generated-next");
      const restoreId = "restore-c3624475-87d7-4886-b0bf-68a5061663d2";
      const payload = join(prepared.runRoot, "payload", "generated", ".next");
      const active = join(prepared.fixture.repoRoot, ".next");
      const rollback = join(prepared.runRoot, "rollback", "regenerated-before-restore", restoreId, ".next");
      // Both trees remain exact durable digests, but their P/A/R roles are
      // reversed from completed=final to the valid-looking initial row.
      renameSync(active, payload);
      renameSync(rollback, active);
      const before = durableRecoveryEvidence(prepared, [payload, active, rollback]);
      const result = await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" });
      if (result.code !== 0) throw new Error(JSON.stringify(result));
      expect(JSON.parse(result.stdout)).toEqual({
        schemaVersion: 2, transactionId: prepared.transactionId, restoreId,
        status: "INCOMPLETE_CONFLICT", action: "resume", conflictEntryIds: ["generated-next"],
      });
      const after = durableRecoveryEvidence(prepared, [payload, active, rollback]);
      expect(after.endpoints).toEqual(before.endpoints);
      expect(after.pointer).toBe(before.pointer);
      expect(after.generations).toEqual(before.generations);
      expect(readFileSync(join(prepared.runRoot, "journal.log")).subarray(0, Buffer.from(before.journal, "base64").length).toString("base64")).toBe(before.journal);
    } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
  }, 60_000);

  it("keeps concurrent fixed recovery handoffs isolated", async () => {
    const first = prepareQuarantinedFixture();
    const second = prepareQuarantinedFixture();
    try {
      const firstOptions = { repoRoot: first.fixture.repoRoot, quarantineRoot: first.fixture.quarantineRoot, transactionId: first.transactionId, writersStopped: true };
      const secondOptions = { repoRoot: second.fixture.repoRoot, quarantineRoot: second.fixture.quarantineRoot, transactionId: second.transactionId, writersStopped: true };
      await crashRestoreWithProof(first, firstOptions, "after-event:RESTORE_INTENT:generated-next");
      await crashRestoreWithProof(second, secondOptions, "after-event:RESTORE_INTENT:generated-next");
      const concurrent = invokeQuarantineWorker("recover-concurrent", {
        first: { ...firstOptions, action: "resume" }, second: { ...secondOptions, action: "rollback" },
      }) as unknown as { ok: boolean; first: Record<string, unknown>; second: Record<string, unknown> };
      expect(concurrent).toEqual({
        ok: true,
        first: { schemaVersion: 2, transactionId: first.transactionId, restoreId: "restore-c3624475-87d7-4886-b0bf-68a5061663d2", status: "RESTORED", action: "resume", reconciledEntries: 3 },
        second: { schemaVersion: 2, transactionId: second.transactionId, restoreId: "restore-c3624475-87d7-4886-b0bf-68a5061663d2", status: "QUARANTINED", action: "rollback", reconciledEntries: 1, restoreAborted: true },
      });
    } finally {
      rmSync(first.fixture.base, { recursive: true, force: true });
      rmSync(second.fixture.base, { recursive: true, force: true });
    }
  }, 60_000);

  it("returns an exact immutable public conflict result record", async () => {
    const prepared = prepareQuarantinedFixture();
    try {
      const options = { repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot, transactionId: prepared.transactionId, writersStopped: true };
      await crashRestoreWithProof(prepared, options, "after-active-to-rollback-rename:generated-next");
      writeFileSync(join(prepared.runRoot, "rollback", "regenerated-before-restore", "restore-c3624475-87d7-4886-b0bf-68a5061663d2", ".next", "foreign"), "foreign\n");
      const observed = invokeQuarantineWorker("recover-restore-shape", { ...options, action: "rollback" }) as unknown as { ok: boolean; result: Record<string, unknown>; shape: ReturnType<typeof exactResultShape> };
      expect(observed.ok).toBe(true);
      expect(observed.result).toEqual({
        schemaVersion: 2,
        transactionId: prepared.transactionId, restoreId: "restore-c3624475-87d7-4886-b0bf-68a5061663d2",
        status: "INCOMPLETE_CONFLICT", action: "rollback", conflictEntryIds: ["generated-next"],
      });
      expect(observed.shape).toEqual(exactResultShape(["schemaVersion", "transactionId", "restoreId", "status", "action", "conflictEntryIds"]));
      const terminal = invokeQuarantineWorker("recover-restore-shape", { ...options, action: "resume" }) as unknown as { ok: boolean; result: Record<string, unknown>; shape: ReturnType<typeof exactResultShape> };
      expect(terminal).toEqual({
        ok: true,
        result: {
          schemaVersion: 2,
          transactionId: prepared.transactionId, restoreId: "restore-c3624475-87d7-4886-b0bf-68a5061663d2",
          status: "INCOMPLETE_CONFLICT", action: "resume", conflictEntryIds: ["generated-next"],
        },
        shape: exactResultShape(["schemaVersion", "transactionId", "restoreId", "status", "action", "conflictEntryIds"]),
      });
    } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
  }, 60_000);

  it.each([
    ["payload mismatch", "conflict", (...[payload]: [string, string, string]) => writeFileSync(join(payload, "foreign"), "foreign\n")],
    ["rollback missing", "conflict", (...[, , rollback]: [string, string, string]) => rmSync(rollback, { recursive: true, force: true })],
    ["rollback mismatch", "conflict", (...[, , rollback]: [string, string, string]) => writeFileSync(join(rollback, "foreign"), "foreign\n")],
    ["both payload and rollback mismatched", "conflict", (...[payload, , rollback]: [string, string, string]) => {
      writeFileSync(join(payload, "foreign"), "foreign payload\n");
      writeFileSync(join(rollback, "foreign"), "foreign rollback\n");
    }],
    ["unauthorized payload symlink", "fatal", (...[payload]: [string, string, string]) => {
      rmSync(payload, { recursive: true, force: true });
      symlinkSync("/nonexistent/foreign-generated", payload);
    }],
  ] as const)("handles public generated %s evidence without replacing it", async (_label, outcome, mutate) => {
    const prepared = prepareQuarantinedFixture();
    try {
      const options = { repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot, transactionId: prepared.transactionId, writersStopped: true };
      await crashRestoreWithProof(prepared, options, "after-active-to-rollback-rename:generated-next");
      const restoreId = "restore-c3624475-87d7-4886-b0bf-68a5061663d2";
      const payload = join(prepared.runRoot, "payload", "generated", ".next");
      const active = join(prepared.fixture.repoRoot, ".next");
      const rollback = join(prepared.runRoot, "rollback", "regenerated-before-restore", restoreId, ".next");
      mutate(payload, active, rollback);
      const paths = [payload, active, rollback, join(prepared.fixture.repoRoot, "node_modules")];
      const before = durableRecoveryEvidence(prepared, paths);
      const result = await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" });
      if (outcome === "conflict") {
        if (result.code !== 0) throw new Error(JSON.stringify(result));
        expect(JSON.parse(result.stdout)).toEqual({
          schemaVersion: 2, transactionId: prepared.transactionId, restoreId,
          status: "INCOMPLETE_CONFLICT", action: "resume", conflictEntryIds: ["generated-next"],
        });
      } else expect(result.code).not.toBe(0);
      const after = durableRecoveryEvidence(prepared, paths);
      // The terminal conflict itself is the only durable addition.  All prior
      // journal bytes, pointer/generation bytes, and endpoint identities stay
      // authoritative evidence.
      if (outcome === "conflict") {
        expect(after.journal).not.toBe(before.journal);
        expect(readFileSync(join(prepared.runRoot, "journal.log")).subarray(0, Buffer.from(before.journal, "base64").length).toString("base64")).toBe(before.journal);
      } else expect(after.journal).toBe(before.journal);
      expect(after.pointer).toBe(before.pointer);
      expect(after.generations).toEqual(before.generations);
      expect(after.endpoints).toEqual(before.endpoints);
    } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
  }, 60_000);
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
      const before = durableRecoveryEvidence(prepared, [
        join(prepared.fixture.repoRoot, ".next"),
        join(prepared.fixture.repoRoot, "node_modules"),
        join(prepared.fixture.repoRoot, "notes 2.txt"),
        join(prepared.runRoot, "payload", "generated", ".next"),
        join(prepared.runRoot, "payload", "source-copies", "copy-0001"),
      ]);
      const recovery = await spawnLifecycleChild("recoverRestore", { ...options, action: "rollback" });
      expect(recovery.code).not.toBe(0);
      expect(durableRecoveryEvidence(prepared, [
        join(prepared.fixture.repoRoot, ".next"),
        join(prepared.fixture.repoRoot, "node_modules"),
        join(prepared.fixture.repoRoot, "notes 2.txt"),
        join(prepared.runRoot, "payload", "generated", ".next"),
        join(prepared.runRoot, "payload", "source-copies", "copy-0001"),
      ])).toEqual(before);
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
      await killThenReleaseFixtureLock(
        "recoverRestore", { ...options, action: "resume" }, prepared.runRoot, killAt,
        RECOVERY_RESUME_PHASES.slice(0, index + 1),
      );
      const journal = join(prepared.runRoot, "journal.log");
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

  it.each((["QUARANTINED", "VALIDATED"] as const).flatMap((prior) =>
    RECOVERY_ROLLBACK_PHASES.map((killAt) => [prior,
      prior === "VALIDATED" && killAt === "after-event:RESTORE_ABORTED_TO_QUARANTINED"
        ? "after-event:RESTORE_ABORTED_TO_VALIDATED"
        : killAt,
    ] as const),
  ))("continues every reverse recovery seam after SIGKILL from %s: %s", async (prior, killAt) => {
    const prepared = prepareQuarantinedFixture();
    try {
      if (prior === "VALIDATED") validatePriorState(prepared);
      const options = {
        repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot,
        transactionId: prepared.transactionId, writersStopped: true,
      };
      const initial = await spawnLifecycleChild("restoreQuarantine", options, {
        killAt: "after-event:RESTORED_ENTRY:copy-0001",
      });
      expect(initial.signal).toBe("SIGKILL");
      rmSync(join(prepared.runRoot, "journal.lock"));
      const phaseForIndex: typeof RECOVERY_ROLLBACK_PHASES[number] = killAt === "after-event:RESTORE_ABORTED_TO_VALIDATED"
        ? "after-event:RESTORE_ABORTED_TO_QUARANTINED"
        : killAt;
      const index = RECOVERY_ROLLBACK_PHASES.indexOf(phaseForIndex);
      await killThenReleaseFixtureLock(
        "recoverRestore", { ...options, action: "rollback" }, prepared.runRoot, killAt,
        RECOVERY_ROLLBACK_PHASES.slice(0, index + 1).map((phase) =>
          prior === "VALIDATED" && phase === "after-event:RESTORE_ABORTED_TO_QUARANTINED"
            ? "after-event:RESTORE_ABORTED_TO_VALIDATED"
            : phase,
        ),
      );
      const journal = join(prepared.runRoot, "journal.log");
      const rolledBack = await spawnLifecycleChild("recoverRestore", { ...options, action: "rollback" });
      if (killAt === `after-event:${prior === "VALIDATED" ? "RESTORE_ABORTED_TO_VALIDATED" : "RESTORE_ABORTED_TO_QUARANTINED"}` || killAt === "before-lock-cleanup") {
        expect(rolledBack.code).not.toBe(0);
      } else {
        if (rolledBack.code !== 0) throw new Error(JSON.stringify(rolledBack));
        expect(JSON.parse(rolledBack.stdout)).toMatchObject({ status: prior, action: "rollback", restoreAborted: true });
      }
      expect(journalEvents(journal).at(-1)).toBe(prior === "VALIDATED" ? "RESTORE_ABORTED_TO_VALIDATED" : "RESTORE_ABORTED_TO_QUARANTINED");
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
        await killThenReleaseFixtureLock(
          "restoreQuarantine", options, prepared.runRoot, killAt, NORMAL_RESTORE_PHASES.slice(0, index + 1),
        );
        const journal = join(prepared.runRoot, "journal.log");
        const continued = await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" });
        if (killAt === "after-event:RESTORED" || killAt === "before-lock-cleanup") {
          expect(continued.code).not.toBe(0);
          expect(journalEvents(journal).at(-1)).toBe("RESTORED");
        } else {
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

  it.each((["QUARANTINED", "VALIDATED"] as const).flatMap((prior) =>
    NORMAL_RESTORE_PHASES.slice(0, 2).map((killAt) => [prior, killAt] as const),
  ))("restarts after the real pre-prepare inventory SIGKILL from %s: %s", async (prior, killAt) => {
    const prepared = prepareQuarantinedFixture();
    try {
      if (prior === "VALIDATED") validatePriorState(prepared);
      const options = { repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot, transactionId: prepared.transactionId, writersStopped: true };
      const { release } = await killThenReleaseFixtureLock("restoreQuarantine", options, prepared.runRoot, killAt,
        NORMAL_RESTORE_PHASES.slice(0, NORMAL_RESTORE_PHASES.indexOf(killAt) + 1));
      const journal = join(prepared.runRoot, "journal.log");
      const before = readFileSync(journal);
      const stale = await spawnLifecycleChild("restoreQuarantine", options);
      expect(stale.code).not.toBe(0);
      expect(readFileSync(journal)).toEqual(before);
      release();
      const restarted = await spawnLifecycleChild("restoreQuarantine", options);
      if (restarted.code !== 0) throw new Error(JSON.stringify(restarted));
      expect(JSON.parse(restarted.stdout)).toMatchObject({ status: "RESTORED" });
    } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
  }, 60_000);

  it("resumes a durable restore intent by reclaiming its authenticated dead lock", async () => {
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
      const resumed = await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" });
      if (resumed.code !== 0) throw new Error(JSON.stringify(resumed));
      expect(JSON.parse(resumed.stdout)).toMatchObject({ status: "RESTORED", action: "resume", reconciledEntries: 3 });
      expect(existsSync(join(prepared.runRoot, "journal.lock"))).toBe(false);
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

  it.each(["QUARANTINED", "VALIDATED"] as const)("persists a no-intent recovery before the first generated restore intent after SIGKILL from %s", async (prior) => {
    const prepared = prepareQuarantinedFixture();
    try {
      if (prior === "VALIDATED") validatePriorState(prepared);
      const options = { repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot, transactionId: prepared.transactionId, writersStopped: true };
      expect((await spawnLifecycleChild("restoreQuarantine", options, { killAt: "after-event:RESTORE_PREPARED" })).signal).toBe("SIGKILL");
      rmSync(join(prepared.runRoot, "journal.lock"));
      const { release } = await killThenReleaseFixtureLock(
        "recoverRestore", { ...options, action: "resume" }, prepared.runRoot,
        "after-event:RESTORE_INTENT:generated-next",
        ["after-event:RECOVERY_REQUIRED", "after-event:RESTORING", "after-event:RESTORE_INTENT:generated-next"],
      );
      release();
      const resumed = await spawnLifecycleChild("recoverRestore", { ...options, action: "resume" });
      if (resumed.code !== 0) throw new Error(JSON.stringify(resumed));
      expect(JSON.parse(resumed.stdout)).toEqual(expect.objectContaining({ status: "RESTORED", action: "resume", reconciledEntries: 3 }));
    } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
  }, 60_000);

  it.each(["QUARANTINED", "VALIDATED"] as const)("leaves a durable terminal conflict after a real SIGKILL from %s", async (prior) => {
    const prepared = prepareQuarantinedFixture();
    try {
      if (prior === "VALIDATED") validatePriorState(prepared);
      const options = { repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot, transactionId: prepared.transactionId, writersStopped: true };
      const secondCrash = await spawnLifecycleChild("restoreQuarantine", options, { killAt: "after-event:RESTORE_INTENT:copy-0001" });
      if (secondCrash.signal !== "SIGKILL") throw new Error(JSON.stringify(secondCrash));
      writeFileSync(join(prepared.runRoot, "payload", "source-copies", "copy-0001"), "foreign\n");
      rmSync(join(prepared.runRoot, "journal.lock"));
      const { release } = await killThenReleaseFixtureLock(
        "recoverRestore", { ...options, action: "resume" }, prepared.runRoot,
        "after-event:INCOMPLETE_CONFLICT",
        ["after-event:RECOVERY_REQUIRED", "after-event:INCOMPLETE_CONFLICT"],
      );
      release();
      const conflict = await spawnLifecycleChild("recoverRestore", { ...options, action: "rollback" });
      if (conflict.code !== 0) throw new Error(JSON.stringify(conflict));
      expect(JSON.parse(conflict.stdout)).toEqual(expect.objectContaining({ status: "INCOMPLETE_CONFLICT", action: "rollback", conflictEntryIds: ["copy-0001"] }));
    } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
  }, 60_000);

  it.each(["resume", "rollback"] as const)("recovers only the second public restore epoch after Q abort then V validation: %s", async (action) => {
    const prepared = prepareQuarantinedFixture();
    try {
      const options = { repoRoot: prepared.fixture.repoRoot, quarantineRoot: prepared.fixture.quarantineRoot, transactionId: prepared.transactionId, writersStopped: true };
      expect((await spawnLifecycleChild("restoreQuarantine", options, { killAt: "after-event:RESTORED_ENTRY:copy-0001" })).signal).toBe("SIGKILL");
      rmSync(join(prepared.runRoot, "journal.lock"));
      const firstAbort = await spawnLifecycleChild("recoverRestore", { ...options, action: "rollback" });
      if (firstAbort.code !== 0) throw new Error(JSON.stringify(firstAbort));
      expect(JSON.parse(firstAbort.stdout)).toEqual({ schemaVersion: 2, transactionId: prepared.transactionId, restoreId: "restore-c3624475-87d7-4886-b0bf-68a5061663d2", status: "QUARANTINED", action: "rollback", reconciledEntries: 3, restoreAborted: true });
      validatePriorState(prepared);
      const oldInventory = join(prepared.runRoot, "inventories", "restore-active", "generated-next.jsonl");
      const oldInventoryIdentity = lstatSync(oldInventory).ino;
      const oldInventoryBytes = readFileSync(oldInventory);
      const secondEpochCrash = await spawnLifecycleChild("restoreQuarantine", options, { killAt: "after-event:RESTORE_INTENT:copy-0001" });
      if (secondEpochCrash.signal !== "SIGKILL") throw new Error(JSON.stringify(secondEpochCrash));
      // The exact durable publication was reused; no close→unlink→rewrite
      // window exists in the second epoch.
      expect(lstatSync(oldInventory).ino).toBe(oldInventoryIdentity);
      expect(readFileSync(oldInventory)).toEqual(oldInventoryBytes);
      rmSync(join(prepared.runRoot, "journal.lock"));
      const recovered = await spawnLifecycleChild("recoverRestore", { ...options, action });
      if (recovered.code !== 0) throw new Error(JSON.stringify(recovered));
      const expected = action === "resume"
        ? { schemaVersion: 2, transactionId: prepared.transactionId, restoreId: "restore-c3624475-87d7-4886-b0bf-68a5061663d2", status: "RESTORED", action: "resume", reconciledEntries: 3 }
        : { schemaVersion: 2, transactionId: prepared.transactionId, restoreId: "restore-c3624475-87d7-4886-b0bf-68a5061663d2", status: "VALIDATED", action: "rollback", reconciledEntries: 3, restoreAborted: true };
      expect(JSON.parse(recovered.stdout)).toEqual(expected);
      const events = journalEvents(join(prepared.runRoot, "journal.log"));
      const currentPrepared = events.lastIndexOf("RESTORE_PREPARED");
      expect(events[currentPrepared - 1]).toBe("VALIDATED");
      expect(events.slice(currentPrepared)).toEqual(action === "resume"
        ? ["RESTORE_PREPARED", "RESTORING", "RESTORE_INTENT", "RESTORED_ENTRY", "RESTORE_INTENT", "RESTORED_ENTRY", "RESTORE_INTENT", "RECOVERY_REQUIRED", "RESTORING", "RESTORED_ENTRY", "RESTORED"]
        : ["RESTORE_PREPARED", "RESTORING", "RESTORE_INTENT", "RESTORED_ENTRY", "RESTORE_INTENT", "RESTORED_ENTRY", "RESTORE_INTENT", "RECOVERY_REQUIRED", "RESTORE_ROLLING_BACK", "RESTORE_ROLLBACK_INTENT", "RESTORE_ROLLED_BACK_ENTRY", "RESTORE_ROLLBACK_INTENT", "RESTORE_ROLLED_BACK_ENTRY", "RESTORE_ROLLBACK_INTENT", "RESTORE_ROLLED_BACK_ENTRY", "RESTORE_ABORTED_TO_VALIDATED"]);
      expect(existsSync(join(prepared.fixture.repoRoot, "notes 2.txt"))).toBe(action === "resume");
      expect(existsSync(join(prepared.runRoot, "payload", "source-copies", "copy-0001"))).toBe(action === "rollback");
    } finally { rmSync(prepared.fixture.base, { recursive: true, force: true }); }
  }, 60_000);
});
