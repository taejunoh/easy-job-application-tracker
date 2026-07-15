import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, isAbsolute, join } from "node:path";

import {
  deriveRunPath,
  revalidateRunCapability,
} from "./quarantine-run-capability.mjs";

const DEFAULT_LIMITS = Object.freeze({
  sortChunkRecords: 4096,
  sortChunkBytes: 8 * 1024 * 1024,
  frontierRecords: 1024,
  frontierBytes: 8 * 1024 * 1024,
  mergeFanIn: 32,
});
const LIMIT_KEYS = Object.freeze(Object.keys(DEFAULT_LIMITS));
const DEFAULT_FS_API = Object.freeze({ ...fsPromises, createReadStream });

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotRecord(value, allowed, required, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      throw new TypeError(`${label} has an unknown field: ${String(key)}`);
    }
  }
  for (const key of required) {
    if (!keys.includes(key)) throw new TypeError(`${label} is missing field: ${key}`);
  }
  const snapshot = Object.create(null);
  for (const key of keys) snapshot[key] = value[key];
  return snapshot;
}

function normalizeFsApi(value, methods) {
  const adapter = value === undefined ? DEFAULT_FS_API : value;
  if (!isPlainObject(adapter)) throw new TypeError("filesystem adapter must be a plain object");
  const normalized = Object.create(null);
  for (const method of methods) {
    if (typeof adapter[method] !== "function") {
      throw new TypeError(`filesystem adapter must provide ${method}`);
    }
    normalized[method] = (...args) => Reflect.apply(adapter[method], adapter, args);
  }
  return Object.freeze(normalized);
}

function normalizeLimits(value) {
  if (value === undefined) return DEFAULT_LIMITS;
  const input = snapshotRecord(value, LIMIT_KEYS, [], "inventory limits");
  const limits = { ...DEFAULT_LIMITS };
  for (const key of LIMIT_KEYS) {
    if (!Object.hasOwn(input, key)) continue;
    if (!Number.isSafeInteger(input[key]) || input[key] <= 0) {
      throw new TypeError(`inventory limit ${key} must be a positive safe integer`);
    }
    limits[key] = input[key];
  }
  if (limits.mergeFanIn > 32 || limits.mergeFanIn < 2) {
    throw new TypeError("inventory merge fan-in must be between 2 and 32");
  }
  return Object.freeze(limits);
}

function normalizeMetrics(value, limits) {
  const metrics = value === undefined ? {} : value;
  if (!isPlainObject(metrics)) throw new TypeError("inventory metrics must be a plain object");
  Object.assign(metrics, {
    maxOpenDirectoryHandles: 0,
    maxTraversalAndHashHandles: 0,
    maxMergeReaders: 0,
    chunkFiles: 0,
    mergePasses: 0,
    frontierSpills: 0,
    sortChunkRecordLimit: limits.sortChunkRecords,
    sortChunkByteLimit: limits.sortChunkBytes,
    frontierRecordLimit: limits.frontierRecords,
    frontierByteLimit: limits.frontierBytes,
    maxWorkFileMode: 0,
    minWorkFileMode: 0o600,
  });
  return metrics;
}

function createHandleMetrics(metrics) {
  let directories = 0;
  let hashes = 0;
  const update = () => {
    metrics.maxOpenDirectoryHandles = Math.max(
      metrics.maxOpenDirectoryHandles,
      directories,
    );
    metrics.maxTraversalAndHashHandles = Math.max(
      metrics.maxTraversalAndHashHandles,
      directories + hashes,
    );
  };
  return Object.freeze({
    directoryOpened() {
      directories += 1;
      update();
      if (directories > 1) throw new Error("inventory opened more than one directory handle");
    },
    directoryClosed() {
      directories -= 1;
      update();
    },
    hashCount(count) {
      hashes = count;
      update();
    },
  });
}

function assertAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new TypeError(`${label} must be an absolute path`);
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

function assertPrivateRegularFile(stat, label) {
  assertRegularFile(stat, label);
  if ((stat.mode & 0o7777) !== 0o600) {
    throw new Error(`${label} must have exact private mode 0600`);
  }
}

