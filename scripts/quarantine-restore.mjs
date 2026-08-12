import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  fsyncVerifiedTree,
  publishVerifiedRestoreActiveInventory,
  cleanupVerifiedRestoreActiveInventory,
  summarizeInventoryDirectory,
  hashVerifiedRegularFile,
} from "./quarantine-inventory-reader.mjs";
import { appendJournalRecord, IndeterminateJournalAppendError, replayJournal, withJournalLock } from "./quarantine-journal.mjs";
import { withExistingQuarantineRun } from "./quarantine-lifecycle-core.mjs";
import { withRestoreRecoveryRun } from "./quarantine-lifecycle-recovery-run.mjs";
import { buildRestoreLedger } from "./quarantine-restore-ledger.mjs";
import { deriveRunPath, revalidateRunCapability } from "./quarantine-run-capability.mjs";

const OPTION_KEYS = Object.freeze([
  "repoRoot", "quarantineRoot", "transactionId", "writersStopped", "fsApi", "faultHook",
]);
const RECOVERY_OPTION_KEYS = Object.freeze([
  "repoRoot", "quarantineRoot", "transactionId", "action", "writersStopped", "fsApi", "faultHook",
]);
const REQUIRED_KEYS = Object.freeze(["repoRoot", "quarantineRoot", "transactionId", "writersStopped"]);
const GENERATED_IDS = Object.freeze(["generated-next", "generated-node-modules"]);
const TRANSACTION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const DIRECTORY_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY;
const activeMetadata = new WeakMap();

function record(entries) {
  const value = Object.create(null);
  for (const [key, entry] of entries) {
    Object.defineProperty(value, key, {
      value: entry, enumerable: true, configurable: false, writable: false,
    });
  }
  return Object.freeze(value);
}

function activeRecord(id, inventory, ancestors, rootIdentity = null) {
  const value = record([["id", id], ["inventory", inventory]]);
  activeMetadata.set(value, Object.freeze({ ancestors, rootIdentity }));
  return value;
}

function snapshotOptions(input, { recovery = false } = {}) {
  const optionKeys = recovery ? RECOVERY_OPTION_KEYS : OPTION_KEYS;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("restore options must be an exact record");
  }
  if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
    throw new TypeError("restore options must be an exact record");
  }
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== "string" || !optionKeys.includes(key)) ||
    REQUIRED_KEYS.some((key) => !keys.includes(key))
  ) throw new TypeError("restore options are invalid");
  const snapshot = Object.create(null);
  for (const key of optionKeys) if (keys.includes(key)) snapshot[key] = input[key];
  if (snapshot.writersStopped !== true) throw new TypeError("writers-stopped attestation must be true");
  for (const [key, value] of [["repoRoot", snapshot.repoRoot], ["quarantineRoot", snapshot.quarantineRoot]]) {
    if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0") || value !== value.normalize("NFC")) {
      throw new TypeError(`restore ${key} is invalid`);
    }
  }
  if (
    typeof snapshot.transactionId !== "string" || snapshot.transactionId === "." || snapshot.transactionId === ".." ||
    snapshot.transactionId !== snapshot.transactionId.normalize("NFC") || !TRANSACTION_ID.test(snapshot.transactionId)
  ) throw new TypeError("restore transaction ID is invalid");
  if (snapshot.faultHook !== undefined && typeof snapshot.faultHook !== "function") {
    throw new TypeError("restore fault hook must be a function");
  }
  if (recovery && snapshot.action !== "resume" && snapshot.action !== "rollback") {
    throw new TypeError("restore recovery action is invalid");
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

function workspacePath(repoRoot, entry) {
  return join(repoRoot, ...entry.relativePath.split("/"));
}

function rollbackEntryPath(capability, restoreId, entryId) {
  return join(
    deriveRunPath(capability, { purpose: "rollback", id: restoreId }),
    entryId === "generated-next" ? ".next" : "node_modules",
  );
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

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    (left.mode & 0o7777) === (right.mode & 0o7777);
}

async function assertVerifiedDirectory(path, expected, fsApi, message) {
  const stat = await fsApi.lstat(path);
  if (!sameIdentity(expected, stat) || stat.isSymbolicLink() || !stat.isDirectory() ||
      await fsApi.realpath(path) !== expected.canonicalRealpath) {
    throw new Error(message);
  }
}

async function assertVerifiedDirectoryChain(ancestorChain, fsApi) {
  for (const expected of ancestorChain) {
    await assertVerifiedDirectory(expected.path, expected, fsApi, "restore sync ancestor changed");
  }
}

function workspaceParentBinding(ancestors, path) {
  const index = ancestors.findIndex((ancestor) => ancestor.path === path);
  if (index < 0) throw new Error("restore workspace parent identity is unavailable");
  return Object.freeze({
    expectedIdentity: ancestors[index],
    ancestorChain: Object.freeze(ancestors.slice(0, index)),
  });
}

async function syncVerifiedDirectory(path, { fsApi, ancestorChain, expectedIdentity }) {
  let handle;
  let primary;
  try {
    await assertVerifiedDirectoryChain(ancestorChain, fsApi);
    handle = await fsApi.open(path, DIRECTORY_OPEN_FLAGS);
    const opened = await handle.stat();
    if (!sameIdentity(expectedIdentity, opened) || opened.isSymbolicLink() || !opened.isDirectory()) {
      throw new Error("restore sync directory handle identity changed");
    }
    await assertVerifiedDirectoryChain(ancestorChain, fsApi);
    await assertVerifiedDirectory(path, expectedIdentity, fsApi, "restore sync directory changed before sync");
    await handle.sync();
    const finalHandle = await handle.stat();
    if (!sameIdentity(opened, finalHandle) || finalHandle.isSymbolicLink() || !finalHandle.isDirectory()) {
      throw new Error("restore sync directory handle changed");
    }
    await assertVerifiedDirectoryChain(ancestorChain, fsApi);
    await assertVerifiedDirectory(path, expectedIdentity, fsApi, "restore sync directory changed after sync");
  } catch (error) {
    primary = error;
  }
  try {
    if (handle !== undefined) await handle.close();
  } catch (error) {
    if (primary !== undefined) throw new AggregateError([primary, error], "verified directory sync and close failed");
    throw error;
  }
  if (primary !== undefined) throw primary;
}

async function capturePrivateParent(path, fsApi) {
  const stat = await fsApi.lstat(path);
  const realPath = await fsApi.realpath(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o7777) !== 0o700 || realPath !== path) {
    throw new Error("restore private parent is unsafe");
  }
  return Object.freeze({
    path, dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777,
    type: "directory", canonicalRealpath: realPath,
  });
}

