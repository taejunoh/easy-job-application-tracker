import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";

import { parseInventoryRecord, parseInventorySummary } from "./quarantine-inventory.mjs";
import { deriveRunPath, revalidateRunCapability } from "./quarantine-run-capability.mjs";
import { getRunFsContext } from "./quarantine-run-fs-context.mjs";

const LIMITS = Object.freeze({
  records: 4096,
  recordBytes: 8 * 1024 * 1024,
  frontier: 4096,
  frontierBytes: 8 * 1024 * 1024,
  depth: 1024,
  nameBytes: 255,
});
const PUBLISHED_RECORD_LIMIT = 1_000_000;

export class InventoryStructuralError extends Error {
  constructor(message = "read-only inventory evidence is structurally invalid") {
    super(message);
    Object.defineProperty(this, "code", { value: "ERR_INVENTORY_STRUCTURAL", enumerable: false });
  }
}
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

function assertInventoryIdentity(expected, observed, type) {
  if (
    observed.isSymbolicLink() || !observed[type]() ||
    !sameIdentity(expected, observed) || modeOf(expected) !== modeOf(observed)
  ) throw new InventoryStructuralError("read-only restore inventory identity changed while being read");
}

function frozenDirectoryIdentity(path, stat, canonicalRealpath) {
  return Object.freeze({
    path,
    dev: stat.dev,
    ino: stat.ino,
    mode: modeOf(stat),
    type: "directory",
    canonicalRealpath,
  });
}

function appendAncestorChain(chain, identity) {
  if (chain.length >= LIMITS.depth + 1) {
    throw new InventoryStructuralError("read-only restore inventory path depth exceeds fixed bounds");
  }
  return Object.freeze([...chain, identity]);
}

async function validateAncestorChain(chain, fsApi) {
  for (const expected of chain) {
    const observed = await fsApi.lstat(expected.path);
    if (
      observed.isSymbolicLink() || !observed.isDirectory() ||
      !sameIdentity(expected, observed) || modeOf(expected) !== modeOf(observed) ||
      await fsApi.realpath(expected.path) !== expected.canonicalRealpath
    ) throw new InventoryStructuralError("restore ancestor pathname changed while being read");
  }
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
    throw new InventoryStructuralError("restore endpoint pathname is unsafe");
  }
  if (!sameIdentity(expected, observed) || modeOf(expected) !== modeOf(observed)) {
    throw new InventoryStructuralError("restore endpoint pathname identity changed");
  }
  return fsApi.realpath(path);
}

async function withVerifiedDirectory(path, expected, ancestorChain, fsApi, callback) {
  let handle;
  let dir;
  let value;
  let primary;
  try {
    await validateAncestorChain(ancestorChain, fsApi);
    handle = await fsApi.open(path, DIRECTORY_OPEN_FLAGS);
    const opened = await handle.stat();
    assertInventoryIdentity(expected, opened, "isDirectory");
    // opendir(path) is allowed only to acquire a held stream. Before its first
    // read, bind that pathname back to the already-open no-follow handle.
    dir = await fsApi.opendir(path);
    await validateAncestorChain(ancestorChain, fsApi);
    const canonicalPath = await assertPathMatchesHandle(path, opened, "isDirectory", fsApi);
    value = await callback(dir, frozenDirectoryIdentity(path, opened, canonicalPath), handle);
    const finalHandle = await handle.stat();
    assertInventoryIdentity(opened, finalHandle, "isDirectory");
    await validateAncestorChain(ancestorChain, fsApi);
    if (canonicalPath !== await assertPathMatchesHandle(path, opened, "isDirectory", fsApi)) {
      throw new InventoryStructuralError("restore directory pathname changed while being read");
    }
  } catch (error) {
    primary = error;
  }
  await closeAll(dir, handle, primary);
  return value;
}