function modeOf(stat) {
  return stat.mode & 0o7777;
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
  let value;
  let primaryError;
  try {
    value = await callback(handle);
  } catch (error) {
    primaryError = error;
  }
  await closeHandle(handle, primaryError, label);
  return value;
}

async function writeBuffers(handle, buffers) {
  let position = 0;
  for await (const value of buffers) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.write(bytes, offset, bytes.length - offset, position + offset);
      if (result.bytesWritten === 0) throw new Error("inventory write made no progress");
      offset += result.bytesWritten;
    }
    position += bytes.length;
  }
}

async function fsyncDirectory(path, fsApi) {
  const handle = await fsApi.open(path, "r");
  await withHandle(handle, (opened) => opened.sync(), "directory sync and close both failed");
}

function purposeRequest(purpose, id, boundary) {
  const request = { purpose, boundary };
  if (id !== undefined) request.id = id;
  return request;
}

async function openPrivateFile({
  capability,
  path,
  purpose,
  id,
  fsApi,
  metrics,
}) {
  await revalidateRunCapability(
    capability,
    purposeRequest(purpose, id, "before-mutation"),
  );
  const handle = await fsApi.open(path, "wx", 0o600);
  let identity;
  try {
    await handle.chmod(0o600);
    identity = await handle.stat();
    assertPrivateRegularFile(identity, `${purpose} file`);
    const pathIdentity = await fsApi.lstat(path);
    assertPrivateRegularFile(pathIdentity, `${purpose} file`);
    if (!sameIdentity(identity, pathIdentity)) {
      throw new Error(`${purpose} file ownership changed after open`);
    }
    if (purpose === "inventory-work") {
      const mode = modeOf(identity);
      metrics.maxWorkFileMode = Math.max(metrics.maxWorkFileMode, mode);
      metrics.minWorkFileMode = Math.min(metrics.minWorkFileMode, mode);
    }
    return { handle, identity };
  } catch (error) {
    await closeHandle(handle, error, `${purpose} setup and close both failed`);
  }
}

async function finishPrivateFile({
  capability,
  path,
  purpose,
  id,
  handle,
  identity,
  fsApi,
}) {
  let primaryError;
  try {
    await handle.sync();
  } catch (error) {
    primaryError = error;
  }
  await closeHandle(handle, primaryError, `${purpose} sync and close both failed`);
  await fsyncDirectory(dirname(path), fsApi);
  await revalidateRunCapability(
    capability,
    purposeRequest(purpose, id, "after-sync"),
  );
  const current = await fsApi.lstat(path);
  assertPrivateRegularFile(current, `${purpose} file`);
  if (!sameIdentity(identity, current)) {
    throw new Error(`${purpose} file ownership changed after sync`);
  }
}

async function createPrivateFile(context, writer, onOwned) {
  const opened = await openPrivateFile(context);
  onOwned?.(opened.identity);
  let primaryError;
  let value;
  try {
    value = await writer(opened.handle);
  } catch (error) {
    primaryError = error;
  }
  if (primaryError === undefined) {
    await finishPrivateFile({ ...context, ...opened });
  } else {
    await closeHandle(opened.handle, primaryError, `${context.purpose} write and close both failed`);
  }
  return { value, identity: opened.identity };
}

export async function hashFileStream(absolutePath, options = {}) {
  assertAbsolutePath(absolutePath, "hash path");
  const input = snapshotRecord(
    options,
    ["fsApi", "onHandleCount"],
    [],
    "hash file options",
  );
  if (input.onHandleCount !== undefined && typeof input.onHandleCount !== "function") {
    throw new TypeError("hash handle-count callback must be a function");
  }
  const fsApi = normalizeFsApi(input.fsApi, ["createReadStream"]);
  const hash = createHash("sha256");
  let bytes = 0;
  let openHandles = 1;
  input.onHandleCount?.(openHandles);
  const stream = fsApi.createReadStream(absolutePath, { highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      bytes += buffer.length;
    }
  } finally {
    openHandles -= 1;
    input.onHandleCount?.(openHandles);
  }
  return { sha256: hash.digest("hex"), bytes };
}

