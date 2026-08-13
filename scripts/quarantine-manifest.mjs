import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute } from "node:path";

import { parseInventorySummary } from "./quarantine-inventory.mjs";
import { parseManifestEntry } from "./quarantine-path-policy.mjs";
import {
  deriveRunPath,
  revalidateRunCapability,
} from "./quarantine-run-capability.mjs";
import { getRunFsContext } from "./quarantine-run-fs-context.mjs";

const RETENTION_DAYS = 4;
const MAX_GENERATION_BYTES = 4 * 1024 * 1024;
const TRANSACTION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const COMMIT_HASH = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MANIFEST_V1_KEYS = [
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
const MANIFEST_V2_KEYS = [
  ...MANIFEST_V1_KEYS,
  "branch",
  "repositoryIdentity",
  "validationAttempt",
  "regeneratedEvidence",
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
const TEMP_ENTRY_KEYS = ["id", "kind", "relativePath", "mode", "size", "sha256", "preMoveInventory"];
const ALL_ENTRY_KEYS = [...new Set([...SOURCE_ENTRY_KEYS, ...GENERATED_ENTRY_KEYS, ...TEMP_ENTRY_KEYS])];
const INVENTORY_KEYS = ["sha256", "entries", "bytes"];
const POINTER_KEYS = ["schemaVersion", "transactionId", "manifestSha256"];
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const VALIDATION_ATTEMPT = /^attempt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REGENERATED_IDS = Object.freeze(["generated-next", "generated-node-modules"]);
const REPOSITORY_IDENTITY_KEYS = ["dev", "ino"];
const REGENERATED_EVIDENCE_KEYS = ["pass1Path", "pass1Summary", "pass2Path", "pass2Summary"];

class ManifestIntegrityError extends Error {
  constructor(message = "durable manifest evidence is invalid") {
    super(message);
    Object.defineProperty(this, "code", { value: "ERR_MANIFEST_INTEGRITY", enumerable: false });
  }
}

function manifestIntegrityFailure(message) {
  return new ManifestIntegrityError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotRecord(value, allowedKeys, requiredKeys, label, preRead = Object.freeze({})) {
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
  for (const key of keys) snapshot[key] = Object.hasOwn(preRead, key) ? preRead[key] : value[key];
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

function snapshotRepositoryIdentity(value) {
  const identity = snapshotRecord(
    value,
    REPOSITORY_IDENTITY_KEYS,
    REPOSITORY_IDENTITY_KEYS,
    "repository identity",
  );
  return Object.freeze({
    dev: assertNonnegativeSafeInteger(identity.dev, "repository device"),
    ino: assertNonnegativeSafeInteger(identity.ino, "repository inode"),
  });
}

function assertValidationAttempt(value) {
  if (typeof value !== "string" || !VALIDATION_ATTEMPT.test(value)) {
    throw new TypeError("validation attempt ID is invalid");
  }
  return value;
}

function sameInventory(left, right) {
  return left.sha256 === right.sha256 && left.entries === right.entries && left.bytes === right.bytes;
}

function snapshotRegeneratedEvidence(value, attemptId) {
  const evidence = snapshotRecord(
    value,
    REGENERATED_IDS,
    REGENERATED_IDS,
    "regenerated evidence",
  );
  const parsed = Object.create(null);
  for (const id of REGENERATED_IDS) {
    const item = snapshotRecord(
      evidence[id],
      REGENERATED_EVIDENCE_KEYS,
      REGENERATED_EVIDENCE_KEYS,
      `regenerated evidence ${id}`,
    );
    const pass1Path = `inventories/validation-pass-1/${attemptId}-${id}.jsonl`;
    const pass2Path = `inventories/validation-pass-2/${attemptId}-${id}.jsonl`;
    if (item.pass1Path !== pass1Path || item.pass2Path !== pass2Path) {
      throw new TypeError(`regenerated evidence paths are invalid for ${id}`);
    }
    const pass1Summary = snapshotInventory(item.pass1Summary);
    const pass2Summary = snapshotInventory(item.pass2Summary);
    if (!sameInventory(pass1Summary, pass2Summary)) {
      throw new TypeError(`regenerated evidence passes differ for ${id}`);
    }
    parsed[id] = Object.freeze({ pass1Path, pass1Summary, pass2Path, pass2Summary });
  }
  return Object.freeze(parsed);
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
  if (snapshot.kind === "temp-residue") {
    const exact = snapshotRecord(snapshot, TEMP_ENTRY_KEYS, TEMP_ENTRY_KEYS, "temp-residue entry");
    const locator = parseManifestEntry({
      id: exact.id,
      kind: exact.kind,
      relativePath: exact.relativePath,
    });
    const mode = assertMode(exact.mode);
    const size = assertNonnegativeSafeInteger(exact.size, "temp-residue size");
    const sha256 = assertSha256(exact.sha256, "temp-residue SHA-256");
    const preMoveInventory = snapshotInventory(exact.preMoveInventory);
    if (
      mode !== 0o600 || size !== 0 || sha256 !== EMPTY_SHA256 ||
      preMoveInventory.entries !== 1 || preMoveInventory.bytes !== 0
    ) {
      throw new TypeError("temp-residue evidence must describe one empty mode-0600 file");
    }
    return Object.freeze({ ...locator, mode, size, sha256, preMoveInventory });
  }
  throw new TypeError("manifest entry kind is invalid");
}

function parseManifestEntries(value, schemaVersion) {
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
  const tempResidues = entries.filter((entry) => entry.kind === "temp-residue");
  if (schemaVersion === 1 && tempResidues.length !== 0) {
    throw new TypeError("v1 manifests cannot contain temp-residue entries");
  }
  for (let index = 0; index < tempResidues.length; index += 1) {
    if (tempResidues[index].id !== `temp-${String(index + 1).padStart(4, "0")}`) {
      throw new TypeError("temp-residue IDs must follow deterministic bytewise numbering");
    }
  }
  return Object.freeze(entries);
}

export function buildValidatedManifest(value) {
  if (!isPlainObject(value)) throw new TypeError("manifest must be a plain object");
  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw new TypeError("manifest schema version is invalid");
  }
  const manifestKeys = schemaVersion === 1 ? MANIFEST_V1_KEYS : MANIFEST_V2_KEYS;
  const manifest = snapshotRecord(value, manifestKeys, manifestKeys, "manifest", { schemaVersion });
  const transactionId = assertTransactionId(manifest.transactionId);
  if (manifest.state !== "PREPARED" && manifest.state !== "VALIDATED") {
    throw new TypeError("manifest state must be PREPARED or VALIDATED");
  }
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
  if (manifest.retentionDays !== RETENTION_DAYS) {
    throw new TypeError("manifest retentionDays is invalid");
  }
  if (manifest.deletionRequiresConfirmation !== true) {
    throw new TypeError("manifest deletion must require confirmation");
  }
  let validatedAt;
  let deleteAfter;
  if (manifest.state === "PREPARED") {
    if (
      manifest.validatedAt !== null ||
      manifest.deleteAfter !== null ||
      manifest.deletionStatus !== "retained"
    ) {
      throw new TypeError("PREPARED manifest validation metadata is invalid");
    }
    validatedAt = null;
    deleteAfter = null;
  } else {
    validatedAt = assertIsoDate(manifest.validatedAt, "validatedAt");
    deleteAfter = assertIsoDate(manifest.deleteAfter, "deleteAfter");
    const expectedDeleteAfter = new Date(
      Date.parse(validatedAt) + RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    if (deleteAfter !== expectedDeleteAfter) {
      throw new TypeError("VALIDATED manifest deleteAfter is invalid");
    }
    if (manifest.deletionStatus !== "retained" && manifest.deletionStatus !== "deleted") {
      throw new TypeError("VALIDATED manifest deletion status is invalid");
    }
  }
  let branch;
  let repositoryIdentity;
  let validationAttempt;
  let regeneratedEvidence;
  if (schemaVersion === 2) {
    if (
      typeof manifest.branch !== "string" || manifest.branch.length === 0 ||
      manifest.branch.length > 1024 || manifest.branch.includes("\0") ||
      manifest.branch !== manifest.branch.normalize("NFC")
    ) {
      throw new TypeError("manifest branch is invalid");
    }
    branch = manifest.branch;
    repositoryIdentity = snapshotRepositoryIdentity(manifest.repositoryIdentity);
    if (manifest.state === "PREPARED") {
      if (manifest.validationAttempt !== null || manifest.regeneratedEvidence !== null) {
        throw new TypeError("PREPARED v2 manifest validation evidence is invalid");
      }
      validationAttempt = null;
      regeneratedEvidence = null;
    } else {
      validationAttempt = assertValidationAttempt(manifest.validationAttempt);
      regeneratedEvidence = snapshotRegeneratedEvidence(
        manifest.regeneratedEvidence,
        validationAttempt,
      );
    }
  }
  return Object.freeze({
    schemaVersion,
    transactionId,
    state: manifest.state,
    repositoryRoot: manifest.repositoryRoot,
    head: manifest.head,
    createdAt,
    validatedAt,
    retentionDays: RETENTION_DAYS,
    deletionRequiresConfirmation: true,
    deleteAfter,
    deletionStatus: manifest.deletionStatus,
    entries: parseManifestEntries(manifest.entries, schemaVersion),
    ...(schemaVersion === 2 ? {
      branch,
      repositoryIdentity,
      validationAttempt,
      regeneratedEvidence,
    } : {}),
  });
}

function getBoundFsApi(input) {
  return Object.hasOwn(input, "fsApi")
    ? getRunFsContext(input.capability, input.fsApi)
    : getRunFsContext(input.capability);
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

function assertOwnedRegularFile(stat, label, invalidError = undefined) {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw invalidError?.(`${label} must be a non-symlink regular file`) ?? new Error(`${label} must be a non-symlink regular file`);
  }
}

function assertRegularFile(stat, label, invalidError = undefined) {
  assertOwnedRegularFile(stat, label, invalidError);
  if ((stat.mode & 0o7777) !== 0o600) {
    throw invalidError?.(`${label} must have private mode 0600`) ?? new Error(`${label} must have private mode 0600`);
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

async function fsyncFile(path, fsApi) {
  const handle = await fsApi.open(path, "r");
  return withHandle(handle, (opened) => opened.sync(), "file sync and close both failed");
}

async function readBoundedSnapshot(path, fsApi, maxBytes, label, invalidError = undefined) {
  const before = await fsApi.lstat(path);
  assertRegularFile(before, label, invalidError);
  if (before.size > maxBytes) throw invalidError?.(`${label} is too large`) ?? new Error(`${label} is too large`);
  const handle = await fsApi.open(path, "r");
  return withHandle(handle, async (opened) => {
    const first = await opened.stat();
    assertRegularFile(first, label, invalidError);
    if (
      !sameIdentity(before, first) ||
      first.size !== before.size ||
      first.mode !== before.mode
    ) {
      throw invalidError?.(`${label} identity, size, or mode changed while being opened`) ?? new Error(`${label} identity, size, or mode changed while being opened`);
    }
    if (first.size > maxBytes) throw invalidError?.(`${label} is too large`) ?? new Error(`${label} is too large`);
    const bytes = Buffer.alloc(first.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await opened.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw invalidError?.(`${label} ended before its recorded size`) ?? new Error(`${label} ended before its recorded size`);
      offset += bytesRead;
    }
    const after = await opened.stat();
    assertRegularFile(after, label, invalidError);
    if (
      !sameIdentity(first, after) ||
      after.size !== first.size ||
      after.mode !== first.mode
    ) {
      throw invalidError?.(`${label} identity, size, or mode changed while being read`) ?? new Error(`${label} identity, size, or mode changed while being read`);
    }
    const finalPath = await fsApi.lstat(path);
    assertRegularFile(finalPath, label, invalidError);
    if (
      !sameIdentity(before, finalPath) ||
      !sameIdentity(after, finalPath) ||
      finalPath.size !== first.size ||
      finalPath.mode !== first.mode
    ) {
      throw invalidError?.(`${label} pathname identity, size, or mode changed after being read`) ?? new Error(`${label} pathname identity, size, or mode changed after being read`);
    }
    return { bytes, identity: after };
  }, `${label} read and close both failed`);
}

async function readBoundedFile(path, fsApi, maxBytes, label, invalidError = undefined) {
  return (await readBoundedSnapshot(path, fsApi, maxBytes, label, invalidError)).bytes;
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
  assertOwnedRegularFile(current, "manifest temporary file");
  if (!sameIdentity(current, identity)) {
    throw new Error("manifest temporary file ownership changed");
  }
  await fsApi.unlink(path);
  await fsyncDirectory(parent, fsApi);
  await revalidateRunCapability(capability, {
    purpose,
    id,
    boundary: "after-sync",
  });
}

async function assertOwnedPrivateTemporary(path, identity, fsApi, label) {
  const current = await fsApi.lstat(path);
  assertRegularFile(current, label);
  if (!sameIdentity(current, identity)) {
    throw new Error(`${label} ownership changed`);
  }
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function digestBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function temporaryIdForDigest(digest) {
  return (
    `${digest.slice(0, 8)}-${digest.slice(8, 12)}-` +
    `4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
  );
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

function parseEnsureValidatedResult(value, expectedDigest) {
  const result = snapshotRecord(
    value,
    ["status", "manifestSha256"],
    ["status", "manifestSha256"],
    "ensure-validated result",
  );
  if (result.status !== "appended" && result.status !== "already-present") {
    throw new TypeError("ensure-validated result status is invalid");
  }
  const manifestSha256 = assertSha256(
    result.manifestSha256,
    "ensure-validated manifest SHA-256",
  );
  if (manifestSha256 !== expectedDigest) {
    throw new Error("ensure-validated result conflicts with the requested manifest digest");
  }
  return Object.freeze({ status: result.status, manifestSha256 });
}

async function readManifestGenerationSnapshot({
  capability,
  manifestSha256,
  fsApi,
  maxBytes,
}) {
  const path = deriveRunPath(capability, {
    purpose: "manifest-generation",
    id: manifestSha256,
  });
  let snapshot;
  try {
    snapshot = await readBoundedSnapshot(
      path,
      fsApi,
      maxBytes,
      "manifest generation",
      manifestIntegrityFailure,
    );
  } catch (error) {
    if (error?.code === "ENOENT") throw manifestIntegrityFailure("manifest generation is missing");
    throw error;
  }
  let manifest;
  try {
    if (digestBytes(snapshot.bytes) !== manifestSha256) {
      throw manifestIntegrityFailure("manifest generation content digest does not match its filename");
    }
    manifest = buildValidatedManifest(parseJson(snapshot.bytes, "manifest generation"));
    if (!snapshot.bytes.equals(canonicalBytes(manifest))) {
      throw manifestIntegrityFailure("manifest generation JSON is not canonical");
    }
    assertGenerationTransaction(path, manifest.transactionId);
  } catch (error) {
    if (error?.code === "ERR_MANIFEST_INTEGRITY") throw error;
    throw manifestIntegrityFailure(error instanceof Error ? error.message : undefined);
  }
  return {
    manifest,
    path,
    bytes: snapshot.bytes,
    identity: snapshot.identity,
  };
}

export async function writeManifestGeneration(options) {
  const input = snapshotRecord(
    options,
    ["capability", "manifest", "fsApi", "faultHook"],
    ["capability", "manifest"],
    "manifest generation write options",
  );
  const fsApi = getBoundFsApi(input);
  const faultHook = normalizeFaultHook(input.faultHook);
  const manifest = buildValidatedManifest(input.manifest);
  const bytes = canonicalBytes(manifest);
  if (bytes.length > MAX_GENERATION_BYTES) throw new Error("manifest generation is too large");
  const manifestSha256 = digestBytes(bytes);
  const temporaryId = temporaryIdForDigest(manifestSha256);
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
  let generationIdentity;
  let publicationAccepted = false;
  let primaryError;
  try {
    await revalidateRunCapability(input.capability, {
      purpose: "manifest-temporary",
      id: temporaryId,
      boundary: "before-mutation",
    });
    let handle;
    try {
      handle = await fsApi.open(temporaryPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stale = await readBoundedSnapshot(
        temporaryPath,
        fsApi,
        bytes.length,
        "stale manifest temporary file",
      );
      if (!stale.bytes.equals(bytes)) {
        throw new Error("stale manifest temporary file conflicts with expected canonical bytes");
      }
      temporaryIdentity = stale.identity;
      await assertOwnedPrivateTemporary(
        temporaryPath,
        temporaryIdentity,
        fsApi,
        "stale manifest temporary file",
      );
      await fsyncFile(temporaryPath, fsApi);
    }
    if (handle !== undefined) {
      await withHandle(handle, async (opened) => {
        temporaryIdentity = await opened.stat();
        assertOwnedRegularFile(temporaryIdentity, "manifest temporary file");
        const pathIdentity = await fsApi.lstat(temporaryPath);
        assertOwnedRegularFile(pathIdentity, "manifest temporary file");
        if (!sameIdentity(temporaryIdentity, pathIdentity)) {
          throw new Error("manifest temporary file ownership changed after open");
        }
        await opened.chmod(0o600);
        const privateIdentity = await opened.stat();
        assertRegularFile(privateIdentity, "manifest temporary file");
        if (!sameIdentity(temporaryIdentity, privateIdentity)) {
          throw new Error("manifest temporary file ownership changed during chmod");
        }
        await writeComplete(opened, bytes);
        await opened.sync();
      }, "manifest temporary write and close both failed");
    }
    await invokeFaultHook(faultHook, "after-generation-temporary-sync");
    await revalidateRunCapability(input.capability, {
      purpose: "manifest-temporary",
      id: temporaryId,
      boundary: "after-sync",
    });
    await assertOwnedPrivateTemporary(
      temporaryPath,
      temporaryIdentity,
      fsApi,
      "manifest temporary file",
    );
    await revalidateRunCapability(input.capability, {
      purpose: "manifest-generation",
      id: manifestSha256,
      boundary: "before-mutation",
    });
    try {
      await fsApi.link(temporaryPath, generationPath);
      generationIdentity = temporaryIdentity;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readBoundedSnapshot(
        generationPath,
        fsApi,
        MAX_GENERATION_BYTES,
        "existing manifest generation",
      );
      if (digestBytes(existing.bytes) !== manifestSha256 || !existing.bytes.equals(bytes)) {
        throw new Error("existing manifest generation conflicts with its digest name", {
          cause: error,
        });
      }
      generationIdentity = existing.identity;
    }
    publicationAccepted = true;
    await invokeFaultHook(faultHook, "after-generation-publish");
    await fsyncDirectory(dirname(generationPath), fsApi);
    await invokeFaultHook(faultHook, "after-generation-directory-sync");
    await revalidateRunCapability(input.capability, {
      purpose: "manifest-generation",
      id: manifestSha256,
      boundary: "after-sync",
    });
    const durable = await readBoundedSnapshot(
      generationPath,
      fsApi,
      bytes.length,
      "durable manifest generation",
    );
    if (!sameIdentity(generationIdentity, durable.identity)) {
      throw new Error("manifest generation identity changed after directory sync");
    }
    if (!durable.bytes.equals(bytes) || digestBytes(durable.bytes) !== manifestSha256) {
      throw new Error("manifest generation bytes changed after directory sync");
    }
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  if (
    temporaryIdentity !== undefined &&
    (primaryError === undefined || !publicationAccepted)
  ) {
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
  const fsApi = getBoundFsApi(input);
  const faultHook = normalizeFaultHook(input.faultHook);
  const generationSnapshot = await readManifestGenerationSnapshot({
    capability: input.capability,
    manifestSha256,
    fsApi,
    maxBytes: MAX_GENERATION_BYTES,
  });
  const generation = generationSnapshot.manifest;
  if (generation.transactionId !== transactionId) {
    throw new Error("manifest generation transaction ID mismatch");
  }
  if (generation.state !== "VALIDATED") {
    throw new Error("only a VALIDATED manifest generation can be activated");
  }
  const generationPath = generationSnapshot.path;
  await fsyncDirectory(dirname(generationPath), fsApi);
  await revalidateRunCapability(input.capability, {
    purpose: "manifest-generation",
    id: manifestSha256,
    boundary: "after-sync",
  });
  const durableGeneration = await readManifestGenerationSnapshot({
    capability: input.capability,
    manifestSha256,
    fsApi,
    maxBytes: MAX_GENERATION_BYTES,
  });
  if (!sameIdentity(generationSnapshot.identity, durableGeneration.identity)) {
    throw new Error("manifest generation identity changed across directory sync");
  }
  if (!generationSnapshot.bytes.equals(durableGeneration.bytes)) {
    throw new Error("manifest generation bytes changed across directory sync");
  }
  const ensureResult = await input.appendValidated(Object.freeze({ manifestSha256 }));
  parseEnsureValidatedResult(ensureResult, manifestSha256);
  await invokeFaultHook(faultHook, "after-ensure-validated");

  const pointer = Object.freeze({ schemaVersion: 1, transactionId, manifestSha256 });
  const pointerBytes = canonicalBytes(pointer);
  const temporaryId = temporaryIdForDigest(manifestSha256);
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
    let handle;
    try {
      handle = await fsApi.open(temporaryPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stale = await readBoundedSnapshot(
        temporaryPath,
        fsApi,
        pointerBytes.length,
        "stale current pointer temporary file",
      );
      if (!stale.bytes.equals(pointerBytes)) {
        throw new Error("stale current pointer temporary conflicts with expected canonical bytes");
      }
      temporaryIdentity = stale.identity;
      await assertOwnedPrivateTemporary(
        temporaryPath,
        temporaryIdentity,
        fsApi,
        "stale current pointer temporary file",
      );
      await fsyncFile(temporaryPath, fsApi);
    }
    if (handle !== undefined) {
      await withHandle(handle, async (opened) => {
        temporaryIdentity = await opened.stat();
        assertOwnedRegularFile(temporaryIdentity, "current pointer temporary file");
        const pathIdentity = await fsApi.lstat(temporaryPath);
        assertOwnedRegularFile(pathIdentity, "current pointer temporary file");
        if (!sameIdentity(temporaryIdentity, pathIdentity)) {
          throw new Error("current pointer temporary file ownership changed after open");
        }
        await opened.chmod(0o600);
        const privateIdentity = await opened.stat();
        assertRegularFile(privateIdentity, "current pointer temporary file");
        if (!sameIdentity(temporaryIdentity, privateIdentity)) {
          throw new Error("current pointer temporary file ownership changed during chmod");
        }
        await writeComplete(opened, pointerBytes);
        await opened.sync();
      }, "current pointer temporary write and close both failed");
    }
    await invokeFaultHook(faultHook, "after-pointer-temporary-sync");
    await revalidateRunCapability(input.capability, {
      purpose: "current-temporary",
      id: temporaryId,
      boundary: "after-sync",
    });
    await assertOwnedPrivateTemporary(
      temporaryPath,
      temporaryIdentity,
      fsApi,
      "current pointer temporary file",
    );
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
    const durableCurrent = await readBoundedSnapshot(
      currentPath,
      fsApi,
      pointerBytes.length,
      "durable current pointer",
    );
    if (!sameIdentity(temporaryIdentity, durableCurrent.identity)) {
      throw new Error("current pointer identity changed after root directory sync");
    }
    if (!durableCurrent.bytes.equals(pointerBytes)) {
      throw new Error("current pointer bytes changed after root directory sync");
    }
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
  const fsApi = getBoundFsApi(input);
  const maxBytes = Math.min(
    assertMaxBytes(
      input.maxBytes === undefined ? 4096 : input.maxBytes,
      "current pointer maximum bytes",
    ),
    4096,
  );
  const path = deriveRunPath(input.capability, { purpose: "current-pointer" });
  const bytes = await readBoundedFile(path, fsApi, maxBytes, "current pointer", manifestIntegrityFailure);
  try {
    const pointer = parsePointer(parseJson(bytes, "current pointer"));
    if (!bytes.equals(canonicalBytes(pointer))) throw manifestIntegrityFailure("current pointer JSON is not canonical");
    const generationPath = deriveRunPath(input.capability, {
      purpose: "manifest-generation",
      id: pointer.manifestSha256,
    });
    assertGenerationTransaction(generationPath, pointer.transactionId);
    return pointer;
  } catch (error) {
    if (error?.code === "ERR_MANIFEST_INTEGRITY") throw error;
    throw manifestIntegrityFailure(error instanceof Error ? error.message : undefined);
  }
}

export async function readManifestGeneration(options) {
  const input = snapshotRecord(
    options,
    ["capability", "manifestSha256", "fsApi", "maxBytes"],
    ["capability", "manifestSha256"],
    "manifest generation read options",
  );
  const manifestSha256 = assertSha256(input.manifestSha256, "manifest generation SHA-256");
  const fsApi = getBoundFsApi(input);
  const maxBytes = Math.min(
    assertMaxBytes(
      input.maxBytes === undefined ? MAX_GENERATION_BYTES : input.maxBytes,
      "manifest generation maximum bytes",
    ),
    MAX_GENERATION_BYTES,
  );
  return (await readManifestGenerationSnapshot({
    capability: input.capability,
    manifestSha256,
    fsApi,
    maxBytes,
  })).manifest;
}
