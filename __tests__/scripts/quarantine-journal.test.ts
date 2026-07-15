import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const journalModuleUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-journal.mjs"),
).href;
const manifestModuleUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-manifest.mjs"),
).href;

function invokeJournal(request: Record<string, unknown>) {
  const source = `
import * as journal from ${JSON.stringify(journalModuleUrl)};
import * as fsPromises from "node:fs/promises";
import { dirname } from "node:path";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const durabilityEvents = [];
let directorySyncCount = 0;
const needsWrappedFs = request.trackDurability || request.failAt;
const wrappedFs = needsWrappedFs ? {
  ...fsPromises,
  open: async (path, flags, mode) => {
    const handle = await fsPromises.open(path, flags, mode);
    return new Proxy(handle, {
      get(target, property) {
        if (property === "sync") return async () => {
          const isDirectory = path === dirname(request.journalPath);
          durabilityEvents.push(isDirectory ? "directory-sync" : "file-sync");
          if (isDirectory) directorySyncCount += 1;
          const result = await target.sync();
          if (request.failAt === "frame-fsync" && path === request.journalPath) {
            throw new Error("injected crash after frame fsync");
          }
          if (request.failAt === "parent-fsync" && isDirectory && directorySyncCount === 2) {
            throw new Error("injected crash after parent fsync");
          }
          return result;
        };
        if (property === "write" && request.failAt === "file-create" && path === request.journalPath) {
          return async () => { throw new Error("injected crash after file create"); };
        }
        if (property === "write" && request.failAt === "partial-frame" && path === request.journalPath) {
          return async (buffer) => {
            const partial = buffer.subarray(0, Math.max(1, Math.floor(buffer.length / 2)));
            await target.write(partial);
            throw new Error("injected crash during frame append");
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  },
} : undefined;
const errorDetails = (error) => ({
  name: error.name,
  code: error.code ?? null,
  message: error.message,
  expectedSequence: error.expectedSequence ?? null,
  expectedRecordHash: error.expectedRecordHash ?? null,
});
const listLockResidues = async () => {
  const directory = dirname(request.journalPath);
  const prefix = request.journalPath.split("/").at(-1) + ".lock.reclaim-";
  return (await fsPromises.readdir(directory)).filter((name) => name.startsWith(prefix)).sort();
};
try {
  let result;
  if (request.operation === "append-many") {
    result = [];
    for (const record of request.records) {
      result.push(await journal.appendJournalRecord({
        journalPath: request.journalPath,
        event: record.event,
        payload: record.payload,
        ...(wrappedFs ? { fsApi: wrappedFs } : {}),
      }));
    }
  } else if (request.operation === "append-one") {
    result = await journal.appendJournalRecord({
      journalPath: request.journalPath,
      event: request.record.event,
      payload: request.record.payload,
      ...(wrappedFs ? { fsApi: wrappedFs } : {}),
    });
  } else if (request.operation === "concurrent") {
    const slowFs = {
      ...fsPromises,
      open: async (path, flags, mode) => {
        const handle = await fsPromises.open(path, flags, mode);
        if (path.endsWith(".lock") || path === request.journalPath) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return handle;
      },
    };
    const options = {
      journalPath: request.journalPath,
      event: request.record.event,
      payload: request.record.payload,
    };
    const settled = await Promise.allSettled([
      journal.appendJournalRecord({ ...options, fsApi: slowFs }),
      journal.appendJournalRecord(options),
    ]);
    result = settled.map((item) => item.status);
  } else if (request.operation === "replay") {
    result = await journal.replayJournal(request.journalPath);
  } else if (request.operation === "reclaim") {
    result = await journal.reclaimJournalLock({
      journalPath: request.journalPath,
      writersStopped: request.writersStopped,
      recovery: async ({ append }) => append({
        event: request.record.event,
        payload: request.record.payload,
      }),
    });
  } else if (request.operation === "reclaim-leaked-capability") {
    let leakedAppend;
    let recoveryError = null;
    try {
      await journal.reclaimJournalLock({
        journalPath: request.journalPath,
        writersStopped: true,
        recovery: async ({ append }) => {
          leakedAppend = append;
          if (request.callbackOutcome === "failure") {
            throw new Error("injected recovery callback failure");
          }
          return append({
            event: request.record.event,
            payload: request.record.payload,
          });
        },
      });
    } catch (error) {
      recoveryError = error.message;
    }
    const beforeLeak = await journal.replayJournal(request.journalPath);
    const beforeLeakBytes = await fsPromises.readFile(request.journalPath);
    let leakedError = null;
    try {
      await leakedAppend({
        event: request.leakedRecord.event,
        payload: request.leakedRecord.payload,
      });
    } catch (error) {
      leakedError = error.message;
    }
    const afterLeak = await journal.replayJournal(request.journalPath);
    const afterLeakBytes = await fsPromises.readFile(request.journalPath);
    result = {
      recoveryError,
      leakedError,
      beforeLeak,
      afterLeak,
      bytesUnchanged: beforeLeakBytes.equals(afterLeakBytes),
    };
  } else if (request.operation === "reclaim-mutated-lock") {
    result = await journal.reclaimJournalLock({
      journalPath: request.journalPath,
      writersStopped: true,
      recovery: async ({ append }) => {
        const lockPath = request.journalPath + ".lock";
        await fsPromises.rm(lockPath);
        if (request.mutation === "replacement") {
          await fsPromises.writeFile(lockPath, "attacker", { mode: 0o600 });
        } else if (request.mutation === "directory") {
          await fsPromises.mkdir(lockPath);
        }
        return append({
          event: request.record.event,
          payload: request.record.payload,
        });
      },
    });
  } else if (request.operation === "reclaim-multiple") {
    result = await journal.reclaimJournalLock({
      journalPath: request.journalPath,
      writersStopped: true,
      recovery: async ({ append }) => {
        const appended = [];
        for (const record of request.records) {
          appended.push(await append({ event: record.event, payload: record.payload }));
        }
        return appended;
      },
    });
  } else if (request.operation === "reclaim-race-boundary") {
    const lockPath = request.journalPath + ".lock";
    const intrudedPath = lockPath + ".intruded-" + request.boundary;
    let ownershipChecks = 0;
    let trackOwnership = false;
    let replaced = false;
    let destructiveSeamCalls = 0;
    const replaceLockPath = async () => {
      if (replaced) return;
      replaced = true;
      await fsPromises.rename(lockPath, intrudedPath);
      await fsPromises.writeFile(lockPath, "attacker", { mode: 0o600 });
    };
    const raceFs = {
      ...fsPromises,
      lstat: async (path) => {
        if (trackOwnership && path === lockPath) {
          ownershipChecks += 1;
          if (request.boundary === "before-last-precheck" && ownershipChecks === 2) {
            await replaceLockPath();
          }
        }
        return fsPromises.lstat(path);
      },
      open: async (path, flags, mode) => {
        const handle = await fsPromises.open(path, flags, mode);
        if (path !== request.journalPath) return handle;
        return new Proxy(handle, {
          get(target, property) {
            if (property === "write") {
              return async (...args) => {
                if (request.boundary === "after-precheck-before-write") {
                  await replaceLockPath();
                }
                return target.write(...args);
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };
    const before = await fsPromises.readFile(request.journalPath);
    let caught = null;
    try {
      await journal.reclaimJournalLock({
        journalPath: request.journalPath,
        writersStopped: true,
        fsApi: raceFs,
        recovery: async ({ append }) => {
          trackOwnership = true;
          const record = await append({
            event: request.record.event,
            payload: request.record.payload,
          });
          if (request.seamSource) {
            await fsPromises.rename(request.seamSource, request.seamDestination);
          }
          destructiveSeamCalls += 1;
          return record;
        },
      });
    } catch (error) {
      caught = errorDetails(error);
    }
    const after = await fsPromises.readFile(request.journalPath);
    result = {
      caught,
      destructiveSeamCalls,
      rawBytesUnchanged: before.equals(after),
      replayed: await journal.replayJournal(request.journalPath),
      residues: await listLockResidues(),
    };
  } else if (request.operation === "reclaim-indeterminate-sync") {
    let destructiveSeamCalls = 0;
    let injected = false;
    const syncFailureFs = {
      ...fsPromises,
      open: async (path, flags, mode) => {
        const handle = await fsPromises.open(path, flags, mode);
        if (path !== request.journalPath) return handle;
        return new Proxy(handle, {
          get(target, property) {
            if (property === "sync") {
              return async () => {
                const synced = await target.sync();
                if (!injected) {
                  injected = true;
                  throw new Error("injected failure after journal sync");
                }
                return synced;
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };
    let caught = null;
    try {
      await journal.reclaimJournalLock({
        journalPath: request.journalPath,
        writersStopped: true,
        fsApi: syncFailureFs,
        recovery: async ({ append }) => {
          const record = await append({
            event: request.record.event,
            payload: request.record.payload,
          });
          if (request.seamSource) {
            await fsPromises.rename(request.seamSource, request.seamDestination);
          }
          destructiveSeamCalls += 1;
          return record;
        },
      });
    } catch (error) {
      caught = errorDetails(error);
    }
    result = {
      caught,
      destructiveSeamCalls,
      replayed: await journal.replayJournal(request.journalPath),
      lockExists: await fsPromises.lstat(request.journalPath + ".lock").then(() => true, () => false),
      residues: await listLockResidues(),
    };
  } else if (request.operation === "reconcile-indeterminate") {
    const before = await journal.replayJournal(request.journalPath);
    const candidate = before.records.find((record) =>
      record.sequence === request.expectedSequence &&
      record.recordHash === request.expectedRecordHash
    );
    let candidateAppendCalls = 0;
    const appended = await journal.reclaimJournalLock({
      journalPath: request.journalPath,
      writersStopped: true,
      recovery: async ({ append }) => {
        if (!candidate) {
          candidateAppendCalls += 1;
          const recoveredCandidate = await append({
            event: request.candidateRecord.event,
            payload: request.candidateRecord.payload,
          });
          if (
            recoveredCandidate.sequence !== request.expectedSequence ||
            recoveredCandidate.recordHash !== request.expectedRecordHash
          ) {
            throw new Error("recovered indeterminate candidate identity mismatch");
          }
        }
        return append({
          event: request.nextRecord.event,
          payload: request.nextRecord.payload,
        });
      },
    });
    result = {
      appended,
      candidateAppendCalls,
      replayed: await journal.replayJournal(request.journalPath),
      residues: await listLockResidues(),
      lockExists: await fsPromises.lstat(request.journalPath + ".lock").then(() => true, () => false),
    };
  } else if (request.operation === "transition") {
    result = journal.validateTransition(request.state, request.event);
  }
  process.stdout.write(JSON.stringify({ ok: true, result, durabilityEvents }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message, durabilityEvents }));
}
`;
  const result = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
      encoding: "utf8",
      input: JSON.stringify(request),
    }),
  );
  if (!result.ok) {
    throw Object.assign(new Error(result.error), { durabilityEvents: result.durabilityEvents });
  }
  return result;
}

