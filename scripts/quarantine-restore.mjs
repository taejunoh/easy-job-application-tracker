import { createHash } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";

import { fsyncTree, writeInventoryJsonl } from "./quarantine-inventory.mjs";
import { summarizeInventoryDirectory, hashVerifiedRegularFile } from "./quarantine-inventory-reader.mjs";
import { appendJournalRecord, replayJournal, withJournalLock } from "./quarantine-journal.mjs";
import { withExistingQuarantineRun } from "./quarantine-lifecycle-core.mjs";
import { deriveRunPath, revalidateRunCapability } from "./quarantine-run-capability.mjs";

const OPTION_KEYS = Object.freeze([
  "repoRoot", "quarantineRoot", "transactionId", "writersStopped", "fsApi", "faultHook",
]);
const REQUIRED_KEYS = Object.freeze(["repoRoot", "quarantineRoot", "transactionId", "writersStopped"]);
const GENERATED_IDS = Object.freeze(["generated-next", "generated-node-modules"]);

function record(entries) {
  const value = Object.create(null);
  for (const [key, entry] of entries) {
    Object.defineProperty(value, key, {
      value: entry, enumerable: true, configurable: false, writable: false,
    });
  }
  return Object.freeze(value);
}

function snapshotOptions(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("restore options must be an exact record");
  }
  if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
    throw new TypeError("restore options must be an exact record");
  }
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== "string" || !OPTION_KEYS.includes(key)) ||
    REQUIRED_KEYS.some((key) => !keys.includes(key))
  ) throw new TypeError("restore options are invalid");
  const snapshot = Object.create(null);
  for (const key of OPTION_KEYS) if (keys.includes(key)) snapshot[key] = input[key];
  if (snapshot.writersStopped !== true) throw new TypeError("writers-stopped attestation must be true");
  if (snapshot.faultHook !== undefined && typeof snapshot.faultHook !== "function") {
    throw new TypeError("restore fault hook must be a function");
  }
  return Object.freeze(snapshot);
}

