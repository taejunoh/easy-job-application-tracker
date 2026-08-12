import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const transactionUrl = pathToFileURL(
  join(__dirname, "../../../scripts/quarantine-transaction.mjs"),
).href;
const runtimeUrl = pathToFileURL(
  join(__dirname, "../../../scripts/quarantine-workspace-runtime.mjs"),
).href;
const capabilityUrl = pathToFileURL(
  join(__dirname, "../../../scripts/quarantine-run-capability.mjs"),
).href;
const journalUrl = pathToFileURL(
  join(__dirname, "../../../scripts/quarantine-journal.mjs"),
).href;
const fsContextUrl = pathToFileURL(
  join(__dirname, "../../../scripts/quarantine-run-fs-context.mjs"),
).href;
const lifecycleCoreUrl = pathToFileURL(
  join(__dirname, "../../../scripts/quarantine-lifecycle-core.mjs"),
).href;
const legacyFacadeUrl = pathToFileURL(
  join(__dirname, "../../../scripts/quarantine-numbered-copies-support.mjs"),
).href;

export const FS_METHODS = [
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
] as const;

export const LAYOUT_RELATIVES = [
  "", "manifests", "inventories", "inventories/pre", "inventories/moved-pass-1",
  "inventories/moved-pass-2", "inventories/restore-active",
  "inventories/validation-pass-1", "inventories/validation-pass-2",
  "inventories/work", "payload", "payload/source-copies", "payload/generated",
  "rollback", "rollback/regenerated-before-restore", "conflicts", "divergent-diffs",
] as const;

export const STATUS_RECORD_LIMIT = 1024 * 1024;
export const HISTORY_FRAME_LIMIT = 4096;
export const HISTORY_OID_BODY_LIMIT = 64;

export type Fixture = {
  base: string;
  repoRoot: string;
  quarantineRoot: string;
  branch: string;
  head: string;
  expectedCount: number;
  historyHead?: string;
  canonicalPath?: string;
  copyPath?: string;
  generatedNestedDirectory?: boolean;
};

export function git(repoRoot: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function listLockResidue(path: string, relative = ""): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.name.endsWith(".lock")) output.push(entryRelative);
    if (entry.isDirectory()) output.push(...listLockResidue(join(path, entry.name), entryRelative));
  }
  return output.sort();
}

export function installGitOutputOverride(
  f: Fixture,
  label: string,
  expectedArgs: string,
  output: Buffer,
) {
  const bin = join(f.base, `git-override-${label}`);
  privateDirectory(bin);
  const payload = join(bin, "payload.bin");
  writeFileSync(payload, output);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nif [ "$*" = ${JSON.stringify(expectedArgs)} ]; then exec /bin/cat ${JSON.stringify(payload)}; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
    { mode: 0o700 },
  );
  chmodSync(join(bin, "git"), 0o700);
  return `${bin}:${process.env.PATH ?? ""}`;
}

export function installGitDiffOverride(
  f: Fixture,
  label: string,
  stdout: Buffer,
  { stderr = Buffer.alloc(0), exit = 1, signal, sentinel }: {
    stderr?: Buffer;
    exit?: number;
    signal?: string;
    sentinel?: string;
  } = {},
) {
  const bin = join(f.base, `git-diff-override-${label}`);
  privateDirectory(bin);
  const stdoutPath = join(bin, "stdout.bin");
  const stderrPath = join(bin, "stderr.bin");
  writeFileSync(stdoutPath, stdout);
  writeFileSync(stderrPath, stderr);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const expected = [
    "-c", "core.fsmonitor=false", "-c", "core.quotePath=true", "diff", "--no-index",
    "--binary", "--full-index", "--no-color", "--no-ext-diff", "--no-textconv",
    "--src-prefix=a/", "--dst-prefix=b/", "--", f.canonicalPath!, f.copyPath!,
  ].join(" ");
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nif [ "$*" = ${JSON.stringify(expected)} ]; then ${sentinel === undefined ? "" : `printf invoked > ${JSON.stringify(sentinel)}; `}/bin/cat ${JSON.stringify(stdoutPath)}; /bin/cat ${JSON.stringify(stderrPath)} >&2; ${signal === undefined ? `exit ${exit}` : `kill -${signal} $$; exit 99`}; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
    { mode: 0o700 },
  );
  chmodSync(join(bin, "git"), 0o700);
  return `${bin}:${process.env.PATH ?? ""}`;
}

export function createQuarantineFixture({
  divergent = false,
  repoName = "repo",
  canonicalPath = "notes.txt",
  copyPath = "notes 2.txt",
  generatedInnerSymlink = false,
  generatedNestedDirectory = false,
} = {}): Fixture {
  const base = mkdtempSync(join(tmpdir(), "quarantine-transaction-"));
  const repoRoot = join(base, repoName);
  const quarantineRoot = join(base, "quarantine");
  privateDirectory(repoRoot);
  privateDirectory(quarantineRoot);
  git(repoRoot, "init", "-b", "slice-one");
  git(repoRoot, "config", "user.name", "Test User");
  git(repoRoot, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repoRoot, ".gitignore"), ".next/\nnode_modules/\n");
  mkdirSync(dirname(join(repoRoot, canonicalPath)), { recursive: true });
  writeFileSync(join(repoRoot, canonicalPath), "canonical\n");
  git(repoRoot, "add", ".gitignore", canonicalPath);
  git(repoRoot, "commit", "-m", "fixture");
  const historyHead = divergent ? git(repoRoot, "rev-parse", "HEAD") : undefined;
  if (divergent) {
    writeFileSync(join(repoRoot, canonicalPath), "new canonical\n");
    git(repoRoot, "add", canonicalPath);
    git(repoRoot, "commit", "-m", "change canonical");
  }
  mkdirSync(dirname(join(repoRoot, copyPath)), { recursive: true });
  writeFileSync(join(repoRoot, copyPath), "canonical\n");
  privateDirectory(join(repoRoot, ".next"));
  privateDirectory(join(repoRoot, "node_modules"));
  writeFileSync(join(repoRoot, ".next", "build"), "ignored");
  writeFileSync(join(repoRoot, "node_modules", "package"), "ignored");
  if (generatedNestedDirectory) {
    privateDirectory(join(repoRoot, ".next", "nested"));
    writeFileSync(join(repoRoot, ".next", "nested", "build"), "ignored");
  }
  if (generatedInnerSymlink) {
    symlinkSync("build", join(repoRoot, ".next", "inner-link"));
    symlinkSync("package", join(repoRoot, "node_modules", "inner-link"));
  }
  const sourceCopyEntries = Object.freeze([copyPath]);
  return {
    base: realpathSync(base),
    repoRoot: realpathSync(repoRoot),
    quarantineRoot: realpathSync(quarantineRoot),
    branch: git(repoRoot, "symbolic-ref", "--short", "HEAD"),
    head: git(repoRoot, "rev-parse", "HEAD"),
    expectedCount: sourceCopyEntries.length,
    historyHead,
    canonicalPath,
    copyPath,
  };
}

export function prepareQuarantinedFixture({
  divergent = false,
  regenerate = true,
  canonicalPath = "notes.txt",
  copyPath = "notes 2.txt",
  generatedInnerSymlink = false,
  generatedNestedDirectory = false,
}: { divergent?: boolean; regenerate?: boolean; canonicalPath?: string; copyPath?: string; generatedInnerSymlink?: boolean; generatedNestedDirectory?: boolean } = {}) {
  const fixture = createQuarantineFixture({ divergent, canonicalPath, copyPath, generatedInnerSymlink, generatedNestedDirectory });
  const transactionId = "tx-0001";
  const createdAt = "2026-08-11T00:00:00.000Z";
  const applyResult = invokeQuarantineWorker("apply", {
    repoRoot: fixture.repoRoot,
    quarantineRoot: fixture.quarantineRoot,
    expectedBranch: fixture.branch,
    expectedHead: fixture.head,
    expectedCount: fixture.expectedCount,
    transactionId,
    createdAt,
    writersStopped: true,
  });
  if (!applyResult.ok || applyResult.result?.status !== "QUARANTINED") {
    throw new Error("quarantine fixture could not be prepared");
  }
  if (regenerate) {
    privateDirectory(join(fixture.repoRoot, ".next"));
    privateDirectory(join(fixture.repoRoot, "node_modules"));
    writeFileSync(join(fixture.repoRoot, ".next", "build"), "ignored");
    writeFileSync(join(fixture.repoRoot, "node_modules", "package"), "ignored");
    if (generatedInnerSymlink) {
      symlinkSync("build", join(fixture.repoRoot, ".next", "inner-link"));
      symlinkSync("package", join(fixture.repoRoot, "node_modules", "inner-link"));
    }
    if (generatedNestedDirectory) {
      privateDirectory(join(fixture.repoRoot, ".next", "nested"));
      writeFileSync(join(fixture.repoRoot, ".next", "nested", "build"), "ignored");
    }
  }
  return {
    fixture,
    transactionId,
    createdAt,
    runRoot: join(fixture.quarantineRoot, transactionId),
    applyResult,
  };
}

export function canonicalDiff(f: Fixture) {
  const diff = spawnSync("git", [
    "-c", "core.fsmonitor=false",
    "-c", "core.quotePath=true",
    "diff", "--no-index", "--binary", "--full-index", "--no-color",
    "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "--",
    f.canonicalPath!, f.copyPath!,
  ], { cwd: f.repoRoot });
  expect(diff.status).toBe(1);
  return diff.stdout;
}

export type DescriptorShape = {
  enumerable: boolean;
  configurable: boolean;
  writable: boolean;
  callable?: boolean;
};

export type ValueShape = {
  prototype: string;
  keys: string[];
  frozen: boolean;
  extensible: boolean;
  descriptors: Record<string, DescriptorShape>;
  top?: ValueShape;
  entries?: ValueShape;
  entryShapes?: ValueShape[];
  identityShapes?: Array<Array<ValueShape | null>>;
  fsSource?: ValueShape;
  fsCallable?: boolean;
  fsStable?: boolean;
  mutationStable?: boolean;
};

