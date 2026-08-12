import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { fsyncTree } from "./quarantine-inventory.mjs";
import {
  fsyncVerifiedTree,
  publishVerifiedRestoreActiveInventory,
  summarizeInventoryDirectory,
  hashVerifiedRegularFile,
} from "./quarantine-inventory-reader.mjs";
import { appendJournalRecord, replayJournal, withJournalLock } from "./quarantine-journal.mjs";
import { withExistingQuarantineRun } from "./quarantine-lifecycle-core.mjs";
import { deriveRunPath, revalidateRunCapability } from "./quarantine-run-capability.mjs";

const OPTION_KEYS = Object.freeze([
  "repoRoot", "quarantineRoot", "transactionId", "writersStopped", "fsApi", "faultHook",
]);
const REQUIRED_KEYS = Object.freeze(["repoRoot", "quarantineRoot", "transactionId", "writersStopped"]);
const GENERATED_IDS = Object.freeze(["generated-next", "generated-node-modules"]);
const TRANSACTION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
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

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    (left.mode & 0o7777) === (right.mode & 0o7777);
}

async function capturePrivateParent(path, fsApi) {
  const stat = await fsApi.lstat(path);
  const realPath = await fsApi.realpath(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o7777) !== 0o700 || realPath !== path) {
    throw new Error("restore private parent is unsafe");
  }
  return Object.freeze({ path, dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777 });
}

async function assertPrivateParent(expected, fsApi) {
  const stat = await fsApi.lstat(expected.path);
  if (!sameIdentity(expected, stat) || stat.isSymbolicLink() || !stat.isDirectory() ||
      await fsApi.realpath(expected.path) !== expected.path) {
    throw new Error("restore private parent changed");
  }
}

async function assertMissing(path, fsApi) {
  if (await optionalStat(path, fsApi) !== null) throw new Error("restore destination is not absent");
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

async function assertPayload(capability, entry, path, fsApi, ancestors = Object.freeze([])) {
  await revalidateRunCapability(capability, { purpose: "payload", id: entry.id, boundary: "before-mutation" });
  if (entry.kind === "source-copy") {
    const stat = await fsApi.lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o7777) !== entry.mode || stat.size !== entry.size) {
      throw new Error("restore payload source is invalid");
    }
    const hash = await hashVerifiedRegularFile(path, stat, fsApi, ancestors);
    if (hash.sha256 !== entry.sha256 || hash.bytes !== entry.size) throw new Error("restore payload content changed");
    return;
  }
  const observed = await summarizeInventoryDirectory(path, { fsApi, ancestorChain: ancestors });
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
  const observed = await summarizeInventoryDirectory(path, { fsApi, ancestorChain: ancestors });
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
    const ancestors = await captureAncestors(handoff.repoRoot, root, handoff.fsApi);
    const stat = await optionalStat(root, handoff.fsApi);
    if (stat === null) {
      active.push(activeRecord(id, null, ancestors));
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("active generated root is unsafe");
    // Inventory publication is capability-owned. The read-only summary is the
    // held-reader validation of the active endpoint and ancestor chain.
    const heldSnapshot = await summarizeInventoryDirectory(root, {
      fsApi: handoff.fsApi, ancestorChain: ancestors, snapshot: true,
    });
    const inventory = await publishVerifiedRestoreActiveInventory({
      capability: handoff.capability, entryId: id, snapshot: heldSnapshot,
    });
    await invokeHook(faultHook, `after-inventory:restore-active:${id}`);
    active.push(activeRecord(id, inventory, ancestors, heldSnapshot.rootIdentity));
  }
  return Object.freeze(active);
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
    const observed = await summarizeInventoryDirectory(root, { fsApi: handoff.fsApi, ancestorChain: ancestors });
    if (!sameSummary(captured.inventory, observed)) throw new Error("active generated root changed during restore preparation");
  }
}