export async function hashVerifiedRegularFile(path, expected, fsApi, ancestorChain = Object.freeze([])) {
  assertAbsolutePath(path, "verified file path");
  let handle;
  let value;
  let primary;
  try {
    await validateAncestorChain(ancestorChain, fsApi);
    handle = await fsApi.open(path, FILE_OPEN_FLAGS);
    const opened = await handle.stat();
    assertInventoryIdentity(expected, opened, "isFile");
    await validateAncestorChain(ancestorChain, fsApi);
    const canonicalPath = await assertPathMatchesHandle(path, opened, "isFile", fsApi);
    const hash = createHash("sha256");
    let bytes = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      bytes += read.bytesRead;
    }
    if (bytes !== opened.size) throw new InventoryStructuralError("restore file changed while being read");
    const finalHandle = await handle.stat();
    assertInventoryIdentity(opened, finalHandle, "isFile");
    await validateAncestorChain(ancestorChain, fsApi);
    if (canonicalPath !== await assertPathMatchesHandle(path, opened, "isFile", fsApi)) {
      throw new InventoryStructuralError("restore file pathname changed while being read");
    }
    value = { sha256: hash.digest("hex"), bytes };
  } catch (error) {
    primary = error;
  }
  await closeAll(undefined, handle, primary);
  return value;
}

async function readVerifiedLink(path, expected, ancestorChain, fsApi) {
  await validateAncestorChain(ancestorChain, fsApi);
  const linkTarget = await fsApi.readlink(path);
  await validateAncestorChain(ancestorChain, fsApi);
  const final = await fsApi.lstat(path);
  if (!final.isSymbolicLink() || !sameIdentity(expected, final) || modeOf(expected) !== modeOf(final)) {
    throw new InventoryStructuralError("restore symlink changed while being read");
  }
  return linkTarget;
}

export async function summarizeInventoryDirectory(root, {
  fsApi, ancestorChain = Object.freeze([]), snapshot = false, expectedRootIdentity = undefined,
}) {
  assertAbsolutePath(root, "read-only inventory root");
  const rootStat = await fsApi.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new InventoryStructuralError("restore tree endpoint is unsafe");
  }
  const rootRealpath = await fsApi.realpath(root);
  if (expectedRootIdentity !== undefined) {
    assertInventoryIdentity(expectedRootIdentity, rootStat, "isDirectory");
    if (rootRealpath !== expectedRootIdentity.canonicalRealpath) {
      throw new InventoryStructuralError("restore tree root pathname identity changed");
    }
  }
  const rootIdentity = frozenDirectoryIdentity(root, rootStat, rootRealpath);
  const records = [];
  const pending = [{
    absolutePath: root, relativePath: "", depth: 0, root: true,
    expected: rootIdentity,
    ancestorChain,
  }];
  let pendingBytes = Buffer.byteLength(JSON.stringify(pending[0])) + 1;
  let recordBytes = 0;
  let bytes = 0;
  const addRecord = (record, contentBytes) => {
    const serialized = Buffer.byteLength(JSON.stringify(record)) + 1;
    if (records.length >= LIMITS.records || recordBytes + serialized > LIMITS.recordBytes) {
      throw new InventoryStructuralError("read-only restore inventory exceeded fixed record bounds");
    }
    records.push(record);
    recordBytes += serialized;
    bytes += contentBytes;
  };
  const enqueue = (item) => {
    const serialized = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (pending.length >= LIMITS.frontier || pendingBytes + serialized > LIMITS.frontierBytes) {
      throw new InventoryStructuralError("read-only restore inventory exceeded fixed traversal bounds");
    }
    pending.push(item);
    pendingBytes += serialized;
  };
  while (pending.length > 0) {
    const item = pending.pop();
    pendingBytes -= Buffer.byteLength(JSON.stringify(item)) + 1;
    await validateAncestorChain(item.ancestorChain, fsApi);
    const stat = await fsApi.lstat(item.absolutePath);
    if (item.expected !== undefined) {
      assertInventoryIdentity(item.expected, stat, "isDirectory");
    }
    if (stat.isSymbolicLink()) {
      if (item.root) throw new InventoryStructuralError("restore tree endpoint is unsafe");
      const linkTarget = await readVerifiedLink(item.absolutePath, stat, item.ancestorChain, fsApi);
      addRecord(parseInventoryRecord({
        scope: "relative", path: item.relativePath, type: "symlink", mode: modeOf(stat),
        size: Buffer.byteLength(linkTarget), linkTarget,
      }), Buffer.byteLength(linkTarget));
      continue;
    }
    if (stat.isFile()) {
      if (item.root) throw new InventoryStructuralError("restore tree endpoint is unsafe");
      const hashed = await hashVerifiedRegularFile(item.absolutePath, stat, fsApi, item.ancestorChain);
      addRecord(parseInventoryRecord({
        scope: "relative", path: item.relativePath, type: "file", mode: modeOf(stat),
        size: stat.size, sha256: hashed.sha256,
      }), stat.size);
      continue;
    }
    if (!stat.isDirectory()) throw new InventoryStructuralError("restore tree contains an unsupported endpoint");
    if (!item.root) addRecord(parseInventoryRecord({
      scope: "relative", path: item.relativePath, type: "directory", mode: modeOf(stat), size: 0,
    }), 0);
    await withVerifiedDirectory(item.absolutePath, stat, item.ancestorChain, fsApi, async (dir, identity) => {
      while (true) {
        const entry = await dir.read();
        if (entry === null) break;
        const name = entry.name;
        if (typeof name !== "string" || Buffer.byteLength(name) > LIMITS.nameBytes) {
          throw new InventoryStructuralError("read-only restore inventory entry name exceeds fixed bounds");
        }
        if (item.depth + 1 > LIMITS.depth) {
          throw new InventoryStructuralError("read-only restore inventory path depth exceeds fixed bounds");
        }
        const relativePath = item.relativePath ? `${item.relativePath}/${name}` : name;
        enqueue({
          absolutePath: join(item.absolutePath, name), relativePath, depth: item.depth + 1, root: false,
          ancestorChain: appendAncestorChain(item.ancestorChain, identity),
        });
      }
    });
  }
  records.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const digest = createHash("sha256");
  for (const record of records) digest.update(Buffer.from(`${JSON.stringify(record)}\n`));
  const summary = parseInventorySummary({ sha256: digest.digest("hex"), entries: records.length, bytes });
  if (!snapshot) return summary;
  return Object.freeze({
    summary,
    records: Object.freeze(records.map((record) => Object.freeze(record))),
    rootIdentity,
    ancestorChain,
  });
}

