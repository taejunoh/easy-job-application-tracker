import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const journalModuleUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-journal.mjs"),
).href;
const capabilityModuleUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-run-capability.mjs"),
).href;

const manifestSha256 = "a".repeat(64);
const validSummary = { sha256: "b".repeat(64), entries: 1, bytes: 1 };
const records = {
  prepared: {
    event: "PREPARED",
    payload: { transactionId: "tx-0001", manifestSha256 },
  },
  moving: { event: "MOVING", payload: {} },
  moveIntent: {
    event: "MOVE_INTENT",
    payload: { id: "copy-0001", expected: validSummary },
  },
  recoveryRequired: {
    event: "RECOVERY_REQUIRED",
    payload: { entryIds: ["copy-0001"] },
  },
  rollingBack: { event: "ROLLING_BACK", payload: {} },
  rolledBack: { event: "ROLLED_BACK", payload: {} },
  incompleteConflict: {
    event: "INCOMPLETE_CONFLICT",
    payload: { conflictEntryIds: ["copy-0001"] },
  },
  verifying: { event: "VERIFYING", payload: {} },
  quarantined: { event: "QUARANTINED", payload: { manifestSha256 } },
  validated: { event: "VALIDATED", payload: {} },
  restorePrepared: { event: "RESTORE_PREPARED", payload: {} },
  restoring: { event: "RESTORING", payload: {} },
  restored: { event: "RESTORED", payload: {} },
} as const;

const terminalRecords = {
  ROLLED_BACK: [
    records.prepared,
    records.moving,
    records.recoveryRequired,
    records.rollingBack,
    records.rolledBack,
  ],
  RESTORED: [
    records.prepared,
    records.moving,
    records.verifying,
    records.quarantined,
    records.restorePrepared,
    records.restoring,
    records.restored,
  ],
  INCOMPLETE_CONFLICT: [
    records.prepared,
    records.moving,
    records.incompleteConflict,
  ],
} as const;

