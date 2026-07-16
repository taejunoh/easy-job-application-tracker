import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  createReadStream,
  lstatSync,
  realpathSync,
} from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { canonicalPathForNumberedCopy } from "./quarantine-path-policy.mjs";

const FS_METHODS = Object.freeze([
  "lstat",
  "realpath",
  "mkdir",
  "open",
  "readdir",
  "rm",
  "rename",
  "unlink",
  "link",
  "opendir",
  "readlink",
  "createReadStream",
  "lstatSync",
  "realpathSync",
]);

const DEFAULT_FS = Object.freeze({
  lstat,
  realpath,
  mkdir,
  open,
  readdir,
  rm,
  rename,
  unlink,
  link,
  opendir,
  readlink,
  createReadStream,
  lstatSync,
  realpathSync,
});

const GIT_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
]);

const TRANSACTION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const OID = HEAD;
const COPY_LIMIT = 9_999;
const CONTROL_LIMIT = 1024 * 1024;
const STATUS_RECORD_LIMIT = 1024 * 1024;
const HISTORY_FRAME_LIMIT = 4096;
const HISTORY_OID_BODY_LIMIT = 64;
const STDERR_LIMIT = 64 * 1024;
const BLOB_STREAM_HIGH_WATER_MARK = 64 * 1024;
const PRIVATE_MODE = 0o700;

const LAYOUT = Object.freeze([
  "",
  "manifests",
  "inventories",
  "inventories/pre",
  "inventories/moved-pass-1",
  "inventories/moved-pass-2",
  "inventories/restore-active",
  "inventories/validation-pass-1",
  "inventories/validation-pass-2",
  "inventories/work",
  "payload",
  "payload/source-copies",
  "payload/generated",
  "rollback",
  "rollback/regenerated-before-restore",
  "conflicts",
  "divergent-diffs",
]);

const EXPECTED_CHILDREN = Object.freeze({
  "": Object.freeze(["conflicts", "divergent-diffs", "inventories", "manifests", "payload", "rollback"]),
  inventories: Object.freeze([
    "moved-pass-1",
    "moved-pass-2",
    "pre",
    "restore-active",
    "validation-pass-1",
    "validation-pass-2",
    "work",
  ]),
  payload: Object.freeze(["generated", "source-copies"]),
  rollback: Object.freeze(["regenerated-before-restore"]),
  manifests: Object.freeze([]),
  "inventories/pre": Object.freeze([]),
  "inventories/moved-pass-1": Object.freeze([]),
  "inventories/moved-pass-2": Object.freeze([]),
  "inventories/restore-active": Object.freeze([]),
  "inventories/validation-pass-1": Object.freeze([]),
  "inventories/validation-pass-2": Object.freeze([]),
  "inventories/work": Object.freeze([]),
  "payload/source-copies": Object.freeze([]),
  "payload/generated": Object.freeze([]),
  "rollback/regenerated-before-restore": Object.freeze([]),
  conflicts: Object.freeze([]),
  "divergent-diffs": Object.freeze([]),
});

const ERROR_MESSAGES = Object.freeze({
  ERR_USAGE: "Invalid quarantine request.",
  ERR_PREFLIGHT: "Workspace preflight failed.",
  ERR_INTEGRITY: "Quarantine evidence failed integrity validation.",
  ERR_EXDEV: "Repository and quarantine must be on the same filesystem.",
  ERR_INTERNAL: "Unexpected quarantine failure.",
});

class QuarantineError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code]);
    const stack = String(this.stack);
    Object.defineProperties(this, {
      stack: { value: stack, enumerable: false },
      message: { value: ERROR_MESSAGES[code], enumerable: false },
      name: { value: "QuarantineError", enumerable: false },
      code: { value: code, enumerable: false },
    });
    Object.freeze(this);
  }
}

class ClassifiedFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new ClassifiedFailure(code);
}

function publicError(error, fallback) {
  if (error instanceof QuarantineError) return error;
  if (error instanceof ClassifiedFailure && Object.hasOwn(ERROR_MESSAGES, error.code)) {
    return new QuarantineError(error.code);
  }
  if (error?.code === "EXDEV") return new QuarantineError("ERR_EXDEV");
  return new QuarantineError(fallback);
}

function record(entries) {
  const value = Object.create(null);
  for (const [key, entry] of entries) {
    Object.defineProperty(value, key, {
      value: entry,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(value);
}

function snapshotOptions(value, allowed, required) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("ERR_USAGE");
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail("ERR_USAGE");
  }
  if (prototype !== Object.prototype && prototype !== null) fail("ERR_USAGE");
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) fail("ERR_USAGE");
  if (required.some((key) => !keys.includes(key))) fail("ERR_USAGE");
  const result = Object.create(null);
  for (const key of allowed) {
    if (keys.includes(key)) {
      try {
        result[key] = value[key];
      } catch {
        fail("ERR_USAGE");
      }
    }
  }
  return Object.freeze(result);
}