export async function verifyPublishedInventory({ capability, entryId, phase, expectedSummary }) {
  const fsApi = getRunFsContext(capability);
  const path = deriveRunPath(capability, { purpose: "inventory", id: entryId, phase });
  const expected = parseInventorySummary(expectedSummary);
  let handle;
  let primary;
  let result;
  try {
    const before = await fsApi.lstat(path);
    if (before.isSymbolicLink() || !before.isFile() || modeOf(before) !== 0o600 || before.nlink !== 1) {
      throw new InventoryStructuralError("published inventory endpoint is unsafe");
    }
    handle = await fsApi.open(path, FILE_OPEN_FLAGS);
    const opened = await handle.stat();
    assertInventoryIdentity(before, opened, "isFile");
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let pending = Buffer.alloc(0);
    let entries = 0;
    let bytes = 0;
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      const chunk = Buffer.from(buffer.subarray(0, read.bytesRead));
      digest.update(chunk);
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > LIMITS.recordBytes) {
        throw new InventoryStructuralError("published inventory record exceeds fixed bounds");
      }
      let newline;
      while ((newline = pending.indexOf(0x0a)) !== -1) {
        const lineBytes = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        if (lineBytes.length === 0 || entries >= PUBLISHED_RECORD_LIMIT) {
          throw new InventoryStructuralError("published inventory has an invalid record count");
        }
        const line = lineBytes.toString("utf8");
        if (!Buffer.from(line, "utf8").equals(lineBytes)) {
          throw new InventoryStructuralError("published inventory is not valid UTF-8");
        }
        let raw;
        try { raw = JSON.parse(line); } catch {
          throw new InventoryStructuralError("published inventory JSON is invalid");
        }
        const record = parseInventoryRecord(raw);
        if (JSON.stringify(record) !== line) {
          throw new InventoryStructuralError("published inventory is not canonical JSONL");
        }
        entries += 1;
        if (record.type === "file" || record.type === "symlink") bytes += record.size;
        if (!Number.isSafeInteger(bytes)) {
          throw new InventoryStructuralError("published inventory byte count exceeds fixed bounds");
        }
      }
    }
    if (pending.length !== 0) {
      throw new InventoryStructuralError("published inventory has a torn final record");
    }
    const after = await handle.stat();
    assertInventoryIdentity(opened, after, "isFile");
    const finalPath = await fsApi.lstat(path);
    assertInventoryIdentity(opened, finalPath, "isFile");
    result = parseInventorySummary({ sha256: digest.digest("hex"), entries, bytes });
    if (JSON.stringify(result) !== JSON.stringify(expected)) {
      throw new InventoryStructuralError("published inventory summary does not match its manifest");
    }
  } catch (error) {
    primary = error;
  }
  await closeAll(undefined, handle, primary);
  return result;
}