export type WorkerEntry = {
  id: string;
  kind: string;
  classification?: string;
  historyMatch?: string | null;
};

export type WorkerValue = {
  status?: string;
  runRoot?: string;
  entries?: WorkerEntry[];
  [key: string]: unknown;
};

export type WorkerError = {
  name: string;
  code?: string;
  message: string;
  ownKeys: string[];
  descriptors: Record<string, DescriptorShape>;
  leaksSecret: boolean;
  prototypeIsError: boolean;
  prototypeParentIsError: boolean;
  prototypeOwnKeys: string[];
  codeMutationInert: boolean;
  [key: string]: unknown;
};

export type WorkerResult = {
  ok: boolean;
  exports?: string[];
  runtimeExports?: string[];
  legacyExports?: string[];
  result?: WorkerValue;
  phases?: string[];
  reads?: number;
  counts?: Record<string, number>;
  wrongReceiver?: number;
  firstCode?: string;
  runRootOpenAttempts?: number;
  hookCalls?: number;
  unlinkCalls?: number;
  injected?: boolean;
  thrownUndefined?: boolean;
  codeReads?: number;
  closeGetterReads?: number;
  closeCalls?: number;
  closeWrongReceiver?: number;
  active?: { callable: boolean; distinctRejected: boolean };
  revoked?: boolean;
  sourceFrozen?: boolean;
  instrumentation?: {
    renamed: string[][];
    synced: string[];
    snapshots: Array<{
      phase: string;
      renamed: string[][];
      synced: string[];
      lockCreates: number;
      lockRemovals: number;
      lockExists: boolean;
    }>;
    lockCreates: number;
    lockRemovals: number;
  };
  maxReadLength?: number;
  mutationCounters?: {
    atFailure: Record<string, number>;
    final: Record<string, number>;
  };
  externalOperations?: string[];
  replayEvents?: Array<{ event: string; payload: { id?: string } }>;
  shape?: ValueShape;
  error?: WorkerError;
};