async function assertPrivateParent(expected, fsApi) {
  const stat = await fsApi.lstat(expected.path);
  if (!sameIdentity(expected, stat) || stat.isSymbolicLink() || !stat.isDirectory() ||
      await fsApi.realpath(expected.path) !== expected.path) {
    throw new Error("restore private parent changed");
  }
}

function privateParentChain(parent) {
  return Object.freeze([parent]);
}

async function assertMissing(path, fsApi) {
  if (await optionalStat(path, fsApi) !== null) throw new Error("restore destination is not absent");
}

async function captureVerifiedSyncIdentity(path, expected, fsApi) {
  const stat = await fsApi.lstat(path);
  if (!sameIdentity(expected, stat) || stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error("restore sync root changed before held sync");
  }
  if (stat.isFile()) return stat;
  const canonicalRealpath = await fsApi.realpath(path);
  if (canonicalRealpath !== path) throw new Error("restore sync root is unsafe");
  return Object.freeze({
    path, dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777,
    type: "directory", canonicalRealpath,
  });
}

/* writersStopped is a cooperative exclusion boundary.  Node exposes no
 * cross-platform rename-no-replace primitive, so this is intentionally the
 * same guarded check->rename authority used by apply/recovery: replacements
 * observed before the final check are rejected and preserved. */
async function guardedRestoreRename({
  capability, pathRequest, source, destination, fsApi, before, after,
}) {
  await revalidateRunCapability(capability, { ...pathRequest, boundary: "before-mutation" });
  await before();
  const sourceStat = await fsApi.lstat(source);
  await assertMissing(destination, fsApi);
  await fsApi.rename(source, destination);
  await revalidateRunCapability(capability, { ...pathRequest, boundary: "after-sync" });
  if (await optionalStat(source, fsApi) !== null) throw new Error("restore rename source remains present");
  const destinationStat = await fsApi.lstat(destination);
  if (!sameIdentity(sourceStat, destinationStat)) throw new Error("restore rename destination changed");
  await after(destinationStat);
}

async function assertPayload(capability, entry, path, fsApi, ancestorChain = Object.freeze([])) {
  await revalidateRunCapability(capability, { purpose: "payload", id: entry.id, boundary: "before-mutation" });
  if (entry.kind === "source-copy") {
    const stat = await fsApi.lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o7777) !== entry.mode || stat.size !== entry.size) {
      throw new Error("restore payload source is invalid");
    }
    const hash = await hashVerifiedRegularFile(path, stat, fsApi, ancestorChain);
    if (hash.sha256 !== entry.sha256 || hash.bytes !== entry.size) throw new Error("restore payload content changed");
    return;
  }
  const observed = await summarizeInventoryDirectory(path, { fsApi, ancestorChain });
  if (!sameSummary(entry.preMoveInventory, observed)) throw new Error("restore payload inventory changed");
}

async function assertPrivatePayload(capability, entry, path, fsApi, parent) {
  const ancestorChain = privateParentChain(parent);
  await assertPrivateParent(parent, fsApi);
  await assertPayload(capability, entry, path, fsApi, ancestorChain);
  await assertPrivateParent(parent, fsApi);
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
  const observed = await summarizeInventoryDirectory(path, { fsApi, ancestorChain: ancestors });
  if (!sameSummary(entry.preMoveInventory, observed)) throw new Error("restored generated endpoint changed");
}