export async function publishVerifiedRestoreActiveInventory({ capability, entryId, snapshot, replaceExisting = false }) {
  if (snapshot === null || typeof snapshot !== "object" || !Array.isArray(snapshot.records)) {
    throw new TypeError("verified restore inventory snapshot is invalid");
  }
  const fsApi = getRunFsContext(capability);
  const path = deriveRunPath(capability, { purpose: "inventory", id: entryId, phase: "restore-active" });
  const chain = Object.freeze([...snapshot.ancestorChain, snapshot.rootIdentity]);
  await validateAncestorChain(chain, fsApi);
  await revalidateRunCapability(capability, { purpose: "inventory", id: entryId, phase: "restore-active", boundary: "before-mutation" });
  const parent = dirname(path);
  const parentStat = await fsApi.lstat(parent);
  const parentRealpath = await fsApi.realpath(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory() || parentRealpath !== parent) {
    throw new Error("restore-active inventory parent is unsafe");
  }
  const parentIdentity = frozenDirectoryIdentity(parent, parentStat, parentRealpath);
  const expectedExistingBytes = Buffer.from(snapshot.records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  const readExactExisting = async () => {
    let existingHandle;
    let primary;
    let identity = null;
    try {
      const expected = await fsApi.lstat(path);
      if (expected.isSymbolicLink() || !expected.isFile() || modeOf(expected) !== 0o600 || expected.nlink !== 1) {
        throw new Error("existing restore-active inventory is unsafe");
      }
      if (expected.size !== expectedExistingBytes.length) return false;
      existingHandle = await fsApi.open(path, FILE_OPEN_FLAGS);
      const opened = await existingHandle.stat();
      assertIdentity(expected, opened, "isFile", "existing restore-active inventory");
      const observed = Buffer.allocUnsafe(expectedExistingBytes.length);
      let offset = 0;
      while (offset < observed.length) {
        const read = await existingHandle.read(observed, offset, observed.length - offset, offset);
        if (read.bytesRead === 0) throw new Error("existing restore-active inventory changed while being read");
        offset += read.bytesRead;
      }
      const final = await existingHandle.stat();
      assertIdentity(opened, final, "isFile", "existing restore-active inventory");
      await assertPathMatchesHandle(path, opened, "isFile", fsApi);
      identity = Buffer.compare(observed, expectedExistingBytes) === 0
        ? Object.freeze({ dev: opened.dev, ino: opened.ino, mode: modeOf(opened), nlink: opened.nlink, type: "file" })
        : null;
    } catch (error) { primary = error; }
    await closeAll(undefined, existingHandle, primary);
    return identity;
  };
  let handle;
  let ownedIdentity;
  const cleanupOwned = async (error) => {
    if (ownedIdentity === undefined) throw error;
    try {
      await cleanupVerifiedRestoreActiveInventory({
        capability,
        publication: Object.freeze({ path, entryId, identity: ownedIdentity, parentIdentity }),
      });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "restore-active inventory publish and cleanup failed");
    }
    throw error;
  };
  let primary;
  try {
    try {
      handle = await fsApi.open(path, "wx", 0o600);
    } catch (error) {
      if (!replaceExisting || error?.code !== "EEXIST") throw error;
      const existingIdentity = await readExactExisting();
      if (existingIdentity === null) throw new Error("existing restore-active inventory is not a prior restore publication");
      // Do not close-check-unlink-rewrite a durable prior publication: even
      // a fully validated pathname can be exchanged after its reader closes.
      // Its exact bytes are already the snapshot required for this epoch.
      return Object.freeze({
        summary: snapshot.summary,
        publication: Object.freeze({ path, entryId, identity: existingIdentity, parentIdentity, reused: true }),
      });
    }
    await handle.chmod(0o600);
    const opened = await handle.stat();
    if (opened.isSymbolicLink() || !opened.isFile() || modeOf(opened) !== 0o600 || opened.nlink !== 1) {
      throw new Error("restore-active inventory output is not private regular file");
    }
    ownedIdentity = Object.freeze({ dev: opened.dev, ino: opened.ino, mode: modeOf(opened), nlink: opened.nlink, type: "file" });
    let position = 0;
    for (const record of snapshot.records) {
      const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
      let offset = 0;
      while (offset < bytes.length) {
        const written = await handle.write(bytes, offset, bytes.length - offset, position + offset);
        if (written.bytesWritten <= 0) throw new Error("verified restore inventory write made no progress");
        offset += written.bytesWritten;
      }
      position += bytes.length;
    }
    await validateAncestorChain(chain, fsApi);
    await handle.sync();
    await validateAncestorChain(chain, fsApi);
  } catch (error) { primary = error; }
  try {
    await closeAll(undefined, handle, primary);
  } catch (error) {
    primary = error;
  }
  if (primary !== undefined) {
    await cleanupOwned(primary);
  }
  try {
    await validateAncestorChain(chain, fsApi);
    const final = await fsApi.lstat(path);
    if (ownedIdentity === undefined || final.isSymbolicLink() || !final.isFile() ||
      !sameIdentity(ownedIdentity, final) || modeOf(final) !== 0o600 || final.nlink !== 1) {
      throw new Error("restore-active inventory output changed before parent sync");
    }
    const directory = await fsApi.open(parent, DIRECTORY_OPEN_FLAGS);
    let directoryPrimary;
    try { await directory.sync(); } catch (error) { directoryPrimary = error; }
    await closeAll(undefined, directory, directoryPrimary);
    await revalidateRunCapability(capability, { purpose: "inventory", id: entryId, phase: "restore-active", boundary: "after-sync" });
    await validateAncestorChain(chain, fsApi);
    const published = await fsApi.lstat(path);
    if (published.isSymbolicLink() || !published.isFile() || !sameIdentity(ownedIdentity, published) || modeOf(published) !== 0o600 || published.nlink !== 1) {
      throw new Error("restore-active inventory output changed after parent sync");
    }
  } catch (error) {
    await cleanupOwned(error);
  }
  return Object.freeze({
    summary: snapshot.summary,
    publication: Object.freeze({ path, entryId, identity: ownedIdentity, parentIdentity }),
  });
}

