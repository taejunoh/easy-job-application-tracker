import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const restoreId = "22222222-2222-4222-8222-222222222222";
const inventoryRecord = {
  scope: "root",
  type: "file",
  mode: 0o600,
  size: 1,
  sha256: "c".repeat(64),
};
const inventoryBytes = Buffer.from(`${JSON.stringify(inventoryRecord)}\n`);
const restoreInventorySummary = {
  sha256: createHash("sha256").update(inventoryBytes).digest("hex"),
  entries: 1,
  bytes: 1,
};
const activeGenerated = (nextInventory: typeof restoreInventorySummary | null = null) => [
  { id: "generated-next", inventory: nextInventory },
  { id: "generated-node-modules", inventory: null },
];
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
    payload: { entryIds: [] },
  },
  recoveryCopy1: {
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
  quarantined: { event: "QUARANTINED", payload: {} },
  validated: { event: "VALIDATED", payload: { manifestSha256 } },
  restorePrepared: {
    event: "RESTORE_PREPARED",
    payload: { restoreId, activeGenerated: activeGenerated() },
  },
  restoring: { event: "RESTORING", payload: {} },
  restoreRollingBack: { event: "RESTORE_ROLLING_BACK", payload: {} },
  restoreAbortedToQuarantined: {
    event: "RESTORE_ABORTED_TO_QUARANTINED",
    payload: {},
  },
  restoreAbortedToValidated: {
    event: "RESTORE_ABORTED_TO_VALIDATED",
    payload: {},
  },
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
import { createReadStream, lstatSync, realpathSync } from "node:fs";
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
const capabilityFsMethods = [
  "lstat", "realpath", "mkdir", "open", "readdir", "rm", "rename", "unlink", "link",
  "opendir", "readlink", "createReadStream", "lstatSync", "realpathSync",
];
const baseFsApi = { ...fsPromises, createReadStream, lstatSync, realpathSync };
let activeFsApi = baseFsApi;
const boundFsApi = Object.fromEntries(capabilityFsMethods.map((method) => [
  method,
  (...args) => {
    const receiver = typeof activeFsApi[method] === "function" ? activeFsApi : baseFsApi;
    return Reflect.apply(receiver[method], receiver, args);
  },
]));
const useFsApi = (fsApi) => {
  activeFsApi = fsApi;
  return boundFsApi;
};

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
const appendAll = async (capability, values, fsApi = boundFsApi, faultHook) =>
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
        causeName: error.cause?.name ?? null,
        causeCleanupError: error.cause?.cleanupError?.message ?? null,
        causeErrors: error.cause instanceof AggregateError
          ? error.cause.errors.map((cause) => cause.message)
          : [],
      },
    };
  }
};