function validateAbsolute(value) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    value !== value.normalize("NFC")
  ) fail("ERR_USAGE");
}

function validateCommon(options) {
  validateAbsolute(options.repoRoot);
  validateAbsolute(options.quarantineRoot);
  if (
    typeof options.expectedBranch !== "string" ||
    options.expectedBranch.length === 0 ||
    options.expectedBranch.includes("\0") ||
    options.expectedBranch !== options.expectedBranch.normalize("NFC") ||
    !HEAD.test(options.expectedHead) ||
    !Number.isSafeInteger(options.expectedCount) ||
    options.expectedCount < 0 ||
    options.expectedCount > COPY_LIMIT
  ) fail("ERR_USAGE");
}

function validateTransactionId(value) {
  if (
    typeof value !== "string" ||
    value === "." ||
    value === ".." ||
    value !== value.normalize("NFC") ||
    !TRANSACTION_ID.test(value)
  ) fail("ERR_USAGE");
}

function validateCreatedAt(value) {
  if (typeof value !== "string") fail("ERR_USAGE");
  const time = new Date(value);
  if (!Number.isFinite(time.valueOf()) || time.toISOString() !== value) fail("ERR_USAGE");
}

function captureFsSource(candidate) {
  const source = candidate === undefined ? DEFAULT_FS : candidate;
  if (source === null || typeof source !== "object" || Array.isArray(source)) fail("ERR_USAGE");
  let prototype;
  try {
    prototype = Object.getPrototypeOf(source);
  } catch {
    fail("ERR_USAGE");
  }
  if (prototype !== Object.prototype && prototype !== null) fail("ERR_USAGE");
  const entries = [];
  for (const method of FS_METHODS) {
    let implementation;
    try {
      implementation = source[method];
    } catch {
      fail("ERR_USAGE");
    }
    if (typeof implementation !== "function") fail("ERR_USAGE");
    entries.push([method, (...args) => Reflect.apply(implementation, source, args)]);
  }
  return record(entries);
}

function snapshotGitEnvironment() {
  const processEnvironment = process.env;
  const environment = Object.create(null);
  for (const key of GIT_ENV_ALLOWLIST) {
    const value = processEnvironment[key];
    if (typeof value === "string" && value.length > 0) environment[key] = value;
  }
  return Object.freeze(environment);
}

function childGitEnvironment(snapshot) {
  const environment = Object.create(null);
  for (const key of Reflect.ownKeys(snapshot)) environment[key] = snapshot[key];
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_NO_LAZY_FETCH = "1";
  environment.GIT_LITERAL_PATHSPECS = "1";
  return environment;
}

function byteCompare(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function isInside(parent, candidate) {
  const path = relative(parent, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function modeOf(stats) {
  return Number(stats.mode) & 0o7777;
}

function statsIdentity(stats, includeFile) {
  const dev = Number(stats.dev);
  const ino = Number(stats.ino);
  const rawMode = Number(stats.mode);
  if (!safeInteger(dev) || !safeInteger(ino) || !safeInteger(rawMode)) fail("ERR_PREFLIGHT");
  const mode = rawMode & 0o7777;
  if (!includeFile) return { dev, ino, mode };
  const size = Number(stats.size);
  if (!safeInteger(size)) fail("ERR_PREFLIGHT");
  return { dev, ino, mode, size };
}

async function collectChild(repoRoot, environment, args, maxStdout = CONTROL_LIMIT) {
  const child = spawn("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: repoRoot,
    env: childGitEnvironment(environment),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflow = false;
  let streamError = false;
  let terminationRequested = false;
  const terminate = () => {
    if (terminationRequested) return;
    terminationRequested = true;
    try {
      child.kill("SIGKILL");
    } catch {
      streamError = true;
    }
  };
  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxStdout) {
      overflow = true;
      terminate();
    }
    else stdout.push(Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > STDERR_LIMIT) {
      overflow = true;
      terminate();
    }
  });
  child.stdout.on("error", () => { streamError = true; terminate(); });
  child.stderr.on("error", () => { streamError = true; terminate(); });
  const outcome = await new Promise((resolve) => {
    let spawnError;
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => resolve({ code, signal, spawnError }));
  });
  if (overflow || streamError || outcome.spawnError || outcome.signal || outcome.code !== 0) {
    fail("ERR_PREFLIGHT");
  }
  return Buffer.concat(stdout);
}

function decodeFatal(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("ERR_PREFLIGHT");
  }
}