const workerSource = `
import { createHash, randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { dirname, join } from "node:path";
import * as journal from ${JSON.stringify(journalModuleUrl)};
import { deriveRunPath, withQuarantineRunCapability } from ${JSON.stringify(capabilityModuleUrl)};

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const repoRoot = join(request.root, "repo");
const quarantineRoot = join(request.root, "quarantine");
const transactionId = "tx-0001";
const runRoot = join(quarantineRoot, transactionId);
await fsPromises.mkdir(repoRoot, { recursive: true, mode: 0o700 });
await fsPromises.mkdir(runRoot, { recursive: true, mode: 0o700 });
await fsPromises.chmod(quarantineRoot, 0o700);
await fsPromises.chmod(runRoot, 0o700);

const lockBytes = (ownerToken = randomUUID()) => {
  const identity = { version: 1, ownerToken, pid: process.pid };
  const checksum = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const body = Buffer.from(JSON.stringify({ ...identity, checksum }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
};
const snapshot = async () => {
  const names = (await fsPromises.readdir(runRoot)).sort();
  const entries = {};
  for (const name of names) {
    const path = join(runRoot, name);
    const stat = await fsPromises.lstat(path);
    entries[name] = stat.isSymbolicLink()
      ? { kind: "symlink", target: await fsPromises.readlink(path) }
      : stat.isFile()
        ? { kind: "file", bytes: (await fsPromises.readFile(path)).toString("base64") }
        : { kind: "other" };
  }
  return entries;
};
const appendAll = async (capability, values, fsApi = fsPromises, faultHook) =>
  journal.withJournalLock({ capability, fsApi }, async (heldLock) => {
    const appended = [];
    for (const value of values) {
      appended.push(await journal.appendJournalRecord({
        capability,
        heldLock,
        event: value.event,
        payload: value.payload,
        fsApi,
        faultHook,
      }));
    }
    return appended;
  });
const seedArtifacts = async (capability, malformed = false, symlink = false) => {
  const lockPath = deriveRunPath(capability, { purpose: "journal-lock" });
  const tombstonePath = deriveRunPath(capability, {
    purpose: "journal-tombstone",
    id: "11111111-1111-4111-8111-111111111111",
  });
  await fsPromises.writeFile(lockPath, lockBytes(), { mode: 0o600 });
  if (symlink) {
    const victim = join(request.root, "victim");
    await fsPromises.writeFile(victim, "victim", { mode: 0o600 });
    await fsPromises.symlink(victim, tombstonePath);
  } else {
    await fsPromises.writeFile(tombstonePath, malformed ? "bad" : lockBytes(), {
      mode: 0o600,
    });
  }
  await fsPromises.writeFile(join(runRoot, "sentinel"), "keep", { mode: 0o600 });
  return { lockPath, tombstonePath };
};
const capture = async (callback) => {
  try {
    return { ok: true, value: await callback() };
  } catch (error) {
    return {
      ok: false,
      error: {
        name: error.name,
        code: error.code ?? null,
        message: error.message,
        expectedSequence: error.expectedSequence ?? null,
        expectedRecordHash: error.expectedRecordHash ?? null,
        cleanupError: error.cleanupError?.message ?? null,
      },
    };
  }
};

const result = await withQuarantineRunCapability({
  repoRoot,
  quarantineRoot,
  transactionId,
  writersStopped: true,
}, async (capability) => {
  if (request.operation === "terminal-cleanup") {
    await appendAll(capability, request.records);
    await seedArtifacts(capability);
    const journalPath = deriveRunPath(capability, { purpose: "journal" });
    const beforeBytes = await fsPromises.readFile(journalPath);
    const before = await journal.replayJournal({ capability });
    let parentSyncs = 0;
    const openCalls = [];
    const trackedFs = {
      ...fsPromises,
      open: async (path, flags, mode) => {
        openCalls.push([String(path), String(flags)]);
        const handle = await fsPromises.open(path, flags, mode);
          if (!String(path).endsWith("/quarantine/tx-0001")) return handle;
          return {
            sync: async () => {
              parentSyncs += 1;
              return handle.sync();
            },
            close: () => handle.close(),
          };
      },
    };
    await journal.cleanupTerminalJournalArtifacts({
      capability,
      writersStopped: true,
      fsApi: trackedFs,
    });
    const afterBytes = await fsPromises.readFile(journalPath);
    const after = await journal.replayJournal({ capability });
    return {
      bytesUnchanged: beforeBytes.equals(afterBytes),
      before,
      after,
      names: (await fsPromises.readdir(runRoot)).sort(),
      parentSyncs,
      openCalls,
    };
  }

  if (request.operation === "cleanup-rejection") {
    await appendAll(capability, request.records);
    const { tombstonePath } = await seedArtifacts(
      capability,
      request.case === "malformed-artifact",
      request.case === "symlink-artifact",
    );
    if (request.case === "torn") {
      const journalPath = deriveRunPath(capability, { purpose: "journal" });
      await fsPromises.appendFile(journalPath, Buffer.from([0, 0]));
    }
    if (request.case === "malformed-journal") {
      const journalPath = deriveRunPath(capability, { purpose: "journal" });
      const bytes = await fsPromises.readFile(journalPath);
      bytes[4] = 0xff;
      await fsPromises.writeFile(journalPath, bytes);
    }
    if (request.case === "nonregular-artifact") {
      await fsPromises.rm(tombstonePath);
      await fsPromises.mkdir(tombstonePath);
    }
    if (request.case === "malformed-name") {
      await fsPromises.writeFile(join(runRoot, "journal.lock.tombstone.bad"), lockBytes(), {
        mode: 0o600,
      });
    }
    if (request.case === "lock-replacement") {
      let lockStats = 0;
      const lockPath = deriveRunPath(capability, { purpose: "journal-lock" });
      const replacedPath = join(runRoot, "original-lock");
      const raceFs = {
        ...fsPromises,
        lstat: async (path) => {
          if (path === lockPath) {
            lockStats += 1;
            if (lockStats === 2) {
              await fsPromises.rename(lockPath, replacedPath);
              await fsPromises.writeFile(lockPath, lockBytes(), { mode: 0o600 });
            }
          }
          return fsPromises.lstat(path);
        },
      };
      const before = await snapshot();
      const outcome = await capture(() => journal.cleanupTerminalJournalArtifacts({
        capability,
        writersStopped: true,
        fsApi: raceFs,
      }));
      return { outcome, before, after: await snapshot(), tombstonePath };
    }
    const before = await snapshot();
    const outcome = await capture(() => journal.cleanupTerminalJournalArtifacts({
      capability,
      writersStopped: request.case === "false-attestation" ? false : true,
      fsApi: fsPromises,
    }));
    return { outcome, before, after: await snapshot(), tombstonePath };
  }

  if (request.operation === "ordinary-race") {
    await appendAll(capability, [request.records[0]]);
    const journalPath = deriveRunPath(capability, { purpose: "journal" });
    const lockPath = deriveRunPath(capability, { purpose: "journal-lock" });
    const displacedPath = join(runRoot, "displaced-owned-lock");
    const beforeBytes = await fsPromises.readFile(journalPath);
    let replaced = false;
    const replace = async () => {
      if (replaced) return;
      replaced = true;
      await fsPromises.rename(lockPath, displacedPath);
      await fsPromises.writeFile(lockPath, lockBytes(), { mode: 0o600 });
    };
    const outcome = await capture(() => journal.withJournalLock(
      { capability, fsApi: fsPromises },
      (heldLock) => journal.appendJournalRecord({
        capability,
        heldLock,
        event: request.records[1].event,
        payload: request.records[1].payload,
        fsApi: fsPromises,
        faultHook: async (phase) => {
          if (phase === request.phase) await replace();
        },
      }),
    ));
    const afterBytes = await fsPromises.readFile(journalPath);
    const beforeRecovery = await journal.replayJournal({ capability });
      const foreignPreserved = await fsPromises.lstat(lockPath).then(() => true, () => false);
    await journal.reclaimJournalLock(
      { capability, writersStopped: true, fsApi: fsPromises },
      async (heldLock) => {
        const replayed = await journal.replayJournal({ capability });
        const candidatePresent = replayed.records.some(
          (record) => record.event === request.records[1].event,
        );
        const next = candidatePresent ? request.records[2] : request.records[1];
        return journal.appendJournalRecord({
          capability,
          heldLock,
          event: next.event,
          payload: next.payload,
          fsApi: fsPromises,
        });
      },
    );
    const replayed = await journal.replayJournal({ capability });
    return {
      outcome,
      rawBytesUnchanged: beforeBytes.equals(afterBytes),
      beforeRecovery,
      replayed,
      foreignPreserved,
    };
  }

  if (request.operation === "recovery-race") {
    await appendAll(capability, [request.records[0]]);
    await seedArtifacts(capability);
    const journalPath = deriveRunPath(capability, { purpose: "journal" });
    const lockPath = deriveRunPath(capability, { purpose: "journal-lock" });
    const displacedPath = join(runRoot, "recovery-displaced-lock");
    const beforeBytes = await fsPromises.readFile(journalPath);
    let replaced = false;
    const replace = async () => {
      if (replaced) return;
      replaced = true;
      await fsPromises.rename(lockPath, displacedPath);
      await fsPromises.writeFile(lockPath, lockBytes(), { mode: 0o600 });
    };
    const outcome = await capture(() => journal.reclaimJournalLock(
      { capability, writersStopped: true, fsApi: fsPromises },
      (heldLock) => journal.appendJournalRecord({
        capability,
        heldLock,
        event: request.records[1].event,
        payload: request.records[1].payload,
        fsApi: fsPromises,
        faultHook: async (phase) => {
          if (phase === request.phase) await replace();
        },
      }),
    ));
    const afterBytes = await fsPromises.readFile(journalPath);
    const foreignPreserved = await fsPromises.lstat(lockPath).then(() => true, () => false);
    await journal.reclaimJournalLock(
      { capability, writersStopped: true, fsApi: fsPromises },
      async (heldLock) => {
        const replayed = await journal.replayJournal({ capability });
        const candidatePresent = replayed.records.some(
          (record) => record.event === request.records[1].event,
        );
        const next = candidatePresent ? request.records[2] : request.records[1];
        return journal.appendJournalRecord({
          capability,
          heldLock,
          event: next.event,
          payload: next.payload,
          fsApi: fsPromises,
        });
      },
    );
    const replayed = await journal.replayJournal({ capability });
    return {
      outcome,
      rawBytesUnchanged: beforeBytes.equals(afterBytes),
      foreignPreserved,
      replayed,
    };
  }

  if (request.operation === "prepare-terminal") {
    await appendAll(capability, request.records);
    await seedArtifacts(capability);
    return journal.replayJournal({ capability });
  }
  if (request.operation === "cleanup-retry") {
    const before = await journal.replayJournal({ capability });
    const journalPath = deriveRunPath(capability, { purpose: "journal" });
    const bytes = await fsPromises.readFile(journalPath);
    await journal.cleanupTerminalJournalArtifacts({ capability, writersStopped: true });
    const after = await journal.replayJournal({ capability });
    return {
      before,
      after,
      bytesUnchanged: bytes.equals(await fsPromises.readFile(journalPath)),
      names: (await fsPromises.readdir(runRoot)).sort(),
    };
  }
  if (request.operation === "replay-attacks") {
    const journalPath = deriveRunPath(capability, { purpose: "journal" });
    if (request.case === "oversized") {
      await fsPromises.writeFile(journalPath, Buffer.alloc(65));
      return capture(() => journal.replayJournal({ capability, maxBytes: 64 }));
    }
    const victim = join(request.root, "journal-victim");
    await fsPromises.writeFile(victim, "victim");
    await fsPromises.symlink(victim, journalPath);
    return capture(() => journal.replayJournal({ capability }));
  }
  if (request.operation === "journal-regression") {
    await appendAll(capability, request.prefix);
    const journalPath = deriveRunPath(capability, { purpose: "journal" });
    const before = await fsPromises.readFile(journalPath).catch((error) => {
      if (error.code === "ENOENT") return Buffer.alloc(0);
      throw error;
    });
    if (request.case === "torn-repair") {
      await fsPromises.appendFile(journalPath, Buffer.from([0, 1]));
      const torn = await journal.replayJournal({ capability });
      await appendAll(capability, [request.record]);
      return { torn, replayed: await journal.replayJournal({ capability }) };
    }
    if (request.case === "malformed-middle") {
      const input = Buffer.from(before);
      const firstLength = input.readUInt32BE(0);
      input[4 + firstLength + 4] = 0xff;
      await fsPromises.writeFile(journalPath, input);
      const corrupted = await fsPromises.readFile(journalPath);
      const replayOutcome = await capture(() => journal.replayJournal({ capability }));
      const appendOutcome = await capture(() => appendAll(capability, [request.record]));
      return {
        replayOutcome,
        appendOutcome,
        bytesUnchanged: corrupted.equals(await fsPromises.readFile(journalPath)),
      };
    }
    const outcome = await capture(() => appendAll(capability, [request.record]));
    return {
      outcome,
      bytesUnchanged: before.equals(await fsPromises.readFile(journalPath).catch((error) => {
        if (error.code === "ENOENT") return Buffer.alloc(0);
        throw error;
      })),
      replayed: await journal.replayJournal({ capability }),
    };
  }
  if (request.operation === "recover-moving") {
    const before = await journal.replayJournal({ capability });
    await journal.reclaimJournalLock(
      { capability, writersStopped: true, fsApi: fsPromises },
      async (heldLock) => {
        const replayed = await journal.replayJournal({ capability });
        const movingPresent = replayed.records.some((record) => record.event === "MOVING");
        const next = movingPresent ? request.nextRecord : request.movingRecord;
        return journal.appendJournalRecord({
          capability,
          heldLock,
          event: next.event,
          payload: next.payload,
          fsApi: fsPromises,
        });
      },
    );
    const after = await journal.replayJournal({ capability });
    return {
      before,
      after,
      movingCount: after.records.filter((record) => record.event === "MOVING").length,
    };
  }
  if (request.operation === "cleanup-mask") {
    await appendAll(capability, [request.prefix]);
    const lockPath = deriveRunPath(capability, { purpose: "journal-lock" });
    const failureFs = {
      ...fsPromises,
      open: async (path, flags, mode) => {
        const handle = await fsPromises.open(path, flags, mode);
        if (String(path) !== lockPath || !String(flags).includes("x")) return handle;
        return new Proxy(handle, {
          get(target, property) {
            if (property === "close") return async () => {
              await target.close();
              throw new Error("injected held-lock close failure");
            };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };
    return capture(() => journal.withJournalLock(
      { capability, fsApi: failureFs },
      (heldLock) => journal.appendJournalRecord({
        capability,
        heldLock,
        event: request.record.event,
        payload: request.record.payload,
        fsApi: failureFs,
        faultHook: async (phase) => {
          if (phase === "after-journal-sync") throw new Error("injected append failure");
        },
      }),
    ));
  }
  if (request.operation === "api-contract") {
    return {
      exports: Object.keys(journal).sort(),
      rawReplay: await capture(() => journal.replayJournal({ journalPath: "/tmp/foreign" })),
      rawAppend: await capture(() => journal.appendJournalRecord({
        journalPath: "/tmp/foreign",
        event: "PREPARED",
        payload: request.record.payload,
      })),
    };
  }
  throw new Error("unknown operation");
});
process.stdout.write(JSON.stringify(result));
`;