const result = await withQuarantineRunCapability({
  repoRoot,
  quarantineRoot,
  transactionId,
  writersStopped: true,
  fsApi: boundFsApi,
}, async (capability) => {
  for (const backing of request.inventoryBackings ?? []) {
    await fsPromises.mkdir(join(runRoot, "inventories", "restore-active"), {
      recursive: true,
      mode: 0o700,
    });
    const inventoryPath = deriveRunPath(capability, {
      purpose: "inventory",
      phase: "restore-active",
      id: backing.id,
    });
    if (backing.kind === "symlink") {
      const victim = join(request.root, "inventory-victim-" + backing.id);
      await fsPromises.writeFile(victim, Buffer.from(backing.base64, "base64"), { mode: 0o600 });
      await fsPromises.symlink(victim, inventoryPath);
    } else {
      await fsPromises.writeFile(inventoryPath, Buffer.from(backing.base64, "base64"), {
        mode: backing.mode ?? 0o600,
      });
    }
  }
  if (request.operation === "closed-options") {
    const definitions = {
      replay: {
        allowed: ["capability", "fsApi", "maxBytes"],
        required: ["capability"],
        values: { capability, fsApi: boundFsApi, maxBytes: 1024 },
      },
      lock: {
        allowed: ["capability", "fsApi"],
        required: ["capability"],
        values: { capability, fsApi: boundFsApi },
      },
      append: {
        allowed: ["capability", "heldLock", "event", "payload", "fsApi", "faultHook"],
        required: ["capability", "heldLock", "event", "payload"],
        values: {
          capability,
          heldLock: Object.freeze(Object.create(null)),
          event: "UNKNOWN",
          payload: {},
          fsApi: boundFsApi,
          faultHook: undefined,
        },
      },
      reclaim: {
        allowed: ["capability", "writersStopped", "fsApi"],
        required: ["capability", "writersStopped"],
        values: { capability, writersStopped: false, fsApi: boundFsApi },
      },
      cleanup: {
        allowed: ["capability", "writersStopped", "fsApi"],
        required: ["capability", "writersStopped"],
        values: { capability, writersStopped: false, fsApi: boundFsApi },
      },
    };
    const invokeApi = (api, options) => {
      if (api === "replay") return journal.replayJournal(options);
      if (api === "lock") return journal.withJournalLock(options, async () => "locked");
      if (api === "append") return journal.appendJournalRecord(options);
      if (api === "reclaim") {
        return journal.reclaimJournalLock(options, async () => "recovered");
      }
      return journal.cleanupTerminalJournalArtifacts(options);
    };
    const distinctCounts = Object.fromEntries(capabilityFsMethods.map((method) => [method, 0]));
    const distinctFsApi = Object.fromEntries(capabilityFsMethods.map((method) => [
      method,
      (...args) => {
        distinctCounts[method] += 1;
        return Reflect.apply(baseFsApi[method], baseFsApi, args);
      },
    ]));
    const results = {};
    for (const [api, definition] of Object.entries(definitions)) {
      const unknown = { ...definition.values, extra: true };
      const symbol = { ...definition.values };
      symbol[Symbol("extra")] = true;
      const inherited = Object.create(definition.values);
      const missing = {};
      for (const required of definition.required) {
        const value = { ...definition.values };
        delete value[required];
        missing[required] = await capture(() => invokeApi(api, value));
      }
      const counts = Object.fromEntries(definition.allowed.map((key) => [key, 0]));
      const getterOptions = {};
      for (const key of definition.allowed) {
        Object.defineProperty(getterOptions, key, {
          enumerable: true,
          get() {
            counts[key] += 1;
            return definition.values[key];
          },
        });
      }
      const mismatch = { ...definition.values, fsApi: distinctFsApi };
      const explicitUndefined = { ...definition.values, fsApi: undefined };
      const omitted = { ...definition.values };
      delete omitted.fsApi;
      results[api] = {
        unknown: await capture(() => invokeApi(api, unknown)),
        symbol: await capture(() => invokeApi(api, symbol)),
        missing,
        array: await capture(() => invokeApi(api, [])),
        function: await capture(() => invokeApi(api, function Options() {})),
        inherited: await capture(() => invokeApi(api, inherited)),
        getter: await capture(() => invokeApi(api, getterOptions)),
        getterCounts: counts,
        mismatch: await capture(() => invokeApi(api, mismatch)),
        explicitUndefined: await capture(() => invokeApi(api, explicitUndefined)),
        omitted: await capture(() => invokeApi(api, omitted)),
      };
    }
    return {
      results,
      distinctCounts,
      files: await snapshot(),
    };
  }
  if (request.operation === "mode-boundary") {
    const mode = request.mode;
    if (request.artifact === "journal") {
      await appendAll(capability, [request.record]);
      const journalPath = deriveRunPath(capability, { purpose: "journal" });
      await fsPromises.chmod(journalPath, mode);
      const before = await snapshot();
      return {
        outcome: await capture(() => journal.replayJournal({ capability })),
        before,
        after: await snapshot(),
      };
    }
    if (request.artifact === "active-lock") {
      let inside;
      const outcome = await capture(() => journal.withJournalLock(
        { capability },
        async (heldLock) => {
          const lockPath = deriveRunPath(capability, { purpose: "journal-lock" });
          await fsPromises.chmod(lockPath, mode);
          inside = {
            append: await capture(() => journal.appendJournalRecord({
              capability,
              heldLock,
              event: request.record.event,
              payload: request.record.payload,
            })),
            beforeReturn: await snapshot(),
          };
        },
      ));
      return { outcome, inside, after: await snapshot() };
    }
    await appendAll(capability, request.records);
    const lockPath = deriveRunPath(capability, { purpose: "journal-lock" });
    const tombstonePath = deriveRunPath(capability, {
      purpose: "journal-tombstone",
      id: "11111111-1111-4111-8111-111111111111",
    });
    if (request.artifact === "stale-lock") {
      await fsPromises.writeFile(lockPath, lockBytes(), { mode: 0o600 });
      await fsPromises.chmod(lockPath, mode);
    } else {
      await fsPromises.writeFile(tombstonePath, lockBytes(), { mode: 0o600 });
      await fsPromises.chmod(tombstonePath, mode);
    }
    const before = await snapshot();
    const outcome = request.artifact === "tombstone"
      ? await capture(() => journal.cleanupTerminalJournalArtifacts({
          capability,
          writersStopped: true,
        }))
      : await capture(() => journal.reclaimJournalLock(
          { capability, writersStopped: true },
          async () => "unreachable",
        ));
    return { outcome, before, after: await snapshot() };
  }
  if (request.operation === "private-create-modes") {
    const priorUmask = process.umask(0o777);
    try {
      return journal.withJournalLock({ capability }, async (heldLock) => {
        const lockPath = deriveRunPath(capability, { purpose: "journal-lock" });
        await journal.appendJournalRecord({
          capability,
          heldLock,
          event: request.record.event,
          payload: request.record.payload,
        });
        const journalPath = deriveRunPath(capability, { purpose: "journal" });
        return {
          lockMode: (await fsPromises.lstat(lockPath)).mode & 0o7777,
          journalMode: (await fsPromises.lstat(journalPath)).mode & 0o7777,
        };
      });
    } finally {
      process.umask(priorUmask);
    }
  }
  if (request.operation === "link-post-sync-replacement") {
    await appendAll(capability, request.records);
    const lockPath = deriveRunPath(capability, { purpose: "journal-lock" });
    await fsPromises.writeFile(lockPath, lockBytes(), { mode: 0o600 });
    let destination;
    let parentSynced = false;
    let replaced = false;
    const replacementFs = {
      ...fsPromises,
      link: async (source, target) => {
        const value = await fsPromises.link(source, target);
        if (source === lockPath) destination = target;
        return value;
      },
      open: async (path, flags, mode) => {
        const handle = await fsPromises.open(path, flags, mode);
        if (!String(path).endsWith("/quarantine/tx-0001") || flags !== "r") return handle;
        return new Proxy(handle, {
          get(target, property) {
            if (property === "sync") return async () => {
              const value = await target.sync();
              if (destination !== undefined) parentSynced = true;
              return value;
            };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      realpath: async (path) => {
        if (String(path).endsWith("/quarantine/tx-0001") && parentSynced && !replaced) {
          replaced = true;
          await fsPromises.rename(destination, destination + ".owned");
          await fsPromises.writeFile(destination, "foreign", { mode: 0o600 });
          await fsPromises.chmod(destination, 0o600);
        }
        return fsPromises.realpath(path);
      },
    };
    const outcome = await capture(() => journal.cleanupTerminalJournalArtifacts({
      capability,
      writersStopped: true,
      fsApi: useFsApi(replacementFs),
    }));
    return { outcome, destination, parentSynced, replaced, entries: await snapshot() };
  }
  if (request.operation === "tombstone-link-contract") {
    await appendAll(capability, request.records);
    const lockPath = deriveRunPath(capability, { purpose: "journal-lock" });
    await fsPromises.writeFile(lockPath, lockBytes(), { mode: 0o600 });
    const residuePath = deriveRunPath(capability, {
      purpose: "journal-tombstone",
      id: "11111111-1111-4111-8111-111111111111",
    });
    if (request.case === "matching-residue") {
      await fsPromises.link(lockPath, residuePath);
    }
    let linkCalls = 0;
    let renameCalls = 0;
    let destination;
    const protocolFs = {
      ...fsPromises,
      link: async (source, target) => {
        linkCalls += 1;
        destination = target;
        if (request.case === "foreign-race") {
          await fsPromises.writeFile(target, "foreign", { flag: "wx", mode: 0o600 });
          await fsPromises.chmod(target, 0o600);
        }
        return fsPromises.link(source, target);
      },
      rename: async (...args) => {
        renameCalls += 1;
        if (request.case === "matching-residue") {
          throw new Error("rename must not publish a tombstone");
        }
        return fsPromises.rename(...args);
      },
    };
    const outcome = await capture(() => journal.cleanupTerminalJournalArtifacts({
      capability,
      writersStopped: true,
      fsApi: useFsApi(protocolFs),
    }));
    return {
      outcome,
      linkCalls,
      renameCalls,
      destination,
      entries: await snapshot(),
    };
  }
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
      fsApi: useFsApi(trackedFs),
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
    if (request.case === "oversized-lock") {
      const lockPath = deriveRunPath(capability, { purpose: "journal-lock" });
      await fsPromises.writeFile(lockPath, Buffer.alloc(5000), { mode: 0o600 });
    }
    if (request.case === "malformed-lock") {
      const lockPath = deriveRunPath(capability, { purpose: "journal-lock" });
      await fsPromises.writeFile(lockPath, "bad", { mode: 0o600 });
    }
    if (request.case === "symlink-lock" || request.case === "nonregular-lock") {
      const lockPath = deriveRunPath(capability, { purpose: "journal-lock" });
      await fsPromises.rm(lockPath);
      if (request.case === "symlink-lock") {
        const victim = join(request.root, "lock-victim");
        await fsPromises.writeFile(victim, "victim", { mode: 0o600 });
        await fsPromises.symlink(victim, lockPath);
      } else {
        await fsPromises.mkdir(lockPath);
      }
    }
    if (request.case === "oversized-tombstone") {
      await fsPromises.writeFile(tombstonePath, Buffer.alloc(5000), { mode: 0o600 });
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
        fsApi: useFsApi(raceFs),
      }));
      return { outcome, before, after: await snapshot(), tombstonePath };
    }
    const before = await snapshot();
    const outcome = await capture(() => journal.cleanupTerminalJournalArtifacts({
      capability,
      writersStopped: request.case === "false-attestation" ? false : true,
      fsApi: boundFsApi,
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
      { capability, fsApi: boundFsApi },
      (heldLock) => journal.appendJournalRecord({
        capability,
        heldLock,
        event: request.records[1].event,
        payload: request.records[1].payload,
        fsApi: boundFsApi,
        faultHook: async (phase) => {
          if (phase === request.phase) await replace();
        },
      }),
    ));
    const afterBytes = await fsPromises.readFile(journalPath);
    const beforeRecovery = await journal.replayJournal({ capability });
      const foreignPreserved = await fsPromises.lstat(lockPath).then(() => true, () => false);
    await journal.reclaimJournalLock(
      { capability, writersStopped: true, fsApi: boundFsApi },
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
          fsApi: boundFsApi,
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
      { capability, writersStopped: true, fsApi: boundFsApi },
      (heldLock) => journal.appendJournalRecord({
        capability,
        heldLock,
        event: request.records[1].event,
        payload: request.records[1].payload,
        fsApi: boundFsApi,
        faultHook: async (phase) => {
          if (phase === request.phase) await replace();
        },
      }),
    ));
    const afterBytes = await fsPromises.readFile(journalPath);
    const foreignPreserved = await fsPromises.lstat(lockPath).then(() => true, () => false);
    await journal.reclaimJournalLock(
      { capability, writersStopped: true, fsApi: boundFsApi },
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
          fsApi: boundFsApi,
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
    const replayed = await journal.replayJournal({ capability });
    const lastActiveGenerated = replayed.records.at(-1)?.payload?.activeGenerated;
    return {
      outcome,
      bytesUnchanged: before.equals(await fsPromises.readFile(journalPath).catch((error) => {
        if (error.code === "ENOENT") return Buffer.alloc(0);
        throw error;
      })),
      replayed,
      activeGeneratedFrozen: lastActiveGenerated === undefined
        ? null
        : Object.isFrozen(lastActiveGenerated),
    };
  }
  if (request.operation === "restore-backing-replay") {
    await appendAll(capability, request.records);
    const journalPath = deriveRunPath(capability, { purpose: "journal" });
    const journalBytes = await fsPromises.readFile(journalPath);
    const inventoryPath = deriveRunPath(capability, {
      purpose: "inventory",
      phase: "restore-active",
      id: request.id,
    });
    if (request.mutation === "content") {
      await fsPromises.writeFile(inventoryPath, "mutated\\n", { mode: 0o600 });
    } else if (request.mutation === "mode") {
      await fsPromises.chmod(inventoryPath, 0o644);
    } else if (request.mutation === "symlink") {
      const victim = join(request.root, "replay-inventory-victim");
      await fsPromises.writeFile(victim, "victim\\n", { mode: 0o600 });
      await fsPromises.rm(inventoryPath);
      await fsPromises.symlink(victim, inventoryPath);
    } else if (request.mutation === "missing") {
      await fsPromises.rm(inventoryPath);
    }
    const outcome = await capture(() => journal.replayJournal({ capability }));
    return {
      outcome,
      bytesUnchanged: journalBytes.equals(await fsPromises.readFile(journalPath)),
    };
  }
  if (request.operation === "restore-backing-stream-fault") {
    let closes = 0;
    const faultFs = {
      ...fsPromises,
      createReadStream: (...args) => {
        const stream = createReadStream(...args);
        stream.once("close", () => { closes += 1; });
        stream.once("data", () => stream.destroy(new Error("injected inventory stream failure")));
        return stream;
      },
    };
    const outcome = await capture(() => appendAll(
      capability,
      request.records,
      useFsApi(faultFs),
    ));
    return { outcome, closes };
  }
  if (request.operation === "recover-moving") {
    const before = await journal.replayJournal({ capability });
    await journal.reclaimJournalLock(
      { capability, writersStopped: true, fsApi: boundFsApi },
      async (heldLock) => {
        const replayed = await journal.replayJournal({ capability });
        const movingPresent = replayed.records.some((record) => record.event === "MOVING");
        const next = movingPresent ? request.nextRecord : request.movingRecord;
        return journal.appendJournalRecord({
          capability,
          heldLock,
          event: next.event,
          payload: next.payload,
          fsApi: boundFsApi,
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
      { capability, fsApi: useFsApi(failureFs) },
      (heldLock) => journal.appendJournalRecord({
        capability,
        heldLock,
        event: request.record.event,
        payload: request.record.payload,
        fsApi: useFsApi(failureFs),
        faultHook: async (phase) => {
          if (phase === "after-journal-sync") throw new Error("injected append failure");
        },
      }),
    ));
  }
  if (request.operation === "close-only") {
    if (request.mode === "recovery") {
      await appendAll(capability, [request.prefix]);
      await seedArtifacts(capability);
    }
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
              throw new Error("injected close-only failure");
            };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };
    const append = (heldLock) => journal.appendJournalRecord({
      capability,
      heldLock,
      event: request.record.event,
      payload: request.record.payload,
      fsApi: useFsApi(failureFs),
    });
    const outcome = request.mode === "recovery"
      ? await capture(() => journal.reclaimJournalLock(
        { capability, writersStopped: true, fsApi: useFsApi(failureFs) },
        append,
      ))
      : await capture(() => journal.withJournalLock(
        { capability, fsApi: useFsApi(failureFs) },
        append,
      ));
    return { outcome, replayed: await journal.replayJournal({ capability }) };
  }
  if (request.operation === "journal-close-only") {
    if (request.mode === "recovery") {
      await appendAll(capability, [request.prefix]);
      await seedArtifacts(capability);
    }
    const journalPath = deriveRunPath(capability, { purpose: "journal" });
    let callbackCount = 0;
    let journalSyncs = 0;
    const failureFs = {
      ...fsPromises,
      open: async (path, flags, mode) => {
        const handle = await fsPromises.open(path, flags, mode);
        const isJournalMutation = String(path) === journalPath && String(flags).includes("+");
        if (!isJournalMutation) return handle;
        let synced = false;
        return new Proxy(handle, {
          get(target, property) {
            if (property === "sync") return async () => {
              await target.sync();
              synced = true;
              journalSyncs += 1;
            };
            if (property === "close") return async () => {
              await target.close();
              if (synced) throw new Error("injected journal close-only failure");
            };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };
    const append = (heldLock) => {
      callbackCount += 1;
      return journal.appendJournalRecord({
        capability,
        heldLock,
        event: request.record.event,
        payload: request.record.payload,
        fsApi: useFsApi(failureFs),
      });
    };
    const outcome = request.mode === "recovery"
      ? await capture(() => journal.reclaimJournalLock(
        { capability, writersStopped: true, fsApi: useFsApi(failureFs) },
        append,
      ))
      : await capture(() => journal.withJournalLock(
        { capability, fsApi: useFsApi(failureFs) },
        append,
      ));
    return {
      callbackCount,
      journalSyncs,
      names: (await fsPromises.readdir(runRoot)).sort(),
      outcome,
      replayed: await journal.replayJournal({ capability }),
    };
  }
  if (request.operation === "pre-mutation") {
    const journalPath = deriveRunPath(capability, { purpose: "journal" });
    let created = false;
    const failureFs = request.case === "after-create"
      ? {
        ...fsPromises,
        open: async (path, flags, mode) => {
          const handle = await fsPromises.open(path, flags, mode);
          if (String(path) === journalPath && String(flags).includes("x")) {
            created = true;
            await handle.close();
            throw new Error("injected failure after journal create");
          }
          return handle;
        },
      }
      : fsPromises;
    const outcome = await capture(() => journal.withJournalLock(
      { capability, fsApi: useFsApi(failureFs) },
      (heldLock) => journal.appendJournalRecord({
        capability,
        heldLock,
        event: request.record.event,
        payload: request.record.payload,
        fsApi: useFsApi(failureFs),
        faultHook: request.case === "precheck"
          ? async (phase) => {
            if (phase === "before-mutation") throw new Error("injected precheck failure");
          }
          : undefined,
      }),
    ));
    return {
      outcome,
      created,
      journalExists: await fsPromises.lstat(journalPath).then(() => true, () => false),
    };
  }
  if (request.operation === "tamper") {
    await appendAll(capability, request.prefix);
    const journalPath = deriveRunPath(capability, { purpose: "journal" });
    if (request.case === "rehashed-invalid-payload") {
      const replayed = await journal.replayJournal({ capability });
      const sequence = replayed.records.length + 1;
      const previousHash = replayed.records.at(-1).recordHash;
      const event = request.event;
      const payload = request.payload;
      const recordHash = createHash("sha256")
        .update(JSON.stringify({ sequence, previousHash, event, payload }))
        .digest("hex");
      const body = Buffer.from(JSON.stringify({
        sequence,
        previousHash,
        event,
        payload,
        recordHash,
      }));
      const length = Buffer.alloc(4);
      length.writeUInt32BE(body.length);
      await fsPromises.appendFile(journalPath, Buffer.concat([length, body]));
    } else {
      const input = await fsPromises.readFile(journalPath);
      const bodyLength = input.readUInt32BE(0);
      const record = JSON.parse(input.subarray(4, 4 + bodyLength).toString("utf8"));
      if (request.case === "sequence") record.sequence = 9;
      if (request.case === "previousHash") record.previousHash = "f".repeat(64);
      if (request.case === "recordHash") record.recordHash = "f".repeat(64);
      if (request.case === "unknown-envelope") record.attackerPath = "../victim";
      const body = Buffer.from(JSON.stringify(record));
      const length = Buffer.alloc(4);
      length.writeUInt32BE(body.length);
      await fsPromises.writeFile(journalPath, Buffer.concat([
        length,
        body,
        input.subarray(4 + bodyLength),
      ]));
    }
    return capture(() => journal.replayJournal({ capability }));
  }
  if (request.operation === "retry-cleanup") {
    await appendAll(capability, [request.prefix]);
    await seedArtifacts(capability);
    const successfulRemovals = [];
    let removalCalls = 0;
    const failureFs = {
      ...fsPromises,
      rm: async (path, options) => {
        removalCalls += 1;
        if (removalCalls === 2) throw new Error("injected cleanup interruption");
        const value = await fsPromises.rm(path, options);
        successfulRemovals.push(String(path).split("/").at(-1));
        return value;
      },
    };
    const recover = async (fsApi) => {
      useFsApi(fsApi);
      return journal.reclaimJournalLock(
        { capability, writersStopped: true, fsApi: boundFsApi },
        async (heldLock) => {
          const replayed = await journal.replayJournal({ capability });
          const movingPresent = replayed.records.some((record) => record.event === "MOVING");
          const next = movingPresent ? request.nextRecord : request.movingRecord;
          return journal.appendJournalRecord({
            capability,
            heldLock,
            event: next.event,
            payload: next.payload,
            fsApi: boundFsApi,
          });
        },
      );
    };
    const first = await capture(() => recover(failureFs));
    const retry = await capture(() => recover(failureFs));
    const replayed = await journal.replayJournal({ capability });
    return {
      first,
      retry,
      successfulRemovals,
      replayed,
      names: (await fsPromises.readdir(runRoot)).sort(),
    };
  }
  if (request.operation === "tombstone-only") {
    await appendAll(capability, request.records);
    const { lockPath } = await seedArtifacts(capability);
    await fsPromises.rm(lockPath);
    let callbackCalls = 0;
    const outcome = await capture(() => journal.reclaimJournalLock(
      { capability, writersStopped: true, fsApi: boundFsApi },
      async (heldLock) => {
        callbackCalls += 1;
        return journal.appendJournalRecord({
          capability,
          heldLock,
          event: request.record.event,
          payload: request.record.payload,
          fsApi: boundFsApi,
        });
      },
    ));
    return {
      outcome,
      callbackCalls,
      replayed: await journal.replayJournal({ capability }),
      names: (await fsPromises.readdir(runRoot)).sort(),
    };
  }
  if (request.operation === "primary-close") {
    const journalPath = deriveRunPath(capability, { purpose: "journal" });
    if (request.case !== "sync") {
      if (request.case === "malformed") {
        await fsPromises.writeFile(journalPath, Buffer.from([0, 0, 0, 1, 0xff]), {
          mode: 0o600,
        });
      } else {
        await appendAll(capability, [request.record]);
      }
    }
    const failureFs = {
      ...fsPromises,
      open: async (path, flags, mode) => {
        const handle = await fsPromises.open(path, flags, mode);
        const isJournalRead = String(path) === journalPath && String(flags) === "r";
        const isLockCreate = String(path).endsWith("/journal.lock") && String(flags).includes("x");
        if (!isJournalRead && !isLockCreate) return handle;
        return new Proxy(handle, {
          get(target, property) {
            if (property === "read" && request.case === "read") {
              return async () => { throw new Error("injected read primary"); };
            }
            if (property === "sync" && request.case === "sync") {
              return async () => { throw new Error("injected sync primary"); };
            }
            if (property === "close") return async () => {
              await target.close();
              throw new Error("injected supplemental close failure");
            };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };
    if (request.case === "sync") {
      return capture(() => journal.withJournalLock(
        { capability, fsApi: useFsApi(failureFs) },
        async () => "unreachable",
      ));
    }
    return capture(() => journal.replayJournal({
      capability,
      fsApi: useFsApi(failureFs),
    }));
  }
  if (request.operation === "overlapping") {
    const settled = await journal.withJournalLock(
      { capability, fsApi: boundFsApi },
      (heldLock) => Promise.allSettled([
        journal.appendJournalRecord({
          capability,
          heldLock,
          event: request.record.event,
          payload: request.record.payload,
          fsApi: boundFsApi,
        }),
        journal.appendJournalRecord({
          capability,
          heldLock,
          event: request.record.event,
          payload: request.record.payload,
          fsApi: boundFsApi,
        }),
      ]),
    );
    return {
      statuses: settled.map((entry) => entry.status).sort(),
      replayed: await journal.replayJournal({ capability }),
    };
  }
  if (request.operation === "transitions") {
    return request.edges.map(([previous, next]) => journal.validateTransition(previous, next));
  }
  if (request.operation === "append-valid-lifecycle") {
    await appendAll(capability, request.records);
    return journal.replayJournal({ capability });
  }
  if (request.operation === "durability") {
    const events = [];
    let directorySyncs = 0;
    let journalSynced = false;
    const trackedFs = {
      ...fsPromises,
      open: async (path, flags, mode) => {
        const handle = await fsPromises.open(path, flags, mode);
        return new Proxy(handle, {
          get(target, property) {
            if (property === "sync") return async () => {
              const isDirectory = String(path).endsWith("/quarantine/tx-0001");
              events.push(isDirectory ? "parent-sync" : String(path).endsWith("journal.log")
                ? "journal-sync"
                : "lock-sync");
              if (String(path).endsWith("journal.log")) journalSynced = true;
              if (isDirectory) {
                directorySyncs += 1;
                if (request.failParent && directorySyncs === 2) {
                  throw new Error("injected parent sync failure");
                }
              }
              return target.sync();
            };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      realpath: async (...args) => {
        if (journalSynced) {
          events.push("revalidate");
          journalSynced = false;
        }
        return fsPromises.realpath(...args);
      },
    };
    const outcome = await capture(() => journal.withJournalLock(
      { capability, fsApi: useFsApi(trackedFs) },
      (heldLock) => journal.appendJournalRecord({
        capability,
        heldLock,
        event: request.record.event,
        payload: request.record.payload,
        fsApi: useFsApi(trackedFs),
      }),
    ));
    return { outcome, events };
  }
  if (request.operation === "false-attestation-inspection") {
    let inspections = 0;
    const guardedFs = {
      ...fsPromises,
      lstat: async (...args) => {
        inspections += 1;
        return fsPromises.lstat(...args);
      },
      readdir: async (...args) => {
        inspections += 1;
        return fsPromises.readdir(...args);
      },
      open: async (...args) => {
        inspections += 1;
        return fsPromises.open(...args);
      },
    };
    const outcome = await capture(() => journal.reclaimJournalLock(
      { capability, writersStopped: false, fsApi: useFsApi(guardedFs) },
      async () => "unreachable",
    ));
    return { outcome, inspections };
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

function killTerminalCleanup(
  root: string,
  boundary:
    | "after-lock-acquired"
    | "after-tombstone-link"
    | "after-link-sync"
    | "after-source-unlink",
) {
  const source = `
import { createReadStream, lstatSync, realpathSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import * as journal from ${JSON.stringify(journalModuleUrl)};
import { withQuarantineRunCapability } from ${JSON.stringify(capabilityModuleUrl)};
const root = process.argv[1];
const repoRoot = join(root, "repo");
const quarantineRoot = join(root, "quarantine");
const runRoot = join(quarantineRoot, "tx-0001");
let linked = false;
const crashFs = {
  ...fsPromises,
  createReadStream,
  lstatSync,
  realpathSync,
  link: async (...args) => {
    const value = await fsPromises.link(...args);
    linked = true;
    if (${JSON.stringify(boundary)} === "after-tombstone-link") {
      process.kill(process.pid, "SIGKILL");
    }
    return value;
  },
  unlink: async (path) => {
    const value = await fsPromises.unlink(path);
    if (
      linked &&
      ${JSON.stringify(boundary)} === "after-source-unlink" &&
      String(path).endsWith("/journal.lock")
    ) process.kill(process.pid, "SIGKILL");
    return value;
  },
  open: async (path, flags, mode) => {
    const handle = await fsPromises.open(path, flags, mode);
    if (
      ${JSON.stringify(boundary)} === "after-lock-acquired" &&
      String(path).endsWith("/quarantine/tx-0001/journal.lock") &&
      String(flags).includes("x")
    ) process.kill(process.pid, "SIGKILL");
    if (
      linked &&
      ${JSON.stringify(boundary)} === "after-link-sync" &&
      String(path).endsWith("/quarantine/tx-0001")
    ) {
      return new Proxy(handle, {
        get(target, property) {
          if (property === "sync") return async () => {
            const value = await target.sync();
            process.kill(process.pid, "SIGKILL");
            return value;
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
    return handle;
  },
};
await withQuarantineRunCapability({
  repoRoot,
  quarantineRoot,
  transactionId: "tx-0001",
  writersStopped: true,
  fsApi: crashFs,
},
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
import { createReadStream, lstatSync, realpathSync } from "node:fs";
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
  createReadStream,
  lstatSync,
  realpathSync,
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
          if (property === "write") return async (
            buffer,
            offset = 0,
            length = buffer.length - offset,
            position = null,
          ) => {
            await target.write(
              buffer,
              offset,
              Math.max(1, Math.floor(length / 2)),
              position,
            );
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
await withQuarantineRunCapability({
  repoRoot,
  quarantineRoot,
  transactionId: "tx-0001",
  writersStopped: true,
  fsApi: crashFs,
},
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

  it("closes and snapshots every public journal option record before bound I/O", () => {
    const result = invoke(join(fixture, "closed-options"), {
      operation: "closed-options",
    }) as {
      results: Record<string, {
        unknown: { ok: boolean; error: { message: string } };
        symbol: { ok: boolean; error: { message: string } };
        missing: Record<string, { ok: boolean; error: { message: string } }>;
        array: { ok: boolean; error: { message: string } };
        function: { ok: boolean; error: { message: string } };
        inherited: { ok: boolean; error: { message: string } };
        getterCounts: Record<string, number>;
        mismatch: { ok: boolean; error: { message: string } };
        explicitUndefined: { ok: boolean; error: { message: string } };
        omitted: { ok: boolean; error?: { message: string } };
      }>;
      distinctCounts: Record<string, number>;
      files: Record<string, unknown>;
    };
    for (const api of ["replay", "lock", "append", "reclaim", "cleanup"]) {
      const observed = result.results[api];
      expect(observed.unknown).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/unknown field/i) },
      });
      expect(observed.symbol).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/unknown field/i) },
      });
      for (const missing of Object.values(observed.missing)) {
        expect(missing).toMatchObject({
          ok: false,
          error: { message: expect.stringMatching(/missing field/i) },
        });
      }
      for (const shape of [observed.array, observed.function, observed.inherited]) {
        expect(shape).toMatchObject({
          ok: false,
          error: { message: expect.stringMatching(/plain object/i) },
        });
      }
      expect(Object.values(observed.getterCounts).every((count) => count === 1)).toBe(true);
      expect(observed.mismatch).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/filesystem|source|context/i) },
      });
      expect(observed.explicitUndefined).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/filesystem|source|context/i) },
      });
      if (api === "replay" || api === "lock") {
        expect(observed.omitted.ok).toBe(true);
      } else {
        expect(observed.omitted).toMatchObject({
          ok: false,
          error: {
            message: expect.stringMatching(
              api === "append" ? /held-lock/i : /writers.*stopped|attestation/i,
            ),
          },
        });
      }
    }
    expect(Object.values(result.distinctCounts).every((count) => count === 0)).toBe(true);
    expect(result.files).toEqual({});
  });

  it.each([
    ["journal", [records.prepared]],
    ["active-lock", [records.prepared]],
    ["stale-lock", [records.prepared]],
    ["tombstone", terminalRecords.ROLLED_BACK],
  ] as const)("rejects and preserves a non-private %s", (artifact, lifecycle) => {
    for (const mode of [0o640, 0o666, 0o1600]) {
      const result = invoke(join(fixture, `mode-${artifact}-${mode.toString(8)}`), {
        operation: "mode-boundary",
        artifact,
        mode,
        record: records.prepared,
        records: lifecycle,
      });
      if (artifact === "active-lock") {
        expect(result.inside.append).toMatchObject({
          ok: false,
          error: { message: expect.stringMatching(/mode|private|0600|lock/i) },
        });
        expect(result.outcome.ok).toBe(false);
        expect(result.after).toEqual(result.inside.beforeReturn);
      } else {
        expect(result.outcome).toMatchObject({
          ok: false,
          error: { message: expect.stringMatching(/mode|private|0600|journal|lock/i) },
        });
        expect(result.after).toEqual(result.before);
      }
    }
  });

  it("creates journal and lock files at exact 0600 even under umask 0777", () => {
    expect(invoke(join(fixture, "private-create-modes"), {
      operation: "private-create-modes",
      record: records.prepared,
    })).toEqual({ lockMode: 0o600, journalMode: 0o600 });
  });

  it("revalidates the linked tombstone after parent sync and preserves a replacement", () => {
    const result = invoke(join(fixture, "link-post-sync-replacement"), {
      operation: "link-post-sync-replacement",
      records: terminalRecords.ROLLED_BACK,
    });
    expect(result).toMatchObject({ parentSynced: true, replaced: true });
    expect(result.outcome).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/ownership|identity|tombstone/i) },
    });
    const name = String(result.destination).split("/").at(-1) as string;
    expect(result.entries[name]).toMatchObject({ kind: "file" });
    expect(result.entries[name].bytes).toBe(Buffer.from("foreign").toString("base64"));
    expect(result.entries[`${name}.owned`]).toMatchObject({ kind: "file" });
  });

  it("never replaces a foreign tombstone created at the link seam", () => {
    const result = invoke(join(fixture, "tombstone-foreign-link-race"), {
      operation: "tombstone-link-contract",
      case: "foreign-race",
      records: terminalRecords.ROLLED_BACK,
    });
    expect(result.outcome).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/exist|foreign|ownership|tombstone/i) },
    });
    expect(result.linkCalls).toBe(1);
    expect(result.renameCalls).toBe(0);
    expect(result.entries["journal.lock"]).toBeDefined();
    const name = String(result.destination).split("/").at(-1) as string;
    expect(result.entries[name].bytes).toBe(Buffer.from("foreign").toString("base64"));
  });

  it("adopts a matching hard-link residue and removes only the stale source", () => {
    const result = invoke(join(fixture, "tombstone-matching-link-residue"), {
      operation: "tombstone-link-contract",
      case: "matching-residue",
      records: terminalRecords.ROLLED_BACK,
    });
    expect(result.outcome.ok).toBe(true);
    expect(result.linkCalls).toBe(0);
    expect(result.renameCalls).toBe(0);
    expect(result.entries).toEqual({ "journal.log": expect.any(Object) });
  });

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
    ["malformed-lock", terminalRecords.ROLLED_BACK],
    ["oversized-lock", terminalRecords.ROLLED_BACK],
    ["symlink-lock", terminalRecords.ROLLED_BACK],
    ["nonregular-lock", terminalRecords.ROLLED_BACK],
    ["oversized-tombstone", terminalRecords.ROLLED_BACK],
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

  it.each([
    "after-lock-acquired",
    "after-tombstone-link",
    "after-link-sync",
    "after-source-unlink",
  ] as const)(
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

  it.each([
    ["QUARANTINED", [records.prepared, records.moving, records.verifying], records.quarantined],
    [
      "VALIDATED",
      [records.prepared, records.moving, records.verifying, records.quarantined],
      records.validated,
    ],
  ])("accepts the exact %s payload contract", (_event, prefix, record) => {
    const result = invoke(join(fixture, `payload-valid-${_event}`), {
      operation: "journal-regression",
      case: "valid-payload",
      prefix,
      record,
    });
    expect(result.outcome.ok).toBe(true);
  });

  it.each([
    ["QUARANTINED unknown", [records.prepared, records.moving, records.verifying], {
      event: "QUARANTINED",
      payload: { manifestSha256 },
    }],
    ["VALIDATED missing", [records.prepared, records.moving, records.verifying, records.quarantined], {
      event: "VALIDATED",
      payload: {},
    }],
    ["VALIDATED unknown", [records.prepared, records.moving, records.verifying, records.quarantined], {
      event: "VALIDATED",
      payload: { manifestSha256, attackerPath: "../victim" },
    }],
    ["VALIDATED uppercase hash", [records.prepared, records.moving, records.verifying, records.quarantined], {
      event: "VALIDATED",
      payload: { manifestSha256: "A".repeat(64) },
    }],
  ])("rejects %s payload", (label, prefix, record) => {
    const result = invoke(join(fixture, `payload-invalid-${label.replaceAll(" ", "-")}`), {
      operation: "journal-regression",
      case: "invalid-payload",
      prefix,
      record,
    });
    expect(result.outcome.ok).toBe(false);
    expect(result.bytesUnchanged).toBe(true);
  });

  const quarantinedPrefix = [
    records.prepared,
    records.moving,
    records.verifying,
    records.quarantined,
  ];

  it.each([
    ["missing restoreId", { activeGenerated: activeGenerated() }],
    ["unknown key", { restoreId, activeGenerated: activeGenerated(), extra: true }],
    ["invalid restoreId", { restoreId: "restore-1", activeGenerated: activeGenerated() }],
    ["missing generated record", { restoreId, activeGenerated: activeGenerated().slice(0, 1) }],
    ["swapped generated records", { restoreId, activeGenerated: activeGenerated().toReversed() }],
    ["duplicate generated IDs", {
      restoreId,
      activeGenerated: [activeGenerated()[0], activeGenerated()[0]],
    }],
    ["sparse generated records", (() => {
      const values = activeGenerated();
      delete values[0];
      return { restoreId, activeGenerated: values };
    })()],
    ["unknown generated-record key", {
      restoreId,
      activeGenerated: [
        { ...activeGenerated()[0], extra: true },
        activeGenerated()[1],
      ],
    }],
    ["malformed inventory summary", {
      restoreId,
      activeGenerated: activeGenerated({ ...restoreInventorySummary, entries: -1 }),
    }],
  ])("rejects RESTORE_PREPARED %s", (label, payload) => {
    const result = invoke(join(fixture, `restore-prepared-${label.replaceAll(" ", "-")}`), {
      operation: "journal-regression",
      case: "invalid-payload",
      prefix: quarantinedPrefix,
      record: { event: "RESTORE_PREPARED", payload },
    });
    expect(result.outcome.ok).toBe(false);
    expect(result.bytesUnchanged).toBe(true);
  });

  it("accepts exact null inventory records without backing JSONL", () => {
    const result = invoke(join(fixture, "restore-prepared-null-inventories"), {
      operation: "journal-regression",
      case: "valid-payload",
      prefix: quarantinedPrefix,
      record: records.restorePrepared,
    });
    expect(result.outcome.ok).toBe(true);
    expect(result.replayed.records.at(-1).payload).toEqual(records.restorePrepared.payload);
    expect(result.activeGeneratedFrozen).toBe(true);
    expect(result.replayed.records.at(-1).payload.activeGenerated).toHaveLength(2);
  });

  it("accepts a matching durable restore-active inventory", () => {
    const result = invoke(join(fixture, "restore-prepared-backed-inventory"), {
      operation: "journal-regression",
      case: "valid-payload",
      prefix: quarantinedPrefix,
      record: {
        event: "RESTORE_PREPARED",
        payload: { restoreId, activeGenerated: activeGenerated(restoreInventorySummary) },
      },
      inventoryBackings: [{
        id: "generated-next",
        base64: inventoryBytes.toString("base64"),
      }],
    });
    expect(result.outcome.ok).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["digest mismatch", { ...restoreInventorySummary, sha256: "d".repeat(64) }],
    ["entry-count mismatch", { ...restoreInventorySummary, entries: 2 }],
    ["byte-count mismatch", { ...restoreInventorySummary, bytes: 2 }],
  ])("rejects a non-null restore inventory with %s backing", (label, summary) => {
    const result = invoke(join(fixture, `restore-backing-${label.replaceAll(" ", "-")}`), {
      operation: "journal-regression",
      case: "invalid-payload",
      prefix: quarantinedPrefix,
      record: {
        event: "RESTORE_PREPARED",
        payload: {
          restoreId,
          activeGenerated: activeGenerated(summary ?? restoreInventorySummary),
        },
      },
      inventoryBackings: label === "missing" ? [] : [{
        id: "generated-next",
        base64: inventoryBytes.toString("base64"),
      }],
    });
    expect(result.outcome.ok).toBe(false);
    expect(result.bytesUnchanged).toBe(true);
  });

  it.each([
    ["wrong-mode", { mode: 0o644 }],
    ["symlink", { kind: "symlink" }],
  ])("rejects a restore inventory backing that is a %s", (label, backing) => {
    const result = invoke(join(fixture, `restore-backing-${label}`), {
      operation: "journal-regression",
      case: "invalid-payload",
      prefix: quarantinedPrefix,
      record: {
        event: "RESTORE_PREPARED",
        payload: { restoreId, activeGenerated: activeGenerated(restoreInventorySummary) },
      },
      inventoryBackings: [{
        id: "generated-next",
        base64: inventoryBytes.toString("base64"),
        ...backing,
      }],
    });
    expect(result.outcome.ok).toBe(false);
    expect(result.bytesUnchanged).toBe(true);
  });

  it.each(["content", "mode", "symlink", "missing"])(
    "rejects %s mutation of RESTORE_PREPARED backing during replay",
    (mutation) => {
      const result = invoke(join(fixture, `restore-replay-${mutation}`), {
        operation: "restore-backing-replay",
        records: [
          ...quarantinedPrefix,
          {
            event: "RESTORE_PREPARED",
            payload: { restoreId, activeGenerated: activeGenerated(restoreInventorySummary) },
          },
        ],
        id: "generated-next",
        mutation,
        inventoryBackings: [{
          id: "generated-next",
          base64: inventoryBytes.toString("base64"),
        }],
      });
      expect(result.outcome.ok).toBe(false);
      expect(result.bytesUnchanged).toBe(true);
    },
  );

  it("closes a failed restore inventory stream and preserves its primary error", () => {
    const result = invoke(join(fixture, "restore-backing-stream-fault"), {
      operation: "restore-backing-stream-fault",
      records: [
        ...quarantinedPrefix,
        {
          event: "RESTORE_PREPARED",
          payload: { restoreId, activeGenerated: activeGenerated(restoreInventorySummary) },
        },
      ],
      inventoryBackings: [{
        id: "generated-next",
        base64: inventoryBytes.toString("base64"),
      }],
    });
    expect(result.outcome).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/injected inventory stream failure/u) },
    });
    expect(result.closes).toBe(1);
  });

  it.each([
    ["MOVE_INTENT", [records.prepared, records.moving], {
      event: "MOVE_INTENT",
      payload: { id: "generic-slug", expected: validSummary },
    }],
    ["MOVED", [records.prepared, records.moving], {
      event: "MOVED",
      payload: { id: "generic-slug", observed: validSummary },
    }],
    ["ROLLBACK_INTENT", [
      records.prepared,
      records.moving,
      records.recoveryRequired,
      records.rollingBack,
    ], { event: "ROLLBACK_INTENT", payload: { id: "generic-slug" } }],
    ["ROLLED_BACK_ENTRY", [
      records.prepared,
      records.moving,
      records.recoveryRequired,
      records.rollingBack,
    ], { event: "ROLLED_BACK_ENTRY", payload: { id: "generic-slug" } }],
    ["RESTORE_INTENT", [
      records.prepared,
      records.moving,
      records.verifying,
      records.quarantined,
      records.restorePrepared,
      records.restoring,
    ], { event: "RESTORE_INTENT", payload: { id: "generic-slug" } }],
    ["RESTORED_ENTRY", [
      records.prepared,
      records.moving,
      records.verifying,
      records.quarantined,
      records.restorePrepared,
      records.restoring,
    ], { event: "RESTORED_ENTRY", payload: { id: "generic-slug" } }],
    ["RESTORE_ROLLBACK_INTENT", [
      records.prepared,
      records.moving,
      records.verifying,
      records.quarantined,
      records.restorePrepared,
      records.restoring,
      { event: "RESTORE_INTENT", payload: { id: "generated-next" } },
      { event: "RECOVERY_REQUIRED", payload: { entryIds: ["generated-next"] } },
      records.restoreRollingBack,
    ], { event: "RESTORE_ROLLBACK_INTENT", payload: { id: "generic-slug" } }],
    ["RESTORE_ROLLED_BACK_ENTRY", [
      records.prepared,
      records.moving,
      records.verifying,
      records.quarantined,
      records.restorePrepared,
      records.restoring,
      { event: "RESTORE_INTENT", payload: { id: "generated-next" } },
      { event: "RECOVERY_REQUIRED", payload: { entryIds: ["generated-next"] } },
      records.restoreRollingBack,
      { event: "RESTORE_ROLLBACK_INTENT", payload: { id: "generated-next" } },
    ], { event: "RESTORE_ROLLED_BACK_ENTRY", payload: { id: "generic-slug" } }],
    ["RECOVERY_REQUIRED", [records.prepared, records.moving], {
      event: "RECOVERY_REQUIRED",
      payload: { entryIds: ["generic-slug"] },
    }],
    ["INCOMPLETE_CONFLICT", [records.prepared, records.moving], {
      event: "INCOMPLETE_CONFLICT",
      payload: { conflictEntryIds: ["generic-slug"] },
    }],
  ])("rejects a generic slug in %s", (event, prefix, record) => {
    const result = invoke(join(fixture, `entry-id-${event}`), {
      operation: "journal-regression",
      case: "invalid-entry",
      prefix,
      record,
    });
    expect(result.outcome.ok).toBe(false);
    expect(result.bytesUnchanged).toBe(true);
  });

  it("rejects a correctly rehashed frame whose VALIDATED payload is invalid", () => {
    const result = invoke(join(fixture, "rehashed-invalid-validated"), {
      operation: "tamper",
      case: "rehashed-invalid-payload",
      prefix: [records.prepared, records.moving, records.verifying, records.quarantined],
      event: "VALIDATED",
      payload: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error.message).toMatch(/VALIDATED|payload|missing/u);
  });

  it.each([
    ["sequence", /sequence/u],
    ["previousHash", /previous hash/u],
    ["recordHash", /hash/u],
    ["unknown-envelope", /unknown field/u],
  ])("rejects replay tampering: %s", (caseName, expected) => {
    const result = invoke(join(fixture, `tamper-${caseName}`), {
      operation: "tamper",
      case: caseName,
      prefix: [records.prepared],
    });
    expect(result.ok).toBe(false);
    expect(result.error.message).toMatch(expected);
  });

  it("fails before creating an absent journal when the pre-mutation check fails", () => {
    const result = invoke(join(fixture, "pre-mutation-absent"), {
      operation: "pre-mutation",
      case: "precheck",
      record: records.prepared,
    });
    expect(result.outcome.ok).toBe(false);
    expect(result.outcome.error.name).not.toBe("IndeterminateJournalAppendError");
    expect(result.journalExists).toBe(false);
  });

  it("reports candidate evidence when absent-journal creation fails after the mutation boundary", () => {
    const result = invoke(join(fixture, "post-create-absent"), {
      operation: "pre-mutation",
      case: "after-create",
      record: records.prepared,
    });
    expect(result.created).toBe(true);
    expect(result.journalExists).toBe(true);
    expect(result.outcome.error).toMatchObject({
      name: "IndeterminateJournalAppendError",
      expectedSequence: 1,
      expectedRecordHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it.each(["ordinary", "recovery"])(
    "surfaces a successful %s append held-lock close-only failure directly",
    (mode) => {
      const result = invoke(join(fixture, `close-only-${mode}`), {
        operation: "close-only",
        mode,
        prefix: records.prepared,
        record: mode === "ordinary" ? records.prepared : records.moving,
      });
      expect(result.outcome.ok).toBe(false);
      expect(result.outcome.error).toMatchObject({
        name: "Error",
        code: null,
        message: "injected close-only failure",
        expectedSequence: null,
        expectedRecordHash: null,
      });
    },
  );

  it.each([
    ["ordinary", 1, records.prepared, null],
    ["recovery", 2, records.moving, records.prepared],
  ] as const)(
    "classifies a synced %s journal-handle close-only failure as indeterminate",
    (mode, expectedSequence, record, prefix) => {
      const result = invoke(join(fixture, `journal-close-only-${mode}`), {
        operation: "journal-close-only",
        mode,
        prefix,
        record,
      });
      expect(result.outcome.ok).toBe(false);
      expect(result.outcome.error).toMatchObject({
        name: "IndeterminateJournalAppendError",
        code: "ERR_INDETERMINATE_JOURNAL_APPEND",
        expectedSequence,
        expectedRecordHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(result.callbackCount).toBe(1);
      expect(result.journalSyncs).toBe(1);
      const candidates = result.replayed.records.filter(
        (candidate: { event: string }) => candidate.event === record.event,
      );
      expect(candidates).toHaveLength(1);
      expect(candidates[0].recordHash).toBe(result.outcome.error.expectedRecordHash);
      expect(result.names).toContain("journal.lock");
      const tombstones = result.names.filter(
        (name: string) => name.startsWith("journal.lock.tombstone."),
      );
      expect(tombstones).toHaveLength(mode === "recovery" ? 2 : 0);
    },
  );

  it("retries an interrupted partial cleanup with tombstones first and the owned lock last", () => {
    const result = invoke(join(fixture, "retry-partial-cleanup"), {
      operation: "retry-cleanup",
      prefix: records.prepared,
      movingRecord: records.moving,
      nextRecord: records.moveIntent,
    });
    expect(result.first.ok).toBe(false);
    expect(result.retry.ok).toBe(true);
    expect(result.replayed.records.filter(
      (record: { event: string }) => record.event === "MOVING",
    )).toHaveLength(1);
    expect(result.successfulRemovals.at(-1)).toBe("journal.lock");
    expect(result.successfulRemovals.slice(0, -1).every(
      (name: string) => name.startsWith("journal.lock.tombstone."),
    )).toBe(true);
    expect(result.names).toEqual(["journal.log", "sentinel"]);
  });

  it("recovers a nonterminal tombstone-only state under a fresh held lock", () => {
    const result = invoke(join(fixture, "tombstone-only-nonterminal"), {
      operation: "tombstone-only",
      records: [records.prepared],
      record: records.moving,
    });
    expect(result.outcome.ok).toBe(true);
    expect(result.callbackCalls).toBe(1);
    expect(result.replayed).toMatchObject({ state: "MOVING", truncatedTail: false });
    expect(result.names).toEqual(["journal.log", "sentinel"]);
  });

  it("routes a terminal tombstone-only reclaim through cleanup without invoking recovery", () => {
    const result = invoke(join(fixture, "tombstone-only-terminal"), {
      operation: "tombstone-only",
      records: terminalRecords.ROLLED_BACK,
      record: records.moving,
    });
    expect(result.outcome.ok).toBe(true);
    expect(result.callbackCalls).toBe(0);
    expect(result.replayed.state).toBe("ROLLED_BACK");
    expect(result.replayed.records).toHaveLength(terminalRecords.ROLLED_BACK.length);
    expect(result.names).toEqual(["journal.log", "sentinel"]);
  });

  it.each([
    ["malformed", /malformed journal/u],
    ["read", /injected read primary/u],
    ["sync", /injected sync primary/u],
  ])("preserves the %s primary when handle close also fails", (caseName, expected) => {
    const result = invoke(join(fixture, `primary-close-${caseName}`), {
      operation: "primary-close",
      case: caseName,
      record: records.prepared,
    });
    expect(result.ok).toBe(false);
    expect(result.error.message).toMatch(expected);
    expect(result.error.cleanupError).toBe("injected supplemental close failure");
    expect(result.error.causeName).toBe("AggregateError");
    expect(result.error.causeErrors).toContain("injected supplemental close failure");
  });

  it("excludes overlapping appends under one held-lock capability", () => {
    const result = invoke(join(fixture, "overlapping-append"), {
      operation: "overlapping",
      record: records.prepared,
    });
    expect(result.statuses).toEqual(["fulfilled", "rejected"]);
    expect(result.replayed.records).toHaveLength(1);
    expect(result.replayed.records[0]).toMatchObject({ sequence: 1, event: "PREPARED" });
  });

  const transitionEdges = [
    [null, "PREPARED", "PREPARED"],
    ["PREPARED", "MOVING", "MOVING"],
    ["PREPARED", "RECOVERY_REQUIRED", "RECOVERY_REQUIRED"],
    ["MOVING", "MOVE_INTENT", "MOVING"],
    ["MOVING", "MOVED", "MOVING"],
    ["MOVING", "VERIFYING", "VERIFYING"],
    ["MOVING", "RECOVERY_REQUIRED", "RECOVERY_REQUIRED"],
    ["MOVING", "INCOMPLETE_CONFLICT", "INCOMPLETE_CONFLICT"],
    ["VERIFYING", "QUARANTINED", "QUARANTINED"],
    ["VERIFYING", "RECOVERY_REQUIRED", "RECOVERY_REQUIRED"],
    ["VERIFYING", "INCOMPLETE_CONFLICT", "INCOMPLETE_CONFLICT"],
    ["RECOVERY_REQUIRED", "MOVING", "MOVING"],
    ["RECOVERY_REQUIRED", "RESTORING", "RESTORING"],
    ["RECOVERY_REQUIRED", "ROLLING_BACK", "ROLLING_BACK"],
    ["RECOVERY_REQUIRED", "RESTORE_ROLLING_BACK", "RESTORE_ROLLING_BACK"],
    ["RECOVERY_REQUIRED", "INCOMPLETE_CONFLICT", "INCOMPLETE_CONFLICT"],
    ["ROLLING_BACK", "ROLLBACK_INTENT", "ROLLING_BACK"],
    ["ROLLING_BACK", "ROLLED_BACK_ENTRY", "ROLLING_BACK"],
    ["ROLLING_BACK", "ROLLED_BACK", "ROLLED_BACK"],
    ["ROLLING_BACK", "INCOMPLETE_CONFLICT", "INCOMPLETE_CONFLICT"],
    ["QUARANTINED", "VALIDATED", "VALIDATED"],
    ["QUARANTINED", "RESTORE_PREPARED", "RESTORE_PREPARED"],
    ["VALIDATED", "RESTORE_PREPARED", "RESTORE_PREPARED"],
    ["RESTORE_PREPARED", "RESTORING", "RESTORING"],
    ["RESTORE_PREPARED", "RECOVERY_REQUIRED", "RECOVERY_REQUIRED"],
    ["RESTORING", "RESTORE_INTENT", "RESTORING"],
    ["RESTORING", "RESTORED_ENTRY", "RESTORING"],
    ["RESTORING", "RESTORED", "RESTORED"],
    ["RESTORING", "RECOVERY_REQUIRED", "RECOVERY_REQUIRED"],
    ["RESTORING", "INCOMPLETE_CONFLICT", "INCOMPLETE_CONFLICT"],
    ["RESTORE_ROLLING_BACK", "RESTORE_ROLLBACK_INTENT", "RESTORE_ROLLING_BACK"],
    ["RESTORE_ROLLING_BACK", "RESTORE_ROLLED_BACK_ENTRY", "RESTORE_ROLLING_BACK"],
    [
      "RESTORE_ROLLING_BACK",
      "RESTORE_ABORTED_TO_QUARANTINED",
      "QUARANTINED",
    ],
    ["RESTORE_ROLLING_BACK", "RESTORE_ABORTED_TO_VALIDATED", "VALIDATED"],
    ["RESTORE_ROLLING_BACK", "INCOMPLETE_CONFLICT", "INCOMPLETE_CONFLICT"],
  ] as const;

  it("covers every legal transition-table edge", () => {
    const result = invoke(join(fixture, "all-transition-edges"), {
      operation: "transitions",
      edges: transitionEdges.map(([previous, next]) => [previous, next]),
    });
    expect(result).toEqual(transitionEdges.map(([, , expected]) => expected));
  });

  it.each([
    ["PREPARED apply resume", [
      records.prepared,
      records.recoveryRequired,
      records.moving,
    ]],
    ["MOVING apply rollback", [
      records.prepared,
      records.moving,
      records.recoveryRequired,
      records.rollingBack,
      records.rolledBack,
    ]],
    ["RESTORE_PREPARED abort to QUARANTINED", [
      ...quarantinedPrefix,
      records.restorePrepared,
      records.recoveryRequired,
      records.restoreRollingBack,
      records.restoreAbortedToQuarantined,
    ]],
    ["RESTORING abort to VALIDATED", [
      ...quarantinedPrefix,
      records.validated,
      records.restorePrepared,
      records.restoring,
      records.recoveryRequired,
      records.restoreRollingBack,
      records.restoreAbortedToValidated,
    ]],
  ])("accepts exact no-intent recovery path: %s", (_label, lifecycle) => {
    const result = invoke(join(fixture, `no-intent-${_label.replaceAll(" ", "-")}`), {
      operation: "append-valid-lifecycle",
      records: lifecycle,
    });
    expect(result.state).toBe(lifecycle.at(-1) === records.moving
      ? "MOVING"
      : lifecycle.at(-1) === records.rolledBack
        ? "ROLLED_BACK"
        : lifecycle.at(-1) === records.restoreAbortedToQuarantined
          ? "QUARANTINED"
          : "VALIDATED");
  });

  it.each([
    ["apply non-empty without intent", [records.prepared, records.moving], {
      event: "RECOVERY_REQUIRED",
      payload: { entryIds: ["copy-0001"] },
    }],
    ["apply empty after intent", [records.prepared, records.moving, records.moveIntent], {
      event: "RECOVERY_REQUIRED",
      payload: { entryIds: [] },
    }],
    ["apply wrong unresolved IDs", [records.prepared, records.moving, records.moveIntent], {
      event: "RECOVERY_REQUIRED",
      payload: { entryIds: ["copy-0002"] },
    }],
    ["restore empty after intent", [
      ...quarantinedPrefix,
      records.restorePrepared,
      records.restoring,
      { event: "RESTORE_INTENT", payload: { id: "generated-next" } },
    ], { event: "RECOVERY_REQUIRED", payload: { entryIds: [] } }],
    ["restore non-empty without intent", [
      ...quarantinedPrefix,
      records.restorePrepared,
      records.restoring,
    ], { event: "RECOVERY_REQUIRED", payload: { entryIds: ["generated-next"] } }],
    ["restore wrong unresolved IDs", [
      ...quarantinedPrefix,
      records.restorePrepared,
      records.restoring,
      { event: "RESTORE_INTENT", payload: { id: "generated-next" } },
    ], { event: "RECOVERY_REQUIRED", payload: { entryIds: ["generated-node-modules"] } }],
    ["apply recovery cannot enter RESTORING", [
      records.prepared,
      records.moving,
      records.recoveryRequired,
    ], records.restoring],
    ["restore recovery cannot enter MOVING", [
      ...quarantinedPrefix,
      records.restorePrepared,
      records.recoveryRequired,
    ], records.moving],
    ["restore recovery cannot enter ROLLING_BACK", [
      ...quarantinedPrefix,
      records.restorePrepared,
      records.recoveryRequired,
    ], records.rollingBack],
    ["quarantined restore cannot abort to VALIDATED", [
      ...quarantinedPrefix,
      records.restorePrepared,
      records.recoveryRequired,
      records.restoreRollingBack,
    ], records.restoreAbortedToValidated],
    ["validated restore cannot abort to QUARANTINED", [
      ...quarantinedPrefix,
      records.validated,
      records.restorePrepared,
      records.recoveryRequired,
      records.restoreRollingBack,
    ], records.restoreAbortedToQuarantined],
  ])("rejects history-invalid recovery: %s", (label, prefix, record) => {
    const result = invoke(join(fixture, `history-invalid-${label.replaceAll(" ", "-")}`), {
      operation: "journal-regression",
      case: "semantic",
      prefix,
      record,
    });
    expect(result.outcome.ok).toBe(false);
    expect(result.bytesUnchanged).toBe(true);
  });

  it.each([
    ["apply", [
      records.prepared,
      records.moving,
      records.moveIntent,
      {
        event: "MOVE_INTENT",
        payload: { id: "copy-0002", expected: validSummary },
      },
      {
        event: "RECOVERY_REQUIRED",
        payload: { entryIds: ["copy-0001", "copy-0002"] },
      },
      records.rollingBack,
    ], { event: "ROLLBACK_INTENT", payload: { id: "copy-0001" } }],
    ["restore", [
      ...quarantinedPrefix,
      records.restorePrepared,
      records.restoring,
      { event: "RESTORE_INTENT", payload: { id: "generated-next" } },
      { event: "RESTORE_INTENT", payload: { id: "generated-node-modules" } },
      {
        event: "RECOVERY_REQUIRED",
        payload: { entryIds: ["generated-next", "generated-node-modules"] },
      },
      records.restoreRollingBack,
    ], { event: "RESTORE_ROLLBACK_INTENT", payload: { id: "generated-next" } }],
  ])("rejects non-reverse first %s rollback intent", (label, prefix, record) => {
    const result = invoke(join(fixture, `rollback-order-${label}`), {
      operation: "journal-regression",
      case: "semantic",
      prefix,
      record,
    });
    expect(result.outcome.ok).toBe(false);
    expect(result.bytesUnchanged).toBe(true);
  });

  it.each([
    ["moving", [
      records.prepared,
      records.moving,
      records.moveIntent,
      { event: "MOVED", payload: { id: "copy-0001", observed: validSummary } },
      records.verifying,
      records.quarantined,
      records.validated,
    ]],
    ["rollback", [
      records.prepared,
      records.moving,
      records.moveIntent,
      records.recoveryCopy1,
      records.rollingBack,
      { event: "ROLLBACK_INTENT", payload: { id: "copy-0001" } },
      { event: "ROLLED_BACK_ENTRY", payload: { id: "copy-0001" } },
      records.rolledBack,
    ]],
    ["restore", [
      records.prepared,
      records.moving,
      records.verifying,
      records.quarantined,
      records.restorePrepared,
      records.restoring,
      { event: "RESTORE_INTENT", payload: { id: "copy-0001" } },
      { event: "RESTORED_ENTRY", payload: { id: "copy-0001" } },
      records.restored,
    ]],
    ["restore rollback", [
      records.prepared,
      records.moving,
      records.verifying,
      records.quarantined,
      records.restorePrepared,
      records.restoring,
      { event: "RESTORE_INTENT", payload: { id: "generated-next" } },
      {
        event: "RECOVERY_REQUIRED",
        payload: { entryIds: ["generated-next"] },
      },
      records.restoreRollingBack,
      { event: "RESTORE_ROLLBACK_INTENT", payload: { id: "generated-next" } },
      { event: "RESTORE_ROLLED_BACK_ENTRY", payload: { id: "generated-next" } },
      records.restoreAbortedToQuarantined,
    ]],
  ])("accepts every event parser in a valid %s lifecycle", (_label, lifecycle) => {
    const result = invoke(join(fixture, `valid-lifecycle-${_label}`), {
      operation: "append-valid-lifecycle",
      records: lifecycle,
    });
    expect(result.truncatedTail).toBe(false);
    expect(result.records).toHaveLength(lifecycle.length);
  });

  it("syncs each journal file before its parent directory", () => {
    const result = invoke(join(fixture, "durability-order"), {
      operation: "durability",
      record: records.prepared,
    });
    expect(result.outcome.ok).toBe(true);
    expect(result.events.slice(0, 4)).toEqual([
      "lock-sync",
      "parent-sync",
      "journal-sync",
      "parent-sync",
    ]);
    expect(result.events.slice(2, 5)).toEqual([
      "journal-sync",
      "parent-sync",
      "revalidate",
    ]);
  });

  it("reports a parent-directory fsync failure after journal sync as indeterminate", () => {
    const result = invoke(join(fixture, "parent-fsync-failure"), {
      operation: "durability",
      record: records.prepared,
      failParent: true,
    });
    expect(result.events.slice(0, 4)).toEqual([
      "lock-sync",
      "parent-sync",
      "journal-sync",
      "parent-sync",
    ]);
    expect(result.outcome.error).toMatchObject({
      name: "IndeterminateJournalAppendError",
      expectedSequence: 1,
      expectedRecordHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("rejects false writersStopped before inspecting any stale artifact", () => {
    const result = invoke(join(fixture, "false-attestation-no-inspection"), {
      operation: "false-attestation-inspection",
    });
    expect(result.outcome.ok).toBe(false);
    expect(result.outcome.error.message).toMatch(/writers.*stopped|attestation/u);
    expect(result.inspections).toBe(0);
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
