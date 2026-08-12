import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

import { parseInventoryRecord, parseInventorySummary } from "./quarantine-inventory.mjs";

const LIMITS = Object.freeze({
  records: 4096,
  recordBytes: 8 * 1024 * 1024,
  frontier: 4096,
  frontierBytes: 8 * 1024 * 1024,
  depth: 1024,
  nameBytes: 255,
});
const FILE_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const DIRECTORY_OPEN_FLAGS = FILE_OPEN_FLAGS | fsConstants.O_DIRECTORY;

function assertAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  return value;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function modeOf(stat) { return stat.mode & 0o7777; }

function assertIdentity(expected, observed, type, label) {
  if (
    observed.isSymbolicLink() || !observed[type]() ||
    !sameIdentity(expected, observed) || modeOf(expected) !== modeOf(observed)
  ) throw new Error(`${label} identity changed while being read`);
}

async function closeAll(dir, handle, primary) {
  const errors = [];
  if (dir !== undefined) {
    try { await dir.close(); } catch (error) {
      if (error?.code !== "ERR_DIR_CLOSED") errors.push(error);
    }
  }
  if (handle !== undefined) {
    try { await handle.close(); } catch (error) { errors.push(error); }
  }
  if (primary !== undefined && errors.length > 0) {
    throw new AggregateError([primary, ...errors], "verified reader and close both failed");
  }
  if (primary !== undefined) throw primary;
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "verified reader close failed");
}

async function assertPathMatchesHandle(path, expected, type, fsApi) {
  const observed = await fsApi.lstat(path);
  if (observed.isSymbolicLink() || !observed[type]()) {
    throw new Error("restore endpoint pathname is unsafe");
  }
  if (!sameIdentity(expected, observed) || modeOf(expected) !== modeOf(observed)) {
    throw new Error("restore endpoint pathname identity changed");
  }
  return fsApi.realpath(path);
}

async function withVerifiedDirectory(path, expected, fsApi, callback) {
  let handle;
  let dir;
  let value;
  let primary;
  try {
    handle = await fsApi.open(path, DIRECTORY_OPEN_FLAGS);
    const opened = await handle.stat();
    assertIdentity(expected, opened, "isDirectory", "restore directory handle");
    // opendir(path) is allowed only to acquire a held stream. Before its first
    // read, bind that pathname back to the already-open no-follow handle.
    dir = await fsApi.opendir(path);
    const canonicalPath = await assertPathMatchesHandle(path, opened, "isDirectory", fsApi);
    value = await callback(dir);
    const finalHandle = await handle.stat();
    assertIdentity(opened, finalHandle, "isDirectory", "restore directory handle");
    if (canonicalPath !== await assertPathMatchesHandle(path, opened, "isDirectory", fsApi)) {
      throw new Error("restore directory pathname changed while being read");
    }
  } catch (error) {
    primary = error;
  }
  await closeAll(dir, handle, primary);
  return value;
}

export async function hashVerifiedRegularFile(path, expected, fsApi) {
  assertAbsolutePath(path, "verified file path");
  let handle;
  let value;
  let primary;
  try {
    handle = await fsApi.open(path, FILE_OPEN_FLAGS);
    const opened = await handle.stat();
    assertIdentity(expected, opened, "isFile", "restore file handle");
    const hash = createHash("sha256");
    let bytes = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      bytes += read.bytesRead;
    }
    if (bytes !== opened.size) throw new Error("restore file changed while being read");
    const finalHandle = await handle.stat();
    assertIdentity(opened, finalHandle, "isFile", "restore file handle");
    await assertPathMatchesHandle(path, opened, "isFile", fsApi);
    value = { sha256: hash.digest("hex"), bytes };
  } catch (error) {
    primary = error;
  }
  await closeAll(undefined, handle, primary);
  return value;
}

async function readVerifiedLink(path, expected, fsApi) {
  const linkTarget = await fsApi.readlink(path);
  const final = await fsApi.lstat(path);
  if (!final.isSymbolicLink() || !sameIdentity(expected, final) || modeOf(expected) !== modeOf(final)) {
    throw new Error("restore symlink changed while being read");
  }
  return linkTarget;
}

export async function summarizeInventoryDirectory(root, { fsApi }) {
  assertAbsolutePath(root, "read-only inventory root");
  const rootStat = await fsApi.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("restore tree endpoint is unsafe");
  }
  const records = [];
  const pending = [{ absolutePath: root, relativePath: "", depth: 0, root: true }];
  let pendingBytes = Buffer.byteLength(JSON.stringify(pending[0])) + 1;
  let recordBytes = 0;
  let bytes = 0;
  const addRecord = (record, contentBytes) => {
    const serialized = Buffer.byteLength(JSON.stringify(record)) + 1;
    if (records.length >= LIMITS.records || recordBytes + serialized > LIMITS.recordBytes) {
      throw new Error("read-only restore inventory exceeded fixed record bounds");
    }
    records.push(record);
    recordBytes += serialized;
    bytes += contentBytes;
  };
  const enqueue = (item) => {
    const serialized = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (pending.length >= LIMITS.frontier || pendingBytes + serialized > LIMITS.frontierBytes) {
      throw new Error("read-only restore inventory exceeded fixed traversal bounds");
    }
    pending.push(item);
    pendingBytes += serialized;
  };
  while (pending.length > 0) {
    const item = pending.pop();
    pendingBytes -= Buffer.byteLength(JSON.stringify(item)) + 1;
    const stat = await fsApi.lstat(item.absolutePath);
    if (stat.isSymbolicLink()) {
      if (item.root) throw new Error("restore tree endpoint is unsafe");
      const linkTarget = await readVerifiedLink(item.absolutePath, stat, fsApi);
      addRecord(parseInventoryRecord({
        scope: "relative", path: item.relativePath, type: "symlink", mode: modeOf(stat),
        size: Buffer.byteLength(linkTarget), linkTarget,
      }), Buffer.byteLength(linkTarget));
      continue;
    }
    if (stat.isFile()) {
      if (item.root) throw new Error("restore tree endpoint is unsafe");
      const hashed = await hashVerifiedRegularFile(item.absolutePath, stat, fsApi);
      addRecord(parseInventoryRecord({
        scope: "relative", path: item.relativePath, type: "file", mode: modeOf(stat),
        size: stat.size, sha256: hashed.sha256,
      }), stat.size);
      continue;
    }
    if (!stat.isDirectory()) throw new Error("restore tree contains an unsupported endpoint");
    if (!item.root) addRecord(parseInventoryRecord({
      scope: "relative", path: item.relativePath, type: "directory", mode: modeOf(stat), size: 0,
    }), 0);
    await withVerifiedDirectory(item.absolutePath, stat, fsApi, async (dir) => {
      while (true) {
        const entry = await dir.read();
        if (entry === null) break;
        const name = entry.name;
        if (typeof name !== "string" || Buffer.byteLength(name) > LIMITS.nameBytes) {
          throw new Error("read-only restore inventory entry name exceeds fixed bounds");
        }
        if (item.depth + 1 > LIMITS.depth) {
          throw new Error("read-only restore inventory path depth exceeds fixed bounds");
        }
        const relativePath = item.relativePath ? `${item.relativePath}/${name}` : name;
        enqueue({ absolutePath: join(item.absolutePath, name), relativePath, depth: item.depth + 1, root: false });
      }
    });
  }
  records.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const digest = createHash("sha256");
  for (const record of records) digest.update(Buffer.from(`${JSON.stringify(record)}\n`));
  return parseInventorySummary({ sha256: digest.digest("hex"), entries: records.length, bytes });
}