export async function cleanupVerifiedRestoreActiveInventory({ capability, publication }) {
  if (publication === null || typeof publication !== "object" || typeof publication.path !== "string" ||
      typeof publication.entryId !== "string") {
    throw new TypeError("restore-active inventory publication is invalid");
  }
  const fsApi = getRunFsContext(capability);
  const parent = dirname(publication.path);
  const expectedParent = publication.parentIdentity;
  const expectedFile = publication.identity;
  await validateAncestorChain(Object.freeze([]), fsApi);
  const parentStat = await fsApi.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !sameIdentity(expectedParent, parentStat) ||
      modeOf(parentStat) !== expectedParent.mode || await fsApi.realpath(parent) !== expectedParent.canonicalRealpath) {
    throw new Error("restore-active inventory cleanup parent changed");
  }
  const stat = await fsApi.lstat(publication.path);
  if (stat.isSymbolicLink() || !stat.isFile() || !sameIdentity(expectedFile, stat) || modeOf(stat) !== 0o600 || stat.nlink !== 1) {
    throw new Error("restore-active inventory cleanup ownership changed");
  }
  await revalidateRunCapability(capability, {
    purpose: "inventory", id: publication.entryId, phase: "restore-active", boundary: "before-mutation",
  });
  await fsApi.unlink(publication.path);
  const directory = await fsApi.open(parent, DIRECTORY_OPEN_FLAGS);
  let primary;
  try { await directory.sync(); } catch (error) { primary = error; }
  await closeAll(undefined, directory, primary);
  await revalidateRunCapability(capability, {
    purpose: "inventory", id: publication.entryId, phase: "restore-active", boundary: "after-sync",
  });
}

/* Internal restore authority.  Each pathname is rebound to an O_NOFOLLOW
 * handle and every ancestor identity is checked before and after the handle
 * operation.  It deliberately does not use path-recursive `readdir`/`open`
 * sequences, which could traverse an exchanged ancestor between calls. */
