import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, isAbsolute, join } from "node:path";

import {
  deriveRunPath,
  revalidateRunCapability,
} from "./quarantine-run-capability.mjs";
import { getRunFsContext } from "./quarantine-run-fs-context.mjs";

const MAX_WORK_REFERENCES = 4096;
const DEFAULT_LIMITS = Object.freeze({
  sortChunkRecords: 4096,
  sortChunkBytes: 8 * 1024 * 1024,
  frontierRecords: 1024,
  frontierBytes: 8 * 1024 * 1024,
  mergeFanIn: 32,
  coordinatorReferences: MAX_WORK_REFERENCES,
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
    limits[key] = Math.min(DEFAULT_LIMITS[key], input[key]);
  }
  if (limits.mergeFanIn < 2) {
    throw new TypeError("inventory merge fan-in must be at least 2");
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
    postorderSpills: 0,
    maxPostorderFrames: 0,
    maxPostorderBytes: 0,
    sortChunkRecordLimit: limits.sortChunkRecords,
    sortChunkByteLimit: limits.sortChunkBytes,
    frontierRecordLimit: limits.frontierRecords,
    frontierByteLimit: limits.frontierBytes,
    mergeFanInLimit: limits.mergeFanIn,
    coordinatorReferenceLimit: limits.coordinatorReferences,
    maxWorkFileMode: 0,
    minWorkFileMode: 0o600,
    maxCoordinatorReferences: 0,
  });
  return metrics;
}

function observeCoordinatorReferences(metrics, count, label) {
  if (count > metrics.coordinatorReferenceLimit) {
    throw new Error(
      `${label} exceeded the fixed ${metrics.coordinatorReferenceLimit} reference ceiling`,
    );
  }
  metrics.maxCoordinatorReferences = Math.max(metrics.maxCoordinatorReferences, count);
}

