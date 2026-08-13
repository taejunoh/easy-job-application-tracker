import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  constants as fsConstants,
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
import {
  appendJournalRecord,
  IndeterminateJournalAppendError,
  replayJournal,
  withJournalLock,
} from "./quarantine-journal.mjs";
import {
  compareInventorySummary,
  fsyncTree,
  writeInventoryJsonl,
} from "./quarantine-inventory.mjs";
import {
  activateManifestGeneration,
  buildValidatedManifest,
  readManifestGeneration,
  writeManifestGeneration,
} from "./quarantine-manifest.mjs";
import { withExistingQuarantineRun } from "./quarantine-lifecycle-core.mjs";
import {
  deriveRunPath,
  revalidateRunCapability,
  withQuarantineRunCapability,
} from "./quarantine-run-capability.mjs";
import { getRunFsContext } from "./quarantine-run-fs-context.mjs";

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
const PRIVATE_FILE_MODE = 0o600;
const ENTRY_ID = /^(?:copy-(?!0000)[0-9]{4}|temp-(?!0000)[0-9]{4}|generated-next|generated-node-modules)$/u;
const COPY_ID = /^copy-(?!0000)[0-9]{4}$/u;
const TEMP_RESIDUE_BASENAME = /^\.BC\.T_[A-Za-z0-9]{6}$/u;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SHA256 = /^[0-9a-f]{64}$/u;

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
  "payload/temp-residues",
  "payload/generated",
  "rollback",
  "rollback/regenerated-before-restore",
  "conflicts",
  "divergent-diffs",
]);