async function append(heldLock, capability, event, payload) {
  await appendJournalRecord({ capability, heldLock, event, payload });
}

async function invokeHook(hook, phase) {
  if (hook !== undefined) await hook(phase);
}

async function captureActiveGenerated(handoff, faultHook, publications, { replaceExisting = false } = {}) {
  const active = [];
  for (const id of GENERATED_IDS) {
    const entry = handoff.manifestGeneration.manifest.entries.find((candidate) => candidate.id === id);
    if (entry === undefined || entry.kind !== "generated-root") throw new Error("generated manifest entries are invalid");
    const root = workspacePath(handoff.repoRoot, entry);
    const ancestors = await captureAncestors(handoff.repoRoot, root, handoff.fsApi);
    const stat = await optionalStat(root, handoff.fsApi);
    if (stat === null) {
      active.push(activeRecord(id, null, ancestors));
      await invokeHook(faultHook, `after-inventory:restore-active:${id}`);
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("active generated root is unsafe");
    // Inventory publication is capability-owned. The read-only summary is the
    // held-reader validation of the active endpoint and ancestor chain.
    const heldSnapshot = await summarizeInventoryDirectory(root, {
      fsApi: handoff.fsApi, ancestorChain: ancestors, snapshot: true,
    });
    const published = await publishVerifiedRestoreActiveInventory({
      capability: handoff.capability, entryId: id, snapshot: heldSnapshot, replaceExisting,
    });
    if (published.publication.reused !== true) publications.push(published.publication);
    await invokeHook(faultHook, `after-inventory:restore-active:${id}`);
    active.push(activeRecord(id, published.summary, ancestors, heldSnapshot.rootIdentity));
  }
  return Object.freeze(active);
}

async function cleanupRestoreActivePublications(capability, publications, primary) {
  const cleanupErrors = [];
  for (const publication of publications.toReversed()) {
    try { await cleanupVerifiedRestoreActiveInventory({ capability, publication }); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length > 0) throw new AggregateError([primary, ...cleanupErrors], "restore-active inventory cleanup failed");
  throw primary;
}

async function assertActiveStable(handoff, active) {
  for (const captured of active) {
    const entry = handoff.manifestGeneration.manifest.entries.find((candidate) => candidate.id === captured.id);
    const root = workspacePath(handoff.repoRoot, entry);
    const metadata = activeMetadata.get(captured);
    if (metadata === undefined) throw new Error("restore active evidence metadata is unavailable");
    const ancestors = metadata.ancestors;
    await assertAncestors(ancestors, handoff.fsApi);
    const stat = await optionalStat(root, handoff.fsApi);
    if (captured.inventory === null) {
      if (stat !== null) throw new Error("absent active generated root appeared during restore preparation");
      continue;
    }
    if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("active generated root disappeared during restore preparation");
    }
    if (metadata.rootIdentity === null) throw new Error("active generated root identity is unavailable");
    await assertVerifiedDirectory(root, metadata.rootIdentity, handoff.fsApi, "active generated root changed during restore preparation");
    const observed = await summarizeInventoryDirectory(root, {
      fsApi: handoff.fsApi,
      ancestorChain: ancestors,
      expectedRootIdentity: metadata.rootIdentity,
    });
    await assertVerifiedDirectory(root, metadata.rootIdentity, handoff.fsApi, "active generated root changed during restore preparation");
    if (!sameSummary(captured.inventory, observed)) throw new Error("active generated root changed during restore preparation");
  }
}

async function restoreEntry({ handoff, heldLock, restoreId, entry, activeGenerated, faultHook }) {
  const fsApi = handoff.fsApi;
  const payload = deriveRunPath(handoff.capability, { purpose: "payload", id: entry.id });
  const active = workspacePath(handoff.repoRoot, entry);
  const ancestors = await captureAncestors(handoff.repoRoot, active, fsApi);
  const workspaceParent = workspaceParentBinding(ancestors, dirname(active));
  const payloadParent = await capturePrivateParent(dirname(payload), fsApi);
  await append(heldLock, handoff.capability, "RESTORE_INTENT", { id: entry.id });
  await invokeHook(faultHook, `after-event:RESTORE_INTENT:${entry.id}`);

  await assertPrivatePayload(handoff.capability, entry, payload, fsApi, payloadParent);
  await assertAncestors(ancestors, fsApi);
  if (entry.kind === "source-copy") {
    let restoredIdentity;
    await guardedRestoreRename({
      capability: handoff.capability, pathRequest: { purpose: "payload", id: entry.id }, source: payload, destination: active, fsApi,
      before: async () => {
        await assertAncestors(ancestors, fsApi);
        await assertPrivatePayload(handoff.capability, entry, payload, fsApi, payloadParent);
      },
      after: async (destinationStat) => {
        restoredIdentity = await captureVerifiedSyncIdentity(active, destinationStat, fsApi);
        await assertRestoredEndpoint(entry, active, fsApi, ancestors);
      },
    });
    await invokeHook(faultHook, `after-payload-to-active-rename:${entry.id}`);
    await fsyncVerifiedTree(active, { fsApi, ancestorChain: ancestors, rootIdentity: restoredIdentity });
    await invokeHook(faultHook, `after-restored-payload-sync:${entry.id}`);
    await revalidateRunCapability(handoff.capability, { purpose: "payload", id: entry.id, boundary: "after-sync" });
    await assertRestoredEndpoint(entry, active, fsApi, ancestors);
    await assertAncestors(ancestors, fsApi);
    await syncVerifiedDirectory(dirname(active), { fsApi, ...workspaceParent });
    await invokeHook(faultHook, `after-restore-destination-parent-sync:${entry.id}`);
    await syncVerifiedDirectory(payloadParent.path, {
      fsApi, ancestorChain: Object.freeze([]), expectedIdentity: payloadParent,
    });
    await invokeHook(faultHook, `after-restore-source-parent-sync:${entry.id}`);
  } else {
    const captured = activeGenerated.find((candidate) => candidate.id === entry.id);
    if (captured === undefined) throw new Error("missing active generated evidence");
    if (captured.inventory !== null) {
      const rollbackRoot = deriveRunPath(handoff.capability, { purpose: "rollback", id: restoreId });
      await fsApi.mkdir(rollbackRoot, { recursive: true, mode: 0o700 });
      const rollback = deriveRunPath(handoff.capability, {
        purpose: "rollback-entry", id: restoreId, phase: entry.id,
      });
      const rollbackParent = await capturePrivateParent(dirname(rollback), fsApi);
      let rollbackIdentity;
      await guardedRestoreRename({
        capability: handoff.capability, pathRequest: { purpose: "rollback-entry", id: restoreId, phase: entry.id }, source: active, destination: rollback, fsApi,
        before: async () => {
          await assertAncestors(ancestors, fsApi);
          await assertPrivateParent(rollbackParent, fsApi);
          const stat = await optionalStat(active, fsApi);
          if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("active generated root disappeared during restore");
          const observed = await summarizeInventoryDirectory(active, { fsApi, ancestorChain: ancestors });
          if (!sameSummary(captured.inventory, observed)) throw new Error("active generated root changed during restore");
        },
        after: async (destinationStat) => {
          rollbackIdentity = await captureVerifiedSyncIdentity(rollback, destinationStat, fsApi);
          await assertPrivateParent(rollbackParent, fsApi);
          const observed = await summarizeInventoryDirectory(rollback, {
            fsApi, ancestorChain: privateParentChain(rollbackParent),
          });
          await assertPrivateParent(rollbackParent, fsApi);
          if (!sameSummary(captured.inventory, observed)) throw new Error("rollback generated root changed");
        },
      });
      await invokeHook(faultHook, `after-active-to-rollback-rename:${entry.id}`);
      await fsyncVerifiedTree(rollback, { fsApi, ancestorChain: Object.freeze([rollbackParent]), rootIdentity: rollbackIdentity });
      await invokeHook(faultHook, `after-rollback-tree-sync:${entry.id}`);
      await syncVerifiedDirectory(rollbackParent.path, {
        fsApi, ancestorChain: Object.freeze([]), expectedIdentity: rollbackParent,
      });
      await invokeHook(faultHook, `after-rollback-destination-parent-sync:${entry.id}`);
      await syncVerifiedDirectory(dirname(active), { fsApi, ...workspaceParent });
      await invokeHook(faultHook, `after-rollback-source-parent-sync:${entry.id}`);
    } else {
      await assertAncestors(ancestors, fsApi);
      await assertMissing(active, fsApi);
    }
    let restoredIdentity;
    await guardedRestoreRename({
      capability: handoff.capability, pathRequest: { purpose: "payload", id: entry.id }, source: payload, destination: active, fsApi,
      before: async () => {
        await assertAncestors(ancestors, fsApi);
        await assertPrivatePayload(handoff.capability, entry, payload, fsApi, payloadParent);
      },
      after: async (destinationStat) => {
        restoredIdentity = await captureVerifiedSyncIdentity(active, destinationStat, fsApi);
        await assertRestoredEndpoint(entry, active, fsApi, ancestors);
      },
    });
    await invokeHook(faultHook, `after-payload-to-active-rename:${entry.id}`);
    await fsyncVerifiedTree(active, { fsApi, ancestorChain: ancestors, rootIdentity: restoredIdentity });
    await invokeHook(faultHook, `after-restored-payload-sync:${entry.id}`);
    await revalidateRunCapability(handoff.capability, { purpose: "payload", id: entry.id, boundary: "after-sync" });
    await assertRestoredEndpoint(entry, active, fsApi, ancestors);
    await assertAncestors(ancestors, fsApi);
    await syncVerifiedDirectory(dirname(active), { fsApi, ...workspaceParent });
    await invokeHook(faultHook, `after-restore-destination-parent-sync:${entry.id}`);
    await syncVerifiedDirectory(payloadParent.path, {
      fsApi, ancestorChain: Object.freeze([]), expectedIdentity: payloadParent,
    });
    await invokeHook(faultHook, `after-restore-source-parent-sync:${entry.id}`);
  }
  await append(heldLock, handoff.capability, "RESTORED_ENTRY", { id: entry.id });
  await invokeHook(faultHook, `after-event:RESTORED_ENTRY:${entry.id}`);
}

async function sourceMatches(path, entry, fsApi, ancestors = Object.freeze([])) {
  const stat = await optionalStat(path, fsApi);
  if (stat === null) return false;
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o7777) !== entry.mode || stat.size !== entry.size) return false;
  const hashed = await hashVerifiedRegularFile(path, stat, fsApi, ancestors);
  return hashed.sha256 === entry.sha256 && hashed.bytes === entry.size;
}