const validSummary = { sha256: "b".repeat(64), entries: 1, bytes: 1 };
const manifestSha256 = "a".repeat(64);

const happyRecords = [
  {
    event: "PREPARED",
    payload: { transactionId: "tx-0001", manifestSha256 },
  },
  { event: "MOVING", payload: {} },
  { event: "MOVE_INTENT", payload: { id: "copy-0001", expected: validSummary } },
  { event: "MOVED", payload: { id: "copy-0001", observed: validSummary } },
  { event: "VERIFYING", payload: {} },
  { event: "QUARANTINED", payload: { manifestSha256 } },
] as const;

function appendMany(journalPath: string, records = happyRecords, trackDurability = false) {
  return invokeJournal({ operation: "append-many", journalPath, records, trackDurability });
}

function replay(journalPath: string) {
  return invokeJournal({ operation: "replay", journalPath }).result;
}

function killAppendAtLockBoundary(
  journalPath: string,
  record: (typeof happyRecords)[number],
  crashAt: "after-wx" | "during-lock-write" | "after-lock-fsync",
) {
  const source = `
import * as journal from ${JSON.stringify(journalModuleUrl)};
import * as fsPromises from "node:fs/promises";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const fsApi = {
  ...fsPromises,
  open: async (path, flags, mode) => {
    const handle = await fsPromises.open(path, flags, mode);
    if (path === request.journalPath + ".lock" && request.crashAt === "after-wx") {
      process.kill(process.pid, "SIGKILL");
    }
    return new Proxy(handle, {
      get(target, property) {
        if (property === "write" && path === request.journalPath + ".lock" && request.crashAt === "during-lock-write") {
          return async (buffer) => {
            await target.write(buffer.subarray(0, 11));
            process.kill(process.pid, "SIGKILL");
          };
        }
        if (property === "sync" && path === request.journalPath + ".lock") {
          return async () => {
            const result = await target.sync();
            if (request.crashAt === "after-lock-fsync") {
              process.kill(process.pid, "SIGKILL");
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  },
};
await journal.appendJournalRecord({
  journalPath: request.journalPath,
  event: request.record.event,
  payload: request.record.payload,
  fsApi,
});
`;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
    input: JSON.stringify({ journalPath, record, crashAt }),
  });
}

function killAppendAtJournalWrite(
  journalPath: string,
  record: (typeof happyRecords)[number],
  writeKind: "partial" | "complete",
) {
  const source = `
import * as journal from ${JSON.stringify(journalModuleUrl)};
import * as fsPromises from "node:fs/promises";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const fsApi = {
  ...fsPromises,
  open: async (path, flags, mode) => {
    const handle = await fsPromises.open(path, flags, mode);
    if (path !== request.journalPath) return handle;
    return new Proxy(handle, {
      get(target, property) {
        if (property === "write") {
          return async (buffer) => {
            const written = request.writeKind === "partial"
              ? buffer.subarray(0, Math.max(1, Math.floor(buffer.length / 2)))
              : buffer;
            await target.write(written);
            process.kill(process.pid, "SIGKILL");
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  },
};
await journal.appendJournalRecord({
  journalPath: request.journalPath,
  event: request.record.event,
  payload: request.record.payload,
  fsApi,
});
`;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
    input: JSON.stringify({ journalPath, record, writeKind }),
  });
}

