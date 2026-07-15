import { createHash, randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";

import { parseInventorySummary } from "./quarantine-inventory.mjs";
import { parseManifestEntry } from "./quarantine-path-policy.mjs";
import {
  deriveRunPath,
  revalidateRunCapability,
} from "./quarantine-run-capability.mjs";

const RETENTION_DAYS = 4;
const MAX_GENERATION_BYTES = 4 * 1024 * 1024;
const TRANSACTION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const COMMIT_HASH = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MANIFEST_KEYS = [
  "schemaVersion",
  "transactionId",
  "state",
  "repositoryRoot",
  "head",
  "createdAt",
  "validatedAt",
  "retentionDays",
  "deletionRequiresConfirmation",
  "deleteAfter",
  "deletionStatus",
  "entries",
];
const SOURCE_ENTRY_KEYS = [
  "id",
  "kind",
  "relativePath",
  "canonicalRelativePath",
  "mode",
  "size",
  "sha256",
  "canonicalSize",
  "canonicalSha256",
  "classification",
  "historyMatch",
  "preMoveInventory",
];
const GENERATED_ENTRY_KEYS = ["id", "kind", "relativePath", "mode", "preMoveInventory"];
const ALL_ENTRY_KEYS = [...new Set([...SOURCE_ENTRY_KEYS, ...GENERATED_ENTRY_KEYS])];
const INVENTORY_KEYS = ["sha256", "entries", "bytes"];
const POINTER_KEYS = ["schemaVersion", "transactionId", "manifestSha256"];
const FS_METHODS = ["lstat", "open", "link", "unlink", "rename"];

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotRecord(value, allowedKeys, requiredKeys, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== "string" || !allowedKeys.includes(key)) {
      throw new TypeError(`${label} has an unknown field: ${String(key)}`);
    }
  }
  for (const key of requiredKeys) {
    if (!keys.includes(key)) throw new TypeError(`${label} is missing field: ${key}`);
  }
  const snapshot = Object.create(null);
  for (const key of keys) snapshot[key] = value[key];
  return snapshot;
}

function snapshotArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const length = value.length;
  const keys = Reflect.ownKeys(value);
  const expected = new Set(["length"]);
  for (let index = 0; index < length; index += 1) expected.add(String(index));
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new TypeError(`${label} must be a dense array without custom fields`);
  }
  const snapshot = [];
  for (let index = 0; index < length; index += 1) snapshot.push(value[index]);
  return snapshot;
}

function assertTransactionId(value) {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFC") ||
    value === "." ||
    value === ".." ||
    !TRANSACTION_ID.test(value)
  ) {
    throw new TypeError("transaction ID is invalid");
  }
  return value;
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function assertIsoDate(value, label) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function assertMode(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0o7777) {
    throw new TypeError("manifest entry mode is invalid");
  }
  return value;
}

function assertNonnegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} is invalid`);
  return value;
}

function snapshotInventory(value) {
  const snapshot = snapshotRecord(
    value,
    INVENTORY_KEYS,
    INVENTORY_KEYS,
    "inventory summary",
  );
  return parseInventorySummary({
    sha256: snapshot.sha256,
    entries: snapshot.entries,
    bytes: snapshot.bytes,
  });
}

function parseEnrichedManifestEntry(value) {
  const snapshot = snapshotRecord(
    value,
    ALL_ENTRY_KEYS,
    ["kind"],
    "manifest entry",
  );
  if (snapshot.kind === "source-copy") {
    const exact = snapshotRecord(snapshot, SOURCE_ENTRY_KEYS, SOURCE_ENTRY_KEYS, "source-copy entry");
    const locator = parseManifestEntry({
      id: exact.id,
      kind: exact.kind,
      relativePath: exact.relativePath,
      canonicalRelativePath: exact.canonicalRelativePath,
    });
    const mode = assertMode(exact.mode);
    const size = assertNonnegativeSafeInteger(exact.size, "source-copy size");
    const sha256 = assertSha256(exact.sha256, "source-copy SHA-256");
    const canonicalSize = assertNonnegativeSafeInteger(exact.canonicalSize, "canonical size");
    const canonicalSha256 = assertSha256(exact.canonicalSha256, "canonical SHA-256");
    if (exact.classification !== "identical" && exact.classification !== "divergent") {
      throw new TypeError("source-copy classification is invalid");
    }
    if (
      exact.historyMatch !== null &&
      (typeof exact.historyMatch !== "string" || !GIT_OBJECT_ID.test(exact.historyMatch))
    ) {
      throw new TypeError("source-copy history match is invalid");
    }
    const preMoveInventory = snapshotInventory(exact.preMoveInventory);
    if (preMoveInventory.entries !== 1 || preMoveInventory.bytes !== size) {
      throw new TypeError("source-copy inventory must describe its one source file");
    }
    if (
      exact.classification === "identical" &&
      (size !== canonicalSize || sha256 !== canonicalSha256)
    ) {
      throw new TypeError("identical source-copy metadata does not match canonical metadata");
    }
    if (exact.classification === "divergent" && sha256 === canonicalSha256) {
      throw new TypeError("divergent source-copy hashes must differ");
    }
    return Object.freeze({
      ...locator,
      mode,
      size,
      sha256,
      canonicalSize,
      canonicalSha256,
      classification: exact.classification,
      historyMatch: exact.historyMatch,
      preMoveInventory,
    });
  }

  if (snapshot.kind === "generated-root") {
    const exact = snapshotRecord(
      snapshot,
      GENERATED_ENTRY_KEYS,
      GENERATED_ENTRY_KEYS,
      "generated-root entry",
    );
    const locator = parseManifestEntry({
      id: exact.id,
      kind: exact.kind,
      relativePath: exact.relativePath,
    });
    const expectedId = locator.relativePath === ".next"
      ? "generated-next"
      : "generated-node-modules";
    if (locator.id !== expectedId) {
      throw new TypeError("generated manifest entry ID/path pair is invalid");
    }
    return Object.freeze({
      ...locator,
      mode: assertMode(exact.mode),
      preMoveInventory: snapshotInventory(exact.preMoveInventory),
    });
  }
  throw new TypeError("manifest entry kind is invalid");
}

function parseManifestEntries(value) {
  const entries = snapshotArray(value, "manifest entries").map(parseEnrichedManifestEntry);
  const ids = new Set();
  const paths = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (ids.has(entry.id)) throw new TypeError("duplicate manifest entry ID");
    if (paths.has(entry.relativePath)) throw new TypeError("duplicate manifest entry path");
    ids.add(entry.id);
    paths.add(entry.relativePath);
    if (
      index > 0 &&
      Buffer.compare(Buffer.from(entries[index - 1].relativePath), Buffer.from(entry.relativePath)) >= 0
    ) {
      throw new TypeError("manifest entries must use bytewise relative-path order");
    }
  }
  const generated = entries.filter((entry) => entry.kind === "generated-root");
  if (
    generated.length !== 2 ||
    !ids.has("generated-next") ||
    !ids.has("generated-node-modules")
  ) {
    throw new TypeError("manifest must contain both fixed generated roots exactly once");
  }
  const sources = entries.filter((entry) => entry.kind === "source-copy");
  for (let index = 0; index < sources.length; index += 1) {
    if (sources[index].id !== `copy-${String(index + 1).padStart(4, "0")}`) {
      throw new TypeError("source-copy IDs must follow deterministic bytewise numbering");
    }
  }
  return Object.freeze(entries);
}

export function buildValidatedManifest(value) {
  const manifest = snapshotRecord(value, MANIFEST_KEYS, MANIFEST_KEYS, "manifest");
  if (manifest.schemaVersion !== 1) throw new TypeError("manifest schema version is invalid");
  const transactionId = assertTransactionId(manifest.transactionId);
  if (manifest.state !== "VALIDATED") throw new TypeError("manifest state must be VALIDATED");
  if (
    typeof manifest.repositoryRoot !== "string" ||
    !isAbsolute(manifest.repositoryRoot) ||
    manifest.repositoryRoot.includes("\0") ||
    manifest.repositoryRoot !== manifest.repositoryRoot.normalize("NFC")
  ) {
    throw new TypeError("manifest repository root is invalid");
  }
  if (typeof manifest.head !== "string" || !COMMIT_HASH.test(manifest.head)) {
    throw new TypeError("manifest HEAD is invalid");
  }
  const createdAt = assertIsoDate(manifest.createdAt, "createdAt");
  const validatedAt = assertIsoDate(manifest.validatedAt, "validatedAt");
  if (manifest.retentionDays !== RETENTION_DAYS) {
    throw new TypeError("validated manifest retentionDays is invalid");
  }
  if (manifest.deletionRequiresConfirmation !== true) {
    throw new TypeError("manifest deletion must require confirmation");
  }
  const deleteAfter = assertIsoDate(manifest.deleteAfter, "deleteAfter");
  const expectedDeleteAfter = new Date(
    Date.parse(validatedAt) + RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  if (deleteAfter !== expectedDeleteAfter) {
    throw new TypeError("validated manifest deleteAfter is invalid");
  }
  if (manifest.deletionStatus !== "retained" && manifest.deletionStatus !== "deleted") {
    throw new TypeError("manifest deletion status is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    transactionId,
    state: "VALIDATED",
    repositoryRoot: manifest.repositoryRoot,
    head: manifest.head,
    createdAt,
    validatedAt,
    retentionDays: RETENTION_DAYS,
    deletionRequiresConfirmation: true,
    deleteAfter,
    deletionStatus: manifest.deletionStatus,
    entries: parseManifestEntries(manifest.entries),
  });
}

function normalizeFsApi(value) {
  const adapter = value === undefined ? fsPromises : value;
  if (!isPlainObject(adapter)) throw new TypeError("filesystem adapter must be a plain object");
  const normalized = Object.create(null);
  for (const method of FS_METHODS) {
    const implementation = adapter[method];
    if (typeof implementation !== "function") {
      throw new TypeError(`filesystem adapter must provide ${method}`);
    }
    normalized[method] = (...args) => Reflect.apply(implementation, adapter, args);
  }
  return Object.freeze(normalized);
}

function normalizeFaultHook(value) {
  if (value !== undefined && typeof value !== "function") {
    throw new TypeError("manifest fault hook must be a function");
  }
  return value;
}

async function invokeFaultHook(faultHook, phase) {
  if (faultHook !== undefined) await faultHook(phase);
}

function assertMaxBytes(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertRegularFile(stat, label) {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a non-symlink regular file`);
  }
}