export async function fsyncVerifiedTree(root, {
  fsApi, ancestorChain = Object.freeze([]), rootIdentity = undefined,
}) {
  assertAbsolutePath(root, "verified sync root");
  const syncFile = async (path, expected, chain) => {
    let handle;
    let primary;
    try {
      await validateAncestorChain(chain, fsApi);
      handle = await fsApi.open(path, FILE_OPEN_FLAGS);
      const opened = await handle.stat();
      assertIdentity(expected, opened, "isFile", "restore sync file handle");
      await validateAncestorChain(chain, fsApi);
      await assertPathMatchesHandle(path, opened, "isFile", fsApi);
      await handle.sync();
      const final = await handle.stat();
      assertIdentity(opened, final, "isFile", "restore sync file handle");
      await validateAncestorChain(chain, fsApi);
      await assertPathMatchesHandle(path, opened, "isFile", fsApi);
    } catch (error) {
      primary = error;
    }
    await closeAll(undefined, handle, primary);
  };
  const syncDirectory = async (path, expected, chain) => {
    let handle;
    let primary;
    try {
      await validateAncestorChain(chain, fsApi);
      handle = await fsApi.open(path, DIRECTORY_OPEN_FLAGS);
      const opened = await handle.stat();
      assertIdentity(expected, opened, "isDirectory", "restore sync directory handle");
      await validateAncestorChain(chain, fsApi);
      await assertPathMatchesHandle(path, opened, "isDirectory", fsApi);
      await handle.sync();
      const final = await handle.stat();
      assertIdentity(opened, final, "isDirectory", "restore sync directory handle");
      await validateAncestorChain(chain, fsApi);
      await assertPathMatchesHandle(path, opened, "isDirectory", fsApi);
    } catch (error) { primary = error; }
    await closeAll(undefined, handle, primary);
  };
  const budget = { records: 0, recordBytes: 0 };
  const enumerateDirectory = async (path, expected, chain) => withVerifiedDirectory(
    path, expected, chain, fsApi,
    async (dir, identity) => {
      const names = [];
      while (true) {
        const item = await dir.read();
        if (item === null) break;
        if (typeof item.name !== "string" || Buffer.byteLength(item.name) > LIMITS.nameBytes) {
          throw new Error("restore sync directory entry is invalid");
        }
        const canonicalBytes = Buffer.byteLength(join(path, item.name));
        if (budget.records >= LIMITS.records || budget.recordBytes + canonicalBytes > LIMITS.recordBytes) {
          throw new Error("restore sync tree exceeded fixed entry bounds");
        }
        names.push(item.name);
        budget.records += 1;
        budget.recordBytes += canonicalBytes;
      }
      names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
      return Object.freeze({ identity, names: Object.freeze(names) });
    },
  );
  const visit = async (path, expected, chain) => {
    const expectedFile = expected.type === undefined ? expected.isFile() : expected.type === "file";
    const expectedDirectory = expected.type === undefined ? expected.isDirectory() : expected.type === "directory";
    if ((!expectedFile && !expectedDirectory) || expected.isSymbolicLink?.()) {
      throw new Error("restore sync endpoint is unsafe");
    }
    if (expectedFile) return syncFile(path, expected, chain);
    const enumerated = await enumerateDirectory(path, expected, chain);
    const childChain = appendAncestorChain(chain, enumerated.identity);
    for (const name of enumerated.names) {
      const child = join(path, name);
      await validateAncestorChain(childChain, fsApi);
      const childStat = await fsApi.lstat(child);
      await visit(child, childStat, childChain);
    }
    await syncDirectory(path, enumerated.identity, chain);
  };
  const stat = await fsApi.lstat(root);
  if (rootIdentity !== undefined) {
    const expectedFile = rootIdentity.type === undefined ? rootIdentity.isFile() : rootIdentity.type === "file";
    const expectedDirectory = rootIdentity.type === undefined ? rootIdentity.isDirectory() : rootIdentity.type === "directory";
    if ((!expectedFile && !expectedDirectory) || stat.isSymbolicLink()) {
      throw new Error("restore sync expected root is unsafe");
    }
    assertIdentity(rootIdentity, stat, expectedFile ? "isFile" : "isDirectory", "restore sync root");
  }
  await visit(root, rootIdentity ?? stat, ancestorChain);
}