function invoke(root: string, request: Record<string, unknown>) {
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "--eval", workerSource], {
      encoding: "utf8",
      input: JSON.stringify({ root, ...request }),
    }),
  );
}

function killTerminalCleanup(root: string, boundary: "after-lock-acquired" | "after-tombstone-rename") {
  const source = `
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import * as journal from ${JSON.stringify(journalModuleUrl)};
import { withQuarantineRunCapability } from ${JSON.stringify(capabilityModuleUrl)};
const root = process.argv[1];
const repoRoot = join(root, "repo");
const quarantineRoot = join(root, "quarantine");
const runRoot = join(quarantineRoot, "tx-0001");
let renamed = false;
const crashFs = {
  ...fsPromises,
  rename: async (...args) => {
    const value = await fsPromises.rename(...args);
    if (${JSON.stringify(boundary)} === "after-tombstone-rename" && !renamed) {
      renamed = true;
      process.kill(process.pid, "SIGKILL");
    }
    return value;
  },
  open: async (path, flags, mode) => {
    const handle = await fsPromises.open(path, flags, mode);
    if (
      ${JSON.stringify(boundary)} !== "after-lock-acquired" ||
      !String(path).endsWith("/quarantine/tx-0001/journal.lock") ||
      !String(flags).includes("x")
    ) return handle;
    process.kill(process.pid, "SIGKILL");
    return handle;
  },
};
await withQuarantineRunCapability({ repoRoot, quarantineRoot, transactionId: "tx-0001", writersStopped: true },
  (capability) => journal.cleanupTerminalJournalArtifacts({ capability, writersStopped: true, fsApi: crashFs }));
`;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source, root], {
    encoding: "utf8",
  });
}