function throwPrimaryAndCleanup(primaryError, cleanupErrors, label) {
  if (primaryError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], label);
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, label);
}

async function closeHandle(handle, primaryError, label) {
  const cleanupErrors = [];
  try {
    await handle.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  throwPrimaryAndCleanup(primaryError, cleanupErrors, label);
}

async function withHandle(handle, callback, label) {
  let result;
  let primaryError;
  try {
    result = await callback(handle);
  } catch (error) {
    primaryError = error;
  }
  await closeHandle(handle, primaryError, label);
  return result;
}

async function writeComplete(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten === 0) throw new Error("manifest write made no progress");
    offset += bytesWritten;
  }
}

async function fsyncDirectory(path, fsApi) {
  const handle = await fsApi.open(path, "r");
  return withHandle(handle, (opened) => opened.sync(), "directory sync and close both failed");
}

async function readBoundedFile(path, fsApi, maxBytes, label) {
  const before = await fsApi.lstat(path);
  assertRegularFile(before, label);
  if (before.size > maxBytes) throw new Error(`${label} is too large`);
  const handle = await fsApi.open(path, "r");
  return withHandle(handle, async (opened) => {
    const first = await opened.stat();
    assertRegularFile(first, label);
    if (!sameIdentity(before, first) || first.size !== before.size) {
      throw new Error(`${label} identity or size changed while being opened`);
    }
    if (first.size > maxBytes) throw new Error(`${label} is too large`);
    const bytes = Buffer.alloc(first.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await opened.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error(`${label} ended before its recorded size`);
      offset += bytesRead;
    }
    const after = await opened.stat();
    assertRegularFile(after, label);
    if (!sameIdentity(first, after) || after.size !== first.size) {
      throw new Error(`${label} changed while being read`);
    }
    return bytes;
  }, `${label} read and close both failed`);
}