function deriveRestoreId(transactionId) {
  const digest = createHash("sha256")
    .update(Buffer.from(`easy-job-application-tracker\0restore-id\0${transactionId}`, "utf8"))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `restore-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sameSummary(left, right) {
  return left !== null && right !== null &&
    left.sha256 === right.sha256 && left.entries === right.entries && left.bytes === right.bytes;
}

async function optionalStat(path, fsApi) {
  try { return await fsApi.lstat(path); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function syncDirectory(path, fsApi) {
  const handle = await fsApi.open(path, "r");
  let primary;
  try { await handle.sync(); } catch (error) { primary = error; }
  try { await handle.close(); } catch (error) {
    if (primary !== undefined) throw new AggregateError([primary, error], "directory sync and close failed");
    throw error;
  }
  if (primary !== undefined) throw primary;
}

async function syncWorkspaceTree(path, fsApi) {
  const stat = await fsApi.lstat(path);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error("restore workspace endpoint is unsafe");
  }
  if (stat.isDirectory()) {
    const names = await fsApi.readdir(path);
    for (const name of names.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))) {
      await syncWorkspaceTree(join(path, name), fsApi);
    }
  }
  await syncDirectory(path, fsApi);
}

function workspacePath(repoRoot, entry) {
  return join(repoRoot, ...entry.relativePath.split("/"));
}

async function captureAncestors(repoRoot, endpoint, fsApi) {
  const relativeEndpoint = relative(repoRoot, endpoint);
  if (relativeEndpoint === "" || relativeEndpoint === ".." || relativeEndpoint.startsWith(`..${sep}`)) {
    throw new Error("restore endpoint escapes repository");
  }
  const values = [];
  let current = repoRoot;
  for (const component of [null, ...relativeEndpoint.split(sep).slice(0, -1)]) {
    if (component !== null) current = join(current, component);
    const stat = await fsApi.lstat(current);
    const realPath = await fsApi.realpath(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || realPath !== current) {
      throw new Error("restore workspace ancestor is unsafe");
    }
    values.push(Object.freeze({
      path: current, dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777,
      type: "directory", canonicalRealpath: realPath,
    }));
  }
  return Object.freeze(values);
}

async function assertAncestors(ancestors, fsApi) {
  for (const expected of ancestors) {
    const stat = await fsApi.lstat(expected.path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== expected.dev ||
        stat.ino !== expected.ino || (stat.mode & 0o7777) !== expected.mode ||
        await fsApi.realpath(expected.path) !== expected.path) {
      throw new Error("restore workspace ancestor changed");
    }
  }
}

async function assertPayload(capability, entry, path, fsApi) {
  await revalidateRunCapability(capability, { purpose: "payload", id: entry.id, boundary: "before-mutation" });
  if (entry.kind === "source-copy") {
    const stat = await fsApi.lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o7777) !== entry.mode || stat.size !== entry.size) {
      throw new Error("restore payload source is invalid");
    }
    const hash = await hashVerifiedRegularFile(path, stat, fsApi);
    if (hash.sha256 !== entry.sha256 || hash.bytes !== entry.size) throw new Error("restore payload content changed");
    return;
  }
  const observed = await summarizeInventoryDirectory(path, { fsApi });
  if (!sameSummary(entry.preMoveInventory, observed)) throw new Error("restore payload inventory changed");
}

async function assertRestoredEndpoint(entry, path, fsApi, ancestors) {
  await assertAncestors(ancestors, fsApi);
  if (entry.kind === "source-copy") {
    const stat = await fsApi.lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o7777) !== entry.mode || stat.size !== entry.size) {
      throw new Error("restored source endpoint is invalid");
    }
    const hash = await hashVerifiedRegularFile(path, stat, fsApi, ancestors);
    if (hash.sha256 !== entry.sha256 || hash.bytes !== entry.size) throw new Error("restored source endpoint changed");
    return;
  }
  const observed = await summarizeInventoryDirectory(path, { fsApi });
  if (!sameSummary(entry.preMoveInventory, observed)) throw new Error("restored generated endpoint changed");
}

async function append(heldLock, capability, event, payload) {
  await appendJournalRecord({ capability, heldLock, event, payload });
}

async function invokeHook(hook, phase) {
  if (hook !== undefined) await hook(phase);
}

async function captureActiveGenerated(handoff, faultHook) {
  const active = [];
  for (const id of GENERATED_IDS) {
    const entry = handoff.manifestGeneration.manifest.entries.find((candidate) => candidate.id === id);
    if (entry === undefined || entry.kind !== "generated-root") throw new Error("generated manifest entries are invalid");
    const root = workspacePath(handoff.repoRoot, entry);
    const stat = await optionalStat(root, handoff.fsApi);
    if (stat === null) {
      active.push(record([["id", id], ["inventory", null]]));
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("active generated root is unsafe");
    const inventory = await writeInventoryJsonl({
      capability: handoff.capability, root, entryId: id, phase: "restore-active",
    });
    await invokeHook(faultHook, `after-inventory:restore-active:${id}`);
    active.push(record([["id", id], ["inventory", inventory]]));
  }
  return Object.freeze(active);
}

async function assertActiveStable(handoff, active) {
  for (const captured of active) {
    const entry = handoff.manifestGeneration.manifest.entries.find((candidate) => candidate.id === captured.id);
    const root = workspacePath(handoff.repoRoot, entry);
    const stat = await optionalStat(root, handoff.fsApi);
    if (captured.inventory === null) {
      if (stat !== null) throw new Error("absent active generated root appeared during restore preparation");
      continue;
    }
    if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("active generated root disappeared during restore preparation");
    }
    const observed = await summarizeInventoryDirectory(root, { fsApi: handoff.fsApi });
    if (!sameSummary(captured.inventory, observed)) throw new Error("active generated root changed during restore preparation");
  }
}

async function restoreEntry({ handoff, heldLock, restoreId, entry, activeGenerated, faultHook }) {
  const fsApi = handoff.fsApi;
  const payload = deriveRunPath(handoff.capability, { purpose: "payload", id: entry.id });
  const active = workspacePath(handoff.repoRoot, entry);
  const ancestors = await captureAncestors(handoff.repoRoot, active, fsApi);
  await append(heldLock, handoff.capability, "RESTORE_INTENT", { id: entry.id });
  await invokeHook(faultHook, `after-event:RESTORE_INTENT:${entry.id}`);

  await assertPayload(handoff.capability, entry, payload, fsApi);
  await assertAncestors(ancestors, fsApi);
  const activeStat = await optionalStat(active, fsApi);
  if (entry.kind === "source-copy") {
    if (activeStat !== null) throw new Error("active source copy appeared during restore");
    await fsApi.rename(payload, active);
    await invokeHook(faultHook, `after-payload-to-active-rename:${entry.id}`);
    await syncWorkspaceTree(active, fsApi);
    await invokeHook(faultHook, `after-restored-payload-sync:${entry.id}`);
    await revalidateRunCapability(handoff.capability, { purpose: "payload", id: entry.id, boundary: "after-sync" });
    await assertRestoredEndpoint(entry, active, fsApi, ancestors);
    await assertAncestors(ancestors, fsApi);
    await syncDirectory(dirname(active), fsApi);
    await invokeHook(faultHook, `after-restore-destination-parent-sync:${entry.id}`);
    await syncDirectory(dirname(payload), fsApi);
    await invokeHook(faultHook, `after-restore-source-parent-sync:${entry.id}`);
  } else {
    const captured = activeGenerated.find((candidate) => candidate.id === entry.id);
    if (captured === undefined) throw new Error("missing active generated evidence");
    if (captured.inventory === null) {
      if (activeStat !== null) throw new Error("active generated root appeared during restore");
    } else {
      if (activeStat === null || activeStat.isSymbolicLink() || !activeStat.isDirectory()) {
        throw new Error("active generated root disappeared during restore");
      }
      const observed = await summarizeInventoryDirectory(active, { fsApi });
      if (!sameSummary(captured.inventory, observed)) throw new Error("active generated root changed during restore");
      const rollbackRoot = deriveRunPath(handoff.capability, { purpose: "rollback", id: restoreId });
      await fsApi.mkdir(rollbackRoot, { recursive: true, mode: 0o700 });
      const rollback = deriveRunPath(handoff.capability, {
        purpose: "rollback-entry", id: restoreId, phase: entry.id,
      });
      if (await optionalStat(rollback, fsApi) !== null) throw new Error("restore rollback destination already exists");
      await fsApi.rename(active, rollback);
      await invokeHook(faultHook, `after-active-to-rollback-rename:${entry.id}`);
      await fsyncTree({ capability: handoff.capability, root: rollback, entryId: entry.id, purpose: "rollback-entry", restoreId });
      await invokeHook(faultHook, `after-rollback-tree-sync`);
      await syncDirectory(dirname(rollback), fsApi);
      await invokeHook(faultHook, `after-rollback-destination-parent-sync`);
      await assertAncestors(ancestors, fsApi);
      await syncDirectory(dirname(active), fsApi);
      await invokeHook(faultHook, `after-rollback-source-parent-sync`);
    }
    await assertPayload(handoff.capability, entry, payload, fsApi);
    await assertAncestors(ancestors, fsApi);
    if (await optionalStat(active, fsApi) !== null) throw new Error("active generated root was concurrently replaced");
    await fsApi.rename(payload, active);
    await invokeHook(faultHook, `after-payload-to-active-rename:${entry.id}`);
    await syncWorkspaceTree(active, fsApi);
    await invokeHook(faultHook, `after-restored-payload-sync:${entry.id}`);
    await revalidateRunCapability(handoff.capability, { purpose: "payload", id: entry.id, boundary: "after-sync" });
    await assertRestoredEndpoint(entry, active, fsApi, ancestors);
    await assertAncestors(ancestors, fsApi);
    await syncDirectory(dirname(active), fsApi);
    await invokeHook(faultHook, `after-restore-destination-parent-sync:${entry.id}`);
    await syncDirectory(dirname(payload), fsApi);
    await invokeHook(faultHook, `after-restore-source-parent-sync:${entry.id}`);
  }
  await append(heldLock, handoff.capability, "RESTORED_ENTRY", { id: entry.id });
  await invokeHook(faultHook, `after-event:RESTORED_ENTRY:${entry.id}`);
}

export async function restoreQuarantine(input) {
  const options = snapshotOptions(input);
  // This must precede capability derivation and every await so later caller
  // mutations cannot affect the deterministically chosen rollback namespace.
  const restoreId = deriveRestoreId(options.transactionId);
  const existing = record([
    ["repoRoot", options.repoRoot], ["quarantineRoot", options.quarantineRoot],
    ["transactionId", options.transactionId], ["writersStopped", true],
    ...(Object.hasOwn(options, "fsApi") ? [["fsApi", options.fsApi]] : []),
  ]);
  return withExistingQuarantineRun(existing, async (handoff) => {
    if (handoff.journalTip.state !== "QUARANTINED" && handoff.journalTip.state !== "VALIDATED") {
      throw new Error("restore is already in progress; explicit recovery is required");
    }
    return withJournalLock({ capability: handoff.capability }, async (heldLock) => {
      const replayed = await replayJournal({ capability: handoff.capability });
      const tip = replayed.records.at(-1);
      if (replayed.state !== handoff.journalTip.state || tip?.recordHash !== handoff.journalTip.recordHash) {
        throw new Error("restore journal changed before mutation");
      }
      const activeGenerated = await captureActiveGenerated(handoff, options.faultHook);
      await assertActiveStable(handoff, activeGenerated);
      await append(heldLock, handoff.capability, "RESTORE_PREPARED", { restoreId, activeGenerated });
      await invokeHook(options.faultHook, "after-event:RESTORE_PREPARED");
      await append(heldLock, handoff.capability, "RESTORING", {});
      await invokeHook(options.faultHook, "after-event:RESTORING");
      for (const entry of handoff.manifestGeneration.manifest.entries) {
        await restoreEntry({ handoff, heldLock, restoreId, entry, activeGenerated, faultHook: options.faultHook });
      }
      await append(heldLock, handoff.capability, "RESTORED", {});
      await invokeHook(options.faultHook, "after-event:RESTORED");
      await invokeHook(options.faultHook, "before-lock-cleanup");
      return record([
        ["transactionId", options.transactionId], ["restoreId", restoreId],
        ["status", "RESTORED"], ["restoredEntries", handoff.manifestGeneration.manifest.entries.length],
      ]);
    });
  });
}