async function treeMatches(path, inventory, fsApi, ancestors = Object.freeze([])) {
  const stat = await optionalStat(path, fsApi);
  if (stat === null) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  return sameSummary(inventory, await summarizeInventoryDirectory(path, { fsApi, ancestorChain: ancestors }));
}

/* Classifying by durable locations is deliberate: a regenerated tree may be
 * byte-identical to the original.  In that case the P/A/R role and ledger,
 * rather than the digest, determine which side may be moved. */
async function classifyRecoveryEntry({ handoff, ledger, entry }) {
  const fsApi = handoff.fsApi;
  const payload = deriveRunPath(handoff.capability, { purpose: "payload", id: entry.id });
  const active = workspacePath(handoff.repoRoot, entry);
  const ancestors = await captureAncestors(handoff.repoRoot, active, fsApi);
  const pStat = await optionalStat(payload, fsApi);
  const aStat = await optionalStat(active, fsApi);
  if (entry.kind === "source-copy") {
    const p = pStat !== null && await sourceMatches(payload, entry, fsApi);
    const a = aStat !== null && await sourceMatches(active, entry, fsApi, ancestors);
    // A non-matching endpoint is concurrent evidence, not an absent endpoint.
    // `sourceMatches` intentionally returns false for both; retain the lstat
    // distinction so recovery persists a conflict before any rename attempt.
    if (p && aStat === null) return Object.freeze({ id: entry.id, state: "initial" });
    if (pStat === null && a) return Object.freeze({ id: entry.id, state: "final" });
    if (pStat === null && aStat === null) return Object.freeze({ id: entry.id, state: "missing" });
    return Object.freeze({ id: entry.id, state: "conflict" });
  }
  const rollback = rollbackEntryPath(handoff.capability, ledger.restoreId, entry.id);
  const rStat = await optionalStat(rollback, fsApi);
  const original = entry.preMoveInventory;
  const generated = ledger.active.get(entry.id);
  const p = pStat !== null && await treeMatches(payload, original, fsApi);
  const aOriginal = aStat !== null && await treeMatches(active, original, fsApi, ancestors);
  const aGenerated = generated !== null && aStat !== null && await treeMatches(active, generated, fsApi, ancestors);
  const rGenerated = generated !== null && rStat !== null && await treeMatches(rollback, generated, fsApi);
  if (generated === null) {
    if (p && aStat === null && rStat === null) return Object.freeze({ id: entry.id, state: "initial" });
    if (pStat === null && aOriginal && rStat === null) return Object.freeze({ id: entry.id, state: "final" });
    if (pStat === null && aStat === null && rStat === null) return Object.freeze({ id: entry.id, state: "missing" });
    return Object.freeze({ id: entry.id, state: "conflict" });
  }
  if (p && aGenerated && rStat === null) return Object.freeze({ id: entry.id, state: "initial" });
  if (p && aStat === null && rGenerated) return Object.freeze({ id: entry.id, state: "staged" });
  if (pStat === null && aOriginal && rGenerated) return Object.freeze({ id: entry.id, state: "final" });
  if (pStat === null && aStat === null && rStat === null) return Object.freeze({ id: entry.id, state: "missing" });
  return Object.freeze({ id: entry.id, state: "conflict" });
}