async function removeOwnedTemporary({
  capability,
  path,
  purpose,
  id,
  identity,
  parent,
  fsApi,
}) {
  await revalidateRunCapability(capability, {
    purpose,
    id,
    boundary: "before-mutation",
  });
  const current = await fsApi.lstat(path);
  assertRegularFile(current, "manifest temporary file");
  if (!sameIdentity(current, identity)) throw new Error("manifest temporary file ownership changed");
  await fsApi.unlink(path);
  await fsyncDirectory(parent, fsApi);
  await revalidateRunCapability(capability, {
    purpose,
    id,
    boundary: "after-sync",
  });
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function digestBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertGenerationTransaction(generationPath, transactionId) {
  if (basename(dirname(dirname(generationPath))) !== transactionId) {
    throw new Error("manifest transaction ID does not match the live run capability");
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} JSON is malformed`, { cause: error });
  }
}

function parsePointer(value) {
  const pointer = snapshotRecord(value, POINTER_KEYS, POINTER_KEYS, "current pointer");
  if (pointer.schemaVersion !== 1) throw new TypeError("current pointer schema version is invalid");
  return Object.freeze({
    schemaVersion: 1,
    transactionId: assertTransactionId(pointer.transactionId),
    manifestSha256: assertSha256(pointer.manifestSha256, "current pointer manifest SHA-256"),
  });
}

export async function writeManifestGeneration(options) {
  const input = snapshotRecord(
    options,
    ["capability", "manifest", "fsApi", "faultHook"],
    ["capability", "manifest"],
    "manifest generation write options",
  );
  const fsApi = normalizeFsApi(input.fsApi);
  const faultHook = normalizeFaultHook(input.faultHook);
  const manifest = buildValidatedManifest(input.manifest);
  const bytes = canonicalBytes(manifest);
  if (bytes.length > MAX_GENERATION_BYTES) throw new Error("manifest generation is too large");
  const manifestSha256 = digestBytes(bytes);
  const temporaryId = randomUUID();
  const temporaryPath = deriveRunPath(input.capability, {
    purpose: "manifest-temporary",
    id: temporaryId,
  });
  const generationPath = deriveRunPath(input.capability, {
    purpose: "manifest-generation",
    id: manifestSha256,
  });
  assertGenerationTransaction(generationPath, manifest.transactionId);
  let temporaryIdentity;
  let primaryError;
  try {
    await revalidateRunCapability(input.capability, {
      purpose: "manifest-temporary",
      id: temporaryId,
      boundary: "before-mutation",
    });
    const handle = await fsApi.open(temporaryPath, "wx", 0o600);
    await withHandle(handle, async (opened) => {
      temporaryIdentity = await opened.stat();
      assertRegularFile(temporaryIdentity, "manifest temporary file");
      await opened.chmod(0o600);
      await writeComplete(opened, bytes);
      await opened.sync();
    }, "manifest temporary write and close both failed");
    await invokeFaultHook(faultHook, "after-generation-temporary-sync");
    await revalidateRunCapability(input.capability, {
      purpose: "manifest-temporary",
      id: temporaryId,
      boundary: "after-sync",
    });
    await revalidateRunCapability(input.capability, {
      purpose: "manifest-generation",
      id: manifestSha256,
      boundary: "before-mutation",
    });
    try {
      await fsApi.link(temporaryPath, generationPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readBoundedFile(
        generationPath,
        fsApi,
        MAX_GENERATION_BYTES,
        "existing manifest generation",
      );
      if (digestBytes(existing) !== manifestSha256 || !existing.equals(bytes)) {
        throw new Error("existing manifest generation conflicts with its digest name", {
          cause: error,
        });
      }
    }
    await invokeFaultHook(faultHook, "after-generation-publish");
    await fsyncDirectory(dirname(generationPath), fsApi);
    await invokeFaultHook(faultHook, "after-generation-directory-sync");
    await revalidateRunCapability(input.capability, {
      purpose: "manifest-generation",
      id: manifestSha256,
      boundary: "after-sync",
    });
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  if (temporaryIdentity !== undefined) {
    try {
      await removeOwnedTemporary({
        capability: input.capability,
        path: temporaryPath,
        purpose: "manifest-temporary",
        id: temporaryId,
        identity: temporaryIdentity,
        parent: dirname(temporaryPath),
        fsApi,
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  throwPrimaryAndCleanup(
    primaryError,
    cleanupErrors,
    "manifest publication and temporary cleanup both failed",
  );
  return Object.freeze({ manifestSha256 });
}

export async function activateManifestGeneration(options) {
  const input = snapshotRecord(
    options,
    ["capability", "transactionId", "manifestSha256", "appendValidated", "fsApi", "faultHook"],
    ["capability", "transactionId", "manifestSha256", "appendValidated"],
    "manifest activation options",
  );
  const transactionId = assertTransactionId(input.transactionId);
  const manifestSha256 = assertSha256(input.manifestSha256, "manifest generation SHA-256");
  if (typeof input.appendValidated !== "function") {
    throw new TypeError("appendValidated must be a function");
  }
  const fsApi = normalizeFsApi(input.fsApi);
  const faultHook = normalizeFaultHook(input.faultHook);
  const generation = await readManifestGeneration({
    capability: input.capability,
    manifestSha256,
    fsApi,
  });
  if (generation.transactionId !== transactionId) {
    throw new Error("manifest generation transaction ID mismatch");
  }
  const generationPath = deriveRunPath(input.capability, {
    purpose: "manifest-generation",
    id: manifestSha256,
  });
  await fsyncDirectory(dirname(generationPath), fsApi);
  await revalidateRunCapability(input.capability, {
    purpose: "manifest-generation",
    id: manifestSha256,
    boundary: "after-sync",
  });
  await input.appendValidated(Object.freeze({ manifestSha256 }));

  const pointer = Object.freeze({ schemaVersion: 1, transactionId, manifestSha256 });
  const pointerBytes = canonicalBytes(pointer);
  const temporaryId = randomUUID();
  const temporaryPath = deriveRunPath(input.capability, {
    purpose: "current-temporary",
    id: temporaryId,
  });
  const currentPath = deriveRunPath(input.capability, { purpose: "current-pointer" });
  let temporaryIdentity;
  let renamed = false;
  let primaryError;
  try {
    await revalidateRunCapability(input.capability, {
      purpose: "current-temporary",
      id: temporaryId,
      boundary: "before-mutation",
    });
    const handle = await fsApi.open(temporaryPath, "wx", 0o600);
    await withHandle(handle, async (opened) => {
      temporaryIdentity = await opened.stat();
      assertRegularFile(temporaryIdentity, "current pointer temporary file");
      await opened.chmod(0o600);
      await writeComplete(opened, pointerBytes);
      await opened.sync();
    }, "current pointer temporary write and close both failed");
    await invokeFaultHook(faultHook, "after-pointer-temporary-sync");
    await revalidateRunCapability(input.capability, {
      purpose: "current-temporary",
      id: temporaryId,
      boundary: "after-sync",
    });
    await revalidateRunCapability(input.capability, {
      purpose: "current-pointer",
      boundary: "before-mutation",
    });
    await fsApi.rename(temporaryPath, currentPath);
    renamed = true;
    await invokeFaultHook(faultHook, "after-pointer-rename");
    await fsyncDirectory(dirname(currentPath), fsApi);
    await invokeFaultHook(faultHook, "after-quarantine-root-sync");
    await revalidateRunCapability(input.capability, {
      purpose: "current-pointer",
      boundary: "after-sync",
    });
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  if (!renamed && temporaryIdentity !== undefined) {
    try {
      await removeOwnedTemporary({
        capability: input.capability,
        path: temporaryPath,
        purpose: "current-temporary",
        id: temporaryId,
        identity: temporaryIdentity,
        parent: dirname(temporaryPath),
        fsApi,
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  throwPrimaryAndCleanup(
    primaryError,
    cleanupErrors,
    "manifest activation and temporary cleanup both failed",
  );
  return pointer;
}

export async function readCurrentManifestPointer(options) {
  const input = snapshotRecord(
    options,
    ["capability", "fsApi", "maxBytes"],
    ["capability"],
    "current pointer read options",
  );
  const fsApi = normalizeFsApi(input.fsApi);
  const maxBytes = assertMaxBytes(
    input.maxBytes === undefined ? 4096 : input.maxBytes,
    "current pointer maximum bytes",
  );
  const path = deriveRunPath(input.capability, { purpose: "current-pointer" });
  const bytes = await readBoundedFile(path, fsApi, maxBytes, "current pointer");
  const pointer = parsePointer(parseJson(bytes, "current pointer"));
  if (!bytes.equals(canonicalBytes(pointer))) throw new Error("current pointer JSON is not canonical");
  const generationPath = deriveRunPath(input.capability, {
    purpose: "manifest-generation",
    id: pointer.manifestSha256,
  });
  assertGenerationTransaction(generationPath, pointer.transactionId);
  return pointer;
}

export async function readManifestGeneration(options) {
  const input = snapshotRecord(
    options,
    ["capability", "manifestSha256", "fsApi", "maxBytes"],
    ["capability", "manifestSha256"],
    "manifest generation read options",
  );
  const manifestSha256 = assertSha256(input.manifestSha256, "manifest generation SHA-256");
  const fsApi = normalizeFsApi(input.fsApi);
  const maxBytes = assertMaxBytes(
    input.maxBytes === undefined ? MAX_GENERATION_BYTES : input.maxBytes,
    "manifest generation maximum bytes",
  );
  const path = deriveRunPath(input.capability, {
    purpose: "manifest-generation",
    id: manifestSha256,
  });
  const bytes = await readBoundedFile(path, fsApi, maxBytes, "manifest generation");
  if (digestBytes(bytes) !== manifestSha256) {
    throw new Error("manifest generation content digest does not match its filename");
  }
  const manifest = buildValidatedManifest(parseJson(bytes, "manifest generation"));
  if (!bytes.equals(canonicalBytes(manifest))) {
    throw new Error("manifest generation JSON is not canonical");
  }
  assertGenerationTransaction(path, manifest.transactionId);
  return manifest;
}