function encodeJournalLock(ownerToken: string, pid: number, checksumOverride?: string) {
  const identity = { version: 1, ownerToken, pid };
  const checksum =
    checksumOverride ?? createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const body = Buffer.from(JSON.stringify({ ...identity, checksum }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

function frameLockPrefix(bodyLength: number, bodyPrefix = Buffer.alloc(0)) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bodyLength);
  return Buffer.concat([length, bodyPrefix]);
}

function lockResidueNames(journalPath: string) {
  const prefix = `${basename(journalPath)}.lock.reclaim-`;
  return readdirSync(dirname(journalPath)).filter((name) => name.startsWith(prefix)).sort();
}

function syncPath(path: string) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function runMoveBoundary(fixture: string, boundary: string) {
  const root = join(fixture, `move-${boundary.replaceAll(" ", "-")}`);
  const sourceParent = join(root, "source");
  const destinationParent = join(root, "destination");
  const source = join(sourceParent, "entry");
  const destination = join(destinationParent, "entry");
  const journalPath = join(root, "journal", "journal.log");
  mkdirSync(sourceParent, { recursive: true });
  mkdirSync(destinationParent, { recursive: true });
  writeFileSync(source, "payload");
  appendMany(journalPath, happyRecords.slice(0, 3));
  const completedSteps: string[] = [];

  renameSync(source, destination);
  completedSteps.push("payload rename");
  if (boundary !== "payload rename") {
    syncPath(destination);
    completedSteps.push("payload fsync");
  }
  if (!["payload rename", "payload fsync"].includes(boundary)) {
    syncPath(destinationParent);
    completedSteps.push("destination-parent fsync");
  }
  if (!["payload rename", "payload fsync", "destination-parent fsync"].includes(boundary)) {
    syncPath(sourceParent);
    completedSteps.push("source-parent fsync");
  }
  if (
    ![
      "payload rename",
      "payload fsync",
      "destination-parent fsync",
      "source-parent fsync",
    ].includes(boundary)
  ) {
    const observed = createHash("sha256").update(readFileSync(destination)).digest("hex");
    expect(observed).toBe("239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5");
    completedSteps.push("verification");
  }
  if (boundary === "MOVED append") {
    appendMany(journalPath, [
      { event: "MOVED", payload: { id: "copy-0001", observed: validSummary } },
    ]);
    completedSteps.push("MOVED append");
  }

  return {
    completedSteps,
    destinationExists: existsSync(destination),
    sourceExists: existsSync(source),
    replayed: replay(journalPath),
  };
}

function rawFrames(path: string) {
  const input = readFileSync(path);
  const frames: Array<{ start: number; length: number; body: Buffer }> = [];
  let offset = 0;
  while (offset < input.length) {
    const length = input.readUInt32BE(offset);
    frames.push({ start: offset, length, body: input.subarray(offset + 4, offset + 4 + length) });
    offset += 4 + length;
  }
  return { input, frames };
}

describe("durable quarantine journal", () => {
  const fixture = mkdtempSync(join(tmpdir(), "quarantine-journal-"));

  afterAll(() => rmSync(fixture, { recursive: true, force: true }));

  it("appends exact hash-chained envelopes and replays lifecycle state", () => {
    const path = join(fixture, "happy", "journal.log");
    appendMany(path);

    const replayed = replay(path);
    expect(replayed.state).toBe("QUARANTINED");
    expect(replayed.records).toHaveLength(happyRecords.length);
    expect(Object.keys(replayed.records[0])).toEqual([
      "sequence",
      "previousHash",
      "event",
      "payload",
      "recordHash",
    ]);
    expect(replayed.records[0]).toMatchObject({
      sequence: 1,
      previousHash: "0".repeat(64),
      event: "PREPARED",
      payload: { manifestSha256, transactionId: "tx-0001" },
    });
    expect(replayed.records[1].previousHash).toBe(replayed.records[0].recordHash);
    expect(replayed.records.every((record: { recordHash: string }) =>
      /^[a-f0-9]{64}$/u.test(record.recordHash),
    )).toBe(true);
  });

  it("writes a 0600 length-framed journal and syncs the file before its parent directory", () => {
    const path = join(fixture, "durability", "journal.log");
    const appended = appendMany(path, happyRecords.slice(0, 1), true);
    expect(readFileSync(path).readUInt32BE(0)).toBe(rawFrames(path).frames[0].body.length);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(appended.durabilityEvents).toEqual([
      "file-sync",
      "directory-sync",
      "file-sync",
      "directory-sync",
      "directory-sync",
    ]);

    chmodSync(path, 0o666);
    appendMany(path, [{ event: "MOVING", payload: {} }]);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  it.each([
    [null, "PREPARED", "PREPARED"],
    ["PREPARED", "MOVING", "MOVING"],
    ["MOVING", "MOVE_INTENT", "MOVING"],
    ["MOVING", "MOVED", "MOVING"],
    ["MOVING", "VERIFYING", "VERIFYING"],
    ["VERIFYING", "QUARANTINED", "QUARANTINED"],
    ["QUARANTINED", "VALIDATED", "VALIDATED"],
    ["MOVING", "RECOVERY_REQUIRED", "RECOVERY_REQUIRED"],
    ["VERIFYING", "RECOVERY_REQUIRED", "RECOVERY_REQUIRED"],
    ["RECOVERY_REQUIRED", "ROLLING_BACK", "ROLLING_BACK"],
    ["ROLLING_BACK", "ROLLBACK_INTENT", "ROLLING_BACK"],
    ["ROLLING_BACK", "ROLLED_BACK_ENTRY", "ROLLING_BACK"],
    ["ROLLING_BACK", "ROLLED_BACK", "ROLLED_BACK"],
    ["MOVING", "INCOMPLETE_CONFLICT", "INCOMPLETE_CONFLICT"],
    ["QUARANTINED", "RESTORE_PREPARED", "RESTORE_PREPARED"],
    ["VALIDATED", "RESTORE_PREPARED", "RESTORE_PREPARED"],
    ["RESTORE_PREPARED", "RESTORING", "RESTORING"],
    ["RESTORING", "RESTORE_INTENT", "RESTORING"],
    ["RESTORING", "RESTORED_ENTRY", "RESTORING"],
    ["RESTORING", "RESTORED", "RESTORED"],
  ])("validates transition %s -> %s", (state, event, expected) => {
    expect(invokeJournal({ operation: "transition", state, event }).result).toBe(expected);
  });

  it.each([
    [null, "MOVING"],
    ["PREPARED", "QUARANTINED"],
    ["MOVING", "VALIDATED"],
    ["INCOMPLETE_CONFLICT", "ROLLING_BACK"],
    ["ROLLED_BACK", "MOVING"],
    ["RESTORED", "RESTORING"],
    ["QUARANTINED", "MOVED"],
  ])("fails closed for illegal transition %s -> %s", (state, event) => {
    expect(() => invokeJournal({ operation: "transition", state, event })).toThrow(
      /transition/u,
    );
  });

  it.each([
    [
      "file create",
      "file-create",
      [],
      happyRecords[0],
      0,
      false,
      ["file-sync", "directory-sync", "directory-sync"],
    ],
    [
      "partial frame append",
      "partial-frame",
      [happyRecords[0]],
      happyRecords[1],
      1,
      true,
      ["file-sync", "directory-sync", "directory-sync"],
    ],
    [
      "frame fsync",
      "frame-fsync",
      [happyRecords[0]],
      happyRecords[1],
      2,
      false,
      ["file-sync", "directory-sync", "file-sync", "directory-sync"],
    ],
    [
      "parent fsync",
      "parent-fsync",
      [happyRecords[0]],
      happyRecords[1],
      2,
      false,
      [
        "file-sync",
        "directory-sync",
        "file-sync",
        "directory-sync",
        "directory-sync",
      ],
    ],
  ])(
    "replays the durable invariant after interruption at %s",
    (label, failAt, prefix, record, expectedRecords, truncatedTail, expectedSyncs) => {
      const path = join(fixture, `primitive-${String(label).replaceAll(" ", "-")}`, "journal.log");
      if ((prefix as typeof happyRecords).length > 0) appendMany(path, prefix as typeof happyRecords);
      let durabilityEvents: string[] = [];
      try {
        invokeJournal({
          operation: "append-one",
          journalPath: path,
          record,
          failAt,
        });
        throw new Error("fault injection did not interrupt append");
      } catch (error) {
        expect((error as Error).message).toMatch(/indeterminate/u);
        durabilityEvents = (error as Error & { durabilityEvents?: string[] }).durabilityEvents ?? [];
      }
      const replayed = replay(path);
      expect(replayed.records).toHaveLength(expectedRecords);
      expect(replayed.truncatedTail).toBe(truncatedTail);
      expect(durabilityEvents).toEqual(expectedSyncs);
      expect(existsSync(path)).toBe(true);
    },
  );

  it.each([
    ["payload rename", ["payload rename"]],
    ["payload fsync", ["payload rename", "payload fsync"]],
    [
      "destination-parent fsync",
      ["payload rename", "payload fsync", "destination-parent fsync"],
    ],
    [
      "source-parent fsync",
      [
        "payload rename",
        "payload fsync",
        "destination-parent fsync",
        "source-parent fsync",
      ],
    ],
    [
      "verification",
      [
        "payload rename",
        "payload fsync",
        "destination-parent fsync",
        "source-parent fsync",
        "verification",
      ],
    ],
    [
      "MOVED append",
      [
        "payload rename",
        "payload fsync",
        "destination-parent fsync",
        "source-parent fsync",
        "verification",
        "MOVED append",
      ],
    ],
  ])("simulates the transaction-like boundary after %s", (boundary, expectedSteps) => {
    const result = runMoveBoundary(fixture, boundary as string);
    expect(result.completedSteps).toEqual(expectedSteps);
    expect(result.sourceExists).toBe(false);
    expect(result.destinationExists).toBe(true);
    expect(result.replayed.records.at(-1)?.event).toBe(
      boundary === "MOVED append" ? "MOVED" : "MOVE_INTENT",
    );
  });

  it("truncates and durably replaces a torn tail before appending the next record", () => {
    const path = join(fixture, "torn-then-append", "journal.log");
    appendMany(path, happyRecords.slice(0, 2));
    const validEndOffset = readFileSync(path).length;
    const body = rawFrames(path).frames.at(-1)!.body;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    appendFileSync(path, Buffer.concat([length, body.subarray(0, 7)]));
    expect(replay(path)).toMatchObject({ validEndOffset, truncatedTail: true });

    appendMany(path, [happyRecords[2]]);
    const replayed = replay(path);
    expect(replayed.truncatedTail).toBe(false);
    expect(replayed.records).toHaveLength(3);
    expect(replayed.records.at(-1)).toMatchObject({ sequence: 3, event: "MOVE_INTENT" });
    expect(rawFrames(path).frames).toHaveLength(3);
  });

  it("never truncates a malformed complete middle frame during append", () => {
    const path = join(fixture, "malformed-append", "journal.log");
    appendMany(path, happyRecords.slice(0, 3));
    const { input, frames } = rawFrames(path);
    input[frames[1].start + 4] = 0xff;
    writeFileSync(path, input);
    const corrupted = readFileSync(path);
    expect(() => appendMany(path, [happyRecords[3]])).toThrow(/malformed/u);
    expect(readFileSync(path)).toEqual(corrupted);
  });

  it("fails one overlapping append closed instead of creating duplicate sequences", () => {
    const path = join(fixture, "concurrent-append", "journal.log");
    appendMany(path, happyRecords.slice(0, 1));
    const statuses = invokeJournal({
      operation: "concurrent",
      journalPath: path,
      record: happyRecords[1],
    }).result;
    expect(statuses.sort()).toEqual(["fulfilled", "rejected"]);
    expect(replay(path).records.map((record: { sequence: number }) => record.sequence)).toEqual([
      1, 2,
    ]);
  });

  it.each(["after-wx", "during-lock-write", "after-lock-fsync"] as const)(
    "recovers explicitly after an actual SIGKILL %s boundary",
    (crashAt) => {
      const path = join(fixture, `sigkill-${crashAt}`, "journal.log");
      appendMany(path, happyRecords.slice(0, 1));

      const killed = killAppendAtLockBoundary(path, happyRecords[1], crashAt);
      expect(killed.signal).toBe("SIGKILL");
      const lockPath = `${path}.lock`;
      expect(existsSync(lockPath)).toBe(true);
      const staleLock = readFileSync(lockPath);
      if (crashAt === "after-wx") {
        expect(staleLock).toHaveLength(0);
      } else if (crashAt === "during-lock-write") {
        expect(staleLock).toHaveLength(11);
      } else {
        expect(lstatSync(lockPath).mode & 0o777).toBe(0o600);
        expect(staleLock.readUInt32BE(0)).toBe(staleLock.length - 4);
        const metadata = JSON.parse(staleLock.subarray(4).toString("utf8"));
        expect(Object.keys(metadata)).toEqual(["version", "ownerToken", "pid", "checksum"]);
        expect(metadata.checksum).toBe(
          createHash("sha256")
            .update(
              JSON.stringify({
                version: metadata.version,
                ownerToken: metadata.ownerToken,
                pid: metadata.pid,
              }),
            )
            .digest("hex"),
        );
      }
      expect(() => appendMany(path, [happyRecords[1]])).toThrow(/lock/u);

      const recovered = invokeJournal({
        operation: "reclaim",
        journalPath: path,
        writersStopped: true,
        record: happyRecords[1],
      }).result;
      const replayed = replay(path);
      expect(recovered).toMatchObject({ sequence: 2, event: "MOVING" });
      expect(replayed.records).toHaveLength(2);
      expect(replayed.records[1].previousHash).toBe(replayed.records[0].recordHash);
      expect(replayed.state).toBe("MOVING");
      expect(existsSync(`${path}.lock`)).toBe(false);
    },
  );

  it("requires stopped-writer attestation but permits PID reuse with a different owner token", () => {
    const path = join(fixture, "pid-reuse", "journal.log");
    appendMany(path, happyRecords.slice(0, 1));
    const lockPath = `${path}.lock`;
    writeFileSync(
      lockPath,
      encodeJournalLock("11111111-1111-4111-8111-111111111111", process.pid),
      { mode: 0o600 },
    );

    expect(() => appendMany(path, [happyRecords[1]])).toThrow(/lock/u);
    expect(() =>
      invokeJournal({
        operation: "reclaim",
        journalPath: path,
        writersStopped: false,
        record: happyRecords[1],
      }),
    ).toThrow(/writers.*stopped|attest/u);
    expect(readFileSync(lockPath)).toEqual(
      encodeJournalLock("11111111-1111-4111-8111-111111111111", process.pid),
    );

    invokeJournal({
      operation: "reclaim",
      journalPath: path,
      writersStopped: true,
      record: happyRecords[1],
    });
    expect(replay(path)).toMatchObject({ state: "MOVING" });
  });

  it.each([
    [
      "schema",
      (() => {
        const body = Buffer.from(JSON.stringify({ version: 1, attackerPath: "../victim" }));
        const length = Buffer.alloc(4);
        length.writeUInt32BE(body.length);
        return Buffer.concat([length, body]);
      })(),
    ],
    [
      "checksum",
      encodeJournalLock(
        "44444444-4444-4444-8444-444444444444",
        process.pid,
        "f".repeat(64),
      ),
    ],
  ])("rejects and preserves a malformed complete stale lock %s", (label, malformed) => {
    const path = join(fixture, `malformed-lock-${label}`, "journal.log");
    appendMany(path, happyRecords.slice(0, 1));
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, malformed, { mode: 0o600 });

    expect(() =>
      invokeJournal({
        operation: "reclaim",
        journalPath: path,
        writersStopped: true,
        record: happyRecords[1],
      }),
    ).toThrow(/lock/u);
    expect(readFileSync(lockPath)).toEqual(malformed);
  });

  it("accepts a recognizable torn lock frame only through attested recovery", () => {
    const path = join(fixture, "torn-lock", "journal.log");
    appendMany(path, happyRecords.slice(0, 1));
    const lockPath = `${path}.lock`;
    const torn = encodeJournalLock("22222222-2222-4222-8222-222222222222", process.pid).subarray(
      0,
      11,
    );
    writeFileSync(lockPath, torn, { mode: 0o600 });

    expect(() => appendMany(path, [happyRecords[1]])).toThrow(/lock/u);
    invokeJournal({
      operation: "reclaim",
      journalPath: path,
      writersStopped: true,
      record: happyRecords[1],
    });
    expect(replay(path)).toMatchObject({ state: "MOVING" });
  });

  it.each([1, 2, 3])(
    "accepts a %i-byte exact lock-length prefix only through attested recovery",
    (prefixBytes) => {
      const path = join(fixture, `torn-lock-length-${prefixBytes}`, "journal.log");
      appendMany(path, happyRecords.slice(0, 1));
      const lockPath = `${path}.lock`;
      const frame = encodeJournalLock("99999999-9999-4999-8999-999999999999", process.pid);
      writeFileSync(lockPath, frame.subarray(0, prefixBytes), { mode: 0o600 });

      invokeJournal({
        operation: "reclaim",
        journalPath: path,
        writersStopped: true,
        record: happyRecords[1],
      });
      expect(replay(path)).toMatchObject({ state: "MOVING" });
    },
  );

  it.each((() => {
    const ownerToken = "55555555-5555-4555-8555-555555555555";
    const minimumFrame = encodeJournalLock(ownerToken, 1);
    const minimumBodyLength = minimumFrame.readUInt32BE(0);
    const maximumBodyLength = encodeJournalLock(ownerToken, Number.MAX_SAFE_INTEGER).readUInt32BE(0);
    const completeBody = minimumFrame.subarray(4).toString("ascii");
    const checksumStart = completeBody.indexOf('"checksum":"') + '"checksum":"'.length;
    const invalidChecksumPrefix = Buffer.from(completeBody.slice(0, checksumStart + 1));
    invalidChecksumPrefix[invalidChecksumPrefix.length - 1] =
      invalidChecksumPrefix.at(-1) === 0x66 ? 0x65 : 0x66;
    return [
      ["declared-one-byte-body", Buffer.from([0, 0, 0, 1])],
      ["random-one-byte-header", Buffer.from([0xa7])],
      ["random-two-byte-header", Buffer.from([0, 0xf1])],
      ["random-three-byte-header", Buffer.from([0, 0, 0xf1])],
      ["impossible-short-body", frameLockPrefix(minimumBodyLength - 1)],
      ["impossible-long-body", frameLockPrefix(maximumBodyLength + 1)],
      ["invalid-utf8-body-prefix", frameLockPrefix(minimumBodyLength, Buffer.from([0xff]))],
      [
        "invalid-canonical-body-prefix",
        frameLockPrefix(minimumBodyLength, Buffer.from('{"version":2')),
      ],
      [
        "invalid-owner-token-prefix",
        frameLockPrefix(
          minimumBodyLength,
          Buffer.from('{"version":1,"ownerToken":"z'),
        ),
      ],
      [
        "invalid-checksum-prefix",
        frameLockPrefix(minimumBodyLength, invalidChecksumPrefix),
      ],
    ];
  })())("rejects and preserves impossible torn lock prefix %s", (label, malformed) => {
    const path = join(fixture, `impossible-torn-${label}`, "journal.log");
    appendMany(path, happyRecords.slice(0, 1));
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, malformed, { mode: 0o600 });

    expect(() =>
      invokeJournal({
        operation: "reclaim",
        journalPath: path,
        writersStopped: true,
        record: happyRecords[1],
      }),
    ).toThrow(/lock/u);
    expect(readFileSync(lockPath)).toEqual(malformed);
    expect(replay(path).records).toHaveLength(1);
  });

  it.each(["success", "failure"])(
    "expires a leaked recovery append capability after callback %s",
    (callbackOutcome) => {
      const path = join(fixture, `leaked-capability-${callbackOutcome}`, "journal.log");
      appendMany(path, happyRecords.slice(0, 1));
      writeFileSync(
        `${path}.lock`,
        encodeJournalLock("66666666-6666-4666-8666-666666666666", process.pid),
        { mode: 0o600 },
      );

      const result = invokeJournal({
        operation: "reclaim-leaked-capability",
        journalPath: path,
        callbackOutcome,
        record: happyRecords[1],
        leakedRecord: callbackOutcome === "success" ? happyRecords[2] : happyRecords[1],
      }).result;
      expect(result.recoveryError).toBe(
        callbackOutcome === "success" ? null : "injected recovery callback failure",
      );
      expect(result.leakedError).toMatch(/capability|inactive|expired|lock ownership/u);
      expect(result.bytesUnchanged).toBe(true);
      const expectedRecords = callbackOutcome === "success" ? 2 : 1;
      expect(result.beforeLeak.records).toHaveLength(expectedRecords);
      expect(result.afterLeak.records).toEqual(result.beforeLeak.records);
    },
  );

  it("allows sequential multiple appends while the recovery callback is active", () => {
    const path = join(fixture, "multiple-recovery-appends", "journal.log");
    appendMany(path, happyRecords.slice(0, 1));
    writeFileSync(
      `${path}.lock`,
      encodeJournalLock("88888888-8888-4888-8888-888888888888", process.pid),
      { mode: 0o600 },
    );

    const result = invokeJournal({
      operation: "reclaim-multiple",
      journalPath: path,
      records: happyRecords.slice(1, 3),
    }).result;
    expect(result.map((record: { sequence: number }) => record.sequence)).toEqual([2, 3]);
    expect(replay(path).records.map((record: { event: string }) => record.event)).toEqual([
      "PREPARED",
      "MOVING",
      "MOVE_INTENT",
    ]);
  });

  it.each(["missing", "replacement", "directory"])(
    "rejects recovery append when the lock path becomes %s before its precheck",
    (mutation) => {
      const path = join(fixture, `mutated-recovery-lock-${mutation}`, "journal.log");
      appendMany(path, happyRecords.slice(0, 1));
      writeFileSync(
        `${path}.lock`,
        encodeJournalLock("77777777-7777-4777-8777-777777777777", process.pid),
        { mode: 0o600 },
      );
      const journalBefore = readFileSync(path);

      expect(() =>
        invokeJournal({
          operation: "reclaim-mutated-lock",
          journalPath: path,
          mutation,
          record: happyRecords[1],
        }),
      ).toThrow(/lock|ownership/u);
      expect(readFileSync(path)).toEqual(journalBefore);
      expect(replay(path).records).toHaveLength(1);
    },
  );

  it("keeps a last-precheck ownership mismatch ordinary and leaves journal bytes unchanged", () => {
    const path = join(fixture, "race-before-last-precheck", "journal.log");
    appendMany(path, happyRecords.slice(0, 1));
    writeFileSync(
      `${path}.lock`,
      encodeJournalLock("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", process.pid),
      { mode: 0o600 },
    );

    const result = invokeJournal({
      operation: "reclaim-race-boundary",
      journalPath: path,
      boundary: "before-last-precheck",
      record: happyRecords[1],
    }).result;
    expect(result.caught).toMatchObject({
      name: "Error",
      code: null,
      expectedSequence: null,
      expectedRecordHash: null,
    });
    expect(result.caught.name).not.toBe("IndeterminateJournalAppendError");
    expect(result.rawBytesUnchanged).toBe(true);
    expect(result.replayed.records).toHaveLength(1);
    expect(result.destructiveSeamCalls).toBe(0);
  });

  it("reports a post-write ownership mismatch as an indeterminate candidate", () => {
    const path = join(fixture, "race-after-last-precheck", "journal.log");
    appendMany(path, happyRecords.slice(0, 1));
    const seamSource = join(dirname(path), "payload-source");
    const seamDestination = join(dirname(path), "payload-destination");
    writeFileSync(seamSource, "payload");
    writeFileSync(
      `${path}.lock`,
      encodeJournalLock("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", process.pid),
      { mode: 0o600 },
    );

    const result = invokeJournal({
      operation: "reclaim-race-boundary",
      journalPath: path,
      boundary: "after-precheck-before-write",
      record: happyRecords[1],
      seamSource,
      seamDestination,
    }).result;
    const candidates = result.replayed.records.filter(
      (record: { event: string }) => record.event === "MOVING",
    );
    expect(result.caught).toEqual({
      name: "IndeterminateJournalAppendError",
      code: "ERR_INDETERMINATE_JOURNAL_APPEND",
      message: expect.stringMatching(/indeterminate/u),
      expectedSequence: 2,
      expectedRecordHash: candidates[0].recordHash,
    });
    expect(result.rawBytesUnchanged).toBe(false);
    expect(candidates).toHaveLength(1);
    expect(result.destructiveSeamCalls).toBe(0);
    expect(existsSync(seamSource)).toBe(true);
    expect(existsSync(seamDestination)).toBe(false);
    expect(result.residues).toHaveLength(1);
  });

  it("preserves locks and blocks the destructive seam for an indeterminate synced append", () => {
    const path = join(fixture, "indeterminate-preserved", "journal.log");
    appendMany(path, happyRecords.slice(0, 1));
    const seamSource = join(dirname(path), "payload-source");
    const seamDestination = join(dirname(path), "payload-destination");
    writeFileSync(seamSource, "payload");
    writeFileSync(
      `${path}.lock`,
      encodeJournalLock("cccccccc-cccc-4ccc-8ccc-cccccccccccc", process.pid),
      { mode: 0o600 },
    );

    const result = invokeJournal({
      operation: "reclaim-indeterminate-sync",
      journalPath: path,
      record: happyRecords[1],
      seamSource,
      seamDestination,
    }).result;
    const candidate = result.replayed.records[1];
    expect(result.caught).toEqual({
      name: "IndeterminateJournalAppendError",
      code: "ERR_INDETERMINATE_JOURNAL_APPEND",
      message: expect.stringMatching(/indeterminate/u),
      expectedSequence: 2,
      expectedRecordHash: candidate.recordHash,
    });
    expect(candidate).toMatchObject({ sequence: 2, event: "MOVING" });
    expect(result.destructiveSeamCalls).toBe(0);
    expect(existsSync(seamSource)).toBe(true);
    expect(existsSync(seamDestination)).toBe(false);
    expect(result.lockExists).toBe(true);
    expect(result.residues).toHaveLength(1);
  });

  it("reconciles an indeterminate candidate once and removes every validated residue", () => {
    const path = join(fixture, "indeterminate-reconciled", "journal.log");
    appendMany(path, happyRecords.slice(0, 1));
    writeFileSync(
      `${path}.lock`,
      encodeJournalLock("dddddddd-dddd-4ddd-8ddd-dddddddddddd", process.pid),
      { mode: 0o600 },
    );
    const interrupted = invokeJournal({
      operation: "reclaim-indeterminate-sync",
      journalPath: path,
      record: happyRecords[1],
    }).result;
    const candidate = interrupted.replayed.records[1];

    const reconciled = invokeJournal({
      operation: "reconcile-indeterminate",
      journalPath: path,
      expectedSequence: candidate.sequence,
      expectedRecordHash: candidate.recordHash,
      candidateRecord: happyRecords[1],
      nextRecord: happyRecords[2],
    }).result;
    expect(reconciled.candidateAppendCalls).toBe(0);
    expect(reconciled.appended).toMatchObject({ sequence: 3, event: "MOVE_INTENT" });
    expect(reconciled.replayed.records.map((record: { event: string }) => record.event)).toEqual([
      "PREPARED",
      "MOVING",
      "MOVE_INTENT",
    ]);
    expect(
      reconciled.replayed.records.filter(
        (record: { recordHash: string }) => record.recordHash === candidate.recordHash,
      ),
    ).toHaveLength(1);
    expect(reconciled.lockExists).toBe(false);
    expect(reconciled.residues).toEqual([]);
  });

  it.each(["malformed", "directory"])(
    "fails closed without deleting a %s prior tombstone residue",
    (kind) => {
      const path = join(fixture, `invalid-tombstone-${kind}`, "journal.log");
      appendMany(path, happyRecords.slice(0, 1));
      const lockPath = `${path}.lock`;
      const lockBytes = encodeJournalLock(
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        process.pid,
      );
      writeFileSync(lockPath, lockBytes, { mode: 0o600 });
      const residue = `${lockPath}.reclaim-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee`;
      if (kind === "directory") mkdirSync(residue);
      else writeFileSync(residue, "malformed", { mode: 0o600 });
      const journalBefore = readFileSync(path);

      expect(() =>
        invokeJournal({
          operation: "reclaim",
          journalPath: path,
          writersStopped: true,
          record: happyRecords[1],
        }),
      ).toThrow(/lock|tombstone/u);
      expect(readFileSync(path)).toEqual(journalBefore);
      expect(readFileSync(lockPath)).toEqual(lockBytes);
      expect(lstatSync(residue)[kind === "directory" ? "isDirectory" : "isFile"]()).toBe(true);
    },
  );

  it("does not inspect or mutate residues without stopped-writer attestation", () => {
    const path = join(fixture, "false-attestation-residue", "journal.log");
    appendMany(path, happyRecords.slice(0, 1));
    const lockPath = `${path}.lock`;
    const lockBytes = encodeJournalLock("ffffffff-ffff-4fff-8fff-ffffffffffff", process.pid);
    const residue = `${lockPath}.reclaim-ffffffff-ffff-4fff-8fff-ffffffffffff`;
    const residueBytes = Buffer.from("do-not-inspect-or-remove");
    writeFileSync(lockPath, lockBytes, { mode: 0o600 });
    writeFileSync(residue, residueBytes, { mode: 0o600 });
    const journalBefore = readFileSync(path);

    expect(() =>
      invokeJournal({
        operation: "reclaim",
        journalPath: path,
        writersStopped: false,
        record: happyRecords[1],
      }),
    ).toThrow(/writers.*stopped|attest/u);
    expect(readFileSync(path)).toEqual(journalBefore);
    expect(readFileSync(lockPath)).toEqual(lockBytes);
    expect(readFileSync(residue)).toEqual(residueBytes);
  });

  it.each(["partial", "complete"] as const)(
    "recovers an actual SIGKILL %s journal write with the candidate exactly once",
    (writeKind) => {
      const path = join(fixture, `sigkill-journal-${writeKind}`, "journal.log");
      appendMany(path, happyRecords.slice(0, 1));

      const killed = killAppendAtJournalWrite(path, happyRecords[1], writeKind);
      expect(killed.signal).toBe("SIGKILL");
      expect(existsSync(`${path}.lock`)).toBe(true);
      const interrupted = replay(path);
      expect(interrupted.records.filter((record: { event: string }) => record.event === "MOVING"))
        .toHaveLength(writeKind === "complete" ? 1 : 0);
      expect(interrupted.truncatedTail).toBe(writeKind === "partial");

      invokeJournal({
        operation: "reclaim",
        journalPath: path,
        writersStopped: true,
        record: writeKind === "complete" ? happyRecords[2] : happyRecords[1],
      });
      const recovered = replay(path);
      expect(recovered.records.filter((record: { event: string }) => record.event === "MOVING"))
        .toHaveLength(1);
      expect(recovered.truncatedTail).toBe(false);
      expect(lockResidueNames(path)).toEqual([]);
    },
  );

  it.each(["symlink", "directory", "oversize"])(
    "rejects and preserves a %s stale-lock inode",
    (kind) => {
      const path = join(fixture, `invalid-lock-${kind}`, "journal.log");
      appendMany(path, happyRecords.slice(0, 1));
      const lockPath = `${path}.lock`;
      if (kind === "symlink") {
        const target = `${lockPath}.target`;
        writeFileSync(target, encodeJournalLock("33333333-3333-4333-8333-333333333333", 1));
        symlinkSync(target, lockPath);
      } else if (kind === "directory") {
        mkdirSync(lockPath);
      } else {
        writeFileSync(lockPath, Buffer.alloc(4 * 1024 + 5), { mode: 0o600 });
      }

      expect(() =>
        invokeJournal({
          operation: "reclaim",
          journalPath: path,
          writersStopped: true,
          record: happyRecords[1],
        }),
      ).toThrow(/lock/u);
      expect(lstatSync(lockPath)[kind === "symlink" ? "isSymbolicLink" : kind === "directory" ? "isDirectory" : "isFile"]()).toBe(true);
    },
  );

  it("ignores only a torn final length or body", () => {
    const path = join(fixture, "torn", "journal.log");
    appendMany(path, happyRecords.slice(0, 2));
    const intact = readFileSync(path);

    appendFileSync(path, Buffer.from([0, 1]));
    expect(replay(path).records).toHaveLength(2);

    writeFileSync(path, intact);
    const finalFrame = rawFrames(path).frames.at(-1)!;
    const torn = Buffer.concat([
      intact,
      Buffer.from([0, 0, 0, finalFrame.length]),
      finalFrame.body.subarray(0, Math.floor(finalFrame.length / 2)),
    ]);
    writeFileSync(path, torn);
    expect(replay(path).records).toHaveLength(2);
  });

  it("fails closed for a malformed complete middle frame", () => {
    const path = join(fixture, "malformed", "journal.log");
    appendMany(path, happyRecords.slice(0, 3));
    const { input, frames } = rawFrames(path);
    input[frames[1].start + 4] = 0xff;
    writeFileSync(path, input);
    expect(() => replay(path)).toThrow(/malformed/u);
  });

  it.each([
    ["changed payload", (record: Record<string, unknown>) => {
      (record.payload as Record<string, unknown>).transactionId = "tx-0002";
    }, /hash/u],
    ["unknown key", (record: Record<string, unknown>) => {
      record.attackerPath = "../victim";
    }, /unknown field/u],
    ["sequence gap", (record: Record<string, unknown>) => {
      record.sequence = 9;
    }, /sequence/u],
    ["hash mismatch", (record: Record<string, unknown>) => {
      record.recordHash = "f".repeat(64);
    }, /hash/u],
  ])("rejects %s", (_label, mutate, expected) => {
    const path = join(fixture, `tamper-${String(_label).replaceAll(" ", "-")}`, "journal.log");
    appendMany(path, happyRecords.slice(0, 1));
    const { frames } = rawFrames(path);
    const record = JSON.parse(frames[0].body.toString("utf8"));
    mutate(record);
    const body = Buffer.from(JSON.stringify(record));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    writeFileSync(path, Buffer.concat([length, body]));
    expect(() => replay(path)).toThrow(expected);
  });

  it("enforces an exact closed payload parser for every journal event", () => {
    const rollbackPath = join(fixture, "payload-all-rollback", "journal.log");
    appendMany(rollbackPath, [
      ...happyRecords.slice(0, 2),
      { event: "RECOVERY_REQUIRED", payload: { entryIds: ["copy-0001"] } },
      { event: "ROLLING_BACK", payload: {} },
      { event: "ROLLBACK_INTENT", payload: { id: "copy-0001" } },
      { event: "ROLLED_BACK_ENTRY", payload: { id: "copy-0001" } },
      { event: "ROLLED_BACK", payload: {} },
    ]);
    expect(replay(rollbackPath).state).toBe("ROLLED_BACK");

    const conflictPath = join(fixture, "payload-all-conflict", "journal.log");
    appendMany(conflictPath, [
      ...happyRecords.slice(0, 2),
      {
        event: "INCOMPLETE_CONFLICT",
        payload: { conflictEntryIds: ["copy-0001"] },
      },
    ]);
    expect(replay(conflictPath).state).toBe("INCOMPLETE_CONFLICT");

    const validatedPath = join(fixture, "payload-all-validated", "journal.log");
    appendMany(validatedPath, [...happyRecords, { event: "VALIDATED", payload: {} }]);
    expect(replay(validatedPath).state).toBe("VALIDATED");

    const restorePath = join(fixture, "payload-all-restore", "journal.log");
    appendMany(restorePath, [
      ...happyRecords,
      { event: "RESTORE_PREPARED", payload: {} },
      { event: "RESTORING", payload: {} },
      { event: "RESTORE_INTENT", payload: { id: "copy-0001" } },
      { event: "RESTORED_ENTRY", payload: { id: "copy-0001" } },
      { event: "RESTORED", payload: {} },
    ]);
    expect(replay(restorePath).state).toBe("RESTORED");
  });

  it("rejects unknown keys on empty lifecycle payloads", () => {
    const path = join(fixture, "payload-empty-unknown", "journal.log");
    expect(() =>
      appendMany(path, [
        happyRecords[0],
        { event: "MOVING", payload: { attackerPath: "../victim" } },
      ]),
    ).toThrow(/payload|unknown field/u);
  });

  it.each([
    [{ transactionId: "tx-0001" }, /missing|payload/u],
    [{ transactionId: "tx-0001", manifestSha256, extra: true }, /unknown field|payload/u],
    [{ transactionId: "../victim", manifestSha256 }, /transaction ID/u],
    [{ transactionId: "tx-0001", manifestSha256: "A".repeat(64) }, /hash|payload/u],
  ])("rejects an invalid PREPARED payload", (payload, expected) => {
    const path = join(fixture, `payload-prepared-${Math.random()}`, "journal.log");
    expect(() => appendMany(path, [{ event: "PREPARED", payload }])).toThrow(expected);
  });

  it.each([
    ["MOVE_INTENT", { id: "../victim", expected: validSummary }],
    ["MOVE_INTENT", { id: "copy-0001", expected: { ...validSummary, path: "../victim" } }],
    ["MOVE_INTENT", { id: "copy-0001", expected: { ...validSummary, sha256: "f" } }],
    ["MOVE_INTENT", { id: "copy-0001", expected: { ...validSummary, entries: -1 } }],
    ["MOVED", { id: "copy-0001", observed: { ...validSummary, bytes: -1 } }],
    ["MOVED", { id: "copy-0001", observed: validSummary, extra: true }],
  ])("rejects invalid %s payloads", (event, payload) => {
    const path = join(fixture, `payload-${event}-${Math.random()}`, "journal.log");
    const prefix = event === "MOVE_INTENT" ? happyRecords.slice(0, 2) : happyRecords.slice(0, 3);
    expect(() => appendMany(path, [...prefix, { event, payload }])).toThrow(/payload|summary|ID/u);
  });

  it.each([
    ["RECOVERY_REQUIRED", { entryIds: [] }],
    ["RECOVERY_REQUIRED", { entryIds: ["copy-0002", "copy-0001"] }],
    ["RECOVERY_REQUIRED", { entryIds: ["copy-0001", "copy-0001"] }],
    ["INCOMPLETE_CONFLICT", { conflictEntryIds: ["../victim"] }],
    ["INCOMPLETE_CONFLICT", { entryIds: ["copy-0001"] }],
  ])("rejects invalid sorted recovery/conflict IDs for %s", (event, payload) => {
    const path = join(fixture, `payload-${event}-${Math.random()}`, "journal.log");
    expect(() => appendMany(path, [...happyRecords.slice(0, 2), { event, payload }])).toThrow(
      /payload|ID|sorted|unknown field/u,
    );
  });

  it("rejects a correctly re-hashed canonical frame with an invalid event payload", () => {
    const path = join(fixture, "payload-replay-invalid", "journal.log");
    appendMany(path, happyRecords.slice(0, 1));
    const first = replay(path).records[0];
    const payload = { attackerPath: "../victim" };
    const hashInput = {
      sequence: 2,
      previousHash: first.recordHash,
      event: "MOVING",
      payload,
    };
    const recordHash = createHash("sha256").update(JSON.stringify(hashInput)).digest("hex");
    const body = Buffer.from(JSON.stringify({ ...hashInput, recordHash }));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    appendFileSync(path, Buffer.concat([length, body]));
    expect(() => replay(path)).toThrow(/payload|unknown field/u);
  });
});

function inventorySummary(overrides: Record<string, unknown> = {}) {
  return { sha256: "9".repeat(64), entries: 1, bytes: 1, ...overrides };
}

function sourceManifestEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "copy-0001",
    kind: "source-copy",
    relativePath: "src/example 2.ts",
    canonicalRelativePath: "src/example.ts",
    mode: 0o640,
    size: 1,
    sha256: "1".repeat(64),
    canonicalSize: 1,
    canonicalSha256: "1".repeat(64),
    classification: "identical",
    historyMatch: null,
    preMoveInventory: inventorySummary(),
    ...overrides,
  };
}