async function moveRecoveryEndpoint({ handoff, entry, source, destination, sourceExpected, sourceInventory, sourceAncestors, destinationAncestors, destinationParent, sourceParent, hook, phases }) {
  const fsApi = handoff.fsApi;
  let identity;
  await guardedRestoreRename({
    capability: handoff.capability, pathRequest: { purpose: "payload", id: entry.id }, source, destination, fsApi,
    before: async () => {
      if (destinationAncestors !== undefined) await assertAncestors(destinationAncestors, fsApi);
      if (sourceExpected === "original") {
        if (entry.kind === "source-copy") {
          if (!await sourceMatches(source, entry, fsApi, sourceAncestors ?? Object.freeze([]))) throw new Error("restore recovery original changed");
        } else if (!await treeMatches(source, entry.preMoveInventory, fsApi, sourceAncestors ?? Object.freeze([]))) throw new Error("restore recovery original changed");
      } else if (sourceExpected === "generated" &&
          !await treeMatches(source, sourceInventory, fsApi, sourceAncestors ?? Object.freeze([]))) {
        throw new Error("restore recovery regenerated tree changed");
      }
    },
    after: async (stat) => { identity = await captureVerifiedSyncIdentity(destination, stat, fsApi); },
  });
  await invokeHook(hook, phases.rename);
  await fsyncVerifiedTree(destination, { fsApi, ancestorChain: destinationAncestors ?? Object.freeze([]), rootIdentity: identity });
  await invokeHook(hook, phases.sync);
  await syncVerifiedDirectory(destinationParent.path, { fsApi, ...destinationParent });
  await invokeHook(hook, phases.destinationParent);
  if (sourceParent !== undefined) {
    await syncVerifiedDirectory(sourceParent.path, { fsApi, ...sourceParent });
    await invokeHook(hook, phases.sourceParent);
  }
}