export function invokeQuarantineWorker(
  operation: string,
  request: Record<string, unknown>,
  extraEnvironment: Record<string, string> = {},
  timeout = 10_000,
): WorkerResult {
  const source = `
import * as transaction from ${JSON.stringify(transactionUrl)};
import * as runtime from ${JSON.stringify(runtimeUrl)};
import { deriveRunPath, withQuarantineRunCapability } from ${JSON.stringify(capabilityUrl)};
import { appendJournalRecord, replayJournal, withJournalLock } from ${JSON.stringify(journalUrl)};
import { getRunFsContext } from ${JSON.stringify(fsContextUrl)};
import { withExistingQuarantineRun } from ${JSON.stringify(lifecycleCoreUrl)};
import { writeInventoryJsonl } from ${JSON.stringify(pathToFileURL(join(__dirname, "../../../scripts/quarantine-inventory.mjs")).href)};
import * as fsPromises from "node:fs/promises";
import {
  appendFileSync, chmodSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync,
  renameSync, symlinkSync, truncateSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { operation, request } = JSON.parse(input);

function shape(value) {
  const descriptors = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    descriptors[key] = {
      enumerable: descriptor.enumerable,
      configurable: descriptor.configurable,
      writable: descriptor.writable,
      callable: typeof descriptor.value === "function",
    };
  }
  return {
    prototype: Array.isArray(value) ? "array" : Object.getPrototypeOf(value) === null ? "null" : "other",
    keys: Reflect.ownKeys(value).map(String),
    frozen: Object.isFrozen(value),
    extensible: Object.isExtensible(value),
    descriptors,
  };
}

function errorShape(error) {
  const descriptors = {};
  for (const key of Reflect.ownKeys(error)) {
    if (typeof key === "string") descriptors[key] = Object.getOwnPropertyDescriptor(error, key);
  }
  const prototype = Object.getPrototypeOf(error);
  const originalCode = error?.code;
  const codeSet = Reflect.set(error, "code", "MUTATED");
  return {
    instanceOfError: error instanceof Error,
    name: error?.name,
    code: error?.code,
    message: error?.message,
    ownKeys: Reflect.ownKeys(error).map(String),
    symbolCount: Reflect.ownKeys(error).filter((key) => typeof key === "symbol").length,
    enumerableKeys: Object.keys(error),
    json: JSON.stringify(error),
    frozen: Object.isFrozen(error),
    extensible: Object.isExtensible(error),
    descriptors: Object.fromEntries(Object.entries(descriptors).map(([key, value]) => [key, {
      enumerable: value.enumerable,
      configurable: value.configurable,
      writable: value.writable,
      valueType: typeof value.value,
    }])),
    leaksSecret: String(error?.stack).includes("/do/not/leak"),
    prototypeIsError: prototype === Error.prototype,
    prototypeParentIsError: Object.getPrototypeOf(prototype) === Error.prototype,
    prototypeOwnKeys: Reflect.ownKeys(prototype).map(String),
    codeMutationInert: codeSet === false && error?.code === originalCode,
  };
}

function treeSnapshot(root) {
  const records = [];
  const visit = (path, components) => {
    let stat;
    try { stat = lstatSync(path); } catch (error) {
      if (error?.code === "ENOENT") { records.push([components, "absent"]); return; }
      throw error;
    }
    const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) records.push([components, "symlink", mode, readlinkSync(path, "buffer").toString("base64")]);
    else if (stat.isFile()) records.push([components, "file", mode, stat.size, createHash("sha256").update(readFileSync(path)).digest("hex")]);
    else if (stat.isDirectory()) {
      records.push([components, "directory", mode]);
      for (const name of readdirSync(path, { encoding: "buffer" }).sort(Buffer.compare)) {
        const parent = Buffer.isBuffer(path) ? path : Buffer.from(path);
        visit(Buffer.concat([parent, Buffer.from("/"), name]), [...components, name.toString("base64")]);
      }
    } else records.push([components, "other", mode]);
  };
  visit(root, []);
  return JSON.stringify(records);
}

function restoreEvidenceSnapshot({ runRoot, pointer, endpointPaths }) {
  return JSON.stringify([
    ["run", treeSnapshot(runRoot)],
    ["pointer", treeSnapshot(pointer)],
    ["endpoints", Object.entries(endpointPaths).map(([key, value]) => [key, treeSnapshot(value)])],
  ]);
}

try {
  if (operation === "exports") {
    const legacyFacade = await import(${JSON.stringify(legacyFacadeUrl)});
    process.stdout.write(JSON.stringify({
      ok: true,
      exports: Object.keys(transaction),
      runtimeExports: Object.keys(runtime),
      legacyExports: Object.keys(legacyFacade),
    }));
  } else if (operation === "inspect") {
    const result = await transaction.inspectWorkspace(request);
    const resultShape = shape(result);
    const before = JSON.stringify(result);
    resultShape.mutationStable = Reflect.set(result, "status", "MUTATED") === false &&
      Reflect.set(result, "sourceCopies", -1) === false && JSON.stringify(result) === before;
    process.stdout.write(JSON.stringify({ ok: true, result, shape: resultShape }));
  } else if (operation === "apply") {
    const { stopPhase, ...applyRequest } = request;
    const phases = [];
    const result = await transaction.quarantineWorkspace({
      ...applyRequest,
      faultHook(phase) {
        phases.push(phase);
        if (phase === stopPhase) throw new RangeError("stop at requested phase");
      },
    });
    process.stdout.write(JSON.stringify({ ok: true, result, phases }));
  } else if (operation === "mark-validated") {
    const { stopPhase, ...validationRequest } = request;
    const phases = [];
    try {
      const result = await transaction.markQuarantineValidated({
        ...validationRequest,
        async faultHook(phase) {
          phases.push(phase);
          if (phase === stopPhase) throw new RangeError("stop at requested validation phase");
        },
      });
      process.stdout.write(JSON.stringify({ ok: true, result, phases }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, phases, error: errorShape(error) }));
    }
  } else if (operation === "core-contract") {
    let observed;
    let callbackInvoked = 0;
    let revoked = false;
    let getters = {};
    let calls = {};
    let wrongReceiver = 0;
    let source;
    let afterFs;
    let staleIdentity = false;
    let journalReads = 0;
    let boundaryJournalReads = 0;
    let repoBoundaryReads = 0;
    let callbackBoundary;
    const beforeDurableEvidence = request.callbackBoundary === undefined
      ? undefined
      : treeSnapshot(request.quarantineRoot);
    if (request.fsCapture === true || request.staleIdentity === true || request.mutateJournalBeforeCallback === true || request.callbackBoundary === "repo-swap" || request.callbackBoundary === "head-advance") {
      const implementations = { ...fsPromises, createReadStream, lstatSync, realpathSync };
      source = {};
      for (const method of ${JSON.stringify(FS_METHODS)}) {
        Object.defineProperty(source, method, {
          enumerable: true,
          configurable: true,
          get() {
            getters[method] = (getters[method] ?? 0) + 1;
            const implementation = implementations[method];
            return function (...args) {
              calls[method] = (calls[method] ?? 0) + 1;
              if (this !== source) wrongReceiver += 1;
              if (
                method === "lstat" && request.staleIdentity === true && !staleIdentity &&
                args[0] === join(request.quarantineRoot, request.transactionId)
              ) {
                staleIdentity = true;
                renameSync(request.quarantineRoot, request.quarantineRoot + ".original");
                mkdirSync(request.quarantineRoot, { recursive: true, mode: 0o700 });
                chmodSync(request.quarantineRoot, 0o700);
                mkdirSync(join(request.quarantineRoot, request.transactionId), { recursive: true, mode: 0o700 });
                chmodSync(join(request.quarantineRoot, request.transactionId), 0o700);
                writeFileSync(join(request.quarantineRoot, "replacement-sentinel"), "foreign");
              }
              if (
                method === "lstat" && request.mutateJournalBeforeCallback === true &&
                args[0] === join(request.quarantineRoot, request.transactionId, "journal.log") &&
                ++journalReads === 2
              ) appendFileSync(args[0], Buffer.from([0, 0, 0]));
              if (method === "lstat" && args[0] === request.repoRoot) {
                repoBoundaryReads += 1;
              }
              if (
                method === "lstat" && request.callbackBoundary !== undefined &&
                args[0] === request.repoRoot && repoBoundaryReads === 4
              ) {
                // Read 1 belongs to capability setup, reads 2/3 are the
                // first validateExistingRun repository evidence, so this is
                // the initial repository lstat of the second validation.
                callbackBoundary = { firedAt: repoBoundaryReads, firstPassCompleted: true };
                if (request.callbackBoundary === "repo-swap") {
                  renameSync(request.repoRoot, request.repoRoot + ".original");
                  mkdirSync(request.repoRoot, { recursive: true, mode: 0o700 });
                  writeFileSync(join(request.repoRoot, "foreign-sentinel"), "foreign");
                } else {
                  writeFileSync(join(request.repoRoot, "advance.txt"), "advance\\n");
                  execFileSync("git", ["add", "advance.txt"], { cwd: request.repoRoot });
                  execFileSync("git", ["commit", "-m", "advance"], { cwd: request.repoRoot });
                }
              }
              return Reflect.apply(implementation, implementations, args);
            };
          },
        });
      }
    }
    const {
      fsCapture, staleIdentity: _staleIdentity, callbackThrows: _callbackThrows,
      mutateJournalBeforeCallback: _mutateJournalBeforeCallback, callbackBoundary: _callbackBoundary, ...coreRequest
    } = request;
    const pending = withExistingQuarantineRun({
      ...coreRequest,
      writersStopped: true,
      ...(source === undefined ? {} : { fsApi: source }),
    }, async (handoff) => {
      callbackInvoked += 1;
      observed = {
        handoff: shape(handoff),
        journalTip: shape(handoff.journalTip),
        manifestGeneration: shape(handoff.manifestGeneration),
        fsApi: shape(handoff.fsApi),
      };
      afterFs = handoff.fsApi;
      if (request.callbackThrows === true) throw new RangeError("callback failure");
    });
    if (source !== undefined) {
      for (const method of ${JSON.stringify(FS_METHODS)}) {
        Object.defineProperty(source, method, {
          enumerable: true,
          configurable: true,
          value() { throw new Error("late filesystem mutation reached"); },
        });
      }
    }
    let captured;
    try { await pending; } catch (error) { captured = error; }
    if (captured !== undefined) {
      try { await afterFs?.lstat(request.repoRoot); } catch (error) {
        revoked = /inactive/u.test(error?.message ?? "");
      }
      process.stdout.write(JSON.stringify({
        ok: false,
        callbackInvoked,
        staleIdentity,
        getters,
        calls,
        wrongReceiver,
        revoked,
        callbackBoundary,
        durableEvidenceStable: beforeDurableEvidence === treeSnapshot(request.quarantineRoot),
        boundarySentinel: request.callbackBoundary !== "repo-swap" || readFileSync(join(request.repoRoot, "foreign-sentinel"), "utf8") === "foreign",
        error: errorShape(captured),
      }));
      process.exit(0);
    }
    try { await afterFs.lstat(request.repoRoot); } catch (error) {
      revoked = /inactive/u.test(error?.message ?? "");
    }
    process.stdout.write(JSON.stringify({ ok: true, callbackInvoked, observed, getters, calls, wrongReceiver, revoked, staleIdentity }));
  } else if (operation === "core-restore-contract") {
    const restoreId = "restore-123e4567-e89b-42d3-a456-426614174000";
    const { restoreState, restoreIntent, preState, ...restoreRequest } = request;
    const append = async (capability, event, payload) => withJournalLock({ capability }, (heldLock) =>
      appendJournalRecord({ capability, heldLock, event, payload }),
    );
    if (preState === "VALIDATED") {
      await transaction.markQuarantineValidated({
        ...restoreRequest,
        writersStopped: true,
        validatedAt: "2026-08-11T00:00:00.000Z",
      });
      rmSync(join(request.repoRoot, ".next"), { recursive: true, force: true });
      rmSync(join(request.repoRoot, "node_modules"), { recursive: true, force: true });
    }
    await withQuarantineRunCapability({ ...restoreRequest, writersStopped: true }, async (capability) => {
      await append(capability, "RESTORE_PREPARED", {
        restoreId,
        activeGenerated: [
          { id: "generated-next", inventory: null },
          { id: "generated-node-modules", inventory: null },
        ],
      });
      if (restoreState !== "RESTORE_PREPARED") await append(capability, "RESTORING", {});
      if (restoreIntent === true) await append(capability, "RESTORE_INTENT", { id: "generated-next" });
      if (restoreState === "RECOVERY_REQUIRED" || restoreState === "RESTORE_ROLLING_BACK") {
        await append(capability, "RECOVERY_REQUIRED", { entryIds: restoreIntent ? ["generated-next"] : [] });
      }
      if (restoreState === "RESTORE_ROLLING_BACK") {
        await append(capability, "RESTORE_ROLLING_BACK", {});
      }
    });
    let callbackInvoked = 0;
    await withExistingQuarantineRun({ ...restoreRequest, writersStopped: true }, async () => { callbackInvoked += 1; });
    process.stdout.write(JSON.stringify({ ok: true, callbackInvoked }));
  } else if (operation === "core-restore-matrix") {
    const restoreId = "restore-123e4567-e89b-42d3-a456-426614174000";
    const { row, preState, corruption, ancestorSwap, descendantSwap, copyPath, ...restoreRequest } = request;
    const append = async (capability, event, payload) => withJournalLock({ capability }, (heldLock) =>
      appendJournalRecord({ capability, heldLock, event, payload }),
    );
    const generated = ["generated-next", "generated-node-modules"];
    const sourceId = "copy-0001";
    if (preState === "VALIDATED") {
      await transaction.markQuarantineValidated({
        ...restoreRequest,
        writersStopped: true,
        validatedAt: "2026-08-11T00:00:00.000Z",
      });
    }
    let callbackInvoked = 0;
    let beforeJournal;
    let beforePointer;
    let beforeEndpoints;
    let endpointPaths;
    let beforeEvidence;
    await withQuarantineRunCapability({ ...restoreRequest, writersStopped: true }, async (capability) => {
      const payload = Object.fromEntries([...generated, sourceId].map((id) => [id, deriveRunPath(capability, { purpose: "payload", id })]));
      mkdirSync(join(request.quarantineRoot, request.transactionId, "rollback", "regenerated-before-restore", restoreId), {
        recursive: true,
        mode: 0o700,
      });
      const rollback = Object.fromEntries(generated.map((id) => [id, deriveRunPath(capability, {
        purpose: "rollback-entry", id: restoreId, phase: id,
      })]));
      const workspace = {
        "generated-next": join(request.repoRoot, ".next"),
        "generated-node-modules": join(request.repoRoot, "node_modules"),
        [sourceId]: join(request.repoRoot, copyPath ?? "notes 2.txt"),
      };
      const manifestPath = join(request.quarantineRoot, request.transactionId, "manifests", readdirSync(join(request.quarantineRoot, request.transactionId, "manifests"))[0]);
      const manifestOrder = JSON.parse(readFileSync(manifestPath, "utf8")).entries.map((entry) => entry.id);
      endpointPaths = Object.fromEntries([
        ...Object.entries(payload).map(([id, path]) => ["P:" + id, path]),
        ...Object.entries(workspace).map(([id, path]) => ["A:" + id, path]),
        ...Object.entries(rollback).map(([id, path]) => ["R:" + id, path]),
      ]);
      for (const id of generated) rmSync(workspace[id], { recursive: true, force: true });
      const active = !String(row).startsWith("no-active") && !String(row).startsWith("source");
      const activeGenerated = [];
      for (const id of generated) {
        if (!active) {
          activeGenerated.push({ id, inventory: null });
          continue;
        }
        mkdirSync(workspace[id], { recursive: true, mode: 0o700 });
        writeFileSync(join(workspace[id], "foreign"), "active-" + id + "\\n");
        const inventory = await writeInventoryJsonl({ capability, root: workspace[id], entryId: id, phase: "restore-active" });
        activeGenerated.push({ id, inventory });
      }
      await append(capability, "RESTORE_PREPARED", { restoreId, activeGenerated });
      const intent = async (id) => append(capability, "RESTORE_INTENT", { id });
      const completed = async (id) => append(capability, "RESTORED_ENTRY", { id });
      const enterRollback = async () => {
        await append(capability, "RECOVERY_REQUIRED", { entryIds: generated });
        await append(capability, "RESTORE_ROLLING_BACK", {});
      };
      const rollbackIntent = async (id) => append(capability, "RESTORE_ROLLBACK_INTENT", { id });
      const rollbackComplete = async (id) => append(capability, "RESTORE_ROLLED_BACK_ENTRY", { id });
      const forwardGenerated = async (id, finish = true) => {
        await intent(id);
        renameSync(workspace[id], rollback[id]);
        renameSync(payload[id], workspace[id]);
        if (finish) await completed(id);
      };
      if (row === "prepared") {
        // RESTORE_PREPARED has the original payload and the generated active endpoint.
      } else if (row === "intent-pre" || row === "no-active-pre") {
        await append(capability, "RESTORING", {});
        await intent("generated-next");
      } else if (row === "stage") {
        await append(capability, "RESTORING", {});
        await intent("generated-next");
        renameSync(workspace["generated-next"], rollback["generated-next"]);
      } else if (row === "completed" || row === "no-active-completed") {
        await append(capability, "RESTORING", {});
        await intent("generated-next");
        if (active) renameSync(workspace["generated-next"], rollback["generated-next"]);
        renameSync(payload["generated-next"], workspace["generated-next"]);
        await completed("generated-next");
      } else if (row === "mixed-prefix") {
        await append(capability, "RESTORING", {});
        await forwardGenerated("generated-next");
        await intent("generated-node-modules");
      } else if (row === "rollback-pre" || row === "rollback-post-first" || row === "rollback-post-second" || row === "rollback-partial-prefix") {
        await append(capability, "RESTORING", {});
        await forwardGenerated("generated-next");
        await forwardGenerated("generated-node-modules");
        await enterRollback();
        await rollbackIntent("generated-node-modules");
        if (row !== "rollback-pre") {
          renameSync(workspace["generated-node-modules"], payload["generated-node-modules"]);
          if (row === "rollback-post-second" || row === "rollback-partial-prefix") {
            renameSync(rollback["generated-node-modules"], workspace["generated-node-modules"]);
            await rollbackComplete("generated-node-modules");
            if (row === "rollback-partial-prefix") await rollbackIntent("generated-next");
          }
        }
      } else if (row === "source-pre" || row === "source-mid" || row === "source-post" || row === "source-rollback-pre" || row === "source-rollback-post") {
        await append(capability, "RESTORING", {});
        const sourceIndex = manifestOrder.indexOf(sourceId);
        const prefix = manifestOrder.slice(0, sourceIndex);
        // The journal schema requires a manifest-order prefix; derive it from
        // the durable generation rather than assuming generated roots precede
        // the numbered copy.
        if (corruption === "out-of-order-intent") await intent("generated-next");
        for (const id of prefix) {
          if (!generated.includes(id)) throw new Error("unexpected source prefix fixture");
          await intent(id);
          renameSync(payload[id], workspace[id]);
          await completed(id);
        }
        await intent(sourceId);
        if (row !== "source-pre") {
          renameSync(payload[sourceId], workspace[sourceId]);
          if (row !== "source-mid") await completed(sourceId);
        }
        if (row === "source-rollback-pre" || row === "source-rollback-post") {
          await append(capability, "RECOVERY_REQUIRED", { entryIds: [...prefix, sourceId] });
          await append(capability, "RESTORE_ROLLING_BACK", {});
          await rollbackIntent(sourceId);
          if (row === "source-rollback-post") {
            renameSync(workspace[sourceId], payload[sourceId]);
            await rollbackComplete(sourceId);
          }
        }
      } else {
        throw new Error("unknown restore matrix row: " + row);
      }
      if (corruption === "wrong-payload") {
        mkdirSync(payload["generated-next"], { recursive: true, mode: 0o700 });
        writeFileSync(join(payload["generated-next"], "foreign"), "wrong\\n");
      }
      if (corruption === "extra-rollback") {
        mkdirSync(rollback["generated-next"], { recursive: true, mode: 0o700 });
        writeFileSync(join(rollback["generated-next"], "foreign"), "extra\\n");
      }
      if (corruption === "missing-rollback") rmSync(rollback["generated-next"], { recursive: true, force: true });
      if (corruption === "wrong-rollback") writeFileSync(join(rollback["generated-next"], "foreign"), "wrong\\n");
      if (corruption === "wrong-active") writeFileSync(join(workspace["generated-next"], "foreign"), "wrong\\n");
      if (corruption === "wrong-source-active") writeFileSync(workspace[sourceId], "wrong\\n");
      if (corruption === "endpoint-symlink") {
        rmSync(workspace["generated-next"], { recursive: true, force: true });
        symlinkSync(payload["generated-next"], workspace["generated-next"]);
      }
      beforeJournal = readFileSync(deriveRunPath(capability, { purpose: "journal" }));
      const pointer = join(request.quarantineRoot, "current");
      beforePointer = existsSync(pointer) ? readFileSync(pointer) : null;
      beforeEndpoints = JSON.stringify(Object.fromEntries(Object.entries(endpointPaths).map(([key, value]) => [key, existsSync(value) ? lstatSync(value).ino : null])));
      beforeEvidence = restoreEvidenceSnapshot({
        runRoot: join(request.quarantineRoot, request.transactionId),
        pointer,
        endpointPaths,
      });
    });
    let error;
    let externalReads = 0;
    let foreignSentinel;
    let coreFs;
    if (ancestorSwap !== undefined || descendantSwap !== undefined) {
      const nested = join(request.repoRoot, "nested");
      const foreign = join(request.quarantineRoot, ancestorSwap === undefined ? "foreign-descendant" : "foreign-ancestor");
      mkdirSync(foreign, { recursive: true, mode: 0o700 });
      foreignSentinel = join(foreign, "sentinel");
      writeFileSync(foreignSentinel, "foreign");
      const implementations = { ...fsPromises, createReadStream, lstatSync, realpathSync };
      coreFs = { ...implementations };
      const originalLstat = coreFs.lstat;
      let nestedReads = 0;
      const descendant = descendantSwap === "directory"
        ? join(request.quarantineRoot, request.transactionId, "payload/generated/.next/nested")
        : join(request.quarantineRoot, request.transactionId, "payload/generated/.next/build");
      let descendantReads = 0;
      coreFs.lstat = async function (path, ...args) {
        if (typeof path === "string" && path.startsWith(foreign)) externalReads += 1;
        if (path === nested && ++nestedReads === ancestorSwap) {
          renameSync(nested, nested + ".original");
          symlinkSync(foreign, nested);
        }
        const result = await Reflect.apply(originalLstat, implementations, [path, ...args]);
        if (path === descendant && ++descendantReads === 1) {
          renameSync(descendant, descendant + ".original");
          symlinkSync(descendantSwap === "directory" ? foreign : foreignSentinel, descendant);
          beforeEndpoints = JSON.stringify(Object.fromEntries(Object.entries(endpointPaths).map(([key, value]) => [key, existsSync(value) ? lstatSync(value).ino : null])));
          beforeEvidence = restoreEvidenceSnapshot({
            runRoot: join(request.quarantineRoot, request.transactionId),
            pointer: join(request.quarantineRoot, "current"),
            endpointPaths,
          });
        }
        return result;
      };
      for (const method of ["realpath", "readdir", "opendir", "open", "readlink", "createReadStream"]) {
        const original = coreFs[method];
        coreFs[method] = function (path, ...args) {
          if (typeof path === "string" && path.startsWith(foreign)) externalReads += 1;
          return Reflect.apply(original, implementations, [path, ...args]);
        };
      }
    }
    try {
      await withExistingQuarantineRun({
        ...restoreRequest,
        writersStopped: true,
        ...(coreFs === undefined ? {} : { fsApi: coreFs }),
      }, async () => { callbackInvoked += 1; });
    } catch (caught) { error = caught; }
    const pointer = join(request.quarantineRoot, "current");
    const runRoot = join(request.quarantineRoot, request.transactionId);
    const afterJournal = readFileSync(join(runRoot, "journal.log"));
    const afterPointer = existsSync(pointer) ? readFileSync(pointer) : null;
    const afterEndpoints = JSON.stringify(Object.fromEntries(Object.entries(endpointPaths).map(([key, value]) => [key, existsSync(value) ? lstatSync(value).ino : null])));
    process.stdout.write(JSON.stringify({
      ok: error === undefined,
      callbackInvoked,
      durableStable: Buffer.compare(beforeJournal, afterJournal) === 0 &&
        ((beforePointer === null && afterPointer === null) || (beforePointer !== null && afterPointer !== null && Buffer.compare(beforePointer, afterPointer) === 0)),
      endpointsStable: beforeEndpoints === afterEndpoints,
      evidenceStable: beforeEvidence === restoreEvidenceSnapshot({ runRoot, pointer, endpointPaths }),
      externalReads,
      foreignIntact: foreignSentinel === undefined || readFileSync(foreignSentinel, "utf8") === "foreign",
      error: error === undefined ? undefined : errorShape(error),
    }));
  } else if (operation === "apply-stop-after-layout") {
    const phases = [];
    let captured;
    try {
      await transaction.quarantineWorkspace({
        ...request,
        faultHook(phase) {
          phases.push(phase);
          if (phase === "after-layout-sync") throw new RangeError("stop after layout");
        },
      });
    } catch (error) {
      captured = error;
    }
    process.stdout.write(JSON.stringify({
      ok: captured === undefined,
      phases,
      error: captured === undefined ? undefined : errorShape(captured),
    }));
  } else if (operation === "apply-stop") {
    const { stopPhase, ...applyRequest } = request;
    const phases = [];
    let captured;
    try {
      await transaction.quarantineWorkspace({
        ...applyRequest,
        faultHook(phase) {
          phases.push(phase);
          if (phase === stopPhase) throw new RangeError("stop at requested phase");
        },
      });
    } catch (error) {
      captured = error;
    }
    process.stdout.write(JSON.stringify({
      ok: captured === undefined,
      phases,
      error: captured === undefined ? undefined : errorShape(captured),
    }));
  } else if (operation === "seed-prepared") {
    const handoff = await runtime.prepareQuarantineWorkspace(request);
    await withQuarantineRunCapability({
      repoRoot: request.repoRoot,
      quarantineRoot: request.quarantineRoot,
      transactionId: request.transactionId,
      writersStopped: true,
      fsApi: handoff.fsSource,
    }, async (capability) => {
      await withJournalLock({ capability }, async (heldLock) => {
        await appendJournalRecord({
          capability,
          heldLock,
          event: "PREPARED",
          payload: {
            transactionId: request.transactionId,
            manifestSha256: "a".repeat(64),
          },
        });
      });
    });
    process.stdout.write(JSON.stringify({ ok: true }));
  } else if (operation === "replay-run") {
    let replayed;
    await withQuarantineRunCapability({
      repoRoot: request.repoRoot,
      quarantineRoot: request.quarantineRoot,
      transactionId: request.transactionId,
      writersStopped: true,
    }, async (capability) => {
      replayed = await replayJournal({ capability });
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result: {
        state: replayed.state,
        records: replayed.records.map((record) => ({
          sequence: record.sequence,
          event: record.event,
          payload: record.payload,
        })),
      },
    }));
  } else if (operation === "recover") {
    const { fsMutation, race, ...recoveryRequest } = request;
    let getterReads = 0;
    let wrongReceiver = 0;
    let recoveryOptions = recoveryRequest;
    if (race !== undefined) {
      let journalSyncs = 0;
      recoveryOptions = {
        ...recoveryOptions,
        async faultHook(phase) {
          if (phase !== "after-journal-sync") return;
          journalSyncs += 1;
          if (journalSyncs !== 2) return;
          const payload = join(
            request.quarantineRoot,
            request.transactionId,
            "payload/source-copies/copy-0001",
          );
          if (race === "resume-source") {
            writeFileSync(join(request.repoRoot, "notes 2.txt"), "foreign source\\n");
          } else if (race === "rollback-payload") {
            writeFileSync(payload, "foreign payload\\n");
          }
        },
      };
    }
    let result;
    if (fsMutation !== undefined) {
      const source = {
        ...fsPromises,
        createReadStream,
        lstatSync,
        realpathSync,
      };
      const originalLstat = source.lstat;
      if (fsMutation === "getter") {
        Object.defineProperty(source, "lstat", {
          enumerable: true,
          configurable: true,
          get() {
            getterReads += 1;
            return originalLstat;
          },
        });
      } else if (fsMutation === "receiver") {
        source.lstat = function (...args) {
          if (this !== source) wrongReceiver += 1;
          return Reflect.apply(originalLstat, this, args);
        };
      }
      recoveryOptions = { ...recoveryRequest, fsApi: source };
      const pending = transaction.recoverQuarantine(recoveryOptions);
      Object.defineProperty(source, "lstat", {
        configurable: true,
        enumerable: true,
        value: async () => { throw new Error("late source mutation"); },
      });
      result = await pending;
    } else {
      result = await transaction.recoverQuarantine(recoveryOptions);
    }
    let replayed;
    await withQuarantineRunCapability({
      repoRoot: request.repoRoot,
      quarantineRoot: request.quarantineRoot,
      transactionId: request.transactionId,
      writersStopped: true,
    }, async (capability) => {
      replayed = await replayJournal({ capability });
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result,
      getterReads,
      wrongReceiver,
      replayEvents: replayed.records.map((record) => ({
        event: record.event,
        payload: record.payload,
      })),
    }));
  } else if (operation === "apply-rename-exdev") {
    const { variant, ...applyRequest } = request;
    let injected = false;
    let unlinkCalls = 0;
    const adapter = {
      ...fsPromises,
      async rename(source, destination) {
        if (!injected && source === join(request.repoRoot, ".next")) {
          injected = true;
          if (variant === "source-changed") {
            await fsPromises.rename(source, source + ".changed");
          } else if (variant === "destination-created") {
            mkdirSync(destination, { mode: 0o700 });
          }
          const error = new Error("cross-device");
          error.code = "EXDEV";
          throw error;
        }
        return fsPromises.rename(source, destination);
      },
      async unlink(path) {
        if (injected) unlinkCalls += 1;
        return fsPromises.unlink(path);
      },
      createReadStream,
      lstatSync,
      realpathSync,
    };
    let captured;
    try {
      await transaction.quarantineWorkspace({ ...applyRequest, fsApi: adapter });
    } catch (error) {
      captured = error;
    }
    process.stdout.write(JSON.stringify({
      ok: captured === undefined,
      unlinkCalls,
      error: captured === undefined ? undefined : errorShape(captured),
    }));
  } else if (operation === "apply-lock-cleanup-failure") {
    const { failCleanupAt = 1, ...applyRequest } = request;
    let cleanupCalls = 0;
    const counters = {
      renames: 0,
      syncs: 0,
      inventoryPublications: 0,
      generationPublications: 0,
      journalMutations: 0,
    };
    let atFailure;
    const adapter = {
      ...fsPromises,
      async rename(...args) {
        const result = await fsPromises.rename(...args);
        counters.renames += 1;
        return result;
      },
      async link(source, destination) {
        const result = await fsPromises.link(source, destination);
        if (destination.includes("/inventories/") && destination.endsWith(".jsonl")) {
          counters.inventoryPublications += 1;
        }
        if (destination.includes("/manifests/") && destination.endsWith(".json")) {
          counters.generationPublications += 1;
        }
        return result;
      },
      async open(path, ...args) {
        const handle = await fsPromises.open(path, ...args);
        if (
          path.endsWith("/journal.log") &&
          (args[0] === "wx+" || args[0] === "r+")
        ) counters.journalMutations += 1;
        return new Proxy(handle, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if (key === "sync") return async (...syncArgs) => {
              const result = await Reflect.apply(value, target, syncArgs);
              counters.syncs += 1;
              return result;
            };
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      async rm(path, ...args) {
        if (path.endsWith("/journal.lock")) {
          cleanupCalls += 1;
        }
        if (path.endsWith("/journal.lock") && cleanupCalls === failCleanupAt) {
          atFailure = { ...counters };
          throw new Error("injected lock cleanup failure");
        }
        return fsPromises.rm(path, ...args);
      },
      createReadStream,
      lstatSync,
      realpathSync,
    };
    let captured;
    try {
      await transaction.quarantineWorkspace({ ...applyRequest, fsApi: adapter });
    } catch (error) {
      captured = error;
    }
    process.stdout.write(JSON.stringify({
      ok: captured === undefined,
      mutationCounters: { atFailure, final: { ...counters } },
      error: captured === undefined ? undefined : errorShape(captured),
    }));
  } else if (operation === "apply-mutate-at-hook") {
    const { mutatePhase, mutation, ...applyRequest } = request;
    let captured;
    try {
      await transaction.quarantineWorkspace({
        ...applyRequest,
        faultHook(phase) {
          if (phase !== mutatePhase) return;
          if (mutation === "payload") {
            writeFileSync(join(request.quarantineRoot, request.transactionId,
              "payload/generated/.next/build"), "mutated");
          } else if (mutation === "source") {
            writeFileSync(join(request.repoRoot, "notes 2.txt"), "recreated");
          } else if (mutation === "status") {
            writeFileSync(join(request.repoRoot, "unexpected.txt"), "unexpected");
          }
        },
      });
    } catch (error) {
      captured = error;
    }
    process.stdout.write(JSON.stringify({
      ok: captured === undefined,
      error: captured === undefined ? undefined : errorShape(captured),
    }));
  } else if (operation === "apply-temp-reappear") {
    let replaced = false;
    const adapter = {
      ...fsPromises,
      async unlink(path) {
        await fsPromises.unlink(path);
        if (!replaced && path.endsWith("/.copy-0001.tmp")) {
          replaced = true;
          writeFileSync(path, "foreign-reappeared", { mode: 0o600 });
          chmodSync(path, 0o600);
        }
      },
      createReadStream,
      lstatSync,
      realpathSync,
    };
    let captured;
    try {
      await transaction.quarantineWorkspace({ ...request, fsApi: adapter });
    } catch (error) {
      captured = error;
    }
    process.stdout.write(JSON.stringify({
      ok: captured === undefined,
      error: captured === undefined ? undefined : errorShape(captured),
    }));
  } else if (operation === "apply-temp-cleanup-seam") {
    const { variant, ...applyRequest } = request;
    let tempUnlinked = false;
    let injected = false;
    const adapter = {
      ...fsPromises,
      async unlink(path) {
        const result = await fsPromises.unlink(path);
        if (path.endsWith("/.copy-0001.tmp")) tempUnlinked = true;
        return result;
      },
      async open(path, ...args) {
        if (tempUnlinked && !injected && path.endsWith("/divergent-diffs")) {
          injected = true;
          if (variant === "parent-sync-failure") {
            throw new Error("injected cleanup parent sync failure");
          }
          const realHandle = await fsPromises.open(path, ...args);
          let wrapper;
          wrapper = {
            async sync() {
              await realHandle.sync();
              const final = join(path, "copy-0001.patch");
              renameSync(final, final + ".owned");
              writeFileSync(final, "foreign-final", { mode: 0o600 });
              chmodSync(final, 0o600);
            },
            async close() { return realHandle.close(); },
          };
          return wrapper;
        }
        return fsPromises.open(path, ...args);
      },
      createReadStream,
      lstatSync,
      realpathSync,
    };
    let captured;
    try {
      await transaction.quarantineWorkspace({ ...applyRequest, fsApi: adapter });
    } catch (error) {
      captured = error;
    }
    process.stdout.write(JSON.stringify({
      ok: captured === undefined,
      error: captured === undefined ? undefined : errorShape(captured),
    }));
  } else if (operation === "apply-same-inode-size-drift") {
    const { driftAtFinalOpen, mutation, ...applyRequest } = request;
    let finalOpens = 0;
    const adapter = {
      ...fsPromises,
      async open(path, ...args) {
        if (path.endsWith("/divergent-diffs/copy-0001.patch")) {
          finalOpens += 1;
          if (finalOpens === driftAtFinalOpen) {
            if (mutation === "append") appendFileSync(path, "x");
            else truncateSync(path, Math.max(0, lstatSync(path).size - 1));
          }
        }
        return fsPromises.open(path, ...args);
      },
      createReadStream,
      lstatSync,
      realpathSync,
    };
    let captured;
    try {
      await transaction.quarantineWorkspace({ ...applyRequest, fsApi: adapter });
    } catch (error) {
      captured = error;
    }
    process.stdout.write(JSON.stringify({
      ok: captured === undefined,
      error: captured === undefined ? undefined : errorShape(captured),
    }));
  } else if (operation === "apply-divergent-seam-swap") {
    const { seam, variant, ...applyRequest } = request;
    const root = join(request.quarantineRoot, request.transactionId, "divergent-diffs");
    const temporary = join(root, ".copy-0001.tmp");
    const final = join(root, "copy-0001.patch");
    let injected = false;
    let finalLstats = 0;
    let parentOpens = 0;
    let temporaryUnlinked = false;
    const swap = (path, label) => {
      if (injected) return;
      injected = true;
      if (existsSync(path)) renameSync(path, path + ".owned-" + label);
      writeFileSync(path, "foreign-" + label, { mode: 0o600 });
      chmodSync(path, 0o600);
    };
    const adapter = {
      ...fsPromises,
      async lstat(path) {
        if (path === final) {
          finalLstats += 1;
          if (seam === "before-link" && variant === "final-plus-temp" && finalLstats === 1) {
            swap(final, seam);
          }
          if (seam === "after-link" && variant === "final-plus-temp" && finalLstats === 1) {
            const stats = await fsPromises.lstat(path);
            swap(final, seam);
            return stats;
          }
        }
        return fsPromises.lstat(path);
      },
      async link(source, destination) {
        if (destination === final && seam === "before-link") swap(temporary, seam);
        const result = await fsPromises.link(source, destination);
        if (destination === final && seam === "after-link") swap(final, seam);
        return result;
      },
      async unlink(path) {
        const result = await fsPromises.unlink(path);
        if (path === temporary) {
          temporaryUnlinked = true;
          if (seam === "cleanup-before-parent-sync") swap(final, seam);
        }
        return result;
      },
      async open(path, ...args) {
        if (path === final && seam === "after-file-sync" && !injected) {
          const realHandle = await fsPromises.open(path, ...args);
          return {
            async stat() { return realHandle.stat(); },
            async sync() { await realHandle.sync(); swap(final, seam); },
            async close() { return realHandle.close(); },
          };
        }
        if (path === root && existsSync(final)) {
          parentOpens += 1;
          if (seam === "before-parent-sync" && parentOpens === 1) swap(final, seam);
          const realHandle = await fsPromises.open(path, ...args);
          if (
            (seam === "after-parent-sync" && parentOpens === 1) ||
            (seam.startsWith("cleanup-after-parent-sync") && temporaryUnlinked)
          ) {
            return {
              async sync() {
                await realHandle.sync();
                if (seam === "cleanup-after-parent-sync-temp") swap(temporary, seam);
                else swap(final, seam);
              },
              async close() { return realHandle.close(); },
            };
          }
          return realHandle;
        }
        return fsPromises.open(path, ...args);
      },
      createReadStream,
      lstatSync,
      realpathSync,
    };
    let captured;
    try {
      await transaction.quarantineWorkspace({ ...applyRequest, fsApi: adapter });
    } catch (error) {
      captured = error;
    }
    process.stdout.write(JSON.stringify({
      ok: captured === undefined,
      injected,
      error: captured === undefined ? undefined : errorShape(captured),
    }));
  } else if (operation === "apply-divergent-spawn-error") {
    let injected = false;
    let captured;
    try {
      await transaction.quarantineWorkspace({
        ...request,
        faultHook(phase) {
          if (phase === "after-pre-inventories") {
            injected = true;
            renameSync(join(process.env.PATH, "git"), join(process.env.PATH, "git.owned"));
          }
        },
      });
    } catch (error) {
      captured = error;
    }
    process.stdout.write(JSON.stringify({
      ok: captured === undefined,
      injected,
      error: captured === undefined ? undefined : errorShape(captured),
    }));
  } else if (operation === "apply-instrumented") {
    const renamed = [];
    const synced = [];
    const snapshots = [];
    let lockCreates = 0;
    let lockRemovals = 0;
    const lockPath = join(request.quarantineRoot, request.transactionId, "journal.lock");
    const adapter = {
      ...fsPromises,
      async rename(source, destination) {
        const result = await fsPromises.rename(source, destination);
        renamed.push([source, destination]);
        return result;
      },
      async open(path, ...args) {
        const handle = await fsPromises.open(path, ...args);
        if (path === lockPath && args[0] === "wx") lockCreates += 1;
        return new Proxy(handle, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if (key === "sync") return async (...syncArgs) => {
              const result = await Reflect.apply(value, target, syncArgs);
              synced.push(path);
              return result;
            };
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      async rm(path, ...args) {
        const result = await fsPromises.rm(path, ...args);
        if (path === lockPath) lockRemovals += 1;
        return result;
      },
      createReadStream,
      lstatSync,
      realpathSync,
    };
    const phases = [];
    const result = await transaction.quarantineWorkspace({
      ...request,
      fsApi: adapter,
      faultHook(phase) {
        phases.push(phase);
        snapshots.push({
          phase,
          renamed: renamed.map((pair) => [...pair]),
          synced: [...synced],
          lockCreates,
          lockRemovals,
          lockExists: existsSync(lockPath),
        });
      },
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      result,
      phases,
      instrumentation: { renamed, synced, snapshots, lockCreates, lockRemovals },
    }));
  } else if (operation === "apply-virtual-cap") {
    const { virtualSourceSize, virtualCanonicalSize, stopPhase, ...applyRequest } = request;
    let virtual = true;
    const adapter = {
      ...fsPromises,
      async lstat(path) {
        const stats = await fsPromises.lstat(path);
        let size;
        if (virtual && path === join(request.repoRoot, "notes 2.txt")) size = virtualSourceSize;
        if (virtual && path === join(request.repoRoot, "notes.txt")) size = virtualCanonicalSize;
        if (size === undefined) return stats;
        return new Proxy(stats, {
          get(target, key) {
            if (key === "size") return size;
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      createReadStream,
      lstatSync,
      realpathSync,
    };
    const phases = [];
    let captured;
    try {
      await transaction.quarantineWorkspace({
        ...applyRequest,
        fsApi: adapter,
        faultHook(phase) {
          phases.push(phase);
          if (phase === "after-layout-sync") virtual = false;
          if (phase === stopPhase) throw new RangeError("stop at requested phase");
        },
      });
    } catch (error) {
      captured = error;
    }
    process.stdout.write(JSON.stringify({
      ok: captured === undefined,
      phases,
      error: captured === undefined ? undefined : errorShape(captured),
    }));
  } else if (operation === "apply-observe-read-bound") {
    const { stopPhase, ...applyRequest } = request;
    const temporary = join(
      request.quarantineRoot,
      request.transactionId,
      "divergent-diffs/.copy-0001.tmp",
    );
    const final = join(
      request.quarantineRoot,
      request.transactionId,
      "divergent-diffs/copy-0001.patch",
    );
    let maxReadLength = 0;
    const adapter = {
      ...fsPromises,
      async open(path, ...args) {
        const handle = await fsPromises.open(path, ...args);
        if (path !== temporary && path !== final) return handle;
        return new Proxy(handle, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if (key === "read") return async (buffer, offset, length, position) => {
              maxReadLength = Math.max(maxReadLength, length);
              return value.call(target, buffer, offset, length, position);
            };
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      createReadStream,
      lstatSync,
      realpathSync,
    };
    const phases = [];
    let captured;
    try {
      await transaction.quarantineWorkspace({
        ...applyRequest,
        fsApi: adapter,
        faultHook(phase) {
          phases.push(phase);
          if (phase === stopPhase) throw new RangeError("stop at requested phase");
        },
      });
    } catch (error) {
      captured = error;
    }
    process.stdout.write(JSON.stringify({
      ok: captured === undefined,
      phases,
      maxReadLength,
      error: captured === undefined ? undefined : errorShape(captured),
    }));
  } else if (operation === "apply-endpoint-swap") {
    const { variant, triggerPhase, targetId, sourceAncestor, externalRoot, ...applyRequest } = request;
    const runRoot = join(request.quarantineRoot, request.transactionId);
    const destinationParent = targetId.startsWith("generated-")
      ? join(runRoot, "payload/generated")
      : join(runRoot, "payload/source-copies");
    let injected = false;
    const externalOperations = [];
    const resolvesExternal = (path) => {
      if (!injected || typeof path !== "string") return false;
      let resolved;
      try {
        resolved = realpathSync(path);
      } catch {
        try { resolved = realpathSync(dirname(path)); } catch { return false; }
      }
      return resolved === externalRoot || resolved.startsWith(externalRoot + "/");
    };
    const note = (method, ...paths) => {
      if (paths.some(resolvesExternal)) externalOperations.push(method);
    };
    const adapter = {
      ...fsPromises,
      async rename(source, destination) {
        note("rename", source, destination);
        return fsPromises.rename(source, destination);
      },
      async link(source, destination) {
        note("link", source, destination);
        return fsPromises.link(source, destination);
      },
      async mkdir(path, ...args) {
        note("mkdir", path);
        return fsPromises.mkdir(path, ...args);
      },
      async unlink(path, ...args) {
        note("unlink", path);
        return fsPromises.unlink(path, ...args);
      },
      async rm(path, ...args) {
        note("rm", path);
        return fsPromises.rm(path, ...args);
      },
      async open(path, ...args) {
        note("open", path);
        return fsPromises.open(path, ...args);
      },
      async opendir(path, ...args) {
        note("opendir", path);
        return fsPromises.opendir(path, ...args);
      },
      async readdir(path, ...args) {
        note("readdir", path);
        return fsPromises.readdir(path, ...args);
      },
      createReadStream(path, ...args) {
        note("createReadStream", path);
        return createReadStream(path, ...args);
      },
      lstatSync,
      realpathSync,
    };
    let captured;
    try {
      await transaction.quarantineWorkspace({
        ...applyRequest,
        fsApi: adapter,
        faultHook(phase) {
          if (phase !== triggerPhase || injected) return;
          if (variant === "source-ancestor") {
            const moved = join(externalRoot, "source-ancestor-owned");
            renameSync(sourceAncestor, moved);
            symlinkSync(moved, sourceAncestor);
          } else if (variant === "destination-before-rename") {
            renameSync(destinationParent, destinationParent + ".owned");
            symlinkSync(externalRoot, destinationParent);
          } else {
            const moved = join(externalRoot, "payload-parent-owned");
            renameSync(destinationParent, moved);
            symlinkSync(moved, destinationParent);
          }
          injected = true;
        },
      });
    } catch (error) {
      captured = error;
    }
    let replayed;
    await withQuarantineRunCapability({
      repoRoot: request.repoRoot,
      quarantineRoot: request.quarantineRoot,
      transactionId: request.transactionId,
      writersStopped: true,
      fsApi: adapter,
    }, async (capability) => {
      replayed = await replayJournal({ capability });
    });
    process.stdout.write(JSON.stringify({
      ok: captured === undefined,
      injected,
      externalOperations,
      replayEvents: replayed.records.map(({ event, payload }) => ({ event, payload })),
      error: captured === undefined ? undefined : errorShape(captured),
    }));
  } else if (operation === "apply-final-only-right-open-failure") {
    const { closeFailure, ...applyRequest } = request;
    const temporary = join(
      request.quarantineRoot,
      request.transactionId,
      "divergent-diffs/.copy-0001.tmp",
    );
    const final = join(
      request.quarantineRoot,
      request.transactionId,
      "divergent-diffs/copy-0001.patch",
    );
    let leftWrapped = false;
    let closeGetterReads = 0;
    let closeCalls = 0;
    let closeWrongReceiver = 0;
    const adapter = {
      ...fsPromises,
      async open(path, ...args) {
        if (path === final && leftWrapped) {
          const error = new Error("injected right open failure");
          error.code = "EACCES";
          throw error;
        }
        const handle = await fsPromises.open(path, ...args);
        if (path !== temporary || args[0] !== "r" || leftWrapped) return handle;
        leftWrapped = true;
        let wrapper;
        wrapper = new Proxy(handle, {
          get(target, key) {
            if (key === "close") {
              closeGetterReads += 1;
              return async function () {
                closeCalls += 1;
                if (this !== wrapper) closeWrongReceiver += 1;
                await target.close();
                if (closeFailure) throw new Error("injected left close failure");
              };
            }
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return wrapper;
      },
      createReadStream,
      lstatSync,
      realpathSync,
    };
    let captured;
    try {
      await transaction.quarantineWorkspace({ ...applyRequest, fsApi: adapter });
    } catch (error) {
      captured = error;
    }
    process.stdout.write(JSON.stringify({
      ok: captured === undefined,
      closeGetterReads,
      closeCalls,
      closeWrongReceiver,
      error: captured === undefined ? undefined : errorShape(captured),
    }));
  } else if (operation === "getter") {
    let reads = 0;
    const options = { ...request };
    Object.defineProperty(options, "repoRoot", { enumerable: true, get() { reads += 1; return request.repoRoot; } });
    const result = await transaction.inspectWorkspace(options);
    process.stdout.write(JSON.stringify({ ok: true, reads, result }));
  } else if (operation === "prepare") {
    const phases = [];
    const result = await runtime.prepareQuarantineWorkspace({
      ...request,
      faultHook(phase) { phases.push(phase); },
    });
    const originalStatus = result.status;
    const originalEntries = result.entries.map((entry) => ({
      entry,
      id: entry.id,
      sourceIdentity: entry.sourceIdentity,
      sourceDev: entry.sourceIdentity.dev,
      canonicalIdentity: entry.canonicalIdentity,
      canonicalDev: entry.canonicalIdentity?.dev,
    }));
    const mutationResults = [
      Reflect.set(result, "status", "MUTATED"),
      Reflect.set(result.entries, 0, null),
      Reflect.set(result.entries, "length", 0),
      Reflect.set(result.fsSource, "lstat", null),
    ];
    for (const original of originalEntries) {
      mutationResults.push(
        Reflect.set(original.entry, "id", "mutated"),
        Reflect.set(original.sourceIdentity, "dev", -1),
      );
      if (original.canonicalIdentity) {
        mutationResults.push(Reflect.set(original.canonicalIdentity, "dev", -1));
      }
    }
    process.stdout.write(JSON.stringify({
      ok: true,
      result,
      phases,
      shape: {
        top: shape(result),
        entries: shape(result.entries),
        entryShapes: result.entries.map(shape),
        identityShapes: result.entries.map((entry) => [shape(entry.sourceIdentity), entry.canonicalIdentity ? shape(entry.canonicalIdentity) : null]),
        fsSource: shape(result.fsSource),
        fsCallable: Object.values(result.fsSource).every((value) => typeof value === "function"),
        fsStable: Object.keys(result.fsSource).every((key) => result.fsSource[key] === result.fsSource[key]),
        mutationStable: mutationResults.every((value) => value === false) &&
          result.status === originalStatus && originalEntries.every((original, index) =>
            result.entries[index] === original.entry && original.entry.id === original.id &&
            original.entry.sourceIdentity === original.sourceIdentity &&
            original.sourceIdentity.dev === original.sourceDev &&
            original.entry.canonicalIdentity === original.canonicalIdentity &&
            original.canonicalIdentity?.dev === original.canonicalDev),
      },
    }));
  } else if (operation === "drift") {
    let sourceReads = 0;
    const adapter = {
      ...fsPromises,
      createReadStream(path, options) {
        if (path.endsWith("notes 2.txt")) {
          sourceReads += 1;
          if (sourceReads === 2) writeFileSync(path, "changed between passes\\n");
        }
        return createReadStream(path, options);
      },
      lstatSync,
      realpathSync,
    };
    const result = await runtime.prepareQuarantineWorkspace({ ...request, fsApi: adapter });
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } else if (operation === "device") {
    const adapter = {
      ...fsPromises,
      async lstat(path) {
        const stats = await fsPromises.lstat(path);
        if (path === request.quarantineRoot) {
          return new Proxy(stats, { get(target, key, receiver) {
            if (key === "dev") return Number(target.dev) + 1;
            return Reflect.get(target, key, receiver);
          } });
        }
        return stats;
      },
      createReadStream,
      lstatSync,
      realpathSync,
    };
    const result = await transaction.inspectWorkspace({ ...request, fsApi: adapter });
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } else if (operation === "invalid-source-mode") {
    const adapter = {
      ...fsPromises,
      async lstat(path) {
        const stats = await fsPromises.lstat(path);
        if (path.endsWith("notes 2.txt")) {
          return new Proxy(stats, { get(target, key, receiver) {
            if (key === "mode") return Number.NaN;
            if (["isSymbolicLink", "isFile", "isDirectory"].includes(String(key))) {
              return Reflect.get(target, key, target).bind(target);
            }
            return Reflect.get(target, key, receiver);
          } });
        }
        return stats;
      },
      createReadStream,
      lstatSync,
      realpathSync,
    };
    const result = await transaction.inspectWorkspace({ ...request, fsApi: adapter });
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } else if (operation === "root-replacement") {
    let replaced = false;
    const adapter = {
      ...fsPromises,
      createReadStream(path, options) {
        if (!replaced && path.endsWith("notes.txt")) {
          replaced = true;
          renameSync(request.quarantineRoot, request.quarantineRoot + ".owned");
          mkdirSync(request.quarantineRoot, { mode: 0o700 });
          chmodSync(request.quarantineRoot, 0o700);
          writeFileSync(join(request.quarantineRoot, "replacement-sentinel"), "preserve");
        }
        return createReadStream(path, options);
      },
      lstatSync,
      realpathSync,
    };
    const result = await transaction.inspectWorkspace({ ...request, fsApi: adapter });
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } else if (operation === "generated-drift") {
    let quarantineRealpathCalls = 0;
    const adapter = {
      ...fsPromises,
      async realpath(path) {
        if (path === request.quarantineRoot) {
          quarantineRealpathCalls += 1;
          if (quarantineRealpathCalls === 2) {
            renameSync(join(request.repoRoot, ".next"), request.quarantineRoot + ".next-owned");
            mkdirSync(join(request.repoRoot, ".next"), { mode: 0o700 });
          }
        }
        return fsPromises.realpath(path);
      },
      createReadStream,
      lstatSync,
      realpathSync,
    };
    const result = await transaction.inspectWorkspace({ ...request, fsApi: adapter });
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } else if (operation === "file-identity-drift") {
    const { driftKind, ...runtimeRequest } = request;
    let quarantineRealpathCalls = 0;
    const adapter = {
      ...fsPromises,
      async realpath(path) {
        if (path === request.quarantineRoot) {
          quarantineRealpathCalls += 1;
          if (quarantineRealpathCalls === 2) {
            const relative = driftKind === "canonical" ? "notes.txt" : "notes 2.txt";
            const source = join(request.repoRoot, relative);
            renameSync(source, request.quarantineRoot + "." + driftKind + "-owned");
            writeFileSync(source, "canonical\\n");
          }
        }
        return fsPromises.realpath(path);
      },
      createReadStream,
      lstatSync,
      realpathSync,
    };
    const result = await transaction.inspectWorkspace({ ...runtimeRequest, fsApi: adapter });
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } else if (operation === "fs-capture") {
    const implementations = { ...fsPromises, createReadStream, lstatSync, realpathSync };
    const counts = {};
    let wrongReceiver = 0;
    const adapter = {};
    for (const method of ${JSON.stringify(FS_METHODS)}) {
      Object.defineProperty(adapter, method, {
        enumerable: true,
        configurable: true,
        get() {
          counts[method] = (counts[method] ?? 0) + 1;
          const implementation = implementations[method];
          return function (...args) {
            if (this !== adapter) wrongReceiver += 1;
            return Reflect.apply(implementation, implementations, args);
          };
        },
      });
    }
    const result = await transaction.inspectWorkspace({ ...request, fsApi: adapter });
    process.stdout.write(JSON.stringify({ ok: true, result, counts, wrongReceiver }));
  } else if (operation === "missing-fs-method") {
    const adapter = { ...fsPromises, createReadStream, lstatSync, realpathSync };
    delete adapter.readlink;
    const result = await transaction.inspectWorkspace({ ...request, fsApi: adapter });
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } else if (operation === "fs-late-mutation") {
    const base = { ...fsPromises, createReadStream, lstatSync, realpathSync };
    const adapter = {};
    for (const method of ${JSON.stringify(FS_METHODS)}) {
      adapter[method] = (...args) => Reflect.apply(base[method], base, args);
    }
    Object.defineProperty(adapter, "realpathSync", {
      enumerable: true,
      configurable: true,
      get() {
        adapter.lstat = () => { throw new Error("late mutation reached"); };
        return (...args) => Reflect.apply(base.realpathSync, base, args);
      },
    });
    const result = await transaction.inspectWorkspace({ ...request, fsApi: adapter });
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } else if (operation === "virtual-files") {
    const body = Buffer.from("canonical\\n");
    const repositoryStats = await fsPromises.lstat(request.repoRoot);
    const virtualPrefix = request.repoRoot + "/virtual-";
    const virtualStats = {
      dev: repositoryStats.dev,
      ino: 777,
      mode: 0o100600,
      size: body.length,
      isSymbolicLink: () => false,
      isFile: () => true,
      isDirectory: () => false,
    };
    const adapter = {
      ...fsPromises,
      async lstat(path) {
        if (path.startsWith(virtualPrefix)) return virtualStats;
        return fsPromises.lstat(path);
      },
      async realpath(path) {
        if (path.startsWith(virtualPrefix)) return path;
        return fsPromises.realpath(path);
      },
      createReadStream(path, options) {
        if (path.startsWith(virtualPrefix)) return Readable.from([body]);
        return createReadStream(path, options);
      },
      lstatSync,
      realpathSync,
    };
    const result = await transaction.inspectWorkspace({ ...request, fsApi: adapter });
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } else if (operation === "symbol") {
    const options = { ...request };
    options[Symbol("unknown-secret")] = true;
    const result = await transaction.inspectWorkspace(options);
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } else if (operation === "hook-error") {
    const injected = new RangeError("injected hook failure");
    const result = await runtime.prepareQuarantineWorkspace({
      ...request,
      faultHook() { throw injected; },
    });
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } else if (operation === "hook-sentinel") {
    const { variant, ...runtimeRequest } = request;
    let hookCalls = 0;
    let rejected = false;
    let captured;
    const adapter = variant === "prehook-undefined" ? {
      ...fsPromises,
      async readdir() { throw undefined; },
      createReadStream,
      lstatSync,
      realpathSync,
    } : undefined;
    try {
      await runtime.prepareQuarantineWorkspace({
        ...runtimeRequest,
        ...(adapter === undefined ? {} : { fsApi: adapter }),
        faultHook() {
          hookCalls += 1;
          if (variant === "hook-undefined") throw undefined;
        },
      });
    } catch (error) {
      rejected = true;
      captured = error;
    }
    process.stdout.write(JSON.stringify({
      ok: !rejected,
      hookCalls,
      thrownUndefined: rejected && captured === undefined,
      error: rejected && captured !== undefined ? errorShape(captured) : undefined,
    }));
  } else if (operation === "mkdir-error-code") {
    const { variant, ...runtimeRequest } = request;
    let codeReads = 0;
    const mkdirError = {};
    Object.defineProperty(mkdirError, "code", {
      get() {
        codeReads += 1;
        if (variant === "throw") throw new Error("code getter failure");
        return codeReads === 1 ? "EXDEV" : "EACCES";
      },
    });
    const adapter = {
      ...fsPromises,
      async mkdir() { throw mkdirError; },
      createReadStream,
      lstatSync,
      realpathSync,
    };
    let rejected = false;
    let captured;
    try {
      await runtime.prepareQuarantineWorkspace({ ...runtimeRequest, fsApi: adapter });
    } catch (error) {
      rejected = true;
      captured = error;
    }
    process.stdout.write(JSON.stringify({
      ok: !rejected,
      codeReads,
      error: rejected ? errorShape(captured) : undefined,
    }));
  } else if (operation === "sync-close-lifecycle") {
    const { variant, ...runtimeRequest } = request;
    let closeGetterReads = 0;
    let closeCalls = 0;
    let closeWrongReceiver = 0;
    let wrapped = false;
    const adapter = {
      ...fsPromises,
      async open(path, ...args) {
        const realHandle = await fsPromises.open(path, ...args);
        if (wrapped) return realHandle;
        wrapped = true;
        let handle;
        handle = {
          async sync() {
            if (variant === "sync-reject") throw new Error("sync failure");
            return realHandle.sync();
          },
          get close() {
            closeGetterReads += 1;
            return async function () {
              closeCalls += 1;
              if (this !== handle) closeWrongReceiver += 1;
              try { await realHandle.close(); } catch {}
              if (variant === "close-reject") throw new Error("close failure");
            };
          },
        };
        return handle;
      },
      createReadStream,
      lstatSync,
      realpathSync,
    };
    let rejected = false;
    let captured;
    try {
      await runtime.prepareQuarantineWorkspace({ ...runtimeRequest, fsApi: adapter });
    } catch (error) {
      rejected = true;
      captured = error;
    }
    process.stdout.write(JSON.stringify({
      ok: !rejected,
      closeGetterReads,
      closeCalls,
      closeWrongReceiver,
      error: rejected ? errorShape(captured) : undefined,
    }));
  } else if (operation === "layout-retry") {
    const { failureRelative, ...runtimeRequest } = request;
    const runRoot = join(request.quarantineRoot, request.transactionId);
    const target = failureRelative === "" ? runRoot : join(runRoot, failureRelative ?? "manifests");
    const targetParent = dirname(target);
    let targetCreated = false;
    let failureUsed = false;
    let runRootOpenAttempts = 0;
    const adapter = {
      ...fsPromises,
      async mkdir(path, ...args) {
        const result = await fsPromises.mkdir(path, ...args);
        if (path === target) targetCreated = true;
        return result;
      },
      async open(path, ...args) {
        if (targetCreated && path === targetParent) {
          runRootOpenAttempts += 1;
          if (!failureUsed) {
            failureUsed = true;
            const error = new Error("injected parent sync failure");
            error.code = "EACCES";
            throw error;
          }
        }
        return fsPromises.open(path, ...args);
      },
      createReadStream,
      lstatSync,
      realpathSync,
    };
    let firstCode;
    try {
      await runtime.prepareQuarantineWorkspace({ ...runtimeRequest, fsApi: adapter });
    } catch (error) {
      firstCode = error?.code;
    }
    const result = await runtime.prepareQuarantineWorkspace({ ...runtimeRequest, fsApi: adapter });
    process.stdout.write(JSON.stringify({ ok: true, result, firstCode, runRootOpenAttempts }));
  } else if (operation === "capability-handoff") {
    const handoff = await runtime.prepareQuarantineWorkspace(request);
    let leakedAdapter;
    const active = await withQuarantineRunCapability({
      repoRoot: request.repoRoot,
      quarantineRoot: request.quarantineRoot,
      transactionId: request.transactionId,
      writersStopped: true,
      fsApi: handoff.fsSource,
    }, async (capability) => {
      const bound = getRunFsContext(capability, handoff.fsSource);
      leakedAdapter = bound;
      await bound.lstat(request.repoRoot);
      let distinctRejected = false;
      try {
        getRunFsContext(capability, { ...handoff.fsSource });
      } catch {
        distinctRejected = true;
      }
      return { callable: typeof bound.lstat === "function", distinctRejected };
    });
    let revoked = false;
    try {
      await leakedAdapter.lstat(request.repoRoot);
    } catch {
      revoked = true;
    }
    process.stdout.write(JSON.stringify({
      ok: true,
      active,
      revoked,
      sourceFrozen: Object.isFrozen(handoff.fsSource),
    }));
  } else if (operation === "layout-replacement") {
    const runRoot = join(request.quarantineRoot, request.transactionId);
    let replaced = false;
    const adapter = {
      ...fsPromises,
      async open(path, ...args) {
        if (!replaced && path === runRoot) {
          replaced = true;
          renameSync(runRoot, runRoot + ".owned");
          mkdirSync(runRoot, { mode: 0o700 });
          chmodSync(runRoot, 0o700);
        }
        return fsPromises.open(path, ...args);
      },
      createReadStream,
      lstatSync,
      realpathSync,
    };
    const result = await runtime.prepareQuarantineWorkspace({ ...request, fsApi: adapter });
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } else if (operation === "prepare-raw") {
    const result = await runtime.prepareQuarantineWorkspace(request);
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } else {
    throw new Error("bad worker operation");
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: errorShape(error) }));
}
`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    input: JSON.stringify({ operation, request }),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout,
    env: { ...process.env, ...extraEnvironment },
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(child.stderr || `worker exited ${child.status}`);
  return JSON.parse(child.stdout) as WorkerResult;
}

export function invokeWithGitStdoutError(request: Record<string, unknown>): WorkerResult {
  const source = `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const originalSpawn = childProcess.spawn;
childProcess.spawn = function (...args) {
  const child = Reflect.apply(originalSpawn, this, args);
  const childArgs = args[1];
  if (Array.isArray(childArgs) && childArgs.includes("--no-index")) {
    child.stdout[Symbol.asyncIterator] = async function* () {
      throw new Error("injected Git stdout stream failure");
    };
  }
  return child;
};
syncBuiltinESMExports();
const transaction = await import(${JSON.stringify(transactionUrl)});
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
try {
  await transaction.quarantineWorkspace(request);
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: { name: error?.name, code: error?.code, message: error?.message },
  }));
}
`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    input: JSON.stringify(request),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(child.stderr || `worker exited ${child.status}`);
  return JSON.parse(child.stdout) as WorkerResult;
}