function killOrdinaryAppend(
  root: string,
  boundary: "after-lock-create" | "after-lock-fsync" | "partial-frame" | "full-frame-before-cleanup",
) {
  const source = `
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import * as journal from ${JSON.stringify(journalModuleUrl)};
import { withQuarantineRunCapability } from ${JSON.stringify(capabilityModuleUrl)};
const root = process.argv[1];
const repoRoot = join(root, "repo");
const quarantineRoot = join(root, "quarantine");
const boundary = ${JSON.stringify(boundary)};
const crashFs = {
  ...fsPromises,
  open: async (path, flags, mode) => {
    const handle = await fsPromises.open(path, flags, mode);
    const value = String(path);
    if (value.endsWith("/journal.lock") && String(flags).includes("x")) {
      if (boundary === "after-lock-create") process.kill(process.pid, "SIGKILL");
      if (boundary === "after-lock-fsync") {
        return new Proxy(handle, {
          get(target, property) {
            if (property === "sync") return async () => {
              const result = await target.sync();
              process.kill(process.pid, "SIGKILL");
              return result;
            };
            const member = Reflect.get(target, property, target);
            return typeof member === "function" ? member.bind(target) : member;
          },
        });
      }
    }
    if (value.endsWith("/journal.log") && boundary === "partial-frame") {
      return new Proxy(handle, {
        get(target, property) {
          if (property === "write") return async (buffer) => {
            await target.write(buffer.subarray(0, Math.max(1, Math.floor(buffer.length / 2))));
            process.kill(process.pid, "SIGKILL");
          };
          const member = Reflect.get(target, property, target);
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
    }
    return handle;
  },
};
await withQuarantineRunCapability({ repoRoot, quarantineRoot, transactionId: "tx-0001", writersStopped: true },
  (capability) => journal.withJournalLock({ capability, fsApi: crashFs },
    (heldLock) => journal.appendJournalRecord({
      capability,
      heldLock,
      event: "MOVING",
      payload: {},
      fsApi: crashFs,
      faultHook: async (phase) => {
        if (boundary === "full-frame-before-cleanup" && phase === "before-lock-cleanup") {
          process.kill(process.pid, "SIGKILL");
        }
      },
    })));
`;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source, root], {
    encoding: "utf8",
  });
}