function parseIdentityLine(bytes) {
  const value = decodeFatal(bytes);
  if (!value.endsWith("\n") || value.slice(0, -1).includes("\n") || value.includes("\0")) {
    fail("ERR_PREFLIGHT");
  }
  return value.slice(0, -1);
}

function parseTopLevel(bytes) {
  const value = decodeFatal(bytes);
  if (!value.endsWith("\n") || value.length === 1 || value.includes("\0")) fail("ERR_PREFLIGHT");
  return value.slice(0, -1);
}

function validateRelativePath(value) {
  if (
    value.length === 0 ||
    isAbsolute(value) ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.includes("//") ||
    value !== value.normalize("NFC") ||
    value.split("/").some((component) => component === "" || component === "." || component === "..")
  ) fail("ERR_PREFLIGHT");
}

function parseStatusRecord(recordBytes) {
  const recordValue = decodeFatal(recordBytes);
  if (!recordValue.startsWith("?? ") || recordValue.length === 3) fail("ERR_PREFLIGHT");
  const path = recordValue.slice(3);
  validateRelativePath(path);
  try {
    canonicalPathForNumberedCopy(path);
  } catch {
    fail("ERR_PREFLIGHT");
  }
  return path;
}

async function collectStatus(repoRoot, environment, expectedCount) {
  const child = spawn(
    "git",
    ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    {
      cwd: repoRoot,
      env: childGitEnvironment(environment),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const hash = createHash("sha256");
  const emittedPaths = [];
  const seen = new Set();
  let frameChunks = [];
  let frameBytes = 0;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let endedWithNul = false;
  let invalid = false;
  let streamError = false;
  let terminationRequested = false;
  const terminate = () => {
    if (terminationRequested) return;
    terminationRequested = true;
    try {
      child.kill("SIGKILL");
    } catch {
      streamError = true;
    }
  };
  const reject = () => {
    invalid = true;
    terminate();
  };
  const appendFrame = (segment) => {
    if (segment.length > STATUS_RECORD_LIMIT - frameBytes) {
      reject();
      return false;
    }
    if (segment.length > 0) {
      frameChunks.push(Buffer.from(segment));
      frameBytes += segment.length;
    }
    return true;
  };
  child.stdout.on("data", (chunk) => {
    if (invalid) return;
    stdoutBytes += chunk.length;
    hash.update(chunk);
    if (expectedCount === 0 && chunk.length > 0) {
      reject();
      return;
    }
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(0, start);
      if (end === -1) {
        const tail = chunk.subarray(start);
        if (!appendFrame(tail)) return;
        endedWithNul = false;
        break;
      }
      const segment = chunk.subarray(start, end);
      if (!appendFrame(segment)) return;
      if (frameBytes === 0 || emittedPaths.length === expectedCount) {
        reject();
        return;
      }
      const frame = frameChunks.length === 1
        ? frameChunks[0]
        : Buffer.concat(frameChunks, frameBytes);
      let path;
      try {
        path = parseStatusRecord(frame);
      } catch {
        reject();
        return;
      }
      if (seen.has(path)) {
        reject();
        return;
      }
      seen.add(path);
      emittedPaths.push(path);
      frameChunks = [];
      frameBytes = 0;
      endedWithNul = true;
      start = end + 1;
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > STDERR_LIMIT) reject();
  });
  child.stdout.on("error", () => { streamError = true; terminate(); });
  child.stderr.on("error", () => { streamError = true; terminate(); });
  const outcome = await new Promise((resolve) => {
    let spawnError;
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => resolve({ code, signal, spawnError }));
  });
  if (
    invalid || streamError || outcome.spawnError || outcome.signal || outcome.code !== 0 ||
    emittedPaths.length !== expectedCount || frameBytes !== 0 ||
    (stdoutBytes > 0 && !endedWithNul)
  ) fail("ERR_PREFLIGHT");
  return {
    statusPaths: emittedPaths,
    statusSha256: hash.digest("hex"),
    paths: [...emittedPaths].sort(byteCompare),
  };
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function gitSnapshot(repoRoot, environment, expectedCount) {
  const topLevel = parseTopLevel(await collectChild(repoRoot, environment, ["rev-parse", "--show-toplevel"]));
  const branch = parseIdentityLine(await collectChild(repoRoot, environment, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
  const head = parseIdentityLine(await collectChild(repoRoot, environment, ["rev-parse", "--verify", "HEAD"]));
  const status = await collectStatus(repoRoot, environment, expectedCount);
  if (!HEAD.test(head) || branch.length === 0 || branch !== branch.normalize("NFC")) fail("ERR_PREFLIGHT");
  return { topLevel, branch, head, ...status };
}

async function assertSafeExistingPath(root, relativePath, fsSource, expectedKind) {
  validateRelativePath(relativePath);
  let current = root;
  for (const component of relativePath.split("/")) {
    current = join(current, component);
    const stats = await fsSource.lstat(current);
    if (stats.isSymbolicLink()) fail("ERR_PREFLIGHT");
  }
  const stats = await fsSource.lstat(current);
  if (expectedKind === "file" ? !stats.isFile() : !stats.isDirectory()) fail("ERR_PREFLIGHT");
  const resolved = await fsSource.realpath(current);
  if (resolved !== current || (!isInside(root, resolved) && resolved !== root)) fail("ERR_PREFLIGHT");
  return stats;
}

async function hashFile(path, fsSource) {
  const hash = createHash("sha256");
  let stream;
  try {
    stream = fsSource.createReadStream(path, { highWaterMark: 64 * 1024 });
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
  } catch {
    stream?.destroy();
    fail("ERR_PREFLIGHT");
  }
}

async function collectHistoryOids(repoRoot, environment, canonicalPath) {
  const child = spawn(
    "git",
    ["-c", "core.fsmonitor=false", "log", "--all", "--format=%H", "-z", "--", canonicalPath],
    {
      cwd: repoRoot,
      env: childGitEnvironment(environment),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const values = [];
  let frame = [];
  let stderrBytes = 0;
  let invalid = false;
  let streamError = false;
  let terminationRequested = false;
  const terminate = () => {
    if (terminationRequested) return;
    terminationRequested = true;
    try {
      child.kill("SIGKILL");
    } catch {
      streamError = true;
    }
  };
  const reject = () => {
    invalid = true;
    terminate();
  };
  child.stdout.on("data", (chunk) => {
    if (invalid) return;
    for (const byte of chunk) {
      if (byte !== 0) {
        if (frame.length === HISTORY_OID_BODY_LIMIT) {
          reject();
          return;
        }
        frame.push(byte);
        continue;
      }
      if (frame.length === 0 || values.length === HISTORY_FRAME_LIMIT) {
        reject();
        return;
      }
      let value;
      try {
        value = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(frame));
      } catch {
        reject();
        return;
      }
      frame = [];
      if (!OID.test(value)) {
        reject();
        return;
      }
      values.push(value);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > STDERR_LIMIT) reject();
  });
  child.stdout.on("error", () => { streamError = true; terminate(); });
  child.stderr.on("error", () => { streamError = true; terminate(); });
  const outcome = await new Promise((resolve) => {
    let spawnError;
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => resolve({ code, signal, spawnError }));
  });
  if (
    invalid || streamError || outcome.spawnError || outcome.signal || outcome.code !== 0 ||
    frame.length !== 0
  ) fail("ERR_PREFLIGHT");
  return values;
}

function parseLsTree(bytes, canonicalPath) {
  if (bytes.length === 0) return null;
  if (bytes.at(-1) !== 0 || bytes.subarray(0, -1).includes(0)) fail("ERR_PREFLIGHT");
  const value = decodeFatal(bytes.subarray(0, -1));
  const match = /^(\d{6}) ([a-z]+) ([0-9a-f]+)\t([\s\S]+)$/u.exec(value);
  if (!match || match[4] !== canonicalPath || !OID.test(match[3])) fail("ERR_PREFLIGHT");
  const pair = `${match[1]} ${match[2]}`;
  if (pair === "100644 blob" || pair === "100755 blob") return match[3];
  if (pair === "040000 tree" || pair === "120000 blob" || pair === "160000 commit") return null;
  fail("ERR_PREFLIGHT");
}

async function hashGitBlob(repoRoot, environment, blobOid) {
  const child = spawn("git", ["-c", "core.fsmonitor=false", "cat-file", "blob", blobOid], {
    cwd: repoRoot,
    env: childGitEnvironment(environment),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const hash = createHash("sha256");
  let stderrBytes = 0;
  let streamError = false;
  const invalidStreamConfiguration =
    child.stdout.readableHighWaterMark !== BLOB_STREAM_HIGH_WATER_MARK;
  let terminationRequested = false;
  const terminate = () => {
    if (terminationRequested) return;
    terminationRequested = true;
    try {
      child.kill("SIGKILL");
    } catch {
      streamError = true;
    }
  };
  child.stdout.on("data", (chunk) => {
    try {
      hash.update(chunk);
    } catch {
      streamError = true;
      terminate();
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > STDERR_LIMIT) terminate();
  });
  child.stdout.on("error", () => { streamError = true; terminate(); });
  child.stderr.on("error", () => { streamError = true; terminate(); });
  if (invalidStreamConfiguration) terminate();
  const outcome = await new Promise((resolve) => {
    let spawnError;
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => resolve({ code, signal, spawnError }));
  });
  if (
    invalidStreamConfiguration || stderrBytes > STDERR_LIMIT || streamError ||
    outcome.spawnError || outcome.signal || outcome.code !== 0
  ) {
    fail("ERR_PREFLIGHT");
  }
  return hash.digest("hex");
}

async function findHistoryMatch(repoRoot, environment, canonicalPath, sourceHash) {
  const commits = await collectHistoryOids(repoRoot, environment, canonicalPath);
  for (const commitOid of commits) {
    const blobOid = parseLsTree(await collectChild(
      repoRoot,
      environment,
      ["ls-tree", "-z", "--full-tree", commitOid, "--", canonicalPath],
      CONTROL_LIMIT,
    ), canonicalPath);
    if (blobOid !== null && await hashGitBlob(repoRoot, environment, blobOid) === sourceHash) {
      return commitOid;
    }
  }
  return null;
}

function fileIdentity(identity, sha256) {
  return record([
    ["dev", identity.dev],
    ["ino", identity.ino],
    ["mode", identity.mode],
    ["size", identity.size],
    ["sha256", sha256],
  ]);
}

function directoryIdentity(identity) {
  return record([
    ["dev", identity.dev],
    ["ino", identity.ino],
    ["mode", identity.mode],
  ]);
}

function frameFields(fields) {
  return Buffer.from(`${fields.join("\0")}\0`, "utf8");
}

async function discoveryPass(options, fsSource, environment, roots) {
  const before = await gitSnapshot(roots.repoRoot, environment, options.expectedCount);
  if (
    before.topLevel !== roots.repoRoot ||
    before.branch !== options.expectedBranch ||
    before.head !== options.expectedHead ||
    before.paths.length !== options.expectedCount
  ) fail("ERR_PREFLIGHT");

  const sourceEntries = [];
  for (let index = 0; index < before.paths.length; index += 1) {
    const relativePath = before.paths[index];
    const canonicalRelativePath = canonicalPathForNumberedCopy(relativePath);
    const sourcePath = resolve(roots.repoRoot, ...relativePath.split("/"));
    const canonicalPath = resolve(roots.repoRoot, ...canonicalRelativePath.split("/"));
    const sourceStats = await assertSafeExistingPath(roots.repoRoot, relativePath, fsSource, "file");
    const canonicalStats = await assertSafeExistingPath(roots.repoRoot, canonicalRelativePath, fsSource, "file");
    const sourceBase = statsIdentity(sourceStats, true);
    const canonicalBase = statsIdentity(canonicalStats, true);
    const sourceSha256 = await hashFile(sourcePath, fsSource);
    const canonicalSha256 = await hashFile(canonicalPath, fsSource);
    const classification = sourceBase.size === canonicalBase.size && sourceSha256 === canonicalSha256
      ? "identical"
      : "divergent";
    const historyMatch = classification === "identical"
      ? null
      : await findHistoryMatch(roots.repoRoot, environment, canonicalRelativePath, sourceSha256);
    sourceEntries.push({
      id: `copy-${String(index + 1).padStart(4, "0")}`,
      kind: "source-copy",
      relativePath,
      canonicalRelativePath,
      sourceIdentity: fileIdentity(sourceBase, sourceSha256),
      canonicalIdentity: fileIdentity(canonicalBase, canonicalSha256),
      classification,
      historyMatch,
    });
  }

  const generatedEntries = [];
  for (const [relativePath, id] of [[".next", "generated-next"], ["node_modules", "generated-node-modules"]]) {
    const stats = await assertSafeExistingPath(roots.repoRoot, relativePath, fsSource, "directory");
    generatedEntries.push({
      id,
      kind: "generated-root",
      relativePath,
      sourceIdentity: directoryIdentity(statsIdentity(stats, false)),
    });
  }

  const after = await gitSnapshot(roots.repoRoot, environment, options.expectedCount);
  if (
    after.topLevel !== before.topLevel ||
    after.branch !== before.branch ||
    after.head !== before.head ||
    !sameStrings(after.statusPaths, before.statusPaths)
  ) fail("ERR_PREFLIGHT");

  const entries = [...sourceEntries, ...generatedEntries].sort((left, right) => byteCompare(left.relativePath, right.relativePath));
  const parts = [frameFields([
    "workspace",
    roots.repoRoot,
    before.branch,
    before.head,
    before.statusSha256,
  ])];
  for (const entry of entries) {
    if (entry.kind === "source-copy") {
      parts.push(frameFields([
        "source", entry.relativePath, entry.canonicalRelativePath,
        entry.sourceIdentity.dev, entry.sourceIdentity.ino, entry.sourceIdentity.mode,
        entry.sourceIdentity.size, entry.sourceIdentity.sha256,
        entry.canonicalIdentity.dev, entry.canonicalIdentity.ino, entry.canonicalIdentity.mode,
        entry.canonicalIdentity.size, entry.canonicalIdentity.sha256,
      ]));
    } else {
      parts.push(frameFields([
        "generated", entry.relativePath, entry.sourceIdentity.dev,
        entry.sourceIdentity.ino, entry.sourceIdentity.mode,
      ]));
    }
  }
  return { frame: Buffer.concat(parts), entries, branch: before.branch, head: before.head };
}

function freezeEntry(entry) {
  if (entry.kind === "source-copy") {
    return record([
      ["id", entry.id],
      ["kind", entry.kind],
      ["relativePath", entry.relativePath],
      ["canonicalRelativePath", entry.canonicalRelativePath],
      ["sourceIdentity", entry.sourceIdentity],
      ["canonicalIdentity", entry.canonicalIdentity],
      ["classification", entry.classification],
      ["historyMatch", entry.historyMatch],
    ]);
  }
  return record([
    ["id", entry.id],
    ["kind", entry.kind],
    ["relativePath", entry.relativePath],
    ["sourceIdentity", entry.sourceIdentity],
  ]);
}

function freezeEntries(entries) {
  const output = entries.map(freezeEntry);
  return Object.freeze(output);
}

async function validateRoots(options, fsSource) {
  let repoStats;
  let quarantineStats;
  try {
    repoStats = await fsSource.lstat(options.repoRoot);
    quarantineStats = await fsSource.lstat(options.quarantineRoot);
  } catch {
    fail("ERR_PREFLIGHT");
  }
  if (
    repoStats.isSymbolicLink() || quarantineStats.isSymbolicLink() ||
    !repoStats.isDirectory() || !quarantineStats.isDirectory() ||
    modeOf(quarantineStats) !== PRIVATE_MODE
  ) fail("ERR_PREFLIGHT");
  const repoRoot = await fsSource.realpath(options.repoRoot);
  const quarantineRoot = await fsSource.realpath(options.quarantineRoot);
  if (
    repoRoot !== options.repoRoot || quarantineRoot !== options.quarantineRoot ||
    repoRoot === quarantineRoot || isInside(repoRoot, quarantineRoot) || isInside(quarantineRoot, repoRoot)
  ) fail("ERR_PREFLIGHT");
  const repoIdentity = statsIdentity(repoStats, false);
  const quarantineIdentity = statsIdentity(quarantineStats, false);
  if (repoIdentity.dev !== quarantineIdentity.dev) fail("ERR_EXDEV");
  return { repoRoot, quarantineRoot, repoIdentity, quarantineIdentity };
}

async function discover(options, fsSource, environment) {
  const firstRoots = await validateRoots(options, fsSource);
  const first = await discoveryPass(options, fsSource, environment, firstRoots);
  const roots = await validateRoots(options, fsSource);
  if (
    firstRoots.repoRoot !== roots.repoRoot ||
    firstRoots.quarantineRoot !== roots.quarantineRoot ||
    firstRoots.repoIdentity.dev !== roots.repoIdentity.dev ||
    firstRoots.repoIdentity.ino !== roots.repoIdentity.ino ||
    firstRoots.repoIdentity.mode !== roots.repoIdentity.mode ||
    firstRoots.quarantineIdentity.dev !== roots.quarantineIdentity.dev ||
    firstRoots.quarantineIdentity.ino !== roots.quarantineIdentity.ino ||
    firstRoots.quarantineIdentity.mode !== roots.quarantineIdentity.mode
  ) fail("ERR_PREFLIGHT");
  const second = await discoveryPass(options, fsSource, environment, roots);
  if (!first.frame.equals(second.frame)) fail("ERR_PREFLIGHT");
  return { roots, ...second, entries: freezeEntries(second.entries) };
}

async function verifyRootIdentity(path, identity, fsSource, code = "ERR_INTEGRITY") {
  let stats;
  let resolved;
  try {
    stats = await fsSource.lstat(path);
    resolved = await fsSource.realpath(path);
  } catch {
    fail(code);
  }
  if (
    stats.isSymbolicLink() || !stats.isDirectory() || resolved !== path ||
    Number(stats.dev) !== identity.dev || Number(stats.ino) !== identity.ino ||
    modeOf(stats) !== identity.mode
  ) fail(code);
}

async function validateLayoutDirectory(path, runRoot, rootDevice, fsSource) {
  let stats;
  let resolved;
  try {
    stats = await fsSource.lstat(path);
    resolved = await fsSource.realpath(path);
  } catch {
    fail("ERR_INTEGRITY");
  }
  if (
    stats.isSymbolicLink() || !stats.isDirectory() || modeOf(stats) !== PRIVATE_MODE ||
    Number(stats.dev) !== rootDevice || resolved !== path ||
    (path !== runRoot && !isInside(runRoot, resolved))
  ) fail("ERR_INTEGRITY");
  return statsIdentity(stats, false);
}

async function verifyLayoutIdentity(path, runRoot, expected, fsSource) {
  const observed = await validateLayoutDirectory(path, runRoot, expected.dev, fsSource);
  if (observed.dev !== expected.dev || observed.ino !== expected.ino || observed.mode !== expected.mode) {
    fail("ERR_INTEGRITY");
  }
}

async function scanExistingLayout(runRoot, rootDevice, fsSource) {
  const allowed = new Set(LAYOUT.slice(1));
  const pending = [""];
  const identities = new Map();
  while (pending.length > 0) {
    const parentRelative = pending.pop();
    const parentPath = parentRelative === "" ? runRoot : join(runRoot, ...parentRelative.split("/"));
    identities.set(parentRelative, await validateLayoutDirectory(parentPath, runRoot, rootDevice, fsSource));
    let names;
    try {
      names = await fsSource.readdir(parentPath);
    } catch {
      fail("ERR_INTEGRITY");
    }
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) fail("ERR_INTEGRITY");
    for (const name of names) {
      if (name.length === 0 || name.includes("/") || name.includes("\\") || name !== name.normalize("NFC")) {
        fail("ERR_INTEGRITY");
      }
      const childRelative = parentRelative === "" ? name : `${parentRelative}/${name}`;
      if (!allowed.has(childRelative)) fail("ERR_INTEGRITY");
      await validateLayoutDirectory(join(runRoot, ...childRelative.split("/")), runRoot, rootDevice, fsSource);
      pending.push(childRelative);
    }
  }
  return identities;
}

async function syncDirectory(path, fsSource) {
  let handle;
  try {
    handle = await fsSource.open(path, "r");
  } catch {
    fail("ERR_PREFLIGHT");
  }
  let close;
  try {
    close = handle.close;
  } catch {
    fail("ERR_PREFLIGHT");
  }
  if (typeof close !== "function") fail("ERR_PREFLIGHT");
  let syncFailed = false;
  try {
    await handle.sync();
  } catch {
    syncFailed = true;
  }
  let closeFailed = false;
  try {
    await Reflect.apply(close, handle, []);
  } catch {
    closeFailed = true;
  }
  if (syncFailed || closeFailed) fail("ERR_PREFLIGHT");
}

async function ensureLayout(discovery, options, fsSource) {
  const { roots } = discovery;
  const runRoot = join(roots.quarantineRoot, options.transactionId);
  let runExisted = false;
  try {
    await fsSource.lstat(runRoot);
    runExisted = true;
  } catch (error) {
    if (error?.code !== "ENOENT") fail("ERR_INTEGRITY");
  }
  const existingIdentities = runExisted
    ? await scanExistingLayout(runRoot, roots.quarantineIdentity.dev, fsSource)
    : new Map();
  const identities = new Map();
  for (const relativePath of LAYOUT) {
    await verifyRootIdentity(roots.repoRoot, roots.repoIdentity, fsSource);
    await verifyRootIdentity(roots.quarantineRoot, roots.quarantineIdentity, fsSource);
    const path = relativePath === "" ? runRoot : join(runRoot, ...relativePath.split("/"));
    if (relativePath !== "") {
      const parentRelative = relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/")) : "";
      const parentPath = parentRelative === "" ? runRoot : join(runRoot, ...parentRelative.split("/"));
      await verifyLayoutIdentity(parentPath, runRoot, identities.get(parentRelative), fsSource);
    }
    let absent = false;
    try {
      await fsSource.lstat(path);
    } catch (error) {
      if (error?.code !== "ENOENT") fail(relativePath === "" ? "ERR_PREFLIGHT" : "ERR_INTEGRITY");
      absent = true;
    }
    if (absent) {
      try {
        await fsSource.mkdir(path, { mode: PRIVATE_MODE });
      } catch (error) {
        let code;
        try {
          code = error?.code;
        } catch {
          fail("ERR_PREFLIGHT");
        }
        if (code !== "EEXIST") {
          if (code === "EXDEV") fail("ERR_EXDEV");
          fail("ERR_PREFLIGHT");
        }
      }
    }
    const identity = await validateLayoutDirectory(path, runRoot, roots.quarantineIdentity.dev, fsSource);
    if (existingIdentities.has(relativePath)) {
      const prior = existingIdentities.get(relativePath);
      if (identity.dev !== prior.dev || identity.ino !== prior.ino || identity.mode !== prior.mode) {
        fail("ERR_INTEGRITY");
      }
    }
    identities.set(relativePath, identity);
    await syncDirectory(dirname(path), fsSource);
    if (relativePath === "") {
      await verifyRootIdentity(roots.quarantineRoot, roots.quarantineIdentity, fsSource);
    } else {
      const parentRelative = relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/")) : "";
      const parentPath = parentRelative === "" ? runRoot : join(runRoot, ...parentRelative.split("/"));
      await verifyLayoutIdentity(parentPath, runRoot, identities.get(parentRelative), fsSource);
    }
    await verifyLayoutIdentity(path, runRoot, identity, fsSource);
  }

  await verifyRootIdentity(roots.repoRoot, roots.repoIdentity, fsSource);
  await verifyRootIdentity(roots.quarantineRoot, roots.quarantineIdentity, fsSource);
  for (const relativePath of LAYOUT) {
    const path = relativePath === "" ? runRoot : join(runRoot, ...relativePath.split("/"));
    await verifyLayoutIdentity(path, runRoot, identities.get(relativePath), fsSource);
    const expected = EXPECTED_CHILDREN[relativePath];
    const actual = await fsSource.readdir(path);
    if (!Array.isArray(actual) || actual.some((name) => typeof name !== "string")) fail("ERR_INTEGRITY");
    actual.sort(byteCompare);
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
      fail("ERR_INTEGRITY");
    }
  }
  return runRoot;
}

const INSPECT_ALLOWED = Object.freeze([
  "repoRoot", "quarantineRoot", "expectedBranch", "expectedHead", "expectedCount", "fsApi",
]);
const INSPECT_REQUIRED = Object.freeze([
  "repoRoot", "quarantineRoot", "expectedBranch", "expectedHead", "expectedCount",
]);
const PREPARE_ALLOWED = Object.freeze([
  "repoRoot", "quarantineRoot", "expectedBranch", "expectedHead", "expectedCount",
  "transactionId", "createdAt", "writersStopped", "fsApi", "faultHook",
]);
const PREPARE_REQUIRED = Object.freeze([
  "repoRoot", "quarantineRoot", "expectedBranch", "expectedHead", "expectedCount",
  "transactionId", "createdAt", "writersStopped",
]);

export async function inspectWorkspace(input) {
  let options;
  let fsSource;
  let environment;
  try {
    options = snapshotOptions(input, INSPECT_ALLOWED, INSPECT_REQUIRED);
    validateCommon(options);
    fsSource = captureFsSource(options.fsApi);
    environment = snapshotGitEnvironment();
    const discovery = await discover(options, fsSource, environment);
    const sourceEntries = discovery.entries.filter((entry) => entry.kind === "source-copy");
    const identicalCopies = sourceEntries.filter((entry) => entry.classification === "identical").length;
    return record([
      ["status", "INSPECTED"],
      ["totalEntries", discovery.entries.length],
      ["sourceCopies", sourceEntries.length],
      ["generatedRoots", 2],
      ["identicalCopies", identicalCopies],
      ["divergentCopies", sourceEntries.length - identicalCopies],
      ["branch", discovery.branch],
      ["head", discovery.head],
      ["sameDevice", true],
    ]);
  } catch (error) {
    throw publicError(error, "ERR_PREFLIGHT");
  }
}

export async function prepareQuarantineWorkspace(input) {
  let hook;
  let hookRejected = false;
  try {
    const options = snapshotOptions(input, PREPARE_ALLOWED, PREPARE_REQUIRED);
    validateCommon(options);
    validateTransactionId(options.transactionId);
    validateCreatedAt(options.createdAt);
    if (options.writersStopped !== true) fail("ERR_USAGE");
    if (Object.hasOwn(options, "faultHook") && typeof options.faultHook !== "function") fail("ERR_USAGE");
    hook = options.faultHook;
    const fsSource = captureFsSource(options.fsApi);
    const environment = snapshotGitEnvironment();
    const discovery = await discover(options, fsSource, environment);
    const runRoot = await ensureLayout(discovery, options, fsSource);
    if (hook !== undefined) {
      try {
        await hook("after-layout-sync");
      } catch (error) {
        hookRejected = true;
        throw error;
      }
    }
    return record([
      ["status", "LAYOUT_READY"],
      ["transactionId", options.transactionId],
      ["createdAt", options.createdAt],
      ["repoRoot", discovery.roots.repoRoot],
      ["quarantineRoot", discovery.roots.quarantineRoot],
      ["runRoot", runRoot],
      ["branch", discovery.branch],
      ["head", discovery.head],
      ["entries", discovery.entries],
      ["fsSource", fsSource],
    ]);
  } catch (error) {
    if (hookRejected) throw error;
    throw publicError(error, "ERR_PREFLIGHT");
  }
}