const ERROR_MESSAGES = Object.freeze({
  ERR_USAGE: "Invalid quarantine request.",
  ERR_PREFLIGHT: "Workspace preflight failed.",
  ERR_RECOVERY_REQUIRED: "Explicit quarantine recovery is required.",
  ERR_INTEGRITY: "Quarantine evidence failed integrity validation.",
  ERR_EXDEV: "Repository and quarantine must be on the same filesystem.",
  ERR_INDETERMINATE_JOURNAL_APPEND: "Journal durability could not be determined.",
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
  const basename = path.slice(path.lastIndexOf("/") + 1);
  if (!TEMP_RESIDUE_BASENAME.test(basename)) {
    try {
      canonicalPathForNumberedCopy(path);
    } catch {
      fail("ERR_PREFLIGHT");
    }
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

async function verifyEmptyPrivateRegularFile(path, expected, fsSource) {
  if (modeOf(expected) !== PRIVATE_FILE_MODE || Number(expected.size) !== 0) fail("ERR_PREFLIGHT");
  let handle;
  let primary;
  try {
    handle = await fsSource.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      opened.isSymbolicLink() || !opened.isFile() || modeOf(opened) !== PRIVATE_FILE_MODE ||
      Number(opened.size) !== 0 || Number(opened.dev) !== Number(expected.dev) ||
      Number(opened.ino) !== Number(expected.ino)
    ) fail("ERR_PREFLIGHT");
    const read = await handle.read(Buffer.alloc(1), 0, 1, 0);
    if (read.bytesRead !== 0) fail("ERR_PREFLIGHT");
    const after = await handle.stat();
    const pathAfter = await fsSource.lstat(path);
    if (
      after.isSymbolicLink() || !after.isFile() || pathAfter.isSymbolicLink() || !pathAfter.isFile() ||
      modeOf(after) !== PRIVATE_FILE_MODE || modeOf(pathAfter) !== PRIVATE_FILE_MODE ||
      Number(after.size) !== 0 || Number(pathAfter.size) !== 0 ||
      Number(after.dev) !== Number(expected.dev) || Number(after.ino) !== Number(expected.ino) ||
      Number(pathAfter.dev) !== Number(expected.dev) || Number(pathAfter.ino) !== Number(expected.ino)
    ) fail("ERR_PREFLIGHT");
  } catch (error) {
    primary = error;
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (closeError) {
      if (primary === undefined) primary = closeError;
      else primary = new AggregateError([primary, closeError], "temp residue read and close both failed");
    }
  }
  if (primary !== undefined) {
    if (primary instanceof ClassifiedFailure) throw primary;
    fail("ERR_PREFLIGHT");
  }
  return EMPTY_SHA256;
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
  const tempEntries = [];
  for (let index = 0; index < before.paths.length; index += 1) {
    const relativePath = before.paths[index];
    const basename = relativePath.slice(relativePath.lastIndexOf("/") + 1);
    if (TEMP_RESIDUE_BASENAME.test(basename)) {
      const sourcePath = resolve(roots.repoRoot, ...relativePath.split("/"));
      const sourceStats = await assertSafeExistingPath(roots.repoRoot, relativePath, fsSource, "file");
      const sourceBase = statsIdentity(sourceStats, true);
      const sourceSha256 = await verifyEmptyPrivateRegularFile(sourcePath, sourceStats, fsSource);
      tempEntries.push({
        id: `temp-${String(tempEntries.length + 1).padStart(4, "0")}`,
        kind: "temp-residue",
        relativePath,
        sourceIdentity: fileIdentity(sourceBase, sourceSha256),
      });
      continue;
    }
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
      id: `copy-${String(sourceEntries.length + 1).padStart(4, "0")}`,
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

  const entries = [...sourceEntries, ...tempEntries, ...generatedEntries]
    .sort((left, right) => byteCompare(left.relativePath, right.relativePath));
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
    } else if (entry.kind === "temp-residue") {
      parts.push(frameFields([
        "temp", entry.relativePath, entry.sourceIdentity.dev,
        entry.sourceIdentity.ino, entry.sourceIdentity.mode,
        entry.sourceIdentity.size, entry.sourceIdentity.sha256,
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
  if (entry.kind === "temp-residue") {
    return record([
      ["id", entry.id],
      ["kind", entry.kind],
      ["relativePath", entry.relativePath],
      ["sourceIdentity", entry.sourceIdentity],
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

function isAllowedPrecommitFile(relativePath) {
  if (relativePath.startsWith("inventories/pre/")) {
    const name = relativePath.slice("inventories/pre/".length);
    return name.endsWith(".jsonl") && ENTRY_ID.test(name.slice(0, -".jsonl".length));
  }
  if (relativePath.startsWith("manifests/")) {
    const name = relativePath.slice("manifests/".length);
    return name.endsWith(".json") && SHA256.test(name.slice(0, -".json".length));
  }
  if (relativePath.startsWith("divergent-diffs/")) {
    const name = relativePath.slice("divergent-diffs/".length);
    if (name.endsWith(".patch")) return COPY_ID.test(name.slice(0, -".patch".length));
    if (name.startsWith(".") && name.endsWith(".tmp")) {
      return COPY_ID.test(name.slice(1, -".tmp".length));
    }
  }
  return false;
}

async function validatePrecommitFile(path, runRoot, rootDevice, fsSource) {
  let stats;
  let resolved;
  try {
    stats = await fsSource.lstat(path);
    resolved = await fsSource.realpath(path);
  } catch {
    fail("ERR_INTEGRITY");
  }
  if (
    stats.isSymbolicLink() || !stats.isFile() || modeOf(stats) !== PRIVATE_FILE_MODE ||
    Number(stats.dev) !== rootDevice || resolved !== path || !isInside(runRoot, resolved)
  ) fail("ERR_INTEGRITY");
}

async function scanExistingLayout(
  runRoot,
  rootDevice,
  fsSource,
  mode = "strict",
  readFailureCode = "ERR_INTEGRITY",
) {
  const allowed = new Set(LAYOUT.slice(1));
  const pending = [""];
  const identities = new Map();
  const files = [];
  while (pending.length > 0) {
    const parentRelative = pending.pop();
    const parentPath = parentRelative === "" ? runRoot : join(runRoot, ...parentRelative.split("/"));
    identities.set(parentRelative, await validateLayoutDirectory(parentPath, runRoot, rootDevice, fsSource));
    let names;
    try {
      names = await fsSource.readdir(parentPath);
    } catch {
      fail(readFailureCode);
    }
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) fail("ERR_INTEGRITY");
    for (const name of names) {
      if (name.length === 0 || name.includes("/") || name.includes("\\") || name !== name.normalize("NFC")) {
        fail("ERR_INTEGRITY");
      }
      const childRelative = parentRelative === "" ? name : `${parentRelative}/${name}`;
      const childPath = join(runRoot, ...childRelative.split("/"));
      if (allowed.has(childRelative)) {
        await validateLayoutDirectory(childPath, runRoot, rootDevice, fsSource);
        pending.push(childRelative);
      } else if (mode === "apply-precommit-resume" && isAllowedPrecommitFile(childRelative)) {
        await validatePrecommitFile(childPath, runRoot, rootDevice, fsSource);
        files.push(childRelative);
      } else {
        fail("ERR_INTEGRITY");
      }
    }
  }
  if (files.length > 0 && identities.size !== LAYOUT.length) fail("ERR_INTEGRITY");
  const manifestFiles = files.filter((path) => path.startsWith("manifests/"));
  if (manifestFiles.length > 1) fail("ERR_INTEGRITY");
  return { identities, files: Object.freeze(files.sort(byteCompare)) };
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

async function ensureLayout(discovery, options, fsSource, mode = "strict") {
  const { roots } = discovery;
  const runRoot = join(roots.quarantineRoot, options.transactionId);
  let runExisted = false;
  try {
    await fsSource.lstat(runRoot);
    runExisted = true;
  } catch (error) {
    if (error?.code !== "ENOENT") fail("ERR_INTEGRITY");
  }
  const existing = runExisted
    ? await scanExistingLayout(runRoot, roots.quarantineIdentity.dev, fsSource, mode)
    : { identities: new Map(), files: Object.freeze([]) };
  const existingIdentities = existing.identities;
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
  const completed = await scanExistingLayout(
    runRoot,
    roots.quarantineIdentity.dev,
    fsSource,
    mode,
    mode === "strict" ? "ERR_PREFLIGHT" : "ERR_INTEGRITY",
  );
  for (const relativePath of LAYOUT) {
    const path = relativePath === "" ? runRoot : join(runRoot, ...relativePath.split("/"));
    await verifyLayoutIdentity(path, runRoot, identities.get(relativePath), fsSource);
    if (!completed.identities.has(relativePath)) fail("ERR_INTEGRITY");
  }
  return runRoot;
}

function isJournalResidueName(name) {
  return name === "journal.log" || name === "journal.lock" ||
    name.startsWith("journal.lock.tombstone.");
}

async function gateOtherOwnedPrecommitRun(options, roots, fsSource) {
  let names;
  try {
    names = await fsSource.readdir(roots.quarantineRoot);
  } catch {
    fail("ERR_INTEGRITY");
  }
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
    fail("ERR_INTEGRITY");
  }
  const requiredTopLevel = new Set(LAYOUT.slice(1).filter((path) => !path.includes("/")));
  for (const name of names.sort(byteCompare)) {
    if (name === options.transactionId || name === ".gitkeep" || !TRANSACTION_ID.test(name)) continue;
    const candidate = join(roots.quarantineRoot, name);
    let stats;
    let rootNames;
    try {
      stats = await fsSource.lstat(candidate);
      if (stats.isSymbolicLink() || !stats.isDirectory() || modeOf(stats) !== PRIVATE_MODE ||
          Number(stats.dev) !== roots.quarantineIdentity.dev || await fsSource.realpath(candidate) !== candidate) continue;
      rootNames = await fsSource.readdir(candidate);
    } catch {
      continue;
    }
    if (!Array.isArray(rootNames) || rootNames.some((entry) => typeof entry !== "string") ||
        rootNames.some(isJournalResidueName) ||
        [...requiredTopLevel].some((entry) => !rootNames.includes(entry))) continue;
    try {
      const scanned = await scanExistingLayout(
        candidate,
        roots.quarantineIdentity.dev,
        fsSource,
        "apply-precommit-resume",
      );
      if (scanned.identities.size === LAYOUT.length) fail("ERR_RECOVERY_REQUIRED");
    } catch (error) {
      if (error instanceof ClassifiedFailure && error.code === "ERR_RECOVERY_REQUIRED") throw error;
      // A sibling is owned only after its entire closed layout validates.
    }
  }
}

async function gateExistingRun(options, roots, fsSource) {
  await gateOtherOwnedPrecommitRun(options, roots, fsSource);
  const runRoot = join(roots.quarantineRoot, options.transactionId);
  let exists = true;
  try {
    await fsSource.lstat(runRoot);
  } catch (error) {
    if (error?.code === "ENOENT") exists = false;
    else fail("ERR_INTEGRITY");
  }
  if (!exists) return;
  await validateLayoutDirectory(
    runRoot,
    runRoot,
    roots.quarantineIdentity.dev,
    fsSource,
  );
  let rootNames;
  try {
    rootNames = await fsSource.readdir(runRoot);
  } catch {
    fail("ERR_INTEGRITY");
  }
  if (!Array.isArray(rootNames) || rootNames.some((name) => typeof name !== "string")) {
    fail("ERR_INTEGRITY");
  }
  if (rootNames.some(isJournalResidueName)) {
    try {
      await withQuarantineRunCapability({
        repoRoot: roots.repoRoot,
        quarantineRoot: roots.quarantineRoot,
        transactionId: options.transactionId,
        writersStopped: true,
        fsApi: fsSource,
      }, async (capability) => {
        if (rootNames.includes("journal.log")) {
          try {
            await replayJournal({ capability });
          } catch {
            // A malformed or torn journal is still recovery evidence. The gate
            // deliberately performs no repair or append.
          }
        }
      });
    } catch (error) {
      if (error instanceof ClassifiedFailure) throw error;
      fail("ERR_INTEGRITY");
    }
    fail("ERR_RECOVERY_REQUIRED");
  }
  await scanExistingLayout(
    runRoot,
    roots.quarantineIdentity.dev,
    fsSource,
    "apply-precommit-resume",
  );
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
      ["tempResidues", discovery.entries.filter((entry) => entry.kind === "temp-residue").length],
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

async function prepareWorkspaceCore(input, mode, hookState) {
  const options = snapshotOptions(input, PREPARE_ALLOWED, PREPARE_REQUIRED);
  validateCommon(options);
  validateTransactionId(options.transactionId);
  validateCreatedAt(options.createdAt);
  if (options.writersStopped !== true) fail("ERR_USAGE");
  if (Object.hasOwn(options, "faultHook") && typeof options.faultHook !== "function") {
    fail("ERR_USAGE");
  }
  const fsSource = captureFsSource(options.fsApi);
  if (mode === "apply-precommit-resume") {
    const roots = await validateRoots(options, fsSource);
    await gateExistingRun(options, roots, fsSource);
  }
  const environment = snapshotGitEnvironment();
  const discovery = await discover(options, fsSource, environment);
  const runRoot = await ensureLayout(discovery, options, fsSource, mode);
  if (options.faultHook !== undefined) {
    try {
      await options.faultHook("after-layout-sync");
    } catch (error) {
      hookState.rejected = true;
      throw error;
    }
  }
  const handoff = record([
    ["status", "LAYOUT_READY"],
    ["transactionId", options.transactionId],
    ["createdAt", options.createdAt],
    ["repoRoot", discovery.roots.repoRoot],
    ["repositoryIdentity", record([
      ["dev", discovery.roots.repoIdentity.dev],
      ["ino", discovery.roots.repoIdentity.ino],
    ])],
    ["quarantineRoot", discovery.roots.quarantineRoot],
    ["runRoot", runRoot],
    ["branch", discovery.branch],
    ["head", discovery.head],
    ["entries", discovery.entries],
    ["fsSource", fsSource],
  ]);
  return { environment, handoff, options };
}

async function invokeApplyHook(faultHook, hookState, phase) {
  if (faultHook === undefined) return;
  try {
    await faultHook(phase);
  } catch (error) {
    hookState.rejected = true;
    throw error;
  }
}

function workspaceEntryPath(repoRoot, entry) {
  return resolve(repoRoot, ...entry.relativePath.split("/"));
}

async function closeFileHandle(handle, primaryError) {
  let closeError;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError !== undefined) {
    if (closeError === undefined) throw primaryError;
    throw new AggregateError([primaryError, closeError], "file operation and close both failed");
  }
  if (closeError !== undefined) throw closeError;
}

async function syncFile(path, identity, fsApi) {
  const handle = await fsApi.open(path, "r");
  let primaryError;
  try {
    const before = await handle.stat();
    assertPrivateFileIdentity(before, identity);
    await handle.sync();
    const after = await handle.stat();
    assertPrivateFileIdentity(after, identity);
  } catch (error) {
    primaryError = error;
  }
  await closeFileHandle(handle, primaryError);
}

function sameFileIdentity(left, right) {
  return (
    Number(left.dev) === Number(right.dev) &&
    Number(left.ino) === Number(right.ino) &&
    modeOf(left) === modeOf(right) &&
    Number(left.size) === Number(right.size)
  );
}

function sameFileObject(left, right) {
  return Number(left.dev) === Number(right.dev) && Number(left.ino) === Number(right.ino);
}

function assertPrivateRegularFile(stats) {
  if (
    stats.isSymbolicLink() || !stats.isFile() || modeOf(stats) !== PRIVATE_FILE_MODE ||
    !safeInteger(Number(stats.size))
  ) fail("ERR_INTEGRITY");
}

function assertPrivateFileIdentity(stats, identity) {
  assertPrivateRegularFile(stats);
  if (!sameFileIdentity(stats, identity)) fail("ERR_INTEGRITY");
}

async function comparePrivateFiles(leftPath, rightPath, fsApi) {
  const left = await fsApi.open(leftPath, "r");
  let right;
  try {
    right = await fsApi.open(rightPath, "r");
  } catch (error) {
    await closeFileHandle(left, error);
  }
  let primaryError;
  let equal = false;
  try {
    const leftStats = await left.stat();
    const rightStats = await right.stat();
    assertPrivateRegularFile(leftStats);
    assertPrivateRegularFile(rightStats);
    const leftSize = Number(leftStats.size);
    const rightSize = Number(rightStats.size);
    const leftHash = createHash("sha256");
    const rightHash = createHash("sha256");
    const leftBuffer = Buffer.allocUnsafe(64 * 1024);
    const rightBuffer = Buffer.allocUnsafe(64 * 1024);
    let leftPosition = 0;
    let rightPosition = 0;
    equal = leftSize === rightSize;
    while (leftPosition < leftSize || rightPosition < rightSize) {
      const leftLength = Math.min(leftBuffer.length, leftSize - leftPosition);
      const rightLength = Math.min(rightBuffer.length, rightSize - rightPosition);
      const [leftRead, rightRead] = await Promise.all([
        leftLength === 0
          ? { bytesRead: 0 }
          : left.read(leftBuffer, 0, leftLength, leftPosition),
        rightLength === 0
          ? { bytesRead: 0 }
          : right.read(rightBuffer, 0, rightLength, rightPosition),
      ]);
      const leftBytes = leftBuffer.subarray(0, leftRead.bytesRead);
      const rightBytes = rightBuffer.subarray(0, rightRead.bytesRead);
      leftHash.update(leftBytes);
      rightHash.update(rightBytes);
      if (
        leftRead.bytesRead !== leftLength || rightRead.bytesRead !== rightLength ||
        leftLength !== rightLength || !leftBytes.equals(rightBytes)
      ) equal = false;
      leftPosition += leftLength;
      rightPosition += rightLength;
    }
    if (leftHash.digest("hex") !== rightHash.digest("hex")) equal = false;
    assertPrivateFileIdentity(await left.stat(), leftStats);
    assertPrivateFileIdentity(await right.stat(), rightStats);
  } catch (error) {
    primaryError = error;
  }
  try {
    await closeFileHandle(left, primaryError);
    primaryError = undefined;
  } catch (error) {
    primaryError = error;
  }
  try {
    await closeFileHandle(right, primaryError);
    primaryError = undefined;
  } catch (error) {
    primaryError = error;
  }
  if (primaryError !== undefined) throw primaryError;
  return equal;
}

async function removeOwnedDiffTemporary({
  capability,
  path,
  id,
  identity,
  retainedPath,
  retainedIdentity,
  fsApi,
}) {
  const current = await fsApi.lstat(path);
  assertPrivateFileIdentity(current, identity);
  if (retainedPath !== undefined) {
    assertPrivateFileIdentity(await fsApi.lstat(retainedPath), retainedIdentity);
  }
  await revalidateRunCapability(capability, {
    purpose: "divergent-diff-temp",
    id,
    boundary: "before-mutation",
  });
  await fsApi.unlink(path);
  await syncDirectory(dirname(path), fsApi);
  await revalidateRunCapability(capability, {
    purpose: "divergent-diff-temp",
    id,
    boundary: "after-sync",
  });
  await assertPathMissing(path, fsApi);
  if (retainedPath !== undefined) {
    assertPrivateFileIdentity(await fsApi.lstat(retainedPath), retainedIdentity);
  }
}

function divergentDiffArgs(entry) {
  return [
    "-c", "core.fsmonitor=false",
    "-c", "core.quotePath=true",
    "diff", "--no-index", "--binary", "--full-index", "--no-color",
    "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "--",
    entry.canonicalRelativePath,
    entry.relativePath,
  ];
}

async function compareCanonicalPatchToFile({
  entry,
  repoRoot,
  environment,
  path,
  identity,
  cap,
  fsApi,
}) {
  const handle = await fsApi.open(path, "r");
  let primaryError;
  let matches = true;
  try {
    const opened = await handle.stat();
    assertPrivateFileIdentity(opened, identity);
    const child = spawn("git", divergentDiffArgs(entry), {
      cwd: repoRoot,
      env: childGitEnvironment(environment),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let invalid = false;
    let stderrBytes = 0;
    let spawnError;
    const terminate = () => {
      if (child.killed) return;
      try { child.kill("SIGKILL"); } catch { invalid = true; }
    };
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > STDERR_LIMIT) { invalid = true; terminate(); }
    });
    child.stderr.on("error", () => { invalid = true; terminate(); });
    child.once("error", (error) => { spawnError = error; });
    const closed = new Promise((resolveClose) => {
      child.once("close", (code, signal) => resolveClose({ code, signal }));
    });
    let position = 0;
    const childHash = createHash("sha256");
    const fileHash = createHash("sha256");
    const expected = Buffer.allocUnsafe(64 * 1024);
    try {
      for await (const chunk of child.stdout) {
        if (position + chunk.length > cap) { invalid = true; terminate(); continue; }
        childHash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const length = Math.min(expected.length, chunk.length - offset);
          const read = await handle.read(expected, 0, length, position);
          const fileBytes = expected.subarray(0, read.bytesRead);
          fileHash.update(fileBytes);
          if (
            read.bytesRead !== length ||
            !fileBytes.equals(chunk.subarray(offset, offset + length))
          ) matches = false;
          position += length;
          offset += length;
        }
      }
    } catch {
      invalid = true;
      terminate();
    }
    const outcome = await closed;
    if (
      invalid || spawnError !== undefined || outcome.signal !== null || outcome.code !== 1 ||
      position !== Number(opened.size)
    ) fail("ERR_INTEGRITY");
    if (childHash.digest("hex") !== fileHash.digest("hex")) fail("ERR_INTEGRITY");
    assertPrivateFileIdentity(await handle.stat(), identity);
  } catch (error) {
    primaryError = error;
  }
  await closeFileHandle(handle, primaryError);
  assertPrivateFileIdentity(await fsApi.lstat(path), identity);
  if (!matches) fail("ERR_INTEGRITY");
}

async function adoptPreexistingDivergentTemporary({
  capability,
  entry,
  repoRoot,
  environment,
  temporaryPath,
  finalPath,
  cap,
  fsApi,
}) {
  const temporary = await fsApi.lstat(temporaryPath);
  assertPrivateRegularFile(temporary);
  await compareCanonicalPatchToFile({
    entry,
    repoRoot,
    environment,
    path: temporaryPath,
    identity: temporary,
    cap,
    fsApi,
  });
  const beforeLink = await fsApi.lstat(temporaryPath);
  assertPrivateFileIdentity(beforeLink, temporary);
  let final;
  try {
    final = await fsApi.lstat(finalPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (final === undefined) {
    await revalidateRunCapability(capability, {
      purpose: "divergent-diff",
      id: entry.id,
      boundary: "before-mutation",
    });
    await fsApi.link(temporaryPath, finalPath);
    final = await fsApi.lstat(finalPath);
  }
  assertPrivateFileIdentity(final, temporary);
  assertPrivateFileIdentity(await fsApi.lstat(temporaryPath), temporary);
  await syncFile(finalPath, temporary, fsApi);
  assertPrivateFileIdentity(await fsApi.lstat(temporaryPath), temporary);
  assertPrivateFileIdentity(await fsApi.lstat(finalPath), temporary);
  const tempBeforeParent = await fsApi.lstat(temporaryPath);
  const finalBeforeParent = await fsApi.lstat(finalPath);
  assertPrivateFileIdentity(tempBeforeParent, temporary);
  assertPrivateFileIdentity(finalBeforeParent, temporary);
  await syncDirectory(dirname(finalPath), fsApi);
  await revalidateRunCapability(capability, {
    purpose: "divergent-diff",
    id: entry.id,
    boundary: "after-sync",
  });
  const durableTemporary = await fsApi.lstat(temporaryPath);
  const durableFinal = await fsApi.lstat(finalPath);
  assertPrivateFileIdentity(durableTemporary, temporary);
  assertPrivateFileIdentity(durableFinal, temporary);
  await removeOwnedDiffTemporary({
    capability,
    path: temporaryPath,
    id: entry.id,
    identity: temporary,
    retainedPath: finalPath,
    retainedIdentity: temporary,
    fsApi,
  });
  assertPrivateFileIdentity(await fsApi.lstat(finalPath), temporary);
}

async function publishDivergentPatch({
  capability,
  entry,
  repoRoot,
  environment,
  fsApi,
}) {
  const combinedSize = entry.sourceIdentity.size + entry.canonicalIdentity.size;
  const cap = 4 * combinedSize + 1_048_576;
  if (!Number.isSafeInteger(combinedSize) || combinedSize < 0 || !Number.isSafeInteger(cap)) {
    fail("ERR_INTEGRITY");
  }
  const temporaryPath = deriveRunPath(capability, {
    purpose: "divergent-diff-temp",
    id: entry.id,
  });
  const finalPath = deriveRunPath(capability, { purpose: "divergent-diff", id: entry.id });
  await revalidateRunCapability(capability, {
    purpose: "divergent-diff-temp",
    id: entry.id,
    boundary: "before-mutation",
  });
  let handle;
  try {
    handle = await fsApi.open(temporaryPath, "wx", PRIVATE_FILE_MODE);
  } catch (error) {
    if (error?.code === "EEXIST") {
      await adoptPreexistingDivergentTemporary({
        capability,
        entry,
        repoRoot,
        environment,
        temporaryPath,
        finalPath,
        cap,
        fsApi,
      });
      return;
    }
    throw error;
  }
  let identity;
  let published = false;
  let primaryError;
  try {
    await handle.chmod(PRIVATE_FILE_MODE);
    identity = await handle.stat();
    assertPrivateRegularFile(identity);
    const pathIdentity = await fsApi.lstat(temporaryPath);
    if (!sameFileIdentity(identity, pathIdentity)) fail("ERR_INTEGRITY");
    const child = spawn("git", divergentDiffArgs(entry), {
      cwd: repoRoot,
      env: childGitEnvironment(environment),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderrBytes = 0;
    let invalid = false;
    let spawnError;
    const terminate = () => {
      if (child.killed) return;
      try { child.kill("SIGKILL"); } catch { invalid = true; }
    };
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > STDERR_LIMIT) {
        invalid = true;
        terminate();
      }
    });
    child.stderr.on("error", () => { invalid = true; terminate(); });
    child.once("error", (error) => { spawnError = error; });
    const closed = new Promise((resolveClose) => {
      child.once("close", (code, signal) => resolveClose({ code, signal }));
    });
    let bytes = 0;
    try {
      for await (const chunk of child.stdout) {
        bytes += chunk.length;
        if (bytes > cap) {
          invalid = true;
          terminate();
          continue;
        }
        let offset = 0;
        while (offset < chunk.length) {
          const written = await handle.write(chunk, offset, chunk.length - offset, null);
          if (!Number.isSafeInteger(written.bytesWritten) || written.bytesWritten <= 0) {
            throw new Error("divergent patch write made no progress");
          }
          offset += written.bytesWritten;
        }
      }
    } catch {
      invalid = true;
      terminate();
    }
    const outcome = await closed;
    if (invalid || spawnError !== undefined || outcome.signal !== null || outcome.code !== 1) {
      fail("ERR_INTEGRITY");
    }
    await handle.sync();
    const completedIdentity = await handle.stat();
    assertPrivateRegularFile(completedIdentity);
    if (!sameFileObject(identity, completedIdentity) || Number(completedIdentity.size) !== bytes) {
      fail("ERR_INTEGRITY");
    }
    identity = completedIdentity;
    await closeFileHandle(handle);
    handle = undefined;
    await revalidateRunCapability(capability, {
      purpose: "divergent-diff-temp",
      id: entry.id,
      boundary: "after-sync",
    });
    const durableTemporary = await fsApi.lstat(temporaryPath);
    assertPrivateFileIdentity(durableTemporary, identity);
    await revalidateRunCapability(capability, {
      purpose: "divergent-diff",
      id: entry.id,
      boundary: "before-mutation",
    });
    try {
      await fsApi.link(temporaryPath, finalPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await fsApi.lstat(finalPath);
      assertPrivateRegularFile(existing);
      if (!(await comparePrivateFiles(temporaryPath, finalPath, fsApi))) {
        fail("ERR_INTEGRITY");
      }
      const afterRead = await fsApi.lstat(finalPath);
      assertPrivateFileIdentity(afterRead, existing);
      assertPrivateFileIdentity(await fsApi.lstat(temporaryPath), identity);
      await syncFile(finalPath, existing, fsApi);
      assertPrivateFileIdentity(await fsApi.lstat(temporaryPath), identity);
      assertPrivateFileIdentity(await fsApi.lstat(finalPath), existing);
      await syncDirectory(dirname(finalPath), fsApi);
      await revalidateRunCapability(capability, {
        purpose: "divergent-diff",
        id: entry.id,
        boundary: "after-sync",
      });
      const durableExisting = await fsApi.lstat(finalPath);
      assertPrivateFileIdentity(durableExisting, existing);
      assertPrivateFileIdentity(await fsApi.lstat(temporaryPath), identity);
      await removeOwnedDiffTemporary({
        capability,
        path: temporaryPath,
        id: entry.id,
        identity,
        retainedPath: finalPath,
        retainedIdentity: existing,
        fsApi,
      });
      const retainedExisting = await fsApi.lstat(finalPath);
      assertPrivateFileIdentity(retainedExisting, existing);
      return;
    }
    published = true;
    const linked = await fsApi.lstat(finalPath);
    assertPrivateFileIdentity(linked, identity);
    assertPrivateFileIdentity(await fsApi.lstat(temporaryPath), identity);
    await syncFile(finalPath, identity, fsApi);
    assertPrivateFileIdentity(await fsApi.lstat(temporaryPath), identity);
    assertPrivateFileIdentity(await fsApi.lstat(finalPath), identity);
    await syncDirectory(dirname(finalPath), fsApi);
    await revalidateRunCapability(capability, {
      purpose: "divergent-diff",
      id: entry.id,
      boundary: "after-sync",
    });
    const durableFinal = await fsApi.lstat(finalPath);
    assertPrivateFileIdentity(durableFinal, identity);
    assertPrivateFileIdentity(await fsApi.lstat(temporaryPath), identity);
    await removeOwnedDiffTemporary({
      capability,
      path: temporaryPath,
      id: entry.id,
      identity,
      retainedPath: finalPath,
      retainedIdentity: identity,
      fsApi,
    });
    const retainedFinal = await fsApi.lstat(finalPath);
    assertPrivateFileIdentity(retainedFinal, identity);
  } catch (error) {
    primaryError = error;
  }
  if (handle !== undefined) {
    try {
      await closeFileHandle(handle, primaryError);
    } catch (error) {
      primaryError = error;
    }
  }
  if (primaryError !== undefined) {
    if (!published && identity !== undefined) {
      try {
        await removeOwnedDiffTemporary({
          capability,
          path: temporaryPath,
          id: entry.id,
          identity,
          fsApi,
        });
      } catch {
        // Preserve cleanup uncertainty; orchestration reports integrity only.
      }
    }
    throw primaryError;
  }
}

function preparedManifest(handoff, entries) {
  return buildValidatedManifest({
    schemaVersion: 2,
    transactionId: handoff.transactionId,
    state: "PREPARED",
    repositoryRoot: handoff.repoRoot,
    head: handoff.head,
    createdAt: handoff.createdAt,
    validatedAt: null,
    retentionDays: 4,
    deletionRequiresConfirmation: true,
    deleteAfter: null,
    deletionStatus: "retained",
    entries: entries.map(({ entry, preMoveInventory }) => entry.kind === "source-copy" ? {
      id: entry.id,
      kind: entry.kind,
      relativePath: entry.relativePath,
      canonicalRelativePath: entry.canonicalRelativePath,
      mode: entry.sourceIdentity.mode,
      size: entry.sourceIdentity.size,
      sha256: entry.sourceIdentity.sha256,
      canonicalSize: entry.canonicalIdentity.size,
      canonicalSha256: entry.canonicalIdentity.sha256,
      classification: entry.classification,
      historyMatch: entry.historyMatch,
      preMoveInventory,
    } : entry.kind === "temp-residue" ? {
      id: entry.id,
      kind: entry.kind,
      relativePath: entry.relativePath,
      mode: entry.sourceIdentity.mode,
      size: entry.sourceIdentity.size,
      sha256: entry.sourceIdentity.sha256,
      preMoveInventory,
    } : {
      id: entry.id,
      kind: entry.kind,
      relativePath: entry.relativePath,
      mode: entry.sourceIdentity.mode,
      preMoveInventory,
    }),
    branch: handoff.branch,
    repositoryIdentity: handoff.repositoryIdentity,
    validationAttempt: null,
    regeneratedEvidence: null,
  });
}

async function appendEvent({ capability, event, payload, faultHook }) {
  return withJournalLock({ capability }, async (heldLock) => appendJournalRecord({
    capability,
    heldLock,
    event,
    payload,
    schemaVersion: 2,
    faultHook,
  }));
}

const RECOVERY_ALLOWED = Object.freeze([
  "repoRoot", "quarantineRoot", "transactionId", "action", "writersStopped", "fsApi", "faultHook",
]);
const RECOVERY_REQUIRED = Object.freeze([
  "repoRoot", "quarantineRoot", "transactionId", "action", "writersStopped",
]);

function snapshotRecoveryOptions(input) {
  const options = snapshotOptions(input, RECOVERY_ALLOWED, RECOVERY_REQUIRED);
  validateAbsolute(options.repoRoot);
  validateAbsolute(options.quarantineRoot);
  validateTransactionId(options.transactionId);
  if (options.writersStopped !== true) fail("ERR_USAGE");
  if (options.action !== "resume" && options.action !== "rollback") fail("ERR_USAGE");
  if (options.faultHook !== undefined && typeof options.faultHook !== "function") {
    fail("ERR_USAGE");
  }
  return options;
}

function recoveryResult(schemaVersion, transactionId, status, action, reconciledEntries) {
  return record([
    ["schemaVersion", schemaVersion],
    ["transactionId", transactionId],
    ["status", status],
    ["action", action],
    ["reconciledEntries", reconciledEntries],
  ]);
}

function recoveryConflict(schemaVersion, transactionId, action, ids) {
  return record([
    ["schemaVersion", schemaVersion],
    ["transactionId", transactionId],
    ["status", "INCOMPLETE_CONFLICT"],
    ["action", action],
    ["conflictEntryIds", Object.freeze([...ids].sort(byteCompare))],
  ]);
}

function buildApplyLedger(replayed, manifest, manifestSha256) {
  const prepared = replayed.records.find((record) => record.event === "PREPARED");
  if (
    prepared === undefined ||
    prepared.payload.transactionId !== manifest.transactionId
  ) fail("ERR_INTEGRITY");
  const entries = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const intents = [];
  const completed = new Set();
  const rollbackIntents = new Set();
  const rollbackCompleted = new Set();
  let rollbackPending = null;
  let completionIndex = 0;
  for (const record of replayed.records) {
    if (record.event === "MOVE_INTENT") {
      const entry = manifest.entries[intents.length];
      if (entry === undefined || entry.id !== record.payload.id) fail("ERR_INTEGRITY");
      if (
        record.payload.expected.sha256 !== entry.preMoveInventory.sha256 ||
        record.payload.expected.entries !== entry.preMoveInventory.entries ||
        record.payload.expected.bytes !== entry.preMoveInventory.bytes
      ) fail("ERR_INTEGRITY");
      intents.push(entry);
    } else if (record.event === "MOVED") {
      if (intents[completionIndex]?.id !== record.payload.id) fail("ERR_INTEGRITY");
      completed.add(record.payload.id);
      completionIndex += 1;
    } else if (
      record.event === "VALIDATED" &&
      record.payload.manifestSha256 !== manifestSha256
    ) {
      fail("ERR_INTEGRITY");
    } else if (record.event === "ROLLBACK_INTENT") {
      if (rollbackPending !== null || rollbackCompleted.has(record.payload.id)) fail("ERR_INTEGRITY");
      rollbackIntents.add(record.payload.id);
      rollbackPending = record.payload.id;
    } else if (record.event === "ROLLED_BACK_ENTRY") {
      if (rollbackPending !== record.payload.id) fail("ERR_INTEGRITY");
      rollbackCompleted.add(record.payload.id);
      rollbackPending = null;
    }
  }
  if (
    (replayed.state === "QUARANTINED" || replayed.state === "VALIDATED") &&
    (intents.length !== manifest.entries.length ||
      completed.size !== manifest.entries.length ||
      completionIndex !== manifest.entries.length)
  ) fail("ERR_INTEGRITY");
  return Object.freeze({
    completed,
    entries,
    intents: Object.freeze(intents),
    intentIds: Object.freeze(intents.map((entry) => entry.id)),
    rollbackIntents,
    rollbackCompleted,
    rollbackPending,
  });
}

async function appendHeldEvent({ capability, heldLock, event, payload, faultHook }) {
  return appendJournalRecord({ capability, heldLock, event, payload, faultHook });
}

async function appendRecoveryEvent({ capability, heldLock, event, payload, faultHook, phase }) {
  await appendHeldEvent({ capability, heldLock, event, payload, faultHook });
  await invokeApplyHook(faultHook, { rejected: false }, phase);
}

async function endpointStat(path, fsApi) {
  try {
    const stat = await fsApi.lstat(path);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) fail("ERR_INTEGRITY");
    return stat;
  } catch (error) {
    if (error instanceof ClassifiedFailure) throw error;
    if (error?.code === "ENOENT") return null;
    fail("ERR_INTEGRITY");
  }
}

async function endpointMatchesInventory({ capability, entry, path, phase }) {
  if (entry.kind !== "generated-root") {
    try {
      const fsApi = getRunFsContext(capability);
      const stat = await fsApi.lstat(path);
      if (
        stat.isSymbolicLink() || !stat.isFile() || modeOf(stat) !== entry.mode ||
        Number(stat.size) !== entry.size
      ) return null;
      const hash = createHash("sha256");
      const stream = fsApi.createReadStream(path, { highWaterMark: BLOB_STREAM_HIGH_WATER_MARK });
      for await (const chunk of stream) hash.update(chunk);
      return hash.digest("hex") === entry.sha256 ? entry.preMoveInventory : null;
    } catch {
      return null;
    }
  }
  try {
    const observed = await writeInventoryJsonl({
      capability,
      root: path,
      entryId: entry.id,
      phase,
    });
    await compareInventorySummary(entry.preMoveInventory, observed);
    return observed;
  } catch {
    return null;
  }
}

async function classifyApplyEndpoint({ capability, entry, repoRoot, fsApi }) {
  const source = workspaceEntryPath(repoRoot, entry);
  const payload = deriveRunPath(capability, { purpose: "payload", id: entry.id });
  const sourceStat = await endpointStat(source, fsApi);
  const payloadStat = await endpointStat(payload, fsApi);
  const sourceObserved = sourceStat === null
    ? null
    : await endpointMatchesInventory({
      capability,
      entry,
      path: source,
      phase: "validation-pass-1",
    });
  const payloadObserved = payloadStat === null
    ? null
    : await endpointMatchesInventory({
      capability,
      entry,
      path: payload,
      phase: "validation-pass-2",
    });
  return { payload, payloadObserved, payloadStat, source, sourceObserved, sourceStat };
}

async function guardedRecoveryRename({
  capability,
  entry,
  repoRoot,
  workspace,
  payload,
  toPayload,
  fsApi,
  faultHook,
}) {
  const workspaceAncestors = await captureSourceAncestors(repoRoot, workspace, fsApi);
  const payloadParent = dirname(payload);
  const payloadParentIdentity = await capturePrivateDirectory(payloadParent, fsApi);
  const expectedSource = toPayload ? workspace : payload;
  const expectedDestination = toPayload ? payload : workspace;
  const sourcePhase = toPayload ? "validation-pass-1" : "validation-pass-2";
  const destinationPhase = toPayload ? "validation-pass-2" : "validation-pass-1";

  const assertBeforeRename = async () => {
    await revalidateRunCapability(capability, {
      purpose: "payload",
      id: entry.id,
      boundary: "before-mutation",
    });
    await assertSourceAncestors(repoRoot, workspaceAncestors, fsApi);
    await assertPrivateDirectoryIdentity(payloadParent, payloadParentIdentity, fsApi);
    if (await endpointStat(expectedDestination, fsApi) !== null) fail("ERR_INTEGRITY");
    if (await endpointStat(expectedSource, fsApi) === null) fail("ERR_INTEGRITY");
    if ((await endpointMatchesInventory({
      capability,
      entry,
      path: expectedSource,
      phase: sourcePhase,
    })) === null) fail("ERR_INTEGRITY");
  };
  const assertAfterRename = async () => {
    await revalidateRunCapability(capability, {
      purpose: "payload",
      id: entry.id,
      boundary: "after-sync",
    });
    await assertSourceAncestors(repoRoot, workspaceAncestors, fsApi);
    await assertPrivateDirectoryIdentity(payloadParent, payloadParentIdentity, fsApi);
    await assertPathMissing(expectedSource, fsApi);
    if ((await endpointMatchesInventory({
      capability,
      entry,
      path: expectedDestination,
      phase: destinationPhase,
    })) === null) fail("ERR_INTEGRITY");
  };

  await assertBeforeRename();
  try {
    await fsApi.rename(expectedSource, expectedDestination);
  } catch (error) {
    if (error?.code === "EXDEV") fail("ERR_EXDEV");
    throw error;
  }
  if (!toPayload) await invokeApplyHook(faultHook, { rejected: false }, `after-rollback-rename:${entry.id}`);
  if (toPayload) {
    try {
      await fsyncTree({ capability, root: payload, entryId: entry.id, purpose: "payload" });
    } catch {
      fail("ERR_INTEGRITY");
    }
  } else {
    try {
      // The restored workspace endpoint is the rollback destination. Its data
      // must be durable before publishing the payload-sync recovery seam.
      await syncDirectory(expectedDestination, fsApi);
    } catch {
      fail("ERR_INTEGRITY");
    }
    await invokeApplyHook(faultHook, { rejected: false }, `after-rollback-payload-sync:${entry.id}`);
  }
  await assertAfterRename();
  if (toPayload) {
    try {
      await syncDirectory(payloadParent, fsApi);
      await syncDirectory(dirname(workspace), fsApi);
    } catch {
      fail("ERR_INTEGRITY");
    }
  } else {
    try {
      // The restored workspace parent is the rollback destination parent.
      await syncDirectory(dirname(expectedDestination), fsApi);
    } catch {
      fail("ERR_INTEGRITY");
    }
    await invokeApplyHook(
      faultHook,
      { rejected: false },
      `after-rollback-destination-parent-sync:${entry.id}`,
    );
    await assertAfterRename();
    try {
      // The quarantine payload parent is the rollback source parent.
      await syncDirectory(dirname(expectedSource), fsApi);
    } catch {
      fail("ERR_INTEGRITY");
    }
    await invokeApplyHook(
      faultHook,
      { rejected: false },
      `after-rollback-source-parent-sync:${entry.id}`,
    );
  }
  await assertAfterRename();
}

async function readRecoveryManifest({ capability, options, replayed }) {
  const prepared = replayed.records.find((record) => record.event === "PREPARED");
  if (prepared === undefined || prepared.payload.transactionId !== options.transactionId) {
    fail("ERR_INTEGRITY");
  }
  const validated = [...replayed.records].reverse().find((record) => record.event === "VALIDATED");
  const selectedSha256 = replayed.state === "VALIDATED"
    ? validated?.payload.manifestSha256
    : prepared.payload.manifestSha256;
  if (typeof selectedSha256 !== "string") fail("ERR_INTEGRITY");
  let manifest;
  try {
    manifest = await readManifestGeneration({
      capability,
      manifestSha256: selectedSha256,
    });
  } catch {
    fail("ERR_INTEGRITY");
  }
  if (
    manifest.transactionId !== options.transactionId ||
    manifest.repositoryRoot !== options.repoRoot ||
    manifest.state !== (replayed.state === "VALIDATED" ? "VALIDATED" : "PREPARED")
  ) fail("ERR_INTEGRITY");
  return Object.freeze({ manifest, manifestSha256: selectedSha256 });
}

async function resumeApplyFromLedger({ capability, heldLock, ledger, manifest, options }) {
  const fsApi = getRunFsContext(capability);
  const classifications = new Map();
  const conflicts = [];
  for (const entry of manifest.entries) {
    const endpoint = await classifyApplyEndpoint({
      capability,
      entry,
      repoRoot: options.repoRoot,
      fsApi,
    });
    classifications.set(entry.id, endpoint);
    const sourceMatches = endpoint.sourceStat !== null && endpoint.sourceObserved !== null;
    const payloadMatches = endpoint.payloadStat !== null && endpoint.payloadObserved !== null;
    if ((endpoint.sourceStat !== null && !sourceMatches) ||
        (endpoint.payloadStat !== null && !payloadMatches) ||
        (endpoint.sourceStat !== null && endpoint.payloadStat !== null) ||
        (endpoint.sourceStat === null && endpoint.payloadStat === null) ||
        (!ledger.intentIds.includes(entry.id) && endpoint.sourceStat === null) ||
        (ledger.completed.has(entry.id) && endpoint.sourceStat !== null)) {
      conflicts.push(entry.id);
    }
  }
  if (conflicts.length > 0) {
    await appendRecoveryEvent({
      capability,
      heldLock,
      event: "INCOMPLETE_CONFLICT",
      payload: { conflictEntryIds: [...conflicts].sort(byteCompare) },
      faultHook: options.faultHook,
      phase: "after-event:INCOMPLETE_CONFLICT",
    });
    return recoveryConflict(manifest.schemaVersion, options.transactionId, "resume", conflicts);
  }

  await appendHeldEvent({ capability, heldLock, event: "MOVING", payload: {}, faultHook: options.faultHook });
  let reconciledEntries = 0;
  const intended = new Set(ledger.intentIds);
  const workOrder = [
    ...ledger.intents,
    ...manifest.entries.filter((entry) => !intended.has(entry.id)),
  ];
  for (const entry of workOrder) {
    const endpoint = classifications.get(entry.id);
    if (!intended.has(entry.id)) {
      await appendHeldEvent({
        capability,
        heldLock,
        event: "MOVE_INTENT",
        payload: { id: entry.id, expected: entry.preMoveInventory },
        faultHook: options.faultHook,
      });
      intended.add(entry.id);
    }
    if (endpoint.sourceStat !== null) {
      await guardedRecoveryRename({
        capability,
        entry,
        repoRoot: options.repoRoot,
        workspace: endpoint.source,
        payload: endpoint.payload,
        toPayload: true,
        fsApi,
      });
      const observed = await endpointMatchesInventory({
        capability,
        entry,
        path: endpoint.payload,
        phase: "validation-pass-2",
      });
      if (observed === null) fail("ERR_INTEGRITY");
      await appendHeldEvent({
        capability,
        heldLock,
        event: "MOVED",
        payload: { id: entry.id, observed },
        faultHook: options.faultHook,
      });
      reconciledEntries += 1;
    } else if (!ledger.completed.has(entry.id)) {
      await appendHeldEvent({
        capability,
        heldLock,
        event: "MOVED",
        payload: { id: entry.id, observed: endpoint.payloadObserved },
        faultHook: options.faultHook,
      });
      reconciledEntries += 1;
    }
  }
  await appendHeldEvent({ capability, heldLock, event: "VERIFYING", payload: {}, faultHook: options.faultHook });
  await appendHeldEvent({ capability, heldLock, event: "QUARANTINED", payload: {}, faultHook: options.faultHook });
  return recoveryResult(manifest.schemaVersion, options.transactionId, "QUARANTINED", "resume", reconciledEntries);
}

async function rollbackApplyFromLedger({
  capability,
  heldLock,
  ledger,
  manifest,
  options,
  isRollingBack,
}) {
  const fsApi = getRunFsContext(capability);
  const classifications = new Map();
  const conflicts = [];
  for (const entry of ledger.intents) {
    const endpoint = await classifyApplyEndpoint({ capability, entry, repoRoot: options.repoRoot, fsApi });
    classifications.set(entry.id, endpoint);
    const sourceMatches = endpoint.sourceStat !== null && endpoint.sourceObserved !== null;
    const payloadMatches = endpoint.payloadStat !== null && endpoint.payloadObserved !== null;
    if ((endpoint.sourceStat !== null && !sourceMatches) ||
        (endpoint.payloadStat !== null && !payloadMatches) ||
        (endpoint.sourceStat !== null && endpoint.payloadStat !== null) ||
        (endpoint.sourceStat === null && endpoint.payloadStat === null)) conflicts.push(entry.id);
  }
  if (conflicts.length > 0) {
    await appendRecoveryEvent({
      capability,
      heldLock,
      event: "INCOMPLETE_CONFLICT",
      payload: { conflictEntryIds: [...conflicts].sort(byteCompare) },
      faultHook: options.faultHook,
      phase: "after-event:INCOMPLETE_CONFLICT",
    });
    return recoveryConflict(manifest.schemaVersion, options.transactionId, "rollback", conflicts);
  }
  if (!isRollingBack) {
    await appendRecoveryEvent({
      capability,
      heldLock,
      event: "ROLLING_BACK",
      payload: {},
      faultHook: options.faultHook,
      phase: "after-event:ROLLING_BACK",
    });
  }
  let reconciledEntries = 0;
  let rollbackPending = ledger.rollbackPending;
  for (const entry of [...ledger.intents].reverse()) {
    const endpoint = classifications.get(entry.id);
    if (ledger.rollbackCompleted.has(entry.id)) continue;
    if (rollbackPending !== entry.id) {
      if (rollbackPending !== null || ledger.rollbackIntents.has(entry.id)) fail("ERR_INTEGRITY");
      await appendRecoveryEvent({
        capability,
        heldLock,
        event: "ROLLBACK_INTENT",
        payload: { id: entry.id },
        faultHook: options.faultHook,
        phase: `after-event:ROLLBACK_INTENT:${entry.id}`,
      });
    }
    if (endpoint.payloadStat !== null) {
      await guardedRecoveryRename({
        capability,
        entry,
        repoRoot: options.repoRoot,
        workspace: endpoint.source,
        payload: endpoint.payload,
        toPayload: false,
        fsApi,
        faultHook: options.faultHook,
      });
      reconciledEntries += 1;
    }
    await appendRecoveryEvent({
      capability,
      heldLock,
      event: "ROLLED_BACK_ENTRY",
      payload: { id: entry.id },
      faultHook: options.faultHook,
      phase: `after-event:ROLLED_BACK_ENTRY:${entry.id}`,
    });
    rollbackPending = null;
  }
  await appendRecoveryEvent({
    capability,
    heldLock,
    event: "ROLLED_BACK",
    payload: {},
    faultHook: options.faultHook,
    phase: "after-event:ROLLED_BACK",
  });
  return recoveryResult(manifest.schemaVersion, options.transactionId, "ROLLED_BACK", "rollback", reconciledEntries);
}

async function recoverApplyOnCapability({ capability, options }) {
  const initial = await replayJournal({ capability });
  // Recovery is a reconciliation operation, not journal repair. A torn tail is
  // evidence of an interrupted append and must remain untouched for explicit
  // operator investigation.
  if (initial.truncatedTail) fail("ERR_INTEGRITY");
  // Terminal shortcuts are safe only after the immutable recovery evidence has
  // been authenticated. This performs no append or filesystem mutation.
  const initialGeneration = await readRecoveryManifest({ capability, options, replayed: initial });
  const initialManifest = initialGeneration.manifest;
  buildApplyLedger(initial, initialManifest, initialGeneration.manifestSha256);
  if (initial.state === "QUARANTINED" || initial.state === "VALIDATED") {
    if (options.action !== "resume") fail("ERR_USAGE");
    return recoveryResult(initialManifest.schemaVersion, options.transactionId, initial.state, "resume", 0);
  }
  if (initial.state === "ROLLED_BACK") {
    if (options.action !== "rollback") fail("ERR_USAGE");
    return recoveryResult(initialManifest.schemaVersion, options.transactionId, "ROLLED_BACK", "rollback", 0);
  }
  if (initial.state === "INCOMPLETE_CONFLICT") {
    const conflict = initial.records.at(-1)?.payload?.conflictEntryIds;
    if (!Array.isArray(conflict)) fail("ERR_INTEGRITY");
    return recoveryConflict(initialManifest.schemaVersion, options.transactionId, options.action, conflict);
  }
  return withJournalLock({ capability }, async (heldLock) => {
    const replayed = await replayJournal({ capability });
    const generation = await readRecoveryManifest({ capability, options, replayed });
    const manifest = generation.manifest;
    const ledger = buildApplyLedger(replayed, manifest, generation.manifestSha256);
    if (replayed.state !== "RECOVERY_REQUIRED" && replayed.state !== "ROLLING_BACK") {
      if (
        replayed.state !== "PREPARED" &&
        replayed.state !== "MOVING" &&
        replayed.state !== "VERIFYING" &&
        replayed.state !== "ROLLING_BACK"
      ) fail("ERR_INTEGRITY");
      await appendRecoveryEvent({
        capability,
        heldLock,
        event: "RECOVERY_REQUIRED",
        payload: { entryIds: ledger.intentIds },
        faultHook: options.faultHook,
        phase: "after-event:RECOVERY_REQUIRED",
      });
    }
    return options.action === "resume"
      ? resumeApplyFromLedger({ capability, heldLock, ledger, manifest, options })
      : rollbackApplyFromLedger({
        capability,
        heldLock,
        ledger,
        manifest,
        options,
        isRollingBack: replayed.state === "ROLLING_BACK",
      });
  });
}

async function assertEntrySourceIdentity(path, entry, fsApi) {
  let stats;
  try {
    stats = await fsApi.lstat(path);
  } catch {
    fail("ERR_INTEGRITY");
  }
  const expected = entry.sourceIdentity;
  if (
    stats.isSymbolicLink() ||
    (entry.kind === "generated-root" ? !stats.isDirectory() : !stats.isFile()) ||
    Number(stats.dev) !== expected.dev || Number(stats.ino) !== expected.ino ||
    modeOf(stats) !== expected.mode ||
    (entry.kind !== "generated-root" && Number(stats.size) !== expected.size)
  ) fail("ERR_INTEGRITY");
  if (entry.kind !== "generated-root") {
    let sha256;
    try {
      sha256 = await hashFile(path, fsApi);
    } catch {
      fail("ERR_INTEGRITY");
    }
    if (sha256 !== expected.sha256) fail("ERR_INTEGRITY");
  }
}

async function assertPathMissing(path, fsApi) {
  try {
    await fsApi.lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail("ERR_INTEGRITY");
  }
  fail("ERR_INTEGRITY");
}

async function captureWorkspaceDirectory(path, repoRoot, fsApi) {
  let stats;
  let resolved;
  try {
    stats = await fsApi.lstat(path);
    resolved = await fsApi.realpath(path);
  } catch {
    fail("ERR_INTEGRITY");
  }
  if (
    stats.isSymbolicLink() || !stats.isDirectory() || resolved !== path ||
    (path !== repoRoot && !isInside(repoRoot, resolved))
  ) fail("ERR_INTEGRITY");
  return statsIdentity(stats, false);
}

async function captureSourceAncestors(repoRoot, source, fsApi) {
  const sourceRelative = relative(repoRoot, source);
  if (
    sourceRelative === "" || sourceRelative === ".." ||
    sourceRelative.startsWith(`..${sep}`) || isAbsolute(sourceRelative)
  ) fail("ERR_INTEGRITY");
  const components = sourceRelative.split(sep);
  const ancestors = [];
  let current = repoRoot;
  ancestors.push(Object.freeze({
    path: current,
    identity: Object.freeze(await captureWorkspaceDirectory(current, repoRoot, fsApi)),
  }));
  for (const component of components.slice(0, -1)) {
    current = join(current, component);
    ancestors.push(Object.freeze({
      path: current,
      identity: Object.freeze(await captureWorkspaceDirectory(current, repoRoot, fsApi)),
    }));
  }
  return Object.freeze(ancestors);
}

async function assertSourceAncestors(repoRoot, ancestors, fsApi) {
  for (const expected of ancestors) {
    const observed = await captureWorkspaceDirectory(expected.path, repoRoot, fsApi);
    if (
      observed.dev !== expected.identity.dev || observed.ino !== expected.identity.ino ||
      observed.mode !== expected.identity.mode
    ) fail("ERR_INTEGRITY");
  }
}

async function capturePrivateDirectory(path, fsApi) {
  let stats;
  let resolved;
  try {
    stats = await fsApi.lstat(path);
    resolved = await fsApi.realpath(path);
  } catch {
    fail("ERR_INTEGRITY");
  }
  if (
    stats.isSymbolicLink() || !stats.isDirectory() ||
    modeOf(stats) !== PRIVATE_MODE || resolved !== path
  ) fail("ERR_INTEGRITY");
  return statsIdentity(stats, false);
}

async function assertPrivateDirectoryIdentity(path, identity, fsApi) {
  const observed = await capturePrivateDirectory(path, fsApi);
  if (
    observed.dev !== identity.dev || observed.ino !== identity.ino ||
    observed.mode !== identity.mode
  ) fail("ERR_INTEGRITY");
}

async function validatePayloadEndpoint({
  capability,
  purpose = "payload",
  entry,
  destination,
  destinationParent,
  destinationParentIdentity,
  boundary,
  fsApi,
}) {
  await revalidateRunCapability(capability, {
    purpose,
    id: entry.id,
    boundary,
  });
  await assertPrivateDirectoryIdentity(destinationParent, destinationParentIdentity, fsApi);
  await assertEntrySourceIdentity(destination, entry, fsApi);
}

async function validateMovedEndpointEvidence(capability, evidence, boundary, fsApi) {
  await validatePayloadEndpoint({
    capability,
    purpose: evidence.purpose,
    entry: evidence.entry,
    destination: evidence.destination,
    destinationParent: evidence.destinationParent,
    destinationParentIdentity: evidence.destinationParentIdentity,
    boundary,
    fsApi,
  });
  await assertSourceAncestors(evidence.repoRoot, evidence.sourceAncestors, fsApi);
  await assertPathMissing(evidence.source, fsApi);
}

async function movePreparedEntry({
  capability,
  handoff,
  planned,
  options,
  hookState,
  fsApi,
}) {
  const { entry, preMoveInventory } = planned;
  const source = workspaceEntryPath(handoff.repoRoot, entry);
  const destination = deriveRunPath(capability, { purpose: "payload", id: entry.id });
  const destinationParent = dirname(destination);
  const sourceAncestors = await captureSourceAncestors(handoff.repoRoot, source, fsApi);
  const destinationParentIdentity = Object.freeze(
    await capturePrivateDirectory(destinationParent, fsApi),
  );
  const endpointEvidence = Object.freeze({
    purpose: "payload",
    entry,
    repoRoot: handoff.repoRoot,
    source,
    sourceParent: dirname(source),
    sourceParentIdentity: sourceAncestors.at(-1).identity,
    sourceAncestors,
    destination,
    destinationParent,
    destinationParentIdentity,
  });
  await assertEntrySourceIdentity(source, entry, fsApi);
  await assertPathMissing(destination, fsApi);
  await appendEvent({
    capability,
    event: "MOVE_INTENT",
    payload: { id: entry.id, expected: preMoveInventory },
  });
  await invokeApplyHook(
    options.faultHook,
    hookState,
    `after-event:MOVE_INTENT:${entry.id}`,
  );
  await revalidateRunCapability(capability, {
    purpose: "payload",
    id: entry.id,
    boundary: "before-mutation",
  });
  await assertPrivateDirectoryIdentity(destinationParent, destinationParentIdentity, fsApi);
  await assertSourceAncestors(handoff.repoRoot, sourceAncestors, fsApi);
  await assertEntrySourceIdentity(source, entry, fsApi);
  await assertPathMissing(destination, fsApi);
  try {
    await fsApi.rename(source, destination);
  } catch (error) {
    if (error?.code === "EXDEV") {
      await revalidateRunCapability(capability, {
        purpose: "payload",
        id: entry.id,
        boundary: "before-mutation",
      });
      await assertPrivateDirectoryIdentity(destinationParent, destinationParentIdentity, fsApi);
      await assertSourceAncestors(handoff.repoRoot, sourceAncestors, fsApi);
      await assertEntrySourceIdentity(source, entry, fsApi);
      await assertPathMissing(destination, fsApi);
      fail("ERR_EXDEV");
    }
    throw error;
  }
  await invokeApplyHook(options.faultHook, hookState, `after-rename:${entry.id}`);
  await validatePayloadEndpoint({
    capability,
    entry,
    destination,
    destinationParent,
    destinationParentIdentity,
    boundary: "after-sync",
    fsApi,
  });
  await assertSourceAncestors(handoff.repoRoot, sourceAncestors, fsApi);
  await assertPathMissing(source, fsApi);
  await fsyncTree({
    capability,
    root: destination,
    entryId: entry.id,
    purpose: "payload",
  });
  await validatePayloadEndpoint({
    capability,
    entry,
    destination,
    destinationParent,
    destinationParentIdentity,
    boundary: "after-sync",
    fsApi,
  });
  await invokeApplyHook(options.faultHook, hookState, `after-payload-sync:${entry.id}`);
  await validatePayloadEndpoint({
    capability,
    entry,
    destination,
    destinationParent,
    destinationParentIdentity,
    boundary: "after-sync",
    fsApi,
  });
  await revalidateRunCapability(capability, {
    purpose: "payload",
    id: entry.id,
    boundary: "before-mutation",
  });
  await assertPrivateDirectoryIdentity(destinationParent, destinationParentIdentity, fsApi);
  await syncDirectory(destinationParent, fsApi);
  await validatePayloadEndpoint({
    capability,
    entry,
    destination,
    destinationParent,
    destinationParentIdentity,
    boundary: "after-sync",
    fsApi,
  });
  await invokeApplyHook(
    options.faultHook,
    hookState,
    `after-destination-parent-sync:${entry.id}`,
  );
  await validatePayloadEndpoint({
    capability,
    entry,
    destination,
    destinationParent,
    destinationParentIdentity,
    boundary: "after-sync",
    fsApi,
  });
  await assertSourceAncestors(handoff.repoRoot, sourceAncestors, fsApi);
  await assertPathMissing(source, fsApi);
  const sourceParent = dirname(source);
  await syncDirectory(sourceParent, fsApi);
  await assertSourceAncestors(handoff.repoRoot, sourceAncestors, fsApi);
  await assertPathMissing(source, fsApi);
  await invokeApplyHook(
    options.faultHook,
    hookState,
    `after-source-parent-sync:${entry.id}`,
  );
  await validatePayloadEndpoint({
    capability,
    entry,
    destination,
    destinationParent,
    destinationParentIdentity,
    boundary: "after-sync",
    fsApi,
  });
  await assertSourceAncestors(handoff.repoRoot, sourceAncestors, fsApi);
  await assertPathMissing(source, fsApi);
  const observed = await writeInventoryJsonl({
    capability,
    root: destination,
    entryId: entry.id,
    phase: "moved-pass-1",
  });
  await compareInventorySummary(preMoveInventory, observed);
  await invokeApplyHook(
    options.faultHook,
    hookState,
    `after-inventory:moved-pass-1:${entry.id}`,
  );
  await validatePayloadEndpoint({
    capability,
    entry,
    destination,
    destinationParent,
    destinationParentIdentity,
    boundary: "after-sync",
    fsApi,
  });
  await assertSourceAncestors(handoff.repoRoot, sourceAncestors, fsApi);
  await assertPathMissing(source, fsApi);
  await appendEvent({
    capability,
    event: "MOVED",
    payload: { id: entry.id, observed },
  });
  await invokeApplyHook(options.faultHook, hookState, `after-event:MOVED:${entry.id}`);
  await validateMovedEndpointEvidence(capability, endpointEvidence, "after-sync", fsApi);
  return endpointEvidence;
}

async function prepareDurableApply({ capability, handoff, environment, options, hookState }) {
  const fsApi = getRunFsContext(capability, handoff.fsSource);
  const entryIds = new Set(handoff.entries.map((entry) => entry.id));
  const divergentIds = new Set(handoff.entries
    .filter((entry) => entry.kind === "source-copy" && entry.classification === "divergent")
    .map((entry) => entry.id));
  const preDirectory = dirname(deriveRunPath(capability, {
    purpose: "inventory",
    id: handoff.entries[0].id,
    phase: "pre",
  }));
  const preNames = await fsApi.readdir(preDirectory);
  if (
    !Array.isArray(preNames) || preNames.some((name) =>
      !name.endsWith(".jsonl") || !entryIds.has(name.slice(0, -".jsonl".length)))
  ) fail("ERR_INTEGRITY");
  const diffDirectory = dirname(deriveRunPath(capability, {
    purpose: "divergent-diff",
    id: "copy-0001",
  }));
  const diffNames = await fsApi.readdir(diffDirectory);
  if (!Array.isArray(diffNames) || diffNames.some((name) => {
    const id = name.endsWith(".patch")
      ? name.slice(0, -".patch".length)
      : name.startsWith(".") && name.endsWith(".tmp")
        ? name.slice(1, -".tmp".length)
        : null;
    return id === null || !divergentIds.has(id);
  })) fail("ERR_INTEGRITY");
  const entries = [];
  for (const entry of handoff.entries) {
    const preMoveInventory = await writeInventoryJsonl({
      capability,
      root: workspaceEntryPath(handoff.repoRoot, entry),
      entryId: entry.id,
      phase: "pre",
    });
    entries.push({ entry, preMoveInventory });
  }
  await invokeApplyHook(options.faultHook, hookState, "after-pre-inventories");
  for (const { entry } of entries) {
    if (entry.kind !== "source-copy" || entry.classification !== "divergent") continue;
    await publishDivergentPatch({
      capability,
      entry,
      repoRoot: handoff.repoRoot,
      environment,
      fsApi,
    });
    await invokeApplyHook(
      options.faultHook,
      hookState,
      `after-divergent-diff:${entry.id}`,
    );
  }
  const manifest = preparedManifest(handoff, entries);
  const expectedManifestSha256 = createHash("sha256")
    .update(Buffer.from(`${JSON.stringify(manifest)}\n`))
    .digest("hex");
  const manifestDirectory = dirname(deriveRunPath(capability, {
    purpose: "manifest-generation",
    id: expectedManifestSha256,
  }));
  const existingGenerations = await fsApi.readdir(manifestDirectory);
  if (
    !Array.isArray(existingGenerations) ||
    existingGenerations.some((name) => name !== `${expectedManifestSha256}.json`)
  ) fail("ERR_INTEGRITY");
  const generation = await writeManifestGeneration({
    capability,
    manifest,
  });
  if (generation.manifestSha256 !== expectedManifestSha256) fail("ERR_INTEGRITY");
  await invokeApplyHook(options.faultHook, hookState, "after-prepared-generation");
  await appendEvent({
    capability,
    event: "PREPARED",
    payload: {
      transactionId: handoff.transactionId,
      manifestSha256: generation.manifestSha256,
    },
  });
  await invokeApplyHook(options.faultHook, hookState, "after-event:PREPARED");
  await appendEvent({ capability, event: "MOVING", payload: {} });
  await invokeApplyHook(options.faultHook, hookState, "after-event:MOVING");
  const movedEndpointEvidence = [];
  for (const planned of entries) {
    movedEndpointEvidence.push(await movePreparedEntry({
      capability,
      handoff,
      planned,
      options,
      hookState,
      fsApi,
    }));
  }
  Object.freeze(movedEndpointEvidence);
  await appendEvent({ capability, event: "VERIFYING", payload: {} });
  await invokeApplyHook(options.faultHook, hookState, "after-event:VERIFYING");
  for (const evidence of movedEndpointEvidence) {
    await validateMovedEndpointEvidence(capability, evidence, "after-sync", fsApi);
  }
  for (let index = 0; index < entries.length; index += 1) {
    const { entry, preMoveInventory } = entries[index];
    const evidence = movedEndpointEvidence[index];
    await validateMovedEndpointEvidence(capability, evidence, "after-sync", fsApi);
    const observed = await writeInventoryJsonl({
      capability,
      root: evidence.destination,
      entryId: entry.id,
      phase: "moved-pass-2",
    });
    await validateMovedEndpointEvidence(capability, evidence, "after-sync", fsApi);
    await compareInventorySummary(preMoveInventory, observed);
    await invokeApplyHook(
      options.faultHook,
      hookState,
      `after-inventory:moved-pass-2:${entry.id}`,
    );
    await validateMovedEndpointEvidence(capability, evidence, "after-sync", fsApi);
  }
  let finalWorkspace;
  try {
    finalWorkspace = await gitSnapshot(handoff.repoRoot, environment, 0);
  } catch {
    fail("ERR_INTEGRITY");
  }
  if (
    finalWorkspace.topLevel !== handoff.repoRoot ||
    finalWorkspace.branch !== handoff.branch ||
    finalWorkspace.head !== handoff.head ||
    finalWorkspace.statusPaths.length !== 0
  ) fail("ERR_INTEGRITY");
  for (const evidence of movedEndpointEvidence) {
    await validateMovedEndpointEvidence(capability, evidence, "after-sync", fsApi);
  }
  await appendEvent({
    capability,
    event: "QUARANTINED",
    payload: {},
    faultHook: options.faultHook === undefined ? undefined : async (phase) => {
      if (phase !== "before-lock-cleanup") return;
      await options.faultHook("after-event:QUARANTINED");
      await options.faultHook("before-lock-cleanup");
    },
  });
  return record([
    ["schemaVersion", 2],
    ["transactionId", handoff.transactionId],
    ["status", "QUARANTINED"],
    ["movedEntries", entries.length],
    ["manifestSha256", generation.manifestSha256],
  ]);
}

export async function prepareQuarantineWorkspace(input) {
  const hookState = { rejected: false };
  try {
    return (await prepareWorkspaceCore(input, "strict", hookState)).handoff;
  } catch (error) {
    if (hookState.rejected) throw error;
    throw publicError(error, "ERR_PREFLIGHT");
  }
}

export async function quarantineWorkspace(input) {
  const hookState = { layoutComplete: false, rejected: false };
  try {
    const prepared = await prepareWorkspaceCore(input, "apply-precommit-resume", hookState);
    hookState.layoutComplete = true;
    return await withQuarantineRunCapability({
      repoRoot: prepared.handoff.repoRoot,
      quarantineRoot: prepared.handoff.quarantineRoot,
      transactionId: prepared.handoff.transactionId,
      writersStopped: true,
      fsApi: prepared.handoff.fsSource,
    }, async (capability) => prepareDurableApply({
      capability,
      handoff: prepared.handoff,
      environment: prepared.environment,
      options: prepared.options,
      hookState,
    }));
  } catch (error) {
    if (hookState.rejected) throw error;
    if (error instanceof IndeterminateJournalAppendError) {
      throw new QuarantineError("ERR_INDETERMINATE_JOURNAL_APPEND");
    }
    if (
      hookState.layoutComplete && error instanceof ClassifiedFailure &&
      error.code === "ERR_PREFLIGHT"
    ) {
      throw new QuarantineError("ERR_INTEGRITY");
    }
    if (!(error instanceof ClassifiedFailure) && !(error instanceof QuarantineError)) {
      throw new QuarantineError("ERR_INTEGRITY");
    }
    throw publicError(error, "ERR_INTERNAL");
  }
}

const VALIDATION_ALLOWED = Object.freeze([
  "repoRoot", "quarantineRoot", "transactionId", "validatedAt", "writersStopped", "fsApi", "faultHook",
]);
const VALIDATION_REQUIRED = Object.freeze([
  "repoRoot", "quarantineRoot", "transactionId", "validatedAt", "writersStopped",
]);

function snapshotValidationOptions(input) {
  const options = snapshotOptions(input, VALIDATION_ALLOWED, VALIDATION_REQUIRED);
  validateAbsolute(options.repoRoot);
  validateAbsolute(options.quarantineRoot);
  validateTransactionId(options.transactionId);
  validateCreatedAt(options.validatedAt);
  if (options.writersStopped !== true) fail("ERR_USAGE");
  if (options.faultHook !== undefined && typeof options.faultHook !== "function") fail("ERR_USAGE");
  return options;
}

function validationFaultHook(hook) {
  if (hook === undefined) return undefined;
  const publicPhase = new Map([
    ["after-generation-directory-sync", "after-validated-generation"],
    ["after-journal-sync", "after-event:VALIDATED"],
    ["before-lock-cleanup", "before-lock-cleanup"],
    ["after-pointer-temporary-sync", "after-pointer-temporary-sync"],
    ["after-pointer-rename", "after-pointer-rename"],
    ["after-quarantine-root-sync", "after-pointer-root-sync"],
  ]);
  return async (phase) => {
    const mapped = publicPhase.get(phase);
    if (mapped !== undefined) await hook(mapped);
  };
}

async function assertValidationJournalUnlocked(handoff) {
  const lockPath = deriveRunPath(handoff.capability, { purpose: "journal-lock" });
  try {
    await handoff.fsApi.lstat(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("journal lock already exists before validation");
}

async function cleanupValidationAttempt(handoff, publications) {
  const fsApi = handoff.fsApi;
  for (const publication of [...publications].reverse()) {
    await revalidateRunCapability(handoff.capability, {
      purpose: "inventory", id: publication.id, phase: publication.phase, boundary: "before-mutation",
    });
    const observed = await fsApi.lstat(publication.path);
    if (
      observed.isSymbolicLink() || !observed.isFile() || modeOf(observed) !== PRIVATE_FILE_MODE ||
      Number(observed.nlink) !== 1 || Number(observed.dev) !== publication.dev ||
      Number(observed.ino) !== publication.ino
    ) fail("ERR_INTEGRITY");
    await fsApi.unlink(publication.path);
    await syncDirectory(dirname(publication.path), fsApi);
    await revalidateRunCapability(handoff.capability, {
      purpose: "inventory", id: publication.id, phase: publication.phase, boundary: "after-sync",
    });
  }
}

async function validateValidationWorkspace(handoff, options) {
  const fsApi = handoff.fsApi;
  let workspace;
  try {
    workspace = await gitSnapshot(handoff.repoRoot, snapshotGitEnvironment(), 0);
  } catch {
    fail("ERR_INTEGRITY");
  }
  if (
    workspace.topLevel !== handoff.repoRoot || workspace.head !== handoff.head ||
    workspace.statusPaths.length !== 0
  ) fail("ERR_INTEGRITY");

  const entries = handoff.manifestGeneration.manifest.entries;
  for (const entry of entries) {
    if (entry.kind === "generated-root") continue;
    try {
      await fsApi.lstat(workspaceEntryPath(handoff.repoRoot, entry));
      fail("ERR_INTEGRITY");
    } catch (error) {
      if (error instanceof ClassifiedFailure) throw error;
      if (error?.code !== "ENOENT") fail("ERR_INTEGRITY");
    }
  }
  if (handoff.manifestGeneration.manifest.schemaVersion === 1) {
    for (const entry of entries) {
      if (entry.kind !== "generated-root") continue;
      const root = workspaceEntryPath(handoff.repoRoot, entry);
      const first = await writeInventoryJsonl({
        capability: handoff.capability, root, entryId: entry.id, phase: "validation-pass-1",
      });
      await compareInventorySummary(entry.preMoveInventory, first);
      if (options.faultHook !== undefined) {
        await options.faultHook(`after-inventory:validation-pass-1:${entry.id}`);
      }
      const second = await writeInventoryJsonl({
        capability: handoff.capability, root, entryId: entry.id, phase: "validation-pass-2",
      });
      await compareInventorySummary(entry.preMoveInventory, second);
      if (options.faultHook !== undefined) {
        await options.faultHook(`after-inventory:validation-pass-2:${entry.id}`);
      }
    }
    return null;
  }
  const validationAttempt = `attempt-${randomUUID()}`;
  const regeneratedEvidence = Object.create(null);
  const publications = [];
  const assertGeneratedRootIdentity = async (root, expected) => {
    const repository = await fsApi.lstat(handoff.repoRoot);
    const stat = await fsApi.lstat(root);
    if (
      repository.isSymbolicLink() || !repository.isDirectory() ||
      Number(repository.dev) !== handoff.manifestGeneration.manifest.repositoryIdentity.dev ||
      Number(repository.ino) !== handoff.manifestGeneration.manifest.repositoryIdentity.ino ||
      await fsApi.realpath(handoff.repoRoot) !== handoff.repoRoot ||
      stat.isSymbolicLink() || !stat.isDirectory() || await fsApi.realpath(root) !== root ||
      (expected !== undefined &&
        (Number(stat.dev) !== expected.dev || Number(stat.ino) !== expected.ino || modeOf(stat) !== expected.mode))
    ) fail("ERR_INTEGRITY");
    return Object.freeze({ dev: Number(stat.dev), ino: Number(stat.ino), mode: modeOf(stat) });
  };
  try {
    for (const entry of entries) {
      if (entry.kind !== "generated-root") continue;
      const root = workspaceEntryPath(handoff.repoRoot, entry);
      const rootIdentity = await assertGeneratedRootIdentity(root);
      const inventoryId = `${validationAttempt}-${entry.id}`;
      const capture = async (phase) => {
        const summary = await writeInventoryJsonl({
          capability: handoff.capability,
          root,
          entryId: inventoryId,
          phase,
        });
        const path = deriveRunPath(handoff.capability, { purpose: "inventory", id: inventoryId, phase });
        const identity = await fsApi.lstat(path);
        if (identity.isSymbolicLink() || !identity.isFile() || modeOf(identity) !== PRIVATE_FILE_MODE ||
            Number(identity.nlink) !== 1) fail("ERR_INTEGRITY");
        publications.push({
          path, id: inventoryId, phase,
          dev: Number(identity.dev), ino: Number(identity.ino),
        });
        await assertGeneratedRootIdentity(root, rootIdentity);
        return summary;
      };
      const first = await capture("validation-pass-1");
      if (options.faultHook !== undefined) {
        await options.faultHook(`after-inventory:validation-pass-1:${entry.id}`);
      }
      const second = await capture("validation-pass-2");
      await compareInventorySummary(first, second);
      if (options.faultHook !== undefined) {
        await options.faultHook(`after-inventory:validation-pass-2:${entry.id}`);
      }
      regeneratedEvidence[entry.id] = Object.freeze({
        pass1Path: `inventories/validation-pass-1/${inventoryId}.jsonl`,
        pass1Summary: first,
        pass2Path: `inventories/validation-pass-2/${inventoryId}.jsonl`,
        pass2Summary: second,
      });
    }
  } catch (error) {
    try {
      await cleanupValidationAttempt(handoff, publications);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "validation attempt and cleanup both failed");
    }
    throw error;
  }
  return Object.freeze({
    validationAttempt,
    regeneratedEvidence: Object.freeze(regeneratedEvidence),
    publications: Object.freeze([...publications]),
  });
}

function validatedManifest(prepared, validatedAt, evidence) {
  const deleteAfter = new Date(Date.parse(validatedAt) + (4 * 24 * 60 * 60 * 1000)).toISOString();
  return buildValidatedManifest({
    ...prepared,
    state: "VALIDATED",
    validatedAt,
    retentionDays: 4,
    deletionRequiresConfirmation: true,
    deleteAfter,
    deletionStatus: "retained",
    ...(prepared.schemaVersion === 2 ? {
      validationAttempt: evidence.validationAttempt,
      regeneratedEvidence: evidence.regeneratedEvidence,
    } : {}),
  });
}

function validationResult(options, manifest) {
  return record([
    ["schemaVersion", manifest.manifest.schemaVersion],
    ["transactionId", options.transactionId],
    ["status", "VALIDATED"],
    ["manifestSha256", manifest.manifestSha256],
    ["validatedAt", manifest.manifest.validatedAt],
    ["deleteAfter", manifest.manifest.deleteAfter],
    ["deletionRequiresConfirmation", true],
  ]);
}

export async function markQuarantineValidated(input) {
  let options;
  try {
    options = snapshotValidationOptions(input);
    return await withExistingQuarantineRun({
      repoRoot: options.repoRoot,
      quarantineRoot: options.quarantineRoot,
      transactionId: options.transactionId,
      writersStopped: options.writersStopped,
      fsApi: options.fsApi,
    }, async (handoff) => {
      await assertValidationJournalUnlocked(handoff);
      const prior = handoff.manifestGeneration;
      let generation;
      if (prior.state === "VALIDATED") {
        generation = Object.freeze({
          manifestSha256: prior.manifestSha256,
          manifest: prior.manifest,
        });
      } else {
        const evidence = await validateValidationWorkspace(handoff, options);
        const manifest = validatedManifest(prior.manifest, options.validatedAt, evidence);
        try {
          generation = await writeManifestGeneration({
            capability: handoff.capability,
            manifest,
            faultHook: validationFaultHook(options.faultHook),
          });
        } catch (error) {
          try {
            await cleanupValidationAttempt(handoff, evidence.publications);
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "validation publication and cleanup both failed");
          }
          throw error;
        }
        generation = Object.freeze({ manifestSha256: generation.manifestSha256, manifest });
      }
      await activateManifestGeneration({
        capability: handoff.capability,
        transactionId: handoff.transactionId,
        manifestSha256: generation.manifestSha256,
        faultHook: validationFaultHook(options.faultHook),
        appendValidated: async ({ manifestSha256 }) => withJournalLock(
          { capability: handoff.capability },
          async (heldLock) => {
            const replayed = await replayJournal({ capability: handoff.capability });
            const tip = replayed.records.at(-1);
            if (replayed.state === "VALIDATED" && tip?.payload.manifestSha256 === manifestSha256) {
              return Object.freeze({ status: "already-present", manifestSha256 });
            }
            if (replayed.state !== "QUARANTINED") throw new Error("validated journal state changed");
            await appendJournalRecord({
              capability: handoff.capability,
              heldLock,
              event: "VALIDATED",
              payload: { manifestSha256 },
              schemaVersion: generation.manifest.schemaVersion,
              faultHook: validationFaultHook(options.faultHook),
            });
            return Object.freeze({ status: "appended", manifestSha256 });
          },
        ),
      });
      return validationResult(options, generation);
    });
  } catch (error) {
    if (error instanceof IndeterminateJournalAppendError) {
      throw new QuarantineError("ERR_INDETERMINATE_JOURNAL_APPEND");
    }
    if (options?.fsApi === undefined && error?.code === "ERR_PREFLIGHT") {
      throw new QuarantineError("ERR_PREFLIGHT");
    }
    throw publicError(error, "ERR_INTEGRITY");
  }
}

export async function recoverQuarantine(input) {
  let options;
  let source;
  try {
    options = snapshotRecoveryOptions(input);
    // Capture before the first await: a later getter, receiver, or method mutation
    // cannot change the filesystem authority used by the run capability.
    source = captureFsSource(options.fsApi);
    return await withQuarantineRunCapability({
      repoRoot: options.repoRoot,
      quarantineRoot: options.quarantineRoot,
      transactionId: options.transactionId,
      writersStopped: options.writersStopped,
      fsApi: source,
    }, async (capability) => recoverApplyOnCapability({ capability, options }));
  } catch (error) {
    if (error instanceof IndeterminateJournalAppendError) {
      throw new QuarantineError("ERR_INDETERMINATE_JOURNAL_APPEND");
    }
    throw publicError(error, "ERR_INTEGRITY");
  }
}