async function restoreEntry({ handoff, heldLock, restoreId, entry, activeGenerated, faultHook }) {
  const fsApi = handoff.fsApi;
  const payload = deriveRunPath(handoff.capability, { purpose: "payload", id: entry.id });
  const active = workspacePath(handoff.repoRoot, entry);
  const ancestors = await captureAncestors(handoff.repoRoot, active, fsApi);
  const payloadParent = await capturePrivateParent(dirname(payload), fsApi);
  await append(heldLock, handoff.capability, "RESTORE_INTENT", { id: entry.id });
  await invokeHook(faultHook, `after-event:RESTORE_INTENT:${entry.id}`);

  await assertPayload(handoff.capability, entry, payload, fsApi);
  await assertAncestors(ancestors, fsApi);
  if (entry.kind === "source-copy") {
    await guardedRestoreRename({
      capability: handoff.capability, pathRequest: { purpose: "payload", id: entry.id }, source: payload, destination: active, fsApi,
      before: async () => {
        await assertPrivateParent(payloadParent, fsApi);
        await assertAncestors(ancestors, fsApi);
        await assertPayload(handoff.capability, entry, payload, fsApi);
      },
      after: async () => assertRestoredEndpoint(entry, active, fsApi, ancestors),
    });
    await invokeHook(faultHook, `after-payload-to-active-rename:${entry.id}`);
    await fsyncVerifiedTree(active, { fsApi, ancestorChain: ancestors });
    await invokeHook(faultHook, `after-restored-payload-sync:${entry.id}`);
    await revalidateRunCapability(handoff.capability, { purpose: "payload", id: entry.id, boundary: "after-sync" });
    await assertRestoredEndpoint(entry, active, fsApi, ancestors);
    await assertAncestors(ancestors, fsApi);
    await syncDirectory(dirname(active), fsApi);
    await invokeHook(faultHook, `after-restore-destination-parent-sync:${entry.id}`);
    await assertPrivateParent(payloadParent, fsApi);
    await syncDirectory(payloadParent.path, fsApi);
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
        after: async () => {
          await assertPrivateParent(rollbackParent, fsApi);
          const observed = await summarizeInventoryDirectory(rollback, { fsApi });
          if (!sameSummary(captured.inventory, observed)) throw new Error("rollback generated root changed");
        },
      });
      await invokeHook(faultHook, `after-active-to-rollback-rename:${entry.id}`);
      await fsyncTree({ capability: handoff.capability, root: rollback, entryId: entry.id, purpose: "rollback-entry", restoreId });
      await invokeHook(faultHook, `after-rollback-tree-sync:${entry.id}`);
      await assertPrivateParent(rollbackParent, fsApi);
      await syncDirectory(rollbackParent.path, fsApi);
      await invokeHook(faultHook, `after-rollback-destination-parent-sync:${entry.id}`);
      await assertAncestors(ancestors, fsApi);
      await syncDirectory(dirname(active), fsApi);
      await invokeHook(faultHook, `after-rollback-source-parent-sync:${entry.id}`);
    } else {
      await assertAncestors(ancestors, fsApi);
      await assertMissing(active, fsApi);
    }
    await guardedRestoreRename({
      capability: handoff.capability, pathRequest: { purpose: "payload", id: entry.id }, source: payload, destination: active, fsApi,
      before: async () => {
        await assertPrivateParent(payloadParent, fsApi);
        await assertAncestors(ancestors, fsApi);
        await assertPayload(handoff.capability, entry, payload, fsApi);
      },
      after: async () => assertRestoredEndpoint(entry, active, fsApi, ancestors),
    });
    await invokeHook(faultHook, `after-payload-to-active-rename:${entry.id}`);
    await fsyncVerifiedTree(active, { fsApi, ancestorChain: ancestors });
    await invokeHook(faultHook, `after-restored-payload-sync:${entry.id}`);
    await revalidateRunCapability(handoff.capability, { purpose: "payload", id: entry.id, boundary: "after-sync" });
    await assertRestoredEndpoint(entry, active, fsApi, ancestors);
    await assertAncestors(ancestors, fsApi);
    await syncDirectory(dirname(active), fsApi);
    await invokeHook(faultHook, `after-restore-destination-parent-sync:${entry.id}`);
    await assertPrivateParent(payloadParent, fsApi);
    await syncDirectory(payloadParent.path, fsApi);
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