async function forwardRecoveryEntry({ handoff, heldLock, ledger, entry, state, faultHook }) {
  const fsApi = handoff.fsApi;
  const payload = deriveRunPath(handoff.capability, { purpose: "payload", id: entry.id });
  const active = workspacePath(handoff.repoRoot, entry);
  const ancestors = await captureAncestors(handoff.repoRoot, active, fsApi);
  const activeParent = workspaceParentBinding(ancestors, dirname(active));
  const payloadParentIdentity = await capturePrivateParent(dirname(payload), fsApi);
  const payloadParent = { path: payloadParentIdentity.path, ancestorChain: Object.freeze([]), expectedIdentity: payloadParentIdentity };
  if (!ledger.intents.includes(entry.id)) {
    await append(heldLock, handoff.capability, "RESTORE_INTENT", { id: entry.id });
    await invokeHook(faultHook, `after-event:RESTORE_INTENT:${entry.id}`);
  }
  if (state === "initial" && entry.kind === "generated-root" && ledger.active.get(entry.id) !== null) {
    const rollback = rollbackEntryPath(handoff.capability, ledger.restoreId, entry.id);
    await fsApi.mkdir(dirname(rollback), { recursive: true, mode: 0o700 });
    const rollbackIdentity = await capturePrivateParent(dirname(rollback), fsApi);
    await moveRecoveryEndpoint({ handoff, entry, source: active, destination: rollback, sourceExpected: "generated", sourceInventory: ledger.active.get(entry.id), sourceAncestors: ancestors, destinationAncestors: Object.freeze([rollbackIdentity]), destinationParent: { path: rollbackIdentity.path, ancestorChain: Object.freeze([]), expectedIdentity: rollbackIdentity }, sourceParent: { path: dirname(active), ...activeParent }, hook: faultHook, phases: {
      rename: `after-active-to-rollback-rename:${entry.id}`, sync: `after-rollback-tree-sync:${entry.id}`,
      destinationParent: `after-rollback-destination-parent-sync:${entry.id}`, sourceParent: `after-rollback-source-parent-sync:${entry.id}`,
    } });
    state = "staged";
  }
  if (state === "initial" || state === "staged") {
    await moveRecoveryEndpoint({ handoff, entry, source: payload, destination: active, sourceExpected: "original", sourceAncestors: Object.freeze([payloadParentIdentity]), destinationAncestors: ancestors, destinationParent: { path: dirname(active), ...activeParent }, sourceParent: payloadParent, hook: faultHook, phases: {
      rename: `after-payload-to-active-rename:${entry.id}`, sync: `after-restored-payload-sync:${entry.id}`,
      destinationParent: `after-restore-destination-parent-sync:${entry.id}`, sourceParent: `after-restore-source-parent-sync:${entry.id}`,
    } });
  }
  await append(heldLock, handoff.capability, "RESTORED_ENTRY", { id: entry.id });
  await invokeHook(faultHook, `after-event:RESTORED_ENTRY:${entry.id}`);
}

