import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { parseManifestEntry } from "./quarantine-path-policy.mjs";

const RETENTION_DAYS = 4;
const TRANSACTION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const COMMIT_HASH = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
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
const STATES = new Set([
  "PREPARED",
  "MOVING",
  "VERIFYING",
  "QUARANTINED",
  "VALIDATED",
  "RECOVERY_REQUIRED",
  "ROLLING_BACK",
  "ROLLED_BACK",
  "INCOMPLETE_CONFLICT",
  "RESTORE_PREPARED",
  "RESTORING",
  "RESTORED",
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function assertIsoDate(value, label, nullable = false) {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function normalizeManifest(value) {
  if (!isPlainObject(value)) throw new TypeError("manifest must be a plain object");
  for (const key of Object.keys(value)) {
    if (!MANIFEST_KEYS.includes(key)) throw new TypeError(`unknown field: ${key}`);
  }
  for (const key of MANIFEST_KEYS) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`missing field: ${key}`);
  }
  if (value.schemaVersion !== 1) throw new TypeError("manifest schema version is invalid");
  const transactionId = assertTransactionId(value.transactionId);
  if (!STATES.has(value.state)) throw new TypeError("manifest state is invalid");
  if (
    typeof value.repositoryRoot !== "string" ||
    !isAbsolute(value.repositoryRoot) ||
    value.repositoryRoot.includes("\0") ||
    value.repositoryRoot !== value.repositoryRoot.normalize("NFC")
  ) {
    throw new TypeError("manifest repository root is invalid");
  }
  if (typeof value.head !== "string" || !COMMIT_HASH.test(value.head)) {
    throw new TypeError("manifest HEAD is invalid");
  }
  const createdAt = assertIsoDate(value.createdAt, "createdAt");
  const validatedAt = assertIsoDate(value.validatedAt, "validatedAt", true);
  if (
    value.retentionDays !== null &&
    (!Number.isSafeInteger(value.retentionDays) || value.retentionDays < 0)
  ) {
    throw new TypeError("manifest retentionDays is invalid");
  }
  if (value.deletionRequiresConfirmation !== true) {
    throw new TypeError("manifest deletion must require confirmation");
  }
  const deleteAfter = assertIsoDate(value.deleteAfter, "deleteAfter", true);
  if (!new Set(["retained", "deleted"]).has(value.deletionStatus)) {
    throw new TypeError("manifest deletion status is invalid");
  }
  if (!Array.isArray(value.entries)) throw new TypeError("manifest entries must be an array");
  const entries = value.entries.map((entry) => parseManifestEntry(entry));

  if (value.state === "VALIDATED") {
    if (validatedAt === null || value.retentionDays !== RETENTION_DAYS || deleteAfter === null) {
      throw new TypeError("validated manifest retention metadata is invalid");
    }
    const expectedDeleteAfter = new Date(
      Date.parse(validatedAt) + RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    if (deleteAfter !== expectedDeleteAfter) {
      throw new TypeError("validated manifest deleteAfter is invalid");
    }
  } else if (validatedAt !== null || value.retentionDays !== null || deleteAfter !== null) {
    throw new TypeError("unvalidated manifest has validation metadata");
  }

  return {
    schemaVersion: 1,
    transactionId,
    state: value.state,
    repositoryRoot: value.repositoryRoot,
    head: value.head,
    createdAt,
    validatedAt,
    retentionDays: value.retentionDays,
    deletionRequiresConfirmation: true,
    deleteAfter,
    deletionStatus: value.deletionStatus,
    entries,
  };
}

async function fsyncDirectory(path, fsApi) {
  const handle = await fsApi.open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomic(targetPath, contents, fsApi) {
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  let renamed = false;
  try {
    const handle = await fsApi.open(temporaryPath, "wx", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsApi.rename(temporaryPath, targetPath);
    renamed = true;
    await fsyncDirectory(dirname(targetPath), fsApi);
  } finally {
    if (!renamed) await fsApi.rm(temporaryPath, { force: true });
  }
}

async function assertSafeFile(path, fsApi, label) {
  const stat = await fsApi.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
}

async function assertSafeDirectory(path, fsApi, label) {
  const stat = await fsApi.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
}

async function readCurrentTransactionId(quarantineRoot, fsApi) {
  const currentPath = join(quarantineRoot, "current");
  await assertSafeFile(currentPath, fsApi, "current pointer");
  const contents = (await fsApi.readFile(currentPath, "utf8")).toString();
  if (!contents.endsWith("\n") || contents.indexOf("\n") !== contents.length - 1) {
    throw new TypeError("current pointer transaction ID is invalid");
  }
  return assertTransactionId(contents.slice(0, -1));
}

export async function readManifest({ quarantineRoot, transactionId, fsApi = fsPromises }) {
  if (typeof quarantineRoot !== "string" || !isAbsolute(quarantineRoot)) {
    throw new TypeError("quarantine root must be absolute");
  }
  await assertSafeDirectory(quarantineRoot, fsApi, "quarantine root");
  const id = transactionId === undefined
    ? await readCurrentTransactionId(quarantineRoot, fsApi)
    : assertTransactionId(transactionId);
  const runRoot = join(quarantineRoot, id);
  await assertSafeDirectory(runRoot, fsApi, "quarantine run root");
  const manifestPath = join(runRoot, "manifest.json");
  const checksumPath = join(runRoot, "manifest.sha256");
  await assertSafeFile(manifestPath, fsApi, "manifest");
  await assertSafeFile(checksumPath, fsApi, "manifest checksum");
  const [manifestContents, checksumContents] = await Promise.all([
    fsApi.readFile(manifestPath),
    fsApi.readFile(checksumPath, "utf8"),
  ]);
  const expectedChecksum = checksumContents.toString();
  if (!/^[a-f0-9]{64}\n$/u.test(expectedChecksum)) {
    throw new Error("manifest checksum file is invalid");
  }
  const observedChecksum = createHash("sha256").update(manifestContents).digest("hex");
  if (!timingSafeEqual(Buffer.from(expectedChecksum.slice(0, -1)), Buffer.from(observedChecksum))) {
    throw new Error("manifest checksum mismatch");
  }
  let parsed;
  try {
    parsed = JSON.parse(manifestContents.toString("utf8"));
  } catch (error) {
    throw new Error("manifest JSON is malformed", { cause: error });
  }
  const manifest = normalizeManifest(parsed);
  if (manifest.transactionId !== id) throw new Error("manifest transaction ID mismatch");
  if (!manifestContents.equals(Buffer.from(`${JSON.stringify(manifest)}\n`))) {
    throw new Error("manifest JSON is not canonical");
  }
  return manifest;
}

export async function publishManifest({ quarantineRoot, manifest, fsApi = fsPromises }) {
  if (typeof quarantineRoot !== "string" || !isAbsolute(quarantineRoot)) {
    throw new TypeError("quarantine root must be absolute");
  }
  const normalized = normalizeManifest(manifest);
  await fsApi.mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
  await fsApi.chmod(quarantineRoot, 0o700);
  const runRoot = join(quarantineRoot, normalized.transactionId);
  await fsApi.mkdir(runRoot, { recursive: true, mode: 0o700 });
  await fsApi.chmod(runRoot, 0o700);

  const manifestContents = Buffer.from(`${JSON.stringify(normalized)}\n`);
  const checksum = createHash("sha256").update(manifestContents).digest("hex");
  await writeAtomic(join(runRoot, "manifest.json"), manifestContents, fsApi);
  await writeAtomic(join(runRoot, "manifest.sha256"), `${checksum}\n`, fsApi);
  await writeAtomic(join(quarantineRoot, "current"), `${normalized.transactionId}\n`, fsApi);
  return normalized;
}

export async function markQuarantineValidated({ quarantineRoot, now = new Date(), fsApi = fsPromises }) {
  const manifest = await readManifest({ quarantineRoot, fsApi });
  if (manifest.state !== "QUARANTINED") {
    throw new Error("only a QUARANTINED manifest can be marked validated");
  }
  const validatedAt = new Date(now).toISOString();
  const marked = {
    ...manifest,
    state: "VALIDATED",
    validatedAt,
    retentionDays: RETENTION_DAYS,
    deletionRequiresConfirmation: true,
    deleteAfter: new Date(
      Date.parse(validatedAt) + RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString(),
  };
  return publishManifest({ quarantineRoot, manifest: marked, fsApi });
}