function assertExactRecordKeys(value, expectedKeys) {
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== expectedKeys.length ||
    actual.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw new TypeError("inventory record has an invalid schema");
  }
}

function parseRecordMode(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0o7777) {
    throw new TypeError("inventory record mode is invalid");
  }
  return value;
}

function parseRecordSize(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("inventory record size is invalid");
  }
  return value;
}

function parseRecordHash(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("inventory record hash is invalid");
  }
  return value;
}

function parseRelativeInventoryPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("//")
  ) {
    throw new TypeError("inventory record relative path is invalid");
  }
  const components = value.split("/");
  if (components.some((component) => component === "" || component === "." || component === "..")) {
    throw new TypeError("inventory record relative path is invalid");
  }
  return value;
}

export function parseInventoryRecord(value) {
  if (!isPlainObject(value)) throw new TypeError("inventory record must be an object");
  if (value.scope === "root") {
    assertExactRecordKeys(value, ["scope", "type", "mode", "size", "sha256"]);
    if (value.type !== "file") throw new TypeError("inventory record root must be a file");
    return Object.freeze({
      scope: "root",
      type: "file",
      mode: parseRecordMode(value.mode),
      size: parseRecordSize(value.size),
      sha256: parseRecordHash(value.sha256),
    });
  }
  if (value.scope !== "relative") {
    throw new TypeError("inventory record scope is invalid");
  }
  const path = parseRelativeInventoryPath(value.path);
  if (value.type === "file") {
    assertExactRecordKeys(value, ["scope", "path", "type", "mode", "size", "sha256"]);
    return Object.freeze({
      scope: "relative",
      path,
      type: "file",
      mode: parseRecordMode(value.mode),
      size: parseRecordSize(value.size),
      sha256: parseRecordHash(value.sha256),
    });
  }
  if (value.type === "directory") {
    assertExactRecordKeys(value, ["scope", "path", "type", "mode", "size"]);
    if (value.size !== 0) throw new TypeError("inventory record directory size is invalid");
    return Object.freeze({
      scope: "relative",
      path,
      type: "directory",
      mode: parseRecordMode(value.mode),
      size: 0,
    });
  }
  if (value.type === "symlink") {
    assertExactRecordKeys(value, ["scope", "path", "type", "mode", "size", "linkTarget"]);
    if (typeof value.linkTarget !== "string") {
      throw new TypeError("inventory record symlink target is invalid");
    }
    return Object.freeze({
      scope: "relative",
      path,
      type: "symlink",
      mode: parseRecordMode(value.mode),
      size: parseRecordSize(value.size),
      linkTarget: value.linkTarget,
    });
  }
  throw new TypeError("inventory record type is invalid");
}

export function parseInventorySummary(value) {
  const input = snapshotRecord(
    value,
    ["sha256", "entries", "bytes"],
    ["sha256", "entries", "bytes"],
    "inventory summary",
  );
  if (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(input.sha256)) {
    throw new TypeError("inventory summary hash is invalid");
  }
  if (!Number.isSafeInteger(input.entries) || input.entries < 0) {
    throw new TypeError("inventory summary entry count is invalid");
  }
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 0) {
    throw new TypeError("inventory summary byte count is invalid");
  }
  return Object.freeze({ sha256: input.sha256, entries: input.entries, bytes: input.bytes });
}

export async function compareInventorySummary(expected, observed) {
  const left = parseInventorySummary(expected);
  const right = parseInventorySummary(observed);
  if (
    left.sha256 !== right.sha256 ||
    left.entries !== right.entries ||
    left.bytes !== right.bytes
  ) {
    throw new Error("inventory summary mismatch");
  }
  return true;
}

function recordSortKey(record) {
  return record.scope === "root" ? Buffer.alloc(0) : Buffer.from(record.path);
}

function compareRecords(left, right) {
  return Buffer.compare(recordSortKey(left), recordSortKey(right));
}