describe("capability-bound durable quarantine journal", () => {
  const fixture = mkdtempSync(join(tmpdir(), "quarantine-journal-capability-"));

  afterAll(() => rmSync(fixture, { recursive: true, force: true }));

  it.each(Object.entries(terminalRecords))(
    "cleans validated stale artifacts at terminal tip %s without changing the journal",
    (state, values) => {
      const root = join(fixture, `terminal-${state}`);
      const result = invoke(root, {
        operation: "terminal-cleanup",
        records: values,
      });
      expect(result.bytesUnchanged).toBe(true);
      expect(result.before).toEqual(result.after);
      expect(result.after.state).toBe(state);
      expect(result.after.records.at(-1).event).toBe(state);
      expect(result.names).toEqual(["journal.log", "sentinel"]);
      expect(result.openCalls.some(
        ([path, flags]: [string, string]) =>
          path.endsWith("/quarantine/tx-0001") && flags === "r",
      )).toBe(true);
      expect(result.parentSyncs).toBeGreaterThan(0);
    },
  );

  it.each([
    ["VALIDATED", [...terminalRecords.RESTORED.slice(0, 4), records.validated]],
    ["nonterminal", [records.prepared, records.moving]],
    ["torn", terminalRecords.ROLLED_BACK],
    ["malformed-journal", terminalRecords.ROLLED_BACK],
    ["false-attestation", terminalRecords.ROLLED_BACK],
    ["malformed-artifact", terminalRecords.ROLLED_BACK],
    ["symlink-artifact", terminalRecords.ROLLED_BACK],
    ["nonregular-artifact", terminalRecords.ROLLED_BACK],
    ["malformed-name", terminalRecords.ROLLED_BACK],
    ["lock-replacement", terminalRecords.ROLLED_BACK],
  ])("fails cleanup closed with every artifact unchanged for %s", (caseName, values) => {
    const result = invoke(join(fixture, `reject-${caseName}`), {
      operation: "cleanup-rejection",
      case: caseName,
      records: values,
    });
    expect(result.outcome.ok).toBe(false);
    if (caseName === "lock-replacement") {
      expect(result.after["journal.log"]).toEqual(result.before["journal.log"]);
      expect(result.after["journal.lock.tombstone.11111111-1111-4111-8111-111111111111"])
        .toEqual(result.before["journal.lock.tombstone.11111111-1111-4111-8111-111111111111"]);
      expect(result.after.sentinel).toEqual(result.before.sentinel);
      expect(result.after["original-lock"]).toEqual(result.before["journal.lock"]);
      expect(result.after["journal.lock"]).toBeDefined();
    } else {
      expect(result.after).toEqual(result.before);
    }
  });

  it.each([
    ["before-mutation", true, false],
    ["after-journal-sync", false, true],
    ["before-lock-cleanup", false, true],
  ])(
    "uses held-lock ownership at %s and explicit recovery records the candidate exactly once",
    (phase, bytesUnchanged, indeterminate) => {
      const result = invoke(join(fixture, `ordinary-${phase}`), {
        operation: "ordinary-race",
        phase,
        records: [records.prepared, records.moving, records.moveIntent],
      });
      expect(result.rawBytesUnchanged).toBe(bytesUnchanged);
      expect(result.foreignPreserved).toBe(true);
      expect(result.outcome.ok).toBe(false);
      if (indeterminate) {
        expect(result.outcome.error).toMatchObject({
          name: "IndeterminateJournalAppendError",
          code: "ERR_INDETERMINATE_JOURNAL_APPEND",
          expectedSequence: 2,
        });
        expect(result.outcome.error.expectedRecordHash).toMatch(/^[a-f0-9]{64}$/u);
      } else {
        expect(result.outcome.error.name).not.toBe("IndeterminateJournalAppendError");
      }
      expect(
        result.replayed.records.filter((record: { event: string }) => record.event === "MOVING"),
      ).toHaveLength(1);
    },
  );

  it.each([
    ["before-mutation", true, false],
    ["after-journal-sync", false, true],
    ["before-lock-cleanup", false, true],
  ])(
    "applies the same ownership and indeterminate rules to recovery at %s",
    (phase, bytesUnchanged, indeterminate) => {
      const result = invoke(join(fixture, `recovery-${phase}`), {
        operation: "recovery-race",
        phase,
        records: [records.prepared, records.moving, records.moveIntent],
      });
      expect(result.rawBytesUnchanged).toBe(bytesUnchanged);
      expect(result.foreignPreserved).toBe(true);
      expect(result.outcome.ok).toBe(false);
      expect(result.outcome.error.name === "IndeterminateJournalAppendError").toBe(indeterminate);
      if (indeterminate) {
        expect(result.outcome.error).toMatchObject({
          expectedSequence: 2,
          expectedRecordHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        });
      }
      expect(result.replayed.records.filter(
        (record: { event: string }) => record.event === "MOVING",
      )).toHaveLength(1);
    },
  );

  it.each(["after-lock-acquired", "after-tombstone-rename"] as const)(
    "retries cleanup without appending after real SIGKILL %s",
    (boundary) => {
      const root = join(fixture, `sigkill-${boundary}`);
      const prepared = invoke(root, {
        operation: "prepare-terminal",
        records: terminalRecords.ROLLED_BACK,
      });
      const killed = killTerminalCleanup(root, boundary);
      expect(killed.signal).toBe("SIGKILL");
      const retried = invoke(root, { operation: "cleanup-retry" });
      expect(retried.before).toEqual(prepared);
      expect(retried.after).toEqual(prepared);
      expect(retried.bytesUnchanged).toBe(true);
      expect(retried.names).toEqual(["journal.log", "sentinel"]);
    },
  );

  it("preserves canonical hash chaining, sequence, and exact envelope keys", () => {
    const result = invoke(join(fixture, "canonical-chain"), {
      operation: "journal-regression",
      case: "illegal",
      prefix: [records.prepared, records.moving],
      record: records.quarantined,
    });
    expect(result.outcome.ok).toBe(false);
    expect(result.bytesUnchanged).toBe(true);
    expect(result.replayed.records.map((record: { sequence: number }) => record.sequence))
      .toEqual([1, 2]);
    expect(Object.keys(result.replayed.records[0])).toEqual([
      "sequence",
      "previousHash",
      "event",
      "payload",
      "recordHash",
    ]);
    expect(result.replayed.records[1].previousHash).toBe(result.replayed.records[0].recordHash);
    expect(result.replayed.records[0].recordHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ["missing PREPARED key", [], { event: "PREPARED", payload: { transactionId: "tx-0001" } }],
    ["unknown PREPARED key", [], {
      event: "PREPARED",
      payload: { ...records.prepared.payload, attackerPath: "../victim" },
    }],
    ["unknown empty-event key", [records.prepared], {
      event: "MOVING",
      payload: { attackerPath: "../victim" },
    }],
    ["invalid entry ID", [records.prepared, records.moving], {
      event: "MOVE_INTENT",
      payload: { id: "../victim", expected: validSummary },
    }],
    ["unsorted recovery IDs", [records.prepared, records.moving], {
      event: "RECOVERY_REQUIRED",
      payload: { entryIds: ["copy-0002", "copy-0001"] },
    }],
  ])("rejects the closed event payload schema: %s", (_label, prefix, record) => {
    const result = invoke(join(fixture, `payload-${_label.replaceAll(" ", "-")}`), {
      operation: "journal-regression",
      case: "payload",
      prefix,
      record,
    });
    expect(result.outcome.ok).toBe(false);
    expect(result.bytesUnchanged).toBe(true);
  });

  it("ignores a torn final tail, then truncates and appends at the next sequence", () => {
    const result = invoke(join(fixture, "torn-repair"), {
      operation: "journal-regression",
      case: "torn-repair",
      prefix: [records.prepared, records.moving],
      record: records.moveIntent,
    });
    expect(result.torn).toMatchObject({ truncatedTail: true, validEndOffset: expect.any(Number) });
    expect(result.torn.records).toHaveLength(2);
    expect(result.replayed).toMatchObject({ truncatedTail: false, state: "MOVING" });
    expect(result.replayed.records.at(-1)).toMatchObject({ sequence: 3, event: "MOVE_INTENT" });
  });

  it("treats a malformed complete middle frame as fatal and never truncates it", () => {
    const result = invoke(join(fixture, "malformed-middle"), {
      operation: "journal-regression",
      case: "malformed-middle",
      prefix: [records.prepared, records.moving, records.moveIntent],
      record: { event: "MOVED", payload: { id: "copy-0001", observed: validSummary } },
    });
    expect(result.replayOutcome.ok).toBe(false);
    expect(result.appendOutcome.ok).toBe(false);
    expect(result.bytesUnchanged).toBe(true);
  });

  it.each([
    "after-lock-create",
    "after-lock-fsync",
    "partial-frame",
    "full-frame-before-cleanup",
  ] as const)(
    "recovers an ordinary append candidate exactly once after actual SIGKILL %s",
    (boundary) => {
      const root = join(fixture, `ordinary-sigkill-${boundary}`);
      invoke(root, {
        operation: "journal-regression",
        case: "seed",
        prefix: [records.prepared],
        record: records.quarantined,
      });
      const killed = killOrdinaryAppend(root, boundary);
      expect(killed.stderr).toBe("");
      expect(killed.signal).toBe("SIGKILL");
      const recovered = invoke(root, {
        operation: "recover-moving",
        movingRecord: records.moving,
        nextRecord: records.moveIntent,
      });
      expect(recovered.before.records.filter(
        (record: { event: string }) => record.event === "MOVING",
      ).length).toBeLessThanOrEqual(1);
      expect(recovered.movingCount).toBe(1);
    },
  );

  it("preserves an indeterminate primary and candidate evidence when lock close also fails", () => {
    const result = invoke(join(fixture, "cleanup-mask"), {
      operation: "cleanup-mask",
      prefix: records.prepared,
      record: records.moving,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      name: "IndeterminateJournalAppendError",
      code: "ERR_INDETERMINATE_JOURNAL_APPEND",
      expectedSequence: 2,
      cleanupError: "injected held-lock close failure",
    });
    expect(result.error.expectedRecordHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each(["oversized", "symlink"])("rejects a %s journal read", (caseName) => {
    const outcome = invoke(join(fixture, `replay-${caseName}`), {
      operation: "replay-attacks",
      case: caseName,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error.message).toMatch(/journal|regular|large|symlink/u);
  });

  it("exports only capability-bound journal mutation APIs and rejects raw paths", () => {
    const result = invoke(join(fixture, "api-contract"), {
      operation: "api-contract",
      record: records.prepared,
    });
    expect(result.exports).toEqual([
      "IndeterminateJournalAppendError",
      "appendJournalRecord",
      "cleanupTerminalJournalArtifacts",
      "reclaimJournalLock",
      "replayJournal",
      "validateTransition",
      "withJournalLock",
    ]);
    expect(result.rawReplay.ok).toBe(false);
    expect(result.rawAppend.ok).toBe(false);
    expect(existsSync(join(fixture, "never-created"))).toBe(false);
  });
});