function generatedManifestEntries() {
  return [
    {
      id: "generated-next",
      kind: "generated-root",
      relativePath: ".next",
      mode: 0o755,
      preMoveInventory: inventorySummary({ sha256: "7".repeat(64), entries: 2, bytes: 3 }),
    },
    {
      id: "generated-node-modules",
      kind: "generated-root",
      relativePath: "node_modules",
      mode: 0o755,
      preMoveInventory: inventorySummary({ sha256: "8".repeat(64), entries: 4, bytes: 5 }),
    },
  ];
}

function validManifestEntries() {
  return [...generatedManifestEntries(), sourceManifestEntry()];
}

function manifestValue(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    transactionId: "2026-07-14T12-00-00.000Z",
    state: "QUARANTINED",
    repositoryRoot: "/repo/easy-job-application-tracker",
    head: "a".repeat(40),
    createdAt: "2026-07-14T12:00:00.000Z",
    validatedAt: null,
    retentionDays: null,
    deletionRequiresConfirmation: true,
    deleteAfter: null,
    deletionStatus: "retained",
    entries: validManifestEntries(),
    ...overrides,
  };
}

function invokeManifest(request: Record<string, unknown>) {
  const source = `
import * as manifest from ${JSON.stringify(manifestModuleUrl)};
import * as fsPromises from "node:fs/promises";
import { basename } from "node:path";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const durabilityEvents = [];
const wrappedFs = request.trackDurability ? {
  ...fsPromises,
  open: async (path, flags, mode) => {
    const handle = await fsPromises.open(path, flags, mode);
    return new Proxy(handle, {
      get(target, property) {
        if (property === "sync") return async () => {
          durabilityEvents.push("sync:" + basename(path));
          return target.sync();
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  },
  rename: async (source, destination) => {
    durabilityEvents.push("rename:" + basename(source) + "->" + basename(destination));
    return fsPromises.rename(source, destination);
  },
} : undefined;
try {
  const fsApi = wrappedFs ?? fsPromises;
  let result;
  if (request.operation === "publish") {
    result = await manifest.publishManifest({
      quarantineRoot: request.quarantineRoot,
      manifest: request.manifest,
      fsApi,
    });
  } else if (request.operation === "read") {
    result = await manifest.readManifest({ quarantineRoot: request.quarantineRoot, fsApi });
  } else if (request.operation === "mark") {
    result = await manifest.markQuarantineValidated({
      quarantineRoot: request.quarantineRoot,
      now: request.now,
      fsApi,
    });
  }
  process.stdout.write(JSON.stringify({ ok: true, result, durabilityEvents }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message, durabilityEvents }));
}
`;
  const result = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
      encoding: "utf8",
      input: JSON.stringify(request),
    }),
  );
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("small quarantine manifest publisher", () => {
  const fixture = mkdtempSync(join(tmpdir(), "quarantine-manifest-"));

  afterAll(() => rmSync(fixture, { recursive: true, force: true }));

  it("rejects unknown manifest fields", () => {
    const quarantineRoot = join(fixture, "unknown-field");
    expect(() =>
      invokeManifest({
        operation: "publish",
        quarantineRoot,
        manifest: { ...manifestValue(), attackerPath: "../victim" },
      }),
    ).toThrow(/unknown field/u);
  });

  it("publishes through atomic temp replacements with file-before-directory fsync", () => {
    const quarantineRoot = join(fixture, "publish");
    const manifest = manifestValue();
    const published = invokeManifest({
      operation: "publish",
      quarantineRoot,
      manifest,
      trackDurability: true,
    });
    const runRoot = join(quarantineRoot, manifest.transactionId);

    expect(invokeManifest({ operation: "read", quarantineRoot }).result).toEqual(manifest);
    expect(readFileSync(join(quarantineRoot, "current"), "utf8")).toBe(
      `${manifest.transactionId}\n`,
    );
    for (const path of [
      join(runRoot, "manifest.json"),
      join(runRoot, "manifest.sha256"),
      join(quarantineRoot, "current"),
    ]) {
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    }

    const renames = published.durabilityEvents
      .map((event: string, index: number) => ({ event, index }))
      .filter(({ event }: { event: string }) => event.startsWith("rename:"));
    expect(renames).toHaveLength(3);
    for (const { event, index } of renames) {
      const [temporaryName, targetName] = event.slice("rename:".length).split("->");
      expect(temporaryName).toContain(".tmp-");
      expect(["manifest.json", "manifest.sha256", "current"]).toContain(targetName);
      expect(published.durabilityEvents[index - 1]).toBe(`sync:${temporaryName}`);
      expect(published.durabilityEvents[index + 1]).toMatch(/^sync:/u);
    }
    expect(renames.at(-1)!.event.endsWith("->current")).toBe(true);
  });

  it("rejects a path-bearing current pointer before deriving a run path", () => {
    const quarantineRoot = join(fixture, "pointer");
    invokeManifest({ operation: "publish", quarantineRoot, manifest: manifestValue() });
    writeFileSync(join(quarantineRoot, "current"), "../victim\n", { mode: 0o600 });
    expect(() => invokeManifest({ operation: "read", quarantineRoot })).toThrow(
      /transaction ID/u,
    );
  });

  it("marks validation with an exact four-day retention deadline and persists it", () => {
    const quarantineRoot = join(fixture, "validated");
    invokeManifest({ operation: "publish", quarantineRoot, manifest: manifestValue() });
    const marked = invokeManifest({
      operation: "mark",
      quarantineRoot,
      now: "2026-07-14T12:00:00.000Z",
    }).result;

    expect(marked).toMatchObject({
      state: "VALIDATED",
      validatedAt: "2026-07-14T12:00:00.000Z",
      retentionDays: 4,
      deletionRequiresConfirmation: true,
      deleteAfter: "2026-07-18T12:00:00.000Z",
    });
    expect(invokeManifest({ operation: "read", quarantineRoot }).result).toEqual(marked);
  });

  it("refuses to mark a manifest that is not quarantined", () => {
    const quarantineRoot = join(fixture, "wrong-state");
    invokeManifest({
      operation: "publish",
      quarantineRoot,
      manifest: manifestValue({ state: "PREPARED" }),
    });
    expect(() =>
      invokeManifest({
        operation: "mark",
        quarantineRoot,
        now: "2026-07-14T12:00:00.000Z",
      }),
    ).toThrow(/QUARANTINED/u);
  });

  it.each(Object.keys(sourceManifestEntry()))(
    "rejects a source-copy entry missing %s",
    (missingField) => {
      const source: Record<string, unknown> = sourceManifestEntry();
      delete source[missingField];
      expect(() =>
        invokeManifest({
          operation: "publish",
          quarantineRoot: join(fixture, `missing-${missingField}`),
          manifest: manifestValue({ entries: [...generatedManifestEntries(), source] }),
        }),
      ).toThrow(/missing field|entry/u);
    },
  );

  it("rejects free-form inventory and destination paths on entries", () => {
    for (const field of ["inventoryPath", "payloadPath", "rollbackPath", "destination"]) {
      expect(() =>
        invokeManifest({
          operation: "publish",
          quarantineRoot: join(fixture, `free-path-${field}`),
          manifest: manifestValue({
            entries: [...generatedManifestEntries(), sourceManifestEntry({ [field]: "../victim" })],
          }),
        }),
      ).toThrow(/unknown field/u);
    }
  });

  it.each(Object.keys(generatedManifestEntries()[0]))(
    "rejects a generated-root entry missing %s",
    (missingField) => {
      const generated: Record<string, unknown> = { ...generatedManifestEntries()[0] };
      delete generated[missingField];
      expect(() =>
        invokeManifest({
          operation: "publish",
          quarantineRoot: join(fixture, `missing-generated-${missingField}`),
          manifest: manifestValue({
            entries: [generated, generatedManifestEntries()[1], sourceManifestEntry()],
          }),
        }),
      ).toThrow(/missing field|entry/u);
    },
  );

  it("rejects unknown generated-root fields", () => {
    expect(() =>
      invokeManifest({
        operation: "publish",
        quarantineRoot: join(fixture, "unknown-generated-field"),
        manifest: manifestValue({
          entries: [
            { ...generatedManifestEntries()[0], inventoryPath: "../victim" },
            generatedManifestEntries()[1],
            sourceManifestEntry(),
          ],
        }),
      }),
    ).toThrow(/unknown field/u);
  });

  it.each([
    ["hash", sourceManifestEntry({ sha256: "A".repeat(64) })],
    ["mode", sourceManifestEntry({ mode: 0o10000 })],
    ["negative size", sourceManifestEntry({ size: -1 })],
    ["unsafe integer", sourceManifestEntry({ canonicalSize: Number.MAX_SAFE_INTEGER + 1 })],
    [
      "identical mismatch",
      sourceManifestEntry({ canonicalSha256: "2".repeat(64), classification: "identical" }),
    ],
    ["divergent equal", sourceManifestEntry({ classification: "divergent" })],
    ["history match", sourceManifestEntry({ historyMatch: "not-a-git-object" })],
    ["source summary entries", sourceManifestEntry({ preMoveInventory: inventorySummary({ entries: 2 }) })],
    ["source summary bytes", sourceManifestEntry({ preMoveInventory: inventorySummary({ bytes: 2 }) })],
  ])("rejects invalid source-copy metadata: %s", (label, source) => {
    expect(label).toBeTruthy();
    expect(() =>
      invokeManifest({
        operation: "publish",
        quarantineRoot: join(fixture, `invalid-source-${String(label).replaceAll(" ", "-")}`),
        manifest: manifestValue({ entries: [...generatedManifestEntries(), source] }),
      }),
    ).toThrow();
  });

  it("accepts a divergent source with a valid history match", () => {
    const divergent = sourceManifestEntry({
      size: 2,
      sha256: "2".repeat(64),
      canonicalSize: 3,
      canonicalSha256: "3".repeat(64),
      classification: "divergent",
      historyMatch: "4".repeat(40),
      preMoveInventory: inventorySummary({ bytes: 2 }),
    });
    const quarantineRoot = join(fixture, "valid-divergent");
    const manifest = manifestValue({ entries: [...generatedManifestEntries(), divergent] });
    expect(
      invokeManifest({ operation: "publish", quarantineRoot, manifest }).result.entries.at(-1),
    ).toEqual(divergent);
  });

  it.each([
    [
      "duplicate ID",
      [...generatedManifestEntries(), sourceManifestEntry(), sourceManifestEntry({ relativePath: "src/z 2.ts", canonicalRelativePath: "src/z.ts" })],
    ],
    [
      "duplicate relative path",
      [...generatedManifestEntries(), sourceManifestEntry(), sourceManifestEntry({ id: "copy-0002" })],
    ],
    ["unsorted", [sourceManifestEntry(), ...generatedManifestEntries()]],
    ["copy numbering", [...generatedManifestEntries(), sourceManifestEntry({ id: "copy-0002" })]],
    ["missing generated", [generatedManifestEntries()[0], sourceManifestEntry()]],
    [
      "duplicate generated",
      [...generatedManifestEntries(), generatedManifestEntries()[0], sourceManifestEntry()],
    ],
    [
      "generated ID/path mismatch",
      [
        { ...generatedManifestEntries()[0], id: "generated-node-modules" },
        generatedManifestEntries()[1],
        sourceManifestEntry(),
      ],
    ],
  ])("rejects cross-entry invariant violations: %s", (label, entries) => {
    expect(() =>
      invokeManifest({
        operation: "publish",
        quarantineRoot: join(fixture, `entry-invariant-${String(label).replaceAll(" ", "-")}`),
        manifest: manifestValue({ entries }),
      }),
    ).toThrow(/entry|generated|sorted|order|duplicate|ID/u);
  });
});