async function inventoryRecord(item, fsApi, handleMetrics) {
  const { absolutePath, relativePath, stat, scope = "relative" } = item;
  if (stat.isDirectory()) {
    return {
      record: parseInventoryRecord({
        scope,
        path: relativePath,
        type: "directory",
        mode: modeOf(stat),
        size: 0,
      }),
      bytes: 0,
    };
  }
  if (stat.isFile()) {
    const hashed = await hashFileStream(absolutePath, {
      fsApi,
      onHandleCount: (count) => handleMetrics.hashCount(count),
    });
    if (hashed.bytes !== stat.size) {
      throw new Error(`file changed while being inventoried: ${relativePath ?? "<root>"}`);
    }
    return {
      record: parseInventoryRecord(
        scope === "root"
          ? {
              scope: "root",
              type: "file",
              mode: modeOf(stat),
              size: stat.size,
              sha256: hashed.sha256,
            }
          : {
              scope: "relative",
              path: relativePath,
              type: "file",
              mode: modeOf(stat),
              size: stat.size,
              sha256: hashed.sha256,
            },
      ),
      bytes: stat.size,
    };
  }
  if (stat.isSymbolicLink()) {
    if (scope === "root") throw new Error("inventory root must not be a symlink");
    const linkTarget = await fsApi.readlink(absolutePath);
    return {
      record: parseInventoryRecord({
        scope: "relative",
        path: relativePath,
        type: "symlink",
        mode: modeOf(stat),
        size: Buffer.byteLength(linkTarget),
        linkTarget,
      }),
      bytes: Buffer.byteLength(linkTarget),
    };
  }
  throw new Error(`unsupported inventory entry type: ${relativePath ?? "<root>"}`);
}

function workRequest(id, boundary) {
  return { purpose: "inventory-work", id, boundary };
}