async function rollbackRecoveryEntry({ handoff, heldLock, ledger, entry, state, faultHook, rollbackIntentRecorded = false }) {
  const fsApi = handoff.fsApi;
  const payload = deriveRunPath(handoff.capability, { purpose: "payload", id: entry.id });
  const active = workspacePath(handoff.repoRoot, entry);
  const ancestors = await captureAncestors(handoff.repoRoot, active, fsApi);
  const activeParent = workspaceParentBinding(ancestors, dirname(active));
  const payloadIdentity = await capturePrivateParent(dirname(payload), fsApi);
  const payloadParent = { path: payloadIdentity.path, ancestorChain: Object.freeze([]), expectedIdentity: payloadIdentity };
  if (!rollbackIntentRecorded) {
    await append(heldLock, handoff.capability, "RESTORE_ROLLBACK_INTENT", { id: entry.id });
    await invokeHook(faultHook, `after-event:RESTORE_ROLLBACK_INTENT:${entry.id}`);
  }
  if (state === "final") {
    await moveRecoveryEndpoint({ handoff, entry, source: active, destination: payload, sourceExpected: "original", sourceAncestors: ancestors, destinationAncestors: Object.freeze([]), destinationParent: payloadParent, sourceParent: { path: dirname(active), ...activeParent }, hook: faultHook, phases: {
      rename: `after-original-active-to-payload-rename:${entry.id}`, sync: `after-original-payload-sync:${entry.id}`,
      destinationParent: `after-original-payload-parent-sync:${entry.id}`, sourceParent: `after-original-active-parent-sync:${entry.id}`,
    } });
    state = "staged";
  }
  if (entry.kind === "generated-root" && ledger.active.get(entry.id) !== null && state === "staged") {
    const rollback = rollbackEntryPath(handoff.capability, ledger.restoreId, entry.id);
    const rollbackIdentity = await capturePrivateParent(dirname(rollback), fsApi);
    let identity;
    await guardedRestoreRename({ capability: handoff.capability, pathRequest: { purpose: "rollback-entry", id: ledger.restoreId, phase: entry.id }, source: rollback, destination: active, fsApi,
      before: async () => {
        await assertPrivateParent(rollbackIdentity, fsApi);
        if (!await treeMatches(rollback, ledger.active.get(entry.id), fsApi, privateParentChain(rollbackIdentity))) throw new Error("restore recovery regenerated rollback changed");
        await assertAncestors(ancestors, fsApi);
      }, after: async (stat) => { identity = await captureVerifiedSyncIdentity(active, stat, fsApi); },
    });
    await invokeHook(faultHook, `after-regenerated-rollback-to-active-rename:${entry.id}`);
    await fsyncVerifiedTree(active, { fsApi, ancestorChain: ancestors, rootIdentity: identity });
    await invokeHook(faultHook, `after-regenerated-active-tree-sync:${entry.id}`);
    await syncVerifiedDirectory(dirname(active), { fsApi, ...activeParent });
    await invokeHook(faultHook, `after-regenerated-active-parent-sync:${entry.id}`);
    await syncVerifiedDirectory(rollbackIdentity.path, { fsApi, ancestorChain: Object.freeze([]), expectedIdentity: rollbackIdentity });
    await invokeHook(faultHook, `after-regenerated-rollback-parent-sync:${entry.id}`);
  }
  await append(heldLock, handoff.capability, "RESTORE_ROLLED_BACK_ENTRY", { id: entry.id });
  await invokeHook(faultHook, `after-event:RESTORE_ROLLED_BACK_ENTRY:${entry.id}`);
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
      const publications = [];
      let activeGenerated;
      try {
        // Exact, held-reader validation makes an interrupted pre-prepare
        // publication safely reusable; mismatched/foreign EEXIST stays fatal.
        activeGenerated = await captureActiveGenerated(handoff, options.faultHook, publications, { replaceExisting: true });
        await assertActiveStable(handoff, activeGenerated);
        await append(heldLock, handoff.capability, "RESTORE_PREPARED", { restoreId, activeGenerated });
      } catch (error) {
        if (error instanceof IndeterminateJournalAppendError || error?.code === "ERR_INDETERMINATE_JOURNAL_APPEND") throw error;
        await cleanupRestoreActivePublications(handoff.capability, publications, error);
      }
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

export async function recoverRestore(input) {
  const options = snapshotOptions(input, { recovery: true });
  const existing = record([
    ["repoRoot", options.repoRoot], ["quarantineRoot", options.quarantineRoot],
    ["transactionId", options.transactionId], ["writersStopped", true],
    ...(Object.hasOwn(options, "fsApi") ? [["fsApi", options.fsApi]] : []),
  ]);
  return withRestoreRecoveryRun(existing, async (handoff) => withJournalLock({ capability: handoff.capability }, async (heldLock) => {
    const replayed = await replayJournal({ capability: handoff.capability });
    if (replayed.truncatedTail) throw new Error("restore recovery journal has a torn tail");
    const tip = replayed.records.at(-1);
    if (tip?.recordHash !== handoff.journalTip.recordHash || replayed.state !== handoff.journalTip.state) {
      throw new Error("restore journal changed before recovery mutation");
    }
    const ledger = buildRestoreLedger(replayed, handoff.manifestGeneration.manifest);
    const restoreId = ledger.restoreId;
    if (replayed.state === "INCOMPLETE_CONFLICT") {
      const conflict = replayed.records.at(-1)?.payload.conflictEntryIds;
      return record([["transactionId", options.transactionId], ["restoreId", restoreId], ["status", "INCOMPLETE_CONFLICT"], ["action", options.action], ["conflictEntryIds", Object.freeze([...conflict])]]);
    }
    if (replayed.state === "RESTORED") throw new Error("completed restore cannot be undone");
    if (!new Set(["RESTORE_PREPARED", "RESTORING", "RECOVERY_REQUIRED", "RESTORE_ROLLING_BACK"]).has(replayed.state)) {
      throw new Error("restore recovery requires an in-progress restore");
    }
    const entries = handoff.manifestGeneration.manifest.entries;
    const { intents, completed, rollbackCompleted } = ledger;
    const pendingRollback = ledger.rollbackIntentIds.length === rollbackCompleted.size ? null : ledger.rollbackIntentIds.at(-1);
    const inspected = [];
    for (const entry of entries) {
      if (options.action === "rollback" && (!intents.includes(entry.id) || rollbackCompleted.has(entry.id))) continue;
      inspected.push(await classifyRecoveryEntry({ handoff, ledger, entry }));
    }
    const missing = inspected.filter((entry) => entry.state === "missing");
    if (missing.length > 0) throw new Error("restore recovery evidence is missing");
    const conflicts = inspected.filter((entry) => entry.state === "conflict").map((entry) => entry.id).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    if (conflicts.length > 0) {
      if (replayed.state !== "RECOVERY_REQUIRED") {
        await append(heldLock, handoff.capability, "RECOVERY_REQUIRED", { entryIds: Object.freeze(intents) });
        await invokeHook(options.faultHook, "after-event:RECOVERY_REQUIRED");
      }
      await append(heldLock, handoff.capability, "INCOMPLETE_CONFLICT", { conflictEntryIds: conflicts });
      await invokeHook(options.faultHook, "after-event:INCOMPLETE_CONFLICT");
      return record([["transactionId", options.transactionId], ["restoreId", restoreId], ["status", "INCOMPLETE_CONFLICT"], ["action", options.action], ["conflictEntryIds", Object.freeze(conflicts)]]);
    }
    if (options.action === "resume") {
      if (replayed.state === "RESTORE_ROLLING_BACK") throw new Error("restore rollback is already in progress");
      if (replayed.state !== "RECOVERY_REQUIRED") {
        await append(heldLock, handoff.capability, "RECOVERY_REQUIRED", { entryIds: Object.freeze(intents) });
        await invokeHook(options.faultHook, "after-event:RECOVERY_REQUIRED");
      }
      await append(heldLock, handoff.capability, "RESTORING", {});
      await invokeHook(options.faultHook, "after-event:RESTORING");
      const states = new Map(inspected.map((entry) => [entry.id, entry.state]));
      for (const entry of entries) {
        if (completed.has(entry.id)) continue;
        await forwardRecoveryEntry({ handoff, heldLock, ledger, entry, state: states.get(entry.id) ?? "initial", faultHook: options.faultHook });
      }
      await append(heldLock, handoff.capability, "RESTORED", {});
      await invokeHook(options.faultHook, "after-event:RESTORED");
      await invokeHook(options.faultHook, "before-lock-cleanup");
      return record([["transactionId", options.transactionId], ["restoreId", restoreId], ["status", "RESTORED"], ["action", "resume"], ["reconciledEntries", entries.length]]);
    }
    if (replayed.state !== "RESTORE_ROLLING_BACK") {
      if (replayed.state !== "RECOVERY_REQUIRED") {
        await append(heldLock, handoff.capability, "RECOVERY_REQUIRED", { entryIds: Object.freeze(intents) });
        await invokeHook(options.faultHook, "after-event:RECOVERY_REQUIRED");
      }
      await append(heldLock, handoff.capability, "RESTORE_ROLLING_BACK", {});
      await invokeHook(options.faultHook, "after-event:RESTORE_ROLLING_BACK");
    }
    const states = new Map(inspected.map((entry) => [entry.id, entry.state]));
    for (const entry of [...entries].reverse()) {
      if (!intents.includes(entry.id) || rollbackCompleted.has(entry.id)) continue;
      await rollbackRecoveryEntry({ handoff, heldLock, ledger, entry, state: states.get(entry.id) ?? "initial", faultHook: options.faultHook, rollbackIntentRecorded: pendingRollback === entry.id });
    }
    const prior = ledger.preRestoreState;
    await append(heldLock, handoff.capability, prior === "VALIDATED" ? "RESTORE_ABORTED_TO_VALIDATED" : "RESTORE_ABORTED_TO_QUARANTINED", {});
    await invokeHook(options.faultHook, prior === "VALIDATED" ? "after-event:RESTORE_ABORTED_TO_VALIDATED" : "after-event:RESTORE_ABORTED_TO_QUARANTINED");
    await invokeHook(options.faultHook, "before-lock-cleanup");
    return record([["transactionId", options.transactionId], ["restoreId", restoreId], ["status", prior], ["action", "rollback"], ["reconciledEntries", intents.length], ["restoreAborted", true]]);
  }));
}