function pushCoordinatorReference(values, value, metrics, label) {
  if (values.length >= metrics.coordinatorReferenceLimit) {
    throw new Error(
      `${label} reached the fixed ${metrics.coordinatorReferenceLimit} reference ceiling`,
    );
  }
  values.push(value);
  observeCoordinatorReferences(metrics, values.length, label);
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
}, onOwned) {
  await revalidateRunCapability(
    capability,
    purposeRequest(purpose, id, "before-mutation"),
  );
  const handle = await fsApi.open(path, "wx", 0o600);
  let identity;
  try {
    const identityErrors = [];
    for (let attempt = 0; attempt < 3 && identity === undefined; attempt += 1) {
      try {
        identity = await handle.stat();
      } catch (error) {
        identityErrors.push(error);
      }
    }
    if (identity === undefined) {
      throw new AggregateError(
        identityErrors,
        `${purpose} file identity could not be established; evidence preserved`,
      );
    }
    assertRegularFile(identity, `${purpose} file`);
    onOwned?.(identity);
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
  const opened = await openPrivateFile(context, onOwned);
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

async function hashFileStreamCore(absolutePath, fsApi, onHandleCount) {
  const hash = createHash("sha256");
  let bytes = 0;
  let openHandles = 1;
  onHandleCount?.(openHandles);
  const stream = fsApi.createReadStream(absolutePath, { highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      bytes += buffer.length;
    }
  } finally {
    openHandles -= 1;
    onHandleCount?.(openHandles);
  }
  return { sha256: hash.digest("hex"), bytes };
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
  return hashFileStreamCore(absolutePath, fsApi, input.onHandleCount);
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
    const hashed = await hashFileStreamCore(
      absolutePath,
      fsApi,
      (count) => handleMetrics.hashCount(count),
    );
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
  const files = new Map();

  async function create(lines) {
    if (files.size >= metrics.coordinatorReferenceLimit - 1) {
      throw new Error(
        `inventory work files reached the fixed ${metrics.coordinatorReferenceLimit} reference ceiling reserve`,
      );
    }
    const id = randomUUID();
    const path = deriveRunPath(capability, { purpose: "inventory-work", id });
    const context = { capability, path, purpose: "inventory-work", id, fsApi, metrics };
    let file;
    await createPrivateFile(
      context,
      (handle) => writeBuffers(handle, lines),
      (identity) => {
        file = { id, path, identity, removed: false };
        files.set(path, file);
        observeCoordinatorReferences(metrics, files.size, "inventory work files");
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
    files.delete(file.path);
    await fsyncDirectory(dirname(file.path), fsApi);
    await revalidateRunCapability(capability, workRequest(file.id, "after-sync"));
  }

  async function cleanup(primaryError) {
    const cleanupErrors = [];
    for (const file of files.values()) {
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

  return Object.freeze({
    create,
    remove,
    cleanup,
    activeCount: () => files.size,
  });
}

async function readLines(file, fsApi) {
  const stream = fsApi.createReadStream(file.path, { encoding: "utf8" });
  const reader = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  const lines = [];
  let primaryError;
  try {
    for await (const line of reader) lines.push(line);
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupErrors = await closeLineSource({ reader, stream });
    throwPrimaryAndCleanup(
      primaryError,
      cleanupErrors,
      "inventory line read and stream teardown both failed",
    );
  }
  return lines;
}

async function destroyReadStream(stream) {
  if (stream.closed) return;
  await new Promise((resolve, reject) => {
    const onClose = () => {
      stream.off("error", onError);
      resolve();
    };
    const onError = (error) => {
      stream.off("close", onClose);
      reject(error);
    };
    stream.once("close", onClose);
    stream.once("error", onError);
    stream.destroy();
  });
}

async function closeLineSource(source) {
  const errors = [];
  try {
    source.reader.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await destroyReadStream(source.stream);
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

async function* walkTree({ root, fsApi, limits, metrics, handles, work }) {
  const frontier = [];
  const spills = [];
  let frontierBytes = 0;
  let current = { absolutePath: root, relativePath: "" };

  const spillFrontier = async () => {
    if (frontier.length === 0) return;
    const lines = frontier.map((entry) => `${JSON.stringify(entry)}\n`);
    pushCoordinatorReference(
      spills,
      await work.create(lines),
      metrics,
      "inventory frontier spills",
    );
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

async function* mergeSortedFiles(files, fsApi, metrics, compareValues = compareRecords) {
  const sources = files.map((file) => {
    const stream = fsApi.createReadStream(file.path, { encoding: "utf8" });
    const reader = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });
    return { stream, reader, iterator: reader[Symbol.asyncIterator](), current: null };
  });
  metrics.maxMergeReaders = Math.max(metrics.maxMergeReaders, sources.length);
  if (sources.length > 32) throw new Error("inventory merge opened more than 32 readers");
  let primaryError;
  try {
    for (const source of sources) {
      const next = await source.iterator.next();
      if (!next.done) {
        source.current = { line: next.value, value: JSON.parse(next.value) };
      }
    }
    while (true) {
      let selected = -1;
      for (let index = 0; index < sources.length; index += 1) {
        const candidate = sources[index].current;
        if (
          candidate !== null &&
          (selected === -1 || compareValues(candidate.value, sources[selected].current.value) < 0)
        ) {
          selected = index;
        }
      }
      if (selected === -1) break;
      const source = sources[selected];
      yield source.current.line;
      const next = await source.iterator.next();
      source.current = next.done
        ? null
        : { line: next.value, value: JSON.parse(next.value) };
    }
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupErrors = [];
    for (const source of sources) {
      cleanupErrors.push(...(await closeLineSource(source)));
    }
    throwPrimaryAndCleanup(
      primaryError,
      cleanupErrors,
      "inventory merge and stream teardown both failed",
    );
  }
}

async function mergeToWork(files, context, compareValues) {
  async function* framedLines() {
    for await (const line of mergeSortedFiles(
      files,
      context.fsApi,
      context.metrics,
      compareValues,
    )) {
      yield `${line}\n`;
    }
  }
  return context.work.create(framedLines());
}

async function reduceMergeFiles(files, context, compareValues = compareRecords) {
  let current = files;
  while (current.length > context.limits.mergeFanIn) {
    const next = [];
    for (let offset = 0; offset < current.length; offset += context.limits.mergeFanIn) {
      const group = current.slice(offset, offset + context.limits.mergeFanIn);
      pushCoordinatorReference(
        next,
        await mergeToWork(group, context, compareValues),
        context.metrics,
        "inventory merge outputs",
      );
    }
    for (const file of current) await context.work.remove(file);
    current = next;
    context.metrics.mergePasses += 1;
  }
  return current;
}

async function removeOwnedInventoryOutput({
  capability,
  path,
  id,
  identity,
  fsApi,
}) {
  await revalidateRunCapability(capability, {
    purpose: "inventory-work",
    id,
    boundary: "before-mutation",
  });
  let current;
  try {
    current = await fsApi.lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  assertRegularFile(current, "inventory publication temporary");
  if (identity === undefined || !sameIdentity(identity, current)) {
    throw new Error("inventory publication temporary ownership changed; foreign replacement preserved");
  }
  await fsApi.unlink(path);
  await fsyncDirectory(dirname(path), fsApi);
  await revalidateRunCapability(capability, {
    purpose: "inventory-work",
    id,
    boundary: "after-sync",
  });
}

function inventoryPublicationId(entryId, phase) {
  const digest = createHash("sha256")
    .update("quarantine-inventory-publication\0")
    .update(entryId)
    .update("\0")
    .update(phase)
    .digest("hex");
  return (
    `${digest.slice(0, 8)}-${digest.slice(8, 12)}-` +
    `4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
  );
}

async function summarizeInventoryLines(inputs, fsApi, metrics) {
  const digest = createHash("sha256");
  let entries = 0;
  let contentBytes = 0;
  for await (const line of mergeSortedFiles(inputs, fsApi, metrics)) {
    const framed = Buffer.from(`${line}\n`);
    digest.update(framed);
    contentBytes += framed.length;
    entries += 1;
  }
  metrics.mergePasses += 1;
  return { sha256: digest.digest("hex"), entries, contentBytes };
}

async function inventoryFileMatches(path, expected, fsApi, label) {
  let before;
  try {
    before = await fsApi.lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
  assertPrivateRegularFile(before, label);
  const hashed = await hashFileStreamCore(path, fsApi);
  const after = await fsApi.lstat(path);
  assertPrivateRegularFile(after, label);
  if (!sameIdentity(before, after) || before.size !== after.size) {
    throw new Error(`${label} identity or size changed while being verified`);
  }
  return {
    exists: true,
    matches: hashed.bytes === expected.contentBytes && hashed.sha256 === expected.sha256,
    identity: after,
  };
}

async function inventoryFileState(path, fsApi, label) {
  try {
    const identity = await fsApi.lstat(path);
    assertPrivateRegularFile(identity, label);
    return { exists: true, identity };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
}

function sameInventoryContent(left, right) {
  return (
    left.sha256 === right.sha256 &&
    left.entries === right.entries &&
    left.contentBytes === right.contentBytes
  );
}

async function writeFinalInventory({
  capability,
  outputPath,
  entryId,
  phase,
  inputs,
  work,
  fsApi,
  metrics,
}) {
  const temporaryId = inventoryPublicationId(entryId, phase);
  const temporaryPath = deriveRunPath(capability, {
    purpose: "inventory-work",
    id: temporaryId,
  });
  const finalState = await inventoryFileState(
    outputPath,
    fsApi,
    "published inventory",
  );
  const temporaryState = await inventoryFileState(
    temporaryPath,
    fsApi,
    "stale inventory publication temporary",
  );
  let expected;
  let finalBefore = finalState;
  let temporary = temporaryState;
  if (finalState.exists || temporaryState.exists) {
    expected = await summarizeInventoryLines(inputs, fsApi, metrics);
    if (finalState.exists) {
      finalBefore = await inventoryFileMatches(
        outputPath,
        expected,
        fsApi,
        "published inventory",
      );
    }
    if (temporaryState.exists) {
      temporary = await inventoryFileMatches(
        temporaryPath,
        expected,
        fsApi,
        "stale inventory publication temporary",
      );
    }
  }
  if (finalBefore.exists && !finalBefore.matches) {
    throw new Error("published inventory conflicts with complete inventory bytes");
  }
  if (finalBefore.exists && finalBefore.matches) {
    observeCoordinatorReferences(
      metrics,
      work.activeCount() + (temporary.exists ? 1 : 0),
      "inventory recovery references",
    );
    for (const file of inputs) await work.remove(file);
    if (temporary.exists) {
      await removeOwnedInventoryOutput({
        capability,
        path: temporaryPath,
        id: temporaryId,
        identity: temporary.identity,
        fsApi,
      });
    }
    return { sha256: expected.sha256, entries: expected.entries };
  }

  if (temporary.exists && !temporary.matches) {
    await removeOwnedInventoryOutput({
      capability,
      path: temporaryPath,
      id: temporaryId,
      identity: temporary.identity,
      fsApi,
    });
    temporary = { exists: false };
  }
  if (!temporary.exists) {
    let ownedIdentity;
    let primaryError;
    let created;
    try {
      created = await createPrivateFile(
        {
          capability,
          path: temporaryPath,
          purpose: "inventory-work",
          id: temporaryId,
          fsApi,
          metrics,
        },
        async (handle) => {
          const digest = createHash("sha256");
          let entries = 0;
          let contentBytes = 0;
          async function* framedLines() {
            for await (const line of mergeSortedFiles(inputs, fsApi, metrics)) {
              const framed = Buffer.from(`${line}\n`);
              digest.update(framed);
              entries += 1;
              contentBytes += framed.length;
              yield framed;
            }
          }
          await writeBuffers(handle, framedLines());
          metrics.mergePasses += 1;
          return { sha256: digest.digest("hex"), entries, contentBytes };
        },
        (identity) => {
          ownedIdentity = identity;
        },
      );
      if (expected !== undefined && !sameInventoryContent(expected, created.value)) {
        throw new Error("inventory inputs changed while recreating publication temporary");
      }
      expected ??= created.value;
      temporary = { exists: true, matches: true, identity: ownedIdentity };
    } catch (error) {
      primaryError = error;
    }
    if (primaryError !== undefined) {
      const cleanupErrors = [];
      if (ownedIdentity !== undefined) {
        try {
          await removeOwnedInventoryOutput({
            capability,
            path: temporaryPath,
            id: temporaryId,
            identity: ownedIdentity,
            fsApi,
          });
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      throwPrimaryAndCleanup(
        primaryError,
        cleanupErrors,
        "inventory publication temporary failure and cleanup both failed",
      );
    }
  }

  observeCoordinatorReferences(
    metrics,
    work.activeCount() + 1,
    "inventory work files and publication temporary",
  );

  for (const file of inputs) await work.remove(file);

  await revalidateRunCapability(capability, {
    purpose: "inventory",
    id: entryId,
    phase,
    boundary: "before-mutation",
  });
  try {
    await fsApi.link(temporaryPath, outputPath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await inventoryFileMatches(
      outputPath,
      expected,
      fsApi,
      "existing published inventory",
    );
    if (!existing.exists || !existing.matches) {
      throw new Error("existing published inventory conflicts with complete inventory bytes");
    }
  }
  const published = await fsApi.lstat(outputPath);
  assertPrivateRegularFile(published, "published inventory");
  if (!sameIdentity(temporary.identity, published)) {
    throw new Error("published inventory is not the no-replace link of its complete temporary");
  }
  await fsyncDirectory(dirname(outputPath), fsApi);
  await revalidateRunCapability(capability, {
    purpose: "inventory",
    id: entryId,
    phase,
    boundary: "after-sync",
  });
  const durableOutput = await fsApi.lstat(outputPath);
  assertPrivateRegularFile(durableOutput, "durable published inventory");
  if (!sameIdentity(temporary.identity, durableOutput)) {
    throw new Error(
      "durable published inventory ownership changed; foreign replacement and temporary evidence preserved",
    );
  }
  await removeOwnedInventoryOutput({
    capability,
    path: temporaryPath,
    id: temporaryId,
    identity: temporary.identity,
    fsApi,
  });
  return { sha256: expected.sha256, entries: expected.entries };
}

export async function writeInventoryJsonl(options) {
  const input = snapshotRecord(
    options,
    ["capability", "root", "entryId", "phase", "fsApi", "limits", "metrics"],
    ["capability", "root", "entryId", "phase"],
    "inventory write options",
  );
  const fsApi = Object.hasOwn(input, "fsApi")
    ? getRunFsContext(input.capability, input.fsApi)
    : getRunFsContext(input.capability);
  const root = assertAbsolutePath(input.root, "inventory root");
  const limits = normalizeLimits(input.limits);
  const metrics = normalizeMetrics(input.metrics, limits);
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
    pushCoordinatorReference(
      chunks,
      await writeSortedChunk(records, work),
      metrics,
      "inventory sort chunks",
    );
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
      work,
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

function comparePostorderTasks(left, right) {
  if (left.depth !== right.depth) return right.depth - left.depth;
  if (left.type !== right.type) return left.type === "file" ? -1 : 1;
  return Buffer.compare(Buffer.from(left.path), Buffer.from(right.path));
}

export async function fsyncTree(options) {
  const input = snapshotRecord(
    options,
    ["capability", "root", "entryId", "purpose", "fsApi", "limits", "metrics"],
    ["capability", "root", "entryId", "purpose"],
    "fsync tree options",
  );
  const fsApi = Object.hasOwn(input, "fsApi")
    ? getRunFsContext(input.capability, input.fsApi)
    : getRunFsContext(input.capability);
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
  const handles = createHandleMetrics(metrics);
  const work = createWorkManager({ capability: input.capability, fsApi, metrics });
  const postorderChunks = [];
  let postorderFrames = [];
  let postorderBytes = 0;
  let primaryError;

  const flushPostorder = async () => {
    if (postorderFrames.length === 0) return;
    postorderFrames.sort(comparePostorderTasks);
    pushCoordinatorReference(
      postorderChunks,
      await work.create(postorderFrames.map((frame) => `${JSON.stringify(frame)}\n`)),
      metrics,
      "inventory postorder chunks",
    );
    metrics.postorderSpills += 1;
    postorderFrames = [];
    postorderBytes = 0;
  };

  const appendPostorder = async (frame) => {
    const frameBytes = Buffer.byteLength(JSON.stringify(frame)) + 1;
    if (
      postorderFrames.length > 0 &&
      (postorderFrames.length >= limits.frontierRecords ||
        postorderBytes + frameBytes > limits.frontierBytes)
    ) {
      await flushPostorder();
    }
    postorderFrames.push(frame);
    postorderBytes += frameBytes;
    metrics.maxPostorderFrames = Math.max(
      metrics.maxPostorderFrames,
      postorderFrames.length,
    );
    metrics.maxPostorderBytes = Math.max(metrics.maxPostorderBytes, postorderBytes);
    if (
      postorderFrames.length >= limits.frontierRecords ||
      postorderBytes >= limits.frontierBytes
    ) {
      await flushPostorder();
    }
  };

  await revalidateRunCapability(input.capability, {
    purpose: "payload",
    id: input.entryId,
    boundary: "before-mutation",
  });
  try {
    const rootStat = await fsApi.lstat(root);
    if (rootStat.isSymbolicLink()) throw new Error("fsync tree root must not be a symlink");
    if (!rootStat.isFile() && !rootStat.isDirectory()) {
      throw new Error(`unsupported fsync entry type: ${root}`);
    }
    await appendPostorder({
      depth: 0,
      type: rootStat.isFile() ? "file" : "directory",
      path: root,
    });
    if (rootStat.isDirectory()) {
      for await (const item of walkTree({ root, fsApi, limits, metrics, handles, work })) {
        if (item.stat.isSymbolicLink()) continue;
        if (!item.stat.isFile() && !item.stat.isDirectory()) {
          throw new Error(`unsupported fsync entry type: ${item.absolutePath}`);
        }
        await appendPostorder({
          depth: item.relativePath.split("/").length,
          type: item.stat.isFile() ? "file" : "directory",
          path: item.absolutePath,
        });
      }
    }
    await flushPostorder();
    const finalInputs = await reduceMergeFiles(
      postorderChunks,
      { fsApi, limits, metrics, work },
      comparePostorderTasks,
    );
    for await (const line of mergeSortedFiles(
      finalInputs,
      fsApi,
      metrics,
      comparePostorderTasks,
    )) {
      const task = JSON.parse(line);
      const current = await fsApi.lstat(task.path);
      if (current.isSymbolicLink()) continue;
      if (
        (task.type === "file" && !current.isFile()) ||
        (task.type === "directory" && !current.isDirectory())
      ) {
        throw new Error(`fsync tree entry type changed: ${task.path}`);
      }
      const handle = await fsApi.open(task.path, "r");
      await withHandle(handle, (opened) => opened.sync(), "tree sync and close both failed");
    }
    metrics.mergePasses += 1;
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