function createWorkManager({ capability, fsApi, metrics }) {
  const files = [];

  async function create(lines) {
    const id = randomUUID();
    const path = deriveRunPath(capability, { purpose: "inventory-work", id });
    const context = { capability, path, purpose: "inventory-work", id, fsApi, metrics };
    let file;
    await createPrivateFile(
      context,
      (handle) => writeBuffers(handle, lines),
      (identity) => {
        file = { id, path, identity, removed: false };
        files.push(file);
      },
    );
    return file;
  }

  async function remove(file) {
    if (file.removed) return;
    await revalidateRunCapability(capability, workRequest(file.id, "before-mutation"));
    const current = await fsApi.lstat(file.path);
    assertPrivateRegularFile(current, "inventory work file");
    if (!sameIdentity(current, file.identity)) {
      throw new Error("inventory work file ownership changed; foreign replacement preserved");
    }
    await fsApi.unlink(file.path);
    file.removed = true;
    await fsyncDirectory(dirname(file.path), fsApi);
    await revalidateRunCapability(capability, workRequest(file.id, "after-sync"));
  }

  async function cleanup(primaryError) {
    const cleanupErrors = [];
    for (const file of files) {
      if (file.removed) continue;
      try {
        await remove(file);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    throwPrimaryAndCleanup(
      primaryError,
      cleanupErrors,
      "inventory operation and owned work cleanup both failed",
    );
  }

  return Object.freeze({ create, remove, cleanup });
}

async function readLines(file, fsApi) {
  const reader = createInterface({
    input: fsApi.createReadStream(file.path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  const lines = [];
  try {
    for await (const line of reader) lines.push(line);
  } finally {
    reader.close();
  }
  return lines;
}

async function* walkTree({ root, fsApi, limits, metrics, handles, work }) {
  const frontier = [];
  const spills = [];
  let frontierBytes = 0;
  let current = { absolutePath: root, relativePath: "" };

  const spillFrontier = async () => {
    if (frontier.length === 0) return;
    const lines = frontier.map((entry) => `${JSON.stringify(entry)}\n`);
    spills.push(await work.create(lines));
    metrics.frontierSpills += 1;
    frontier.length = 0;
    frontierBytes = 0;
  };

  while (current !== undefined) {
    const directory = await fsApi.opendir(current.absolutePath);
    handles.directoryOpened();
    try {
      for await (const entry of directory) {
        const relativePath = current.relativePath
          ? `${current.relativePath}/${entry.name}`
          : entry.name;
        const absolutePath = join(current.absolutePath, entry.name);
        const stat = await fsApi.lstat(absolutePath);
        yield { absolutePath, relativePath, stat };
        if (stat.isDirectory()) {
          const child = { absolutePath, relativePath };
          const childBytes = Buffer.byteLength(JSON.stringify(child)) + 1;
          if (
            frontier.length > 0 &&
            (frontier.length >= limits.frontierRecords ||
              frontierBytes + childBytes > limits.frontierBytes)
          ) {
            await spillFrontier();
          }
          frontier.push(child);
          frontierBytes += childBytes;
          if (
            frontier.length >= limits.frontierRecords ||
            frontierBytes >= limits.frontierBytes
          ) {
            await spillFrontier();
          }
        }
      }
    } finally {
      handles.directoryClosed();
    }

    current = frontier.pop();
    if (current !== undefined) {
      frontierBytes -= Buffer.byteLength(JSON.stringify(current)) + 1;
      continue;
    }
    if (spills.length > 0) {
      const spill = spills.pop();
      const lines = await readLines(spill, fsApi);
      await work.remove(spill);
      for (const line of lines) {
        const child = JSON.parse(line);
        frontier.push(child);
        frontierBytes += Buffer.byteLength(line) + 1;
      }
      current = frontier.pop();
      if (current !== undefined) {
        frontierBytes -= Buffer.byteLength(JSON.stringify(current)) + 1;
      }
    }
  }
}

async function writeSortedChunk(records, work) {
  records.sort(compareRecords);
  return work.create(records.map((record) => `${JSON.stringify(record)}\n`));
}

async function* mergeSortedFiles(files, fsApi, metrics) {
  const sources = files.map((file) => {
    const reader = createInterface({
      input: fsApi.createReadStream(file.path, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    return { reader, iterator: reader[Symbol.asyncIterator](), current: null };
  });
  metrics.maxMergeReaders = Math.max(metrics.maxMergeReaders, sources.length);
  if (sources.length > 32) throw new Error("inventory merge opened more than 32 readers");
  try {
    for (const source of sources) {
      const next = await source.iterator.next();
      if (!next.done) {
        source.current = { line: next.value, key: recordSortKey(JSON.parse(next.value)) };
      }
    }
    while (true) {
      let selected = -1;
      for (let index = 0; index < sources.length; index += 1) {
        const candidate = sources[index].current;
        if (
          candidate !== null &&
          (selected === -1 || Buffer.compare(candidate.key, sources[selected].current.key) < 0)
        ) {
          selected = index;
        }
      }
      if (selected === -1) return;
      const source = sources[selected];
      yield source.current.line;
      const next = await source.iterator.next();
      source.current = next.done
        ? null
        : { line: next.value, key: recordSortKey(JSON.parse(next.value)) };
    }
  } finally {
    for (const source of sources) source.reader.close();
  }
}

async function mergeToWork(files, context) {
  async function* framedLines() {
    for await (const line of mergeSortedFiles(files, context.fsApi, context.metrics)) {
      yield `${line}\n`;
    }
  }
  return context.work.create(framedLines());
}

async function reduceMergeFiles(files, context) {
  let current = files;
  while (current.length > context.limits.mergeFanIn) {
    const next = [];
    for (let offset = 0; offset < current.length; offset += context.limits.mergeFanIn) {
      const group = current.slice(offset, offset + context.limits.mergeFanIn);
      next.push(await mergeToWork(group, context));
    }
    for (const file of current) await context.work.remove(file);
    current = next;
    context.metrics.mergePasses += 1;
  }
  return current;
}

async function writeFinalInventory({
  capability,
  outputPath,
  entryId,
  phase,
  inputs,
  fsApi,
  metrics,
}) {
  await revalidateRunCapability(capability, {
    purpose: "inventory",
    id: entryId,
    phase,
    boundary: "before-mutation",
  });
  const handle = await fsApi.open(outputPath, "wx", 0o600);
  let identity;
  let primaryError;
  const digest = createHash("sha256");
  let entries = 0;
  try {
    await handle.chmod(0o600);
    identity = await handle.stat();
    assertPrivateRegularFile(identity, "inventory output");
    const current = await fsApi.lstat(outputPath);
    assertPrivateRegularFile(current, "inventory output");
    if (!sameIdentity(identity, current)) {
      throw new Error("inventory output ownership changed after open");
    }
    let position = 0;
    if (inputs.length > 0) {
      for await (const line of mergeSortedFiles(inputs, fsApi, metrics)) {
        const framed = Buffer.from(`${line}\n`);
        digest.update(framed);
        let offset = 0;
        while (offset < framed.length) {
          const result = await handle.write(
            framed,
            offset,
            framed.length - offset,
            position + offset,
          );
          if (result.bytesWritten === 0) throw new Error("inventory output write made no progress");
          offset += result.bytesWritten;
        }
        position += framed.length;
        entries += 1;
      }
      metrics.mergePasses += 1;
    }
    await handle.sync();
  } catch (error) {
    primaryError = error;
  }
  await closeHandle(handle, primaryError, "inventory output write and close both failed");
  await fsyncDirectory(dirname(outputPath), fsApi);
  await revalidateRunCapability(capability, {
    purpose: "inventory",
    id: entryId,
    phase,
    boundary: "after-sync",
  });
  const after = await fsApi.lstat(outputPath);
  assertPrivateRegularFile(after, "inventory output");
  if (!sameIdentity(identity, after)) {
    throw new Error("inventory output ownership changed after sync");
  }
  return { sha256: digest.digest("hex"), entries };
}

export async function writeInventoryJsonl(options) {
  const input = snapshotRecord(
    options,
    ["capability", "root", "entryId", "phase", "fsApi", "limits", "metrics"],
    ["capability", "root", "entryId", "phase"],
    "inventory write options",
  );
  const root = assertAbsolutePath(input.root, "inventory root");
  const limits = normalizeLimits(input.limits);
  const metrics = normalizeMetrics(input.metrics, limits);
  const fsApi = normalizeFsApi(input.fsApi, [
    "lstat",
    "opendir",
    "readlink",
    "open",
    "unlink",
    "createReadStream",
  ]);
  const outputPath = deriveRunPath(input.capability, {
    purpose: "inventory",
    id: input.entryId,
    phase: input.phase,
  });
  const rootStat = await fsApi.lstat(root);
  if (rootStat.isSymbolicLink() || (!rootStat.isDirectory() && !rootStat.isFile())) {
    throw new Error("inventory root must be a non-symlink regular file or directory");
  }
  const handles = createHandleMetrics(metrics);
  const work = createWorkManager({ capability: input.capability, fsApi, metrics });
  const chunks = [];
  let records = [];
  let recordBytes = 0;
  let entries = 0;
  let bytes = 0;
  let primaryError;
  let summary;

  const flush = async () => {
    if (records.length === 0) return;
    chunks.push(await writeSortedChunk(records, work));
    metrics.chunkFiles += 1;
    records = [];
    recordBytes = 0;
  };

  try {
    const items = rootStat.isFile()
      ? [{ absolutePath: root, relativePath: null, stat: rootStat, scope: "root" }]
      : walkTree({ root, fsApi, limits, metrics, handles, work });
    for await (const item of items) {
      const result = await inventoryRecord(item, fsApi, handles);
      const serializedBytes = Buffer.byteLength(JSON.stringify(result.record)) + 1;
      if (
        records.length > 0 &&
        (records.length >= limits.sortChunkRecords ||
          recordBytes + serializedBytes > limits.sortChunkBytes)
      ) {
        await flush();
      }
      records.push(result.record);
      recordBytes += serializedBytes;
      entries += 1;
      bytes += result.bytes;
      if (
        records.length >= limits.sortChunkRecords ||
        recordBytes >= limits.sortChunkBytes
      ) {
        await flush();
      }
    }
    await flush();
    const finalInputs = await reduceMergeFiles(chunks, { fsApi, limits, metrics, work });
    const written = await writeFinalInventory({
      capability: input.capability,
      outputPath,
      entryId: input.entryId,
      phase: input.phase,
      inputs: finalInputs,
      fsApi,
      metrics,
    });
    if (written.entries !== entries) throw new Error("inventory merge lost entries");
    summary = { sha256: written.sha256, entries, bytes };
  } catch (error) {
    primaryError = error;
  }
  await work.cleanup(primaryError);
  return parseInventorySummary(summary);
}

async function readWorkChildren(file, fsApi, work) {
  const children = (await readLines(file, fsApi)).map((line) => JSON.parse(line));
  await work.remove(file);
  return children;
}

export async function fsyncTree(options) {
  const input = snapshotRecord(
    options,
    ["capability", "root", "entryId", "purpose", "fsApi", "limits", "metrics"],
    ["capability", "root", "entryId", "purpose"],
    "fsync tree options",
  );
  const root = assertAbsolutePath(input.root, "fsync tree root");
  if (input.purpose !== "payload") {
    throw new TypeError("fsync tree purpose must be payload");
  }
  const expectedRoot = deriveRunPath(input.capability, {
    purpose: "payload",
    id: input.entryId,
  });
  if (root !== expectedRoot) {
    throw new Error(`fsync tree root does not match capability path: ${root} !== ${expectedRoot}`);
  }
  const limits = normalizeLimits(input.limits);
  const metrics = normalizeMetrics(input.metrics, limits);
  const fsApi = normalizeFsApi(input.fsApi, [
    "lstat",
    "opendir",
    "open",
    "unlink",
    "createReadStream",
  ]);
  const handles = createHandleMetrics(metrics);
  const work = createWorkManager({ capability: input.capability, fsApi, metrics });
  const stack = [{ kind: "visit", path: root, isRoot: true }];
  let primaryError;

  await revalidateRunCapability(input.capability, {
    purpose: "payload",
    id: input.entryId,
    boundary: "before-mutation",
  });
  try {
    while (stack.length > 0) {
      const action = stack.pop();
      if (action.kind === "load") {
        const children = await readWorkChildren(action.file, fsApi, work);
        for (let index = children.length - 1; index >= 0; index -= 1) {
          stack.push({ kind: "visit", path: children[index].path, isRoot: false });
        }
        continue;
      }
      if (action.kind === "sync") {
        const handle = await fsApi.open(action.path, "r");
        await withHandle(handle, (opened) => opened.sync(), "tree sync and close both failed");
        continue;
      }

      const stat = await fsApi.lstat(action.path);
      if (stat.isSymbolicLink()) {
        if (action.isRoot) throw new Error("fsync tree root must not be a symlink");
        continue;
      }
      if (stat.isFile()) {
        stack.push({ kind: "sync", path: action.path });
        continue;
      }
      if (!stat.isDirectory()) throw new Error(`unsupported fsync entry type: ${action.path}`);

      const children = [];
      const spills = [];
      let childBytes = 0;
      const spill = async () => {
        if (children.length === 0) return;
        spills.push(await work.create(children.map((child) => `${JSON.stringify(child)}\n`)));
        metrics.frontierSpills += 1;
        children.length = 0;
        childBytes = 0;
      };
      const directory = await fsApi.opendir(action.path);
      handles.directoryOpened();
      try {
        for await (const entry of directory) {
          const child = { path: join(action.path, entry.name) };
          const bytes = Buffer.byteLength(JSON.stringify(child)) + 1;
          if (
            children.length > 0 &&
            (children.length >= limits.frontierRecords ||
              childBytes + bytes > limits.frontierBytes)
          ) {
            await spill();
          }
          children.push(child);
          childBytes += bytes;
          if (
            children.length >= limits.frontierRecords ||
            childBytes >= limits.frontierBytes
          ) {
            await spill();
          }
        }
      } finally {
        handles.directoryClosed();
      }

      stack.push({ kind: "sync", path: action.path });
      for (const file of spills) stack.push({ kind: "load", file });
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: "visit", path: children[index].path, isRoot: false });
      }
    }
    await revalidateRunCapability(input.capability, {
      purpose: "payload",
      id: input.entryId,
      boundary: "after-sync",
    });
  } catch (error) {
    primaryError = error;
  }
  await work.cleanup(primaryError);
}
