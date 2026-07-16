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
  join(__dirname, "../../scripts/quarantine-transaction.mjs"),
).href;
const runtimeUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-workspace-runtime.mjs"),
).href;
const capabilityUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-run-capability.mjs"),
).href;
const journalUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-journal.mjs"),
).href;
const fsContextUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-run-fs-context.mjs"),
).href;
const legacyFacadeUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-numbered-copies-support.mjs"),
).href;

const FS_METHODS = [
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

const LAYOUT_RELATIVES = [
  "", "manifests", "inventories", "inventories/pre", "inventories/moved-pass-1",
  "inventories/moved-pass-2", "inventories/restore-active",
  "inventories/validation-pass-1", "inventories/validation-pass-2",
  "inventories/work", "payload", "payload/source-copies", "payload/generated",
  "rollback", "rollback/regenerated-before-restore", "conflicts", "divergent-diffs",
] as const;

const STATUS_RECORD_LIMIT = 1024 * 1024;
const HISTORY_FRAME_LIMIT = 4096;
const HISTORY_OID_BODY_LIMIT = 64;

type Fixture = {
  base: string;
  repoRoot: string;
  quarantineRoot: string;
  branch: string;
  head: string;
  historyHead?: string;
  canonicalPath?: string;
  copyPath?: string;
};

function git(repoRoot: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function listLockResidue(path: string, relative = ""): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.name.endsWith(".lock")) output.push(entryRelative);
    if (entry.isDirectory()) output.push(...listLockResidue(join(path, entry.name), entryRelative));
  }
  return output.sort();
}

function installGitOutputOverride(
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

function installGitDiffOverride(
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

function fixture({
  divergent = false,
  repoName = "repo",
  canonicalPath = "notes.txt",
  copyPath = "notes 2.txt",
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
  return {
    base: realpathSync(base),
    repoRoot: realpathSync(repoRoot),
    quarantineRoot: realpathSync(quarantineRoot),
    branch: git(repoRoot, "symbolic-ref", "--short", "HEAD"),
    head: git(repoRoot, "rev-parse", "HEAD"),
    historyHead,
    canonicalPath,
    copyPath,
  };
}

function canonicalDiff(f: Fixture) {
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

type DescriptorShape = {
  enumerable: boolean;
  configurable: boolean;
  writable: boolean;
  callable?: boolean;
};

type ValueShape = {
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

type WorkerEntry = {
  id: string;
  kind: string;
  classification?: string;
  historyMatch?: string | null;
};

type WorkerValue = {
  status?: string;
  runRoot?: string;
  entries?: WorkerEntry[];
  [key: string]: unknown;
};

type WorkerError = {
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

type WorkerResult = {
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

function invoke(
  operation: string,
  request: Record<string, unknown>,
  extraEnvironment: Record<string, string> = {},
  timeout = 10_000,
): WorkerResult {
  const source = `
import * as transaction from ${JSON.stringify(transactionUrl)};
import * as runtime from ${JSON.stringify(runtimeUrl)};
import { withQuarantineRunCapability } from ${JSON.stringify(capabilityUrl)};
import { appendJournalRecord, replayJournal, withJournalLock } from ${JSON.stringify(journalUrl)};
import { getRunFsContext } from ${JSON.stringify(fsContextUrl)};
import * as fsPromises from "node:fs/promises";
import {
  appendFileSync, chmodSync, createReadStream, existsSync, lstatSync, mkdirSync, realpathSync,
  renameSync, symlinkSync, truncateSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

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

function invokeWithGitStdoutError(request: Record<string, unknown>): WorkerResult {
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

function expectWorkerError(result: WorkerResult, code: string, message: string) {
  expect(result.ok).toBe(false);
  expect(result.error!).toMatchObject({
    instanceOfError: true,
    name: "QuarantineError",
    code,
    message,
    symbolCount: 0,
    enumerableKeys: [],
    json: "{}",
    frozen: true,
    extensible: false,
    prototypeIsError: false,
    prototypeParentIsError: true,
    prototypeOwnKeys: ["constructor"],
    codeMutationInert: true,
  });
  expect(new Set(result.error!.ownKeys)).toEqual(new Set(["stack", "message", "name", "code"]));
  for (const descriptor of Object.values(result.error!.descriptors)) {
    expect(descriptor).toMatchObject({ enumerable: false, configurable: false, writable: false });
  }
}

describe("quarantine transaction Slice 1", () => {
  const bases: string[] = [];

  afterEach(() => {
    for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  });

  it("exposes the completed atomic apply API only at the Slice 2 surfaces", async () => {
    const exports = invoke("exports", {});
    expect(exports.exports).toEqual(["inspectWorkspace", "quarantineWorkspace"]);
    expect(exports.runtimeExports).toEqual([
      "inspectWorkspace",
      "prepareQuarantineWorkspace",
      "quarantineWorkspace",
    ]);
    expect(exports.legacyExports).not.toContain("prepareQuarantineWorkspace");
    const packageJson = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8"));
    expect(Object.hasOwn(packageJson, "exports")).toBe(false);
  });

  it("returns QUARANTINED only after the complete durable atomic-move protocol", () => {
    const f = fixture();
    bases.push(f.base);
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-slice-2-happy",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const worker = invoke("apply", request, {}, 30_000);
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect(worker.result).toEqual({
      transactionId: "tx-slice-2-happy",
      status: "QUARANTINED",
      movedEntries: 3,
      manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(worker.phases).toEqual([
      "after-layout-sync",
      "after-pre-inventories",
      "after-prepared-generation",
      "after-event:PREPARED",
      "after-event:MOVING",
      "after-event:MOVE_INTENT:generated-next",
      "after-rename:generated-next",
      "after-payload-sync:generated-next",
      "after-destination-parent-sync:generated-next",
      "after-source-parent-sync:generated-next",
      "after-inventory:moved-pass-1:generated-next",
      "after-event:MOVED:generated-next",
      "after-event:MOVE_INTENT:generated-node-modules",
      "after-rename:generated-node-modules",
      "after-payload-sync:generated-node-modules",
      "after-destination-parent-sync:generated-node-modules",
      "after-source-parent-sync:generated-node-modules",
      "after-inventory:moved-pass-1:generated-node-modules",
      "after-event:MOVED:generated-node-modules",
      "after-event:MOVE_INTENT:copy-0001",
      "after-rename:copy-0001",
      "after-payload-sync:copy-0001",
      "after-destination-parent-sync:copy-0001",
      "after-source-parent-sync:copy-0001",
      "after-inventory:moved-pass-1:copy-0001",
      "after-event:MOVED:copy-0001",
      "after-event:VERIFYING",
      "after-inventory:moved-pass-2:generated-next",
      "after-inventory:moved-pass-2:generated-node-modules",
      "after-inventory:moved-pass-2:copy-0001",
      "after-event:QUARANTINED",
      "before-lock-cleanup",
    ]);
    expect(existsSync(join(f.repoRoot, ".next"))).toBe(false);
    expect(existsSync(join(f.repoRoot, "node_modules"))).toBe(false);
    expect(existsSync(join(f.repoRoot, "notes 2.txt"))).toBe(false);
    expect(existsSync(join(f.quarantineRoot, "current"))).toBe(false);
    const runRoot = join(f.quarantineRoot, request.transactionId);
    const manifestSha256 = worker.result?.manifestSha256 as string;
    const manifestNames = readdirSync(join(runRoot, "manifests"));
    expect(manifestNames).toEqual([`${manifestSha256}.json`]);
    const manifestBytes = readFileSync(join(runRoot, "manifests", manifestNames[0]));
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    expect(manifestBytes).toEqual(Buffer.from(`${JSON.stringify(manifest)}\n`));
    expect(createHash("sha256").update(manifestBytes).digest("hex")).toBe(manifestSha256);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      transactionId: request.transactionId,
      state: "PREPARED",
      retentionDays: 4,
      deletionRequiresConfirmation: true,
      deleteAfter: null,
      deletionStatus: "retained",
    });
    expect(manifest.entries.map((entry: { id: string }) => entry.id)).toEqual([
      "generated-next", "generated-node-modules", "copy-0001",
    ]);
    const summaries = new Map(manifest.entries.map(
      (entry: { id: string; preMoveInventory: unknown }) => [entry.id, entry.preMoveInventory],
    ));
    const replay = invoke("replay-run", request, {}, 30_000);
    if (!replay.ok) throw new Error(JSON.stringify(replay.error));
    const replayed = replay.result as {
      state: string;
      records: Array<{ sequence: number; event: string; payload: Record<string, unknown> }>;
    };
    expect(replayed.state).toBe("QUARANTINED");
    expect(replayed.records).toEqual([
      { sequence: 1, event: "PREPARED", payload: {
        transactionId: request.transactionId,
        manifestSha256,
      } },
      { sequence: 2, event: "MOVING", payload: {} },
      ...["generated-next", "generated-node-modules", "copy-0001"].flatMap((id, index) => [
        { sequence: 3 + 2 * index, event: "MOVE_INTENT", payload: {
          id,
          expected: summaries.get(id),
        } },
        { sequence: 4 + 2 * index, event: "MOVED", payload: {
          id,
          observed: summaries.get(id),
        } },
      ]),
      { sequence: 9, event: "VERIFYING", payload: {} },
      { sequence: 10, event: "QUARANTINED", payload: {} },
    ]);
    expect(readdirSync(runRoot).filter((name) => name === "journal.lock" ||
      name.startsWith("journal.lock.tombstone."))).toEqual([]);
    expect(readdirSync(join(runRoot, "manifests")).some((name) =>
      name === "current" || name.includes("intermediate"))).toBe(false);
  });

  it("uses exact global byte order for two source copies and two generated roots", () => {
    const f = fixture();
    bases.push(f.base);
    writeFileSync(join(f.repoRoot, "alpha.txt"), "alpha\n");
    git(f.repoRoot, "add", "alpha.txt");
    git(f.repoRoot, "commit", "-m", "add second canonical");
    writeFileSync(join(f.repoRoot, "alpha 2.txt"), "alpha\n");
    f.head = git(f.repoRoot, "rev-parse", "HEAD");
    const worker = invoke("apply", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 2,
      transactionId: "tx-global-entry-order",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, {}, 30_000);
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const ids = ["generated-next", "copy-0001", "generated-node-modules", "copy-0002"];
    const movePhases = ids.flatMap((id) => [
      `after-event:MOVE_INTENT:${id}`,
      `after-rename:${id}`,
      `after-payload-sync:${id}`,
      `after-destination-parent-sync:${id}`,
      `after-source-parent-sync:${id}`,
      `after-inventory:moved-pass-1:${id}`,
      `after-event:MOVED:${id}`,
    ]);
    expect(worker.phases).toEqual([
      "after-layout-sync",
      "after-pre-inventories",
      "after-prepared-generation",
      "after-event:PREPARED",
      "after-event:MOVING",
      ...movePhases,
      "after-event:VERIFYING",
      ...ids.map((id) => `after-inventory:moved-pass-2:${id}`),
      "after-event:QUARANTINED",
      "before-lock-cleanup",
    ]);
    expect(worker.result).toMatchObject({ status: "QUARANTINED", movedEntries: 4 });
  });

  it("instruments real rename, fsync, and lock state at every public apply hook", () => {
    const f = fixture();
    bases.push(f.base);
    const transactionId = "tx-public-hook-instrumentation";
    const worker = invoke("apply-instrumented", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, {}, 30_000);
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const instrumentation = worker.instrumentation!;
    expect(instrumentation.snapshots.map(({ phase }) => phase)).toEqual(worker.phases);
    const runRoot = join(f.quarantineRoot, transactionId);
    const moves = [
      ["generated-next", join(f.repoRoot, ".next"), join(runRoot, "payload/generated/.next")],
      ["generated-node-modules", join(f.repoRoot, "node_modules"), join(runRoot, "payload/generated/node_modules")],
      ["copy-0001", join(f.repoRoot, "notes 2.txt"), join(runRoot, "payload/source-copies/copy-0001")],
    ] as const;
    expect(instrumentation.renamed).toEqual(moves.map(([, source, destination]) => [
      source,
      destination,
    ]));
    for (const [id, source, destination] of moves) {
      const atRename = instrumentation.snapshots.find(({ phase }) => phase === `after-rename:${id}`)!;
      expect(atRename.renamed).toContainEqual([source, destination]);
      const atPayload = instrumentation.snapshots.find(
        ({ phase }) => phase === `after-payload-sync:${id}`,
      )!;
      expect(atPayload.synced).toContain(destination);
      const atDestinationParent = instrumentation.snapshots.find(
        ({ phase }) => phase === `after-destination-parent-sync:${id}`,
      )!;
      expect(atDestinationParent.synced).toContain(dirname(destination));
      const atSourceParent = instrumentation.snapshots.find(
        ({ phase }) => phase === `after-source-parent-sync:${id}`,
      )!;
      expect(atSourceParent.synced).toContain(dirname(source));
      expect(existsSync(join(runRoot, "inventories/moved-pass-1", `${id}.jsonl`))).toBe(true);
      expect(existsSync(join(runRoot, "inventories/moved-pass-2", `${id}.jsonl`))).toBe(true);
    }
    const eventPhases = worker.phases!.filter((phase) => phase.startsWith("after-event:"));
    for (let index = 0; index < eventPhases.length; index += 1) {
      const snapshot = instrumentation.snapshots.find(({ phase }) => phase === eventPhases[index])!;
      const finalEvent = eventPhases[index] === "after-event:QUARANTINED";
      expect(snapshot.lockCreates).toBe(index + 1);
      expect(snapshot.lockRemovals).toBe(finalEvent ? index : index + 1);
      expect(snapshot.lockExists).toBe(finalEvent);
    }
    const beforeCleanup = instrumentation.snapshots.find(
      ({ phase }) => phase === "before-lock-cleanup",
    )!;
    expect(beforeCleanup).toMatchObject({ lockCreates: 10, lockRemovals: 9, lockExists: true });
    expect(instrumentation.lockCreates).toBe(10);
    expect(instrumentation.lockRemovals).toBe(10);
    expect(existsSync(join(runRoot, "journal.lock"))).toBe(false);
  });

  it("handles deterministic hook rejection at every public apply phase", () => {
    const ids = ["generated-next", "generated-node-modules", "copy-0001"];
    const phases = [
      "after-layout-sync",
      "after-pre-inventories",
      "after-prepared-generation",
      "after-event:PREPARED",
      "after-event:MOVING",
      ...ids.flatMap((id) => [
        `after-event:MOVE_INTENT:${id}`,
        `after-rename:${id}`,
        `after-payload-sync:${id}`,
        `after-destination-parent-sync:${id}`,
        `after-source-parent-sync:${id}`,
        `after-inventory:moved-pass-1:${id}`,
        `after-event:MOVED:${id}`,
      ]),
      "after-event:VERIFYING",
      ...ids.map((id) => `after-inventory:moved-pass-2:${id}`),
      "after-event:QUARANTINED",
      "before-lock-cleanup",
    ];
    for (const [index, stopPhase] of phases.entries()) {
      const f = fixture();
      bases.push(f.base);
      const transactionId = `tx-hook-rejection-${String(index + 1).padStart(2, "0")}`;
      const worker = invoke("apply-stop", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
        stopPhase,
      }, {}, 30_000);
      expect(worker.ok).toBe(false);
      expect(worker.phases?.at(-1)).toBe(stopPhase);
      if (stopPhase === "after-event:QUARANTINED" || stopPhase === "before-lock-cleanup") {
        expect(worker.error).toMatchObject({
          name: "QuarantineError",
          code: "ERR_INDETERMINATE_JOURNAL_APPEND",
        });
        expect(existsSync(join(f.quarantineRoot, transactionId, "journal.lock"))).toBe(true);
      } else {
        expect(worker.error).toMatchObject({ name: "RangeError", message: "stop at requested phase" });
      }
    }
  });

  it("prioritizes a durable PREPARED journal over precommit mismatch before Git discovery", () => {
    const f = fixture();
    bases.push(f.base);
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-existing-journal",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const seeded = invoke("seed-prepared", request, {}, 30_000);
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    writeFileSync(join(f.quarantineRoot, request.transactionId, "manifests", "foreign"), "preserve");
    const sentinel = join(f.base, "git-was-invoked");
    const bin = join(f.base, "reject-git");
    privateDirectory(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nprintf invoked > ${JSON.stringify(sentinel)}\nexit 99\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);

    const worker = invoke("apply", request, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    expectWorkerError(
      worker,
      "ERR_RECOVERY_REQUIRED",
      "Explicit quarantine recovery is required.",
    );
    expect(existsSync(sentinel)).toBe(false);
    expect(readFileSync(
      join(f.quarantineRoot, request.transactionId, "manifests", "foreign"),
      "utf8",
    )).toBe("preserve");
  });

  it.each([
    ["MOVING", "after-event:MOVING", "journal"],
    ["VERIFYING", "after-event:VERIFYING", "torn-journal"],
    ["QUARANTINED", "after-event:QUARANTINED", "lock"],
  ] as const)(
    "prioritizes %s recovery evidence with %s residue before precommit and Git",
    (_stage, stopPhase, residue) => {
      const f = fixture();
      bases.push(f.base);
      const transactionId = `tx-gate-${residue}`;
      const request = {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      };
      const first = invoke("apply-stop", { ...request, stopPhase }, {}, 30_000);
      expect(first.ok).toBe(false);
      const runRoot = join(f.quarantineRoot, transactionId);
      if (residue === "torn-journal") {
        appendFileSync(join(runRoot, "journal.log"), Buffer.from([0, 0, 0, 9, 0x7b]));
      }
      writeFileSync(join(runRoot, "manifests", "foreign"), "preserve", { mode: 0o600 });
      chmodSync(join(runRoot, "manifests", "foreign"), 0o600);
      const sentinel = join(f.base, "git-was-invoked");
      const bin = join(f.base, `reject-git-${residue}`);
      privateDirectory(bin);
      writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf invoked > ${JSON.stringify(sentinel)}\nexit 99\n`, {
        mode: 0o700,
      });
      chmodSync(join(bin, "git"), 0o700);
      expectWorkerError(
        invoke("apply", request, { PATH: `${bin}:${process.env.PATH ?? ""}` }),
        "ERR_RECOVERY_REQUIRED",
        "Explicit quarantine recovery is required.",
      );
      expect(existsSync(sentinel)).toBe(false);
      expect(readFileSync(join(runRoot, "manifests", "foreign"), "utf8")).toBe("preserve");
    },
  );

  it.each(["lock", "tombstone"] as const)(
    "prioritizes a journal %s residue even without journal.log",
    (residue) => {
      const f = fixture();
      bases.push(f.base);
      const transactionId = `tx-gate-residue-${residue}`;
      const request = {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      };
      const prepared = invoke("prepare-raw", request, {}, 30_000);
      if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
      const name = residue === "lock"
        ? "journal.lock"
        : "journal.lock.tombstone.11111111-1111-4111-8111-111111111111";
      const artifact = join(f.quarantineRoot, transactionId, name);
      writeFileSync(artifact, "foreign", { mode: 0o600 });
      chmodSync(artifact, 0o600);
      expectWorkerError(
        invoke("apply", request, {}, 30_000),
        "ERR_RECOVERY_REQUIRED",
        "Explicit quarantine recovery is required.",
      );
      expect(readFileSync(artifact, "utf8")).toBe("foreign");
    },
  );

  it("completes an ancestor-closed partial layout before advancing apply", () => {
    const f = fixture();
    bases.push(f.base);
    const runRoot = join(f.quarantineRoot, "tx-partial-layout");
    privateDirectory(runRoot);
    privateDirectory(join(runRoot, "manifests"));
    const worker = invoke("apply-stop-after-layout", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-partial-layout",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, {}, 30_000);
    expect(worker.ok).toBe(false);
    expect(worker.phases).toEqual(["after-layout-sync"]);
    expect(worker.error).toMatchObject({ name: "RangeError", message: "stop after layout" });
    for (const relativePath of LAYOUT_RELATIVES) {
      expect(statSync(relativePath === "" ? runRoot : join(runRoot, relativePath)).mode & 0o7777)
        .toBe(0o700);
    }
  });

  it("keeps direct prepare strict while private apply admits only closed precommit finals", () => {
    const f = fixture();
    bases.push(f.base);
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-private-resume",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const prepared = invoke("prepare-raw", request, {}, 30_000);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const preInventory = join(
      f.quarantineRoot,
      request.transactionId,
      "inventories/pre/copy-0001.jsonl",
    );
    writeFileSync(preInventory, "preserve", { mode: 0o600 });
    chmodSync(preInventory, 0o600);
    expectWorkerError(
      invoke("prepare-raw", request, {}, 30_000),
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    const apply = invoke("apply-stop-after-layout", request, {}, 30_000);
    expect(apply.ok).toBe(false);
    expect(apply.phases).toEqual(["after-layout-sync"]);
    expect(apply.error).toMatchObject({ name: "RangeError", message: "stop after layout" });
    expect(readFileSync(preInventory, "utf8")).toBe("preserve");
    expectWorkerError(
      invoke("apply", request, {}, 30_000),
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(readFileSync(preInventory, "utf8")).toBe("preserve");
  });

  it("publishes exact pre inventories and one immutable generation before durable PREPARED", () => {
    const f = fixture();
    bases.push(f.base);
    const transactionId = "tx-prepared-boundary";
    const worker = invoke("apply-stop", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
      stopPhase: "after-event:PREPARED",
    }, {}, 30_000);
    expect(worker.ok).toBe(false);
    expect(worker.phases).toEqual([
      "after-layout-sync",
      "after-pre-inventories",
      "after-prepared-generation",
      "after-event:PREPARED",
    ]);
    expect(worker.error).toMatchObject({ name: "RangeError", message: "stop at requested phase" });
    const runRoot = join(f.quarantineRoot, transactionId);
    for (const id of ["generated-next", "generated-node-modules", "copy-0001"]) {
      const path = join(runRoot, "inventories/pre", `${id}.jsonl`);
      expect(statSync(path).mode & 0o7777).toBe(0o600);
      expect(readFileSync(path).length).toBeGreaterThan(0);
    }
    const generations = readdirSync(join(runRoot, "manifests"));
    expect(generations).toHaveLength(1);
    expect(generations[0]).toMatch(/^[0-9a-f]{64}\.json$/u);
    expect(statSync(join(runRoot, "journal.log")).mode & 0o7777).toBe(0o600);
    expect(existsSync(join(f.repoRoot, ".next"))).toBe(true);
    expect(existsSync(join(f.repoRoot, "node_modules"))).toBe(true);
    expect(existsSync(join(f.repoRoot, "notes 2.txt"))).toBe(true);
  });

  it("streams and durably publishes each divergent patch before PREPARED", () => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const transactionId = "tx-divergent-patch";
    const worker = invoke("apply-stop", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
      stopPhase: "after-divergent-diff:copy-0001",
    }, {}, 30_000);
    expect(worker.ok).toBe(false);
    expect(worker.phases).toEqual([
      "after-layout-sync",
      "after-pre-inventories",
      "after-divergent-diff:copy-0001",
    ]);
    expect(worker.error).toMatchObject({ name: "RangeError", message: "stop at requested phase" });
    const diffRoot = join(f.quarantineRoot, transactionId, "divergent-diffs");
    expect(statSync(join(diffRoot, "copy-0001.patch")).mode & 0o7777).toBe(0o600);
    expect(readFileSync(join(diffRoot, "copy-0001.patch")).length).toBeGreaterThan(0);
    expect(existsSync(join(diffRoot, ".copy-0001.tmp"))).toBe(false);
    expect(existsSync(join(f.quarantineRoot, transactionId, "journal.log"))).toBe(false);
  });

  it.each([
    ["cap", 0, 1, true],
    ["cap-plus-one", 1, 1, false],
    ["stderr-limit", -1, 1, true],
    ["stderr-overflow", -2, 1, false],
    ["exit-zero", -1, 0, false],
  ] as const)(
    "bounds and settles the divergent Git child case %s",
    (label, capDelta, exit, succeeds) => {
      const f = fixture({ divergent: true });
      bases.push(f.base);
      const cap = 4 * (
        statSync(join(f.repoRoot, f.canonicalPath!)).size +
        statSync(join(f.repoRoot, f.copyPath!)).size
      ) + 1_048_576;
      const stdout = capDelta >= 0
        ? Buffer.alloc(cap + capDelta, 0x61)
        : Buffer.from("canonical patch bytes\n");
      const stderr = capDelta === -1
        ? Buffer.alloc(64 * 1024, 0x65)
        : capDelta === -2
          ? Buffer.alloc(64 * 1024 + 1, 0x65)
          : Buffer.alloc(0);
      const path = installGitDiffOverride(f, label, stdout, { stderr, exit });
      const worker = invoke("apply", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId: `tx-diff-${label}`,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      }, { PATH: path }, 30_000);
      if (succeeds) {
        if (!worker.ok) throw new Error(JSON.stringify(worker.error));
        expect(worker.result).toMatchObject({ status: "QUARANTINED" });
      } else {
        expectWorkerError(
          worker,
          "ERR_INTEGRITY",
          "Quarantine evidence failed integrity validation.",
        );
      }
    },
  );

  it.each([
    ["nonzero", { exit: 2 }],
    ["partial-signal", { signal: "TERM" }],
  ] as const)("rejects and settles a divergent Git child %s outcome", (label, outcome) => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const diff = canonicalDiff(f);
    const path = installGitDiffOverride(
      f,
      label,
      label === "partial-signal" ? diff.subarray(0, Math.max(1, Math.floor(diff.length / 2))) : diff,
      outcome,
    );
    const transactionId = `tx-child-${label}`;
    expectWorkerError(
      invoke("apply", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      }, { PATH: path }, 30_000),
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(existsSync(join(f.quarantineRoot, transactionId, "journal.log"))).toBe(false);
  });

  it("rejects and settles a divergent Git child spawn error", () => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const path = installGitDiffOverride(f, "spawn-error", canonicalDiff(f));
    const isolatedBin = path.slice(0, path.indexOf(":"));
    const transactionId = "tx-child-spawn-error";
    const worker = invoke("apply-divergent-spawn-error", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, { PATH: isolatedBin }, 30_000);
    expect(worker.injected).toBe(true);
    expectWorkerError(
      worker,
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(existsSync(join(f.quarantineRoot, transactionId, "journal.log"))).toBe(false);
  });

  it.each(["safe-boundary", "overflow"] as const)(
    "checks the divergent cap %s before spawning Git",
    (variant) => {
      const f = fixture({ divergent: true });
      bases.push(f.base);
      const largestSafeCombined = Math.floor(
        (Number.MAX_SAFE_INTEGER - 1_048_576) / 4,
      );
      const combined = variant === "safe-boundary"
        ? largestSafeCombined
        : largestSafeCombined + 1;
      const virtualSourceSize = Math.floor(combined / 2);
      const virtualCanonicalSize = combined - virtualSourceSize;
      const sentinel = join(f.base, `diff-spawn-${variant}`);
      const path = installGitDiffOverride(
        f,
        `virtual-cap-${variant}`,
        canonicalDiff(f),
        { sentinel },
      );
      const transactionId = `tx-virtual-cap-${variant}`;
      const worker = invoke("apply-virtual-cap", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
        virtualSourceSize,
        virtualCanonicalSize,
        stopPhase: "after-divergent-diff:copy-0001",
      }, { PATH: path }, 30_000);
      if (variant === "safe-boundary") {
        expect(worker.ok).toBe(false);
        expect(worker.error).toMatchObject({ name: "RangeError", message: "stop at requested phase" });
        expect(existsSync(sentinel)).toBe(true);
      } else {
        expectWorkerError(
          worker,
          "ERR_INTEGRITY",
          "Quarantine evidence failed integrity validation.",
        );
        expect(existsSync(sentinel)).toBe(false);
      }
      expect(existsSync(join(f.quarantineRoot, transactionId, "journal.log"))).toBe(false);
    },
  );

  it("keeps canonical re-comparison reads bounded to 64 KiB for multi-MiB output", () => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    writeFileSync(join(f.repoRoot, f.canonicalPath!), Buffer.alloc(1024 * 1024, 0x61));
    git(f.repoRoot, "add", f.canonicalPath!);
    git(f.repoRoot, "commit", "-m", "large canonical");
    writeFileSync(join(f.repoRoot, f.copyPath!), Buffer.alloc(1024 * 1024, 0x62));
    f.head = git(f.repoRoot, "rev-parse", "HEAD");
    const transactionId = "tx-bounded-canonical-compare";
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const prepared = invoke("prepare-raw", request, {}, 30_000);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const output = Buffer.alloc(6 * 1024 * 1024, 0x70);
    const temporary = join(
      f.quarantineRoot,
      transactionId,
      "divergent-diffs/.copy-0001.tmp",
    );
    writeFileSync(temporary, output, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    const path = installGitDiffOverride(f, "bounded-canonical-compare", output);
    const worker = invoke("apply-observe-read-bound", {
      ...request,
      stopPhase: "after-divergent-diff:copy-0001",
    }, { PATH: path }, 30_000);
    expect(worker.ok).toBe(false);
    expect(worker.error).toMatchObject({ name: "RangeError", message: "stop at requested phase" });
    expect(worker.maxReadLength).toBe(64 * 1024);
    expect(readFileSync(join(
      f.quarantineRoot,
      transactionId,
      "divergent-diffs/copy-0001.patch",
    )).length).toBe(output.length);
  });

  it("keeps final-only two-file comparison reads bounded to 64 KiB", () => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    writeFileSync(join(f.repoRoot, f.canonicalPath!), Buffer.alloc(1024 * 1024, 0x63));
    git(f.repoRoot, "add", f.canonicalPath!);
    git(f.repoRoot, "commit", "-m", "large final-only canonical");
    writeFileSync(join(f.repoRoot, f.copyPath!), Buffer.alloc(1024 * 1024, 0x64));
    f.head = git(f.repoRoot, "rev-parse", "HEAD");
    const transactionId = "tx-bounded-final-only-compare";
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const output = Buffer.alloc(6 * 1024 * 1024, 0x71);
    const path = installGitDiffOverride(f, "bounded-final-only-compare", output);
    const first = invoke("apply-stop", {
      ...request,
      stopPhase: "after-divergent-diff:copy-0001",
    }, { PATH: path }, 30_000);
    expect(first.ok).toBe(false);
    const worker = invoke("apply-observe-read-bound", {
      ...request,
      stopPhase: "after-divergent-diff:copy-0001",
    }, { PATH: path }, 30_000);
    expect(worker.ok).toBe(false);
    expect(worker.error).toMatchObject({ name: "RangeError", message: "stop at requested phase" });
    expect(worker.maxReadLength).toBe(64 * 1024);
    expect(readFileSync(join(
      f.quarantineRoot,
      transactionId,
      "divergent-diffs/copy-0001.patch",
    )).length).toBe(output.length);
  });

  it.each([false, true])(
    "settles the left compare handle exactly once when right open fails (closeFailure=%s)",
    (closeFailure) => {
      const f = fixture({ divergent: true });
      bases.push(f.base);
      const transactionId = `tx-right-open-failure-${closeFailure}`;
      const request = {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      };
      const first = invoke("apply-stop", {
        ...request,
        stopPhase: "after-divergent-diff:copy-0001",
      }, {}, 30_000);
      expect(first.ok).toBe(false);
      const worker = invoke("apply-final-only-right-open-failure", {
        ...request,
        closeFailure,
      }, {}, 30_000);
      expectWorkerError(
        worker,
        "ERR_INTEGRITY",
        "Quarantine evidence failed integrity validation.",
      );
      expect(worker.closeGetterReads).toBe(1);
      expect(worker.closeCalls).toBe(1);
      expect(worker.closeWrongReceiver).toBe(0);
    },
  );

  it("settles a true Git stdout stream error independently of child signals", () => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const transactionId = "tx-child-stdout-error";
    const worker = invokeWithGitStdoutError({
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    });
    expect(worker).toMatchObject({
      ok: false,
      error: {
        name: "QuarantineError",
        code: "ERR_INTEGRITY",
        message: "Quarantine evidence failed integrity validation.",
      },
    });
    expect(existsSync(join(f.quarantineRoot, transactionId, "journal.log"))).toBe(false);
  });

  it("keeps hostile external-diff and textconv drivers disabled", () => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const sentinel = join(f.base, "hostile-diff-ran");
    const driver = join(f.base, "hostile-diff.sh");
    writeFileSync(driver, `#!/bin/sh\nprintf invoked > ${JSON.stringify(sentinel)}\nexit 99\n`, {
      mode: 0o700,
    });
    chmodSync(driver, 0o700);
    writeFileSync(join(f.repoRoot, ".gitattributes"), "*.txt diff=hostile\n");
    git(f.repoRoot, "add", ".gitattributes");
    git(f.repoRoot, "commit", "-m", "hostile diff attributes");
    git(f.repoRoot, "config", "diff.external", driver);
    git(f.repoRoot, "config", "diff.hostile.textconv", driver);
    f.head = git(f.repoRoot, "rev-parse", "HEAD");
    const worker = invoke("apply", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-hostile-diff",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, {}, 30_000);
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect(worker.result).toMatchObject({ status: "QUARANTINED" });
    expect(existsSync(sentinel)).toBe(false);
  });

  it.each([
    ["zero-byte", Buffer.alloc(0)],
    ["binary", Buffer.from([0, 1, 2, 255])],
    ["no-final-newline", Buffer.from("older content")],
  ] as const)("publishes an actual Git patch with a %s source side", (label, body) => {
    const f = fixture();
    bases.push(f.base);
    writeFileSync(join(f.repoRoot, f.copyPath!), body);
    const worker = invoke("apply", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: `tx-patch-${label}`,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, {}, 30_000);
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const patch = readFileSync(join(
      f.quarantineRoot,
      `tx-patch-${label}`,
      "divergent-diffs/copy-0001.patch",
    ));
    expect(patch.length).toBeGreaterThan(0);
  });

  it("durably records intent, rename syncs, pass-1 inventory, and MOVED per entry", () => {
    const f = fixture();
    bases.push(f.base);
    const transactionId = "tx-first-moved";
    const worker = invoke("apply-stop", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
      stopPhase: "after-event:MOVED:generated-next",
    }, {}, 30_000);
    expect(worker.ok).toBe(false);
    expect(worker.phases).toEqual([
      "after-layout-sync",
      "after-pre-inventories",
      "after-prepared-generation",
      "after-event:PREPARED",
      "after-event:MOVING",
      "after-event:MOVE_INTENT:generated-next",
      "after-rename:generated-next",
      "after-payload-sync:generated-next",
      "after-destination-parent-sync:generated-next",
      "after-source-parent-sync:generated-next",
      "after-inventory:moved-pass-1:generated-next",
      "after-event:MOVED:generated-next",
    ]);
    expect(worker.error).toMatchObject({ name: "RangeError", message: "stop at requested phase" });
    const runRoot = join(f.quarantineRoot, transactionId);
    expect(existsSync(join(f.repoRoot, ".next"))).toBe(false);
    expect(existsSync(join(runRoot, "payload/generated/.next"))).toBe(true);
    expect(existsSync(join(f.repoRoot, "node_modules"))).toBe(true);
    expect(existsSync(join(f.repoRoot, "notes 2.txt"))).toBe(true);
    expect(statSync(join(
      runRoot,
      "inventories/moved-pass-1/generated-next.jsonl",
    )).mode & 0o7777).toBe(0o600);
  });

  it.each([false, true])(
    "recomputes and adopts exact precommit finals on retry (divergent=%s)",
    (divergent) => {
      const f = fixture({ divergent });
      bases.push(f.base);
      const transactionId = divergent ? "tx-retry-divergent" : "tx-retry-generation";
      const request = {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      };
      const first = invoke("apply-stop", {
        ...request,
        stopPhase: divergent
          ? "after-divergent-diff:copy-0001"
          : "after-prepared-generation",
      }, {}, 30_000);
      expect(first.ok).toBe(false);
      expect(first.error).toMatchObject({ name: "RangeError" });
      const second = invoke("apply", request, {}, 30_000);
      if (!second.ok) throw new Error(JSON.stringify(second.error));
      expect(second.result).toMatchObject({
        transactionId,
        status: "QUARANTINED",
        movedEntries: 3,
      });
    },
  );

  it("adopts all exact pre inventories after the inventory publication seam", () => {
    const f = fixture();
    bases.push(f.base);
    const transactionId = "tx-retry-inventories";
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const first = invoke("apply-stop", {
      ...request,
      stopPhase: "after-pre-inventories",
    }, {}, 30_000);
    expect(first.ok).toBe(false);
    const second = invoke("apply", request, {}, 30_000);
    if (!second.ok) throw new Error(JSON.stringify(second.error));
    expect(second.result).toMatchObject({ status: "QUARANTINED", movedEntries: 3 });
  });

  it.each(["after-event:QUARANTINED", "before-lock-cleanup"])(
    "maps final in-lock hook rejection at %s to indeterminate and preserves evidence",
    (stopPhase) => {
    const f = fixture();
    bases.push(f.base);
    const transactionId = "tx-final-hook";
    const worker = invoke("apply-stop", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
      stopPhase,
    }, {}, 30_000);
    expectWorkerError(
      worker,
      "ERR_INDETERMINATE_JOURNAL_APPEND",
      "Journal durability could not be determined.",
    );
    expect(worker.phases?.at(-1)).toBe(stopPhase);
    const runRoot = join(f.quarantineRoot, transactionId);
    expect(existsSync(join(runRoot, "journal.log"))).toBe(true);
    expect(existsSync(join(runRoot, "journal.lock"))).toBe(true);
    },
  );

  it.each([
    ["unchanged", "ERR_EXDEV"],
    ["source-changed", "ERR_INTEGRITY"],
    ["destination-created", "ERR_INTEGRITY"],
  ] as const)("classifies rename EXDEV only after fresh evidence checks (%s)", (variant, code) => {
    const f = fixture();
    bases.push(f.base);
    const worker = invoke("apply-rename-exdev", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: `tx-exdev-${variant}`,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
      variant,
    }, {}, 30_000);
    expectWorkerError(
      worker,
      code,
      code === "ERR_EXDEV"
        ? "Repository and quarantine must be on the same filesystem."
        : "Quarantine evidence failed integrity validation.",
    );
    expect(worker.unlinkCalls).toBe(0);
  });

  it.each([
    ["generated parent after intent", "generated-next", "after-event:MOVE_INTENT:generated-next"],
    ["source-copies parent after intent", "copy-0001", "after-event:MOVE_INTENT:copy-0001"],
  ] as const)(
    "does not follow an external %s symlink before rename",
    (_label, targetId, triggerPhase) => {
      const f = fixture();
      bases.push(f.base);
      const externalRoot = join(f.base, `external-${targetId}`);
      privateDirectory(externalRoot);
      writeFileSync(join(externalRoot, "sentinel"), "preserve");
      const transactionId = `tx-endpoint-intent-${targetId}`;
      const worker = invoke("apply-endpoint-swap", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
        variant: "destination-before-rename",
        triggerPhase,
        targetId,
        externalRoot,
      }, {}, 30_000);
      expectWorkerError(
        worker,
        "ERR_INTEGRITY",
        "Quarantine evidence failed integrity validation.",
      );
      expect(worker.externalOperations).toEqual([]);
      expect(worker.replayEvents).not.toContainEqual({
        event: "MOVED",
        payload: expect.objectContaining({ id: targetId }),
      });
      expect(readFileSync(join(externalRoot, "sentinel"), "utf8")).toBe("preserve");
      expect(existsSync(join(
        externalRoot,
        targetId === "generated-next" ? ".next" : "copy-0001",
      ))).toBe(false);
      expect(existsSync(join(
        f.repoRoot,
        targetId === "generated-next" ? ".next" : "notes 2.txt",
      ))).toBe(true);
    },
  );

  it("does not follow a nested source ancestor moved outside and replaced by a symlink", () => {
    const f = fixture({
      canonicalPath: "nested/deeper/notes.txt",
      copyPath: "nested/deeper/notes 2.txt",
    });
    bases.push(f.base);
    const externalRoot = join(f.base, "external-source-ancestor");
    privateDirectory(externalRoot);
    writeFileSync(join(externalRoot, "sentinel"), "preserve");
    const sourceAncestor = join(f.repoRoot, "nested");
    const transactionId = "tx-endpoint-source-ancestor";
    const worker = invoke("apply-endpoint-swap", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
      variant: "source-ancestor",
      triggerPhase: "after-event:MOVE_INTENT:copy-0001",
      targetId: "copy-0001",
      sourceAncestor,
      externalRoot,
    }, {}, 30_000);
    expectWorkerError(
      worker,
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(worker.externalOperations).toEqual([]);
    expect(worker.replayEvents).not.toContainEqual({
      event: "MOVED",
      payload: expect.objectContaining({ id: "copy-0001" }),
    });
    expect(readFileSync(join(externalRoot, "sentinel"), "utf8")).toBe("preserve");
    expect(existsSync(join(
      externalRoot,
      "source-ancestor-owned/deeper/notes 2.txt",
    ))).toBe(true);
  });

  it.each([
    ["after payload fsync", "after-payload-sync:generated-next"],
    ["before inventory", "after-destination-parent-sync:generated-next"],
  ] as const)("does not open an external payload parent %s", (_label, triggerPhase) => {
    const f = fixture();
    bases.push(f.base);
    const externalRoot = join(f.base, `external-${triggerPhase.replaceAll(":", "-")}`);
    privateDirectory(externalRoot);
    writeFileSync(join(externalRoot, "sentinel"), "preserve");
    const transactionId = `tx-endpoint-${triggerPhase.replaceAll(":", "-")}`;
    const worker = invoke("apply-endpoint-swap", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
      variant: "destination-after-move",
      triggerPhase,
      targetId: "generated-next",
      externalRoot,
    }, {}, 30_000);
    expectWorkerError(
      worker,
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(worker.externalOperations).toEqual([]);
    expect(worker.replayEvents).not.toContainEqual({
      event: "MOVED",
      payload: expect.objectContaining({ id: "generated-next" }),
    });
    expect(readFileSync(join(externalRoot, "sentinel"), "utf8")).toBe("preserve");
    expect(existsSync(join(externalRoot, "payload-parent-owned/.next"))).toBe(true);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])(
    "maps append lock-cleanup failure %i to indeterminate at the exact durable event",
    (failCleanupAt) => {
    const f = fixture();
    bases.push(f.base);
    const transactionId = `tx-lock-cleanup-${failCleanupAt}`;
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const worker = invoke("apply-lock-cleanup-failure", {
      ...request,
      failCleanupAt,
    }, {}, 30_000);
    expectWorkerError(
      worker,
      "ERR_INDETERMINATE_JOURNAL_APPEND",
      "Journal durability could not be determined.",
    );
    expect(existsSync(join(f.quarantineRoot, transactionId, "journal.lock"))).toBe(true);
    expect(worker.mutationCounters?.atFailure).toEqual(worker.mutationCounters?.final);
    expect(worker.mutationCounters?.final).toMatchObject({
      generationPublications: 1,
      journalMutations: failCleanupAt,
    });
    const replay = invoke("replay-run", request, {}, 30_000);
    if (!replay.ok) throw new Error(JSON.stringify(replay.error));
    const records = replay.result?.records as Array<{
      sequence: number;
      event: string;
      payload: { id?: string; manifestSha256?: string; transactionId?: string };
    }>;
    const expected = [
      ["PREPARED", undefined],
      ["MOVING", undefined],
      ["MOVE_INTENT", "generated-next"],
      ["MOVED", "generated-next"],
      ["MOVE_INTENT", "generated-node-modules"],
      ["MOVED", "generated-node-modules"],
      ["MOVE_INTENT", "copy-0001"],
      ["MOVED", "copy-0001"],
      ["VERIFYING", undefined],
      ["QUARANTINED", undefined],
    ] as const;
    expect(records.map((record) => [record.event, record.payload.id])).toEqual(
      expected.slice(0, failCleanupAt),
    );
    expect(records.map((record) => record.sequence)).toEqual(
      Array.from({ length: failCleanupAt }, (_, index) => index + 1),
    );
    expect(records[0]).toMatchObject({
      sequence: 1,
      event: "PREPARED",
      payload: {
        transactionId,
        manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
    const manifestSha256 = records[0].payload.manifestSha256!;
    const runRoot = join(f.quarantineRoot, transactionId);
    expect(readdirSync(join(runRoot, "manifests"))).toEqual([`${manifestSha256}.json`]);
    const manifestPath = join(runRoot, "manifests", `${manifestSha256}.json`);
    const beforeReplayBytes = readFileSync(manifestPath);
    const manifest = JSON.parse(beforeReplayBytes.toString("utf8"));
    expect(beforeReplayBytes).toEqual(Buffer.from(`${JSON.stringify(manifest)}\n`));
    expect(createHash("sha256").update(beforeReplayBytes).digest("hex")).toBe(manifestSha256);
    expect(manifest).toMatchObject({
      transactionId,
      state: "PREPARED",
      retentionDays: 4,
      deletionRequiresConfirmation: true,
    });
    expect(manifest.entries).toHaveLength(3);
    for (const entry of manifest.entries) {
      expect(entry.preMoveInventory).toMatchObject({
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        entries: expect.any(Number),
        bytes: expect.any(Number),
      });
    }
    expect(readFileSync(manifestPath)).toEqual(beforeReplayBytes);
    expect(existsSync(join(f.quarantineRoot, "current"))).toBe(false);
    expect(readdirSync(join(runRoot, "manifests")).some((name) =>
      name === "current" || name.includes("intermediate"))).toBe(false);
    },
  );

  it.each([
    ["after-source-parent-sync:generated-next", "payload"],
    ["after-event:VERIFYING", "payload"],
    ["after-inventory:moved-pass-2:copy-0001", "source"],
    ["after-inventory:moved-pass-2:copy-0001", "status"],
  ] as const)("fails closed on final verification drift at %s (%s)", (mutatePhase, mutation) => {
    const f = fixture();
    bases.push(f.base);
    const worker = invoke("apply-mutate-at-hook", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: `tx-verify-${mutation}`,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
      mutatePhase,
      mutation,
    }, {}, 30_000);
    expectWorkerError(
      worker,
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
  });

  it("preserves and rejects a wrong-mode adopted divergent final", () => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const transactionId = "tx-wrong-mode-patch";
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const first = invoke("apply-stop", {
      ...request,
      stopPhase: "after-divergent-diff:copy-0001",
    }, {}, 30_000);
    expect(first.ok).toBe(false);
    const final = join(f.quarantineRoot, transactionId, "divergent-diffs/copy-0001.patch");
    chmodSync(final, 0o644);
    expectWorkerError(
      invoke("apply", request, {}, 30_000),
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(readFileSync(final).length).toBeGreaterThan(0);
    expect(statSync(final).mode & 0o7777).toBe(0o644);
  });

  it.each(["temp-only", "final-plus-temp"] as const)(
    "recomputes and adopts an exact preexisting divergent %s artifact set",
    (variant) => {
      const f = fixture({ divergent: true });
      bases.push(f.base);
      const transactionId = `tx-${variant}`;
      const request = {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      };
      const prepared = invoke("prepare-raw", request, {}, 30_000);
      if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
      const diff = spawnSync("git", [
        "-c", "core.fsmonitor=false",
        "-c", "core.quotePath=true",
        "diff", "--no-index", "--binary", "--full-index", "--no-color",
        "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "--",
        f.canonicalPath!, f.copyPath!,
      ], { cwd: f.repoRoot });
      expect(diff.status).toBe(1);
      const root = join(f.quarantineRoot, transactionId, "divergent-diffs");
      const temporary = join(root, ".copy-0001.tmp");
      const final = join(root, "copy-0001.patch");
      writeFileSync(temporary, diff.stdout, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      if (variant === "final-plus-temp") linkSync(temporary, final);
      const applied = invoke("apply", request, {}, 30_000);
      if (!applied.ok) throw new Error(JSON.stringify(applied.error));
      expect(applied.result).toMatchObject({ status: "QUARANTINED" });
      expect(readFileSync(final)).toEqual(diff.stdout);
      expect(existsSync(temporary)).toBe(false);
    },
  );

  it.each([
    ["normal", "append", 1],
    ["normal", "truncate", 1],
    ["final-only", "append", 1],
    ["final-only", "truncate", 1],
    ["temp-only", "append", 1],
    ["temp-only", "truncate", 1],
    ["final-plus-temp", "append", 1],
    ["final-plus-temp", "truncate", 1],
  ] as const)(
    "rejects same-inode %s divergent evidence after an in-place %s",
    (variant, mutation, driftAtFinalOpen) => {
      const f = fixture({ divergent: true });
      bases.push(f.base);
      const transactionId = `tx-size-drift-${variant}-${mutation}`;
      const request = {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      };
      const diffRoot = join(f.quarantineRoot, transactionId, "divergent-diffs");
      const temporary = join(diffRoot, ".copy-0001.tmp");
      const final = join(diffRoot, "copy-0001.patch");
      if (variant === "final-only") {
        const first = invoke("apply-stop", {
          ...request,
          stopPhase: "after-divergent-diff:copy-0001",
        }, {}, 30_000);
        expect(first.ok).toBe(false);
        expect(existsSync(final)).toBe(true);
      } else if (variant !== "normal") {
        const prepared = invoke("prepare-raw", request, {}, 30_000);
        if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
        writeFileSync(temporary, canonicalDiff(f), { mode: 0o600 });
        chmodSync(temporary, 0o600);
        if (variant === "final-plus-temp") linkSync(temporary, final);
      }
      expectWorkerError(
        invoke("apply-same-inode-size-drift", {
          ...request,
          driftAtFinalOpen,
          mutation,
        }, {}, 30_000),
        "ERR_INTEGRITY",
        "Quarantine evidence failed integrity validation.",
      );
    },
  );

  it.each(
    (["normal", "temp-only", "final-plus-temp"] as const).flatMap((variant) =>
      ([
        "before-link",
        "after-link",
        "after-file-sync",
        "before-parent-sync",
        "after-parent-sync",
        "cleanup-before-parent-sync",
        "cleanup-after-parent-sync-final",
        "cleanup-after-parent-sync-temp",
      ] as const).map((seam) => [variant, seam] as const)),
  )("rejects a %s divergent artifact swap at %s", (variant, seam) => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const transactionId = `tx-seam-${variant}-${seam}`;
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    if (variant !== "normal") {
      const prepared = invoke("prepare-raw", request, {}, 30_000);
      if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
      const root = join(f.quarantineRoot, transactionId, "divergent-diffs");
      const temporary = join(root, ".copy-0001.tmp");
      writeFileSync(temporary, canonicalDiff(f), { mode: 0o600 });
      chmodSync(temporary, 0o600);
      if (variant === "final-plus-temp") {
        linkSync(temporary, join(root, "copy-0001.patch"));
      }
    }
    const worker = invoke("apply-divergent-seam-swap", {
      ...request,
      variant,
      seam,
    }, {}, 30_000);
    expect(worker.injected).toBe(true);
    expectWorkerError(
      worker,
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(existsSync(join(f.quarantineRoot, transactionId, "journal.log"))).toBe(false);
  });

  it("preserves a mismatching preexisting divergent temporary", () => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const transactionId = "tx-mismatch-temp";
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const prepared = invoke("prepare-raw", request, {}, 30_000);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const temporary = join(
      f.quarantineRoot,
      transactionId,
      "divergent-diffs/.copy-0001.tmp",
    );
    writeFileSync(temporary, "foreign", { mode: 0o600 });
    chmodSync(temporary, 0o600);
    expectWorkerError(
      invoke("apply", request, {}, 30_000),
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(readFileSync(temporary, "utf8")).toBe("foreign");
  });

  it.each([
    ["temporary", "symlink"],
    ["temporary", "directory"],
    ["final", "symlink"],
    ["final", "directory"],
  ] as const)("preserves and rejects a nonregular divergent %s %s", (artifact, kind) => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const transactionId = `tx-nonregular-${artifact}-${kind}`;
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const prepared = invoke("prepare-raw", request, {}, 30_000);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const root = join(f.quarantineRoot, transactionId, "divergent-diffs");
    const temporary = join(root, ".copy-0001.tmp");
    const final = join(root, "copy-0001.patch");
    if (artifact === "final") {
      writeFileSync(temporary, canonicalDiff(f), { mode: 0o600 });
      chmodSync(temporary, 0o600);
    }
    const target = artifact === "temporary" ? temporary : final;
    if (kind === "symlink") symlinkSync(f.canonicalPath!, target);
    else privateDirectory(target);
    expectWorkerError(
      invoke("apply", request, {}, 30_000),
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(lstatSync(target).isSymbolicLink()).toBe(kind === "symlink");
    expect(lstatSync(target).isDirectory()).toBe(kind === "directory");
    expect(existsSync(join(f.quarantineRoot, transactionId, "journal.log"))).toBe(false);
  });

  it("preserves an EEXIST divergent final collision and removes its owned temporary", () => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const transactionId = "tx-divergent-eexist-collision";
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const prepared = invoke("prepare-raw", request, {}, 30_000);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const root = join(f.quarantineRoot, transactionId, "divergent-diffs");
    const temporary = join(root, ".copy-0001.tmp");
    const final = join(root, "copy-0001.patch");
    writeFileSync(final, "foreign-final", { mode: 0o600 });
    chmodSync(final, 0o600);
    expectWorkerError(
      invoke("apply", request, {}, 30_000),
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(readFileSync(final, "utf8")).toBe("foreign-final");
    expect(existsSync(temporary)).toBe(false);
    expect(existsSync(join(f.quarantineRoot, transactionId, "journal.log"))).toBe(false);
  });

  it("fails closed and preserves a divergent temporary that reappears after cleanup", () => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const transactionId = "tx-temp-reappears";
    const worker = invoke("apply-temp-reappear", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, {}, 30_000);
    expectWorkerError(
      worker,
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    const root = join(f.quarantineRoot, transactionId, "divergent-diffs");
    expect(readFileSync(join(root, ".copy-0001.tmp"), "utf8")).toBe("foreign-reappeared");
    expect(existsSync(join(root, "copy-0001.patch"))).toBe(true);
    expect(existsSync(join(f.quarantineRoot, transactionId, "journal.log"))).toBe(false);
  });

  it.each(["parent-sync-failure", "final-swap"] as const)(
    "does not advance after divergent temporary cleanup seam %s",
    (variant) => {
      const f = fixture({ divergent: true });
      bases.push(f.base);
      const transactionId = `tx-cleanup-${variant}`;
      const worker = invoke("apply-temp-cleanup-seam", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
        variant,
      }, {}, 30_000);
      expectWorkerError(
        worker,
        "ERR_INTEGRITY",
        "Quarantine evidence failed integrity validation.",
      );
      const root = join(f.quarantineRoot, transactionId, "divergent-diffs");
      expect(existsSync(join(root, "copy-0001.patch"))).toBe(true);
      expect(existsSync(join(f.quarantineRoot, transactionId, "journal.log"))).toBe(false);
      if (variant === "final-swap") {
        expect(readFileSync(join(root, "copy-0001.patch"), "utf8")).toBe("foreign-final");
        expect(existsSync(join(root, "copy-0001.patch.owned"))).toBe(true);
      }
    },
  );

  it("preserves and rejects a syntactically valid but wrong manifest generation", () => {
    const f = fixture();
    bases.push(f.base);
    const transactionId = "tx-wrong-generation";
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const prepared = invoke("prepare-raw", request, {}, 30_000);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const generation = join(
      f.quarantineRoot,
      transactionId,
      "manifests",
      `${"0".repeat(64)}.json`,
    );
    writeFileSync(generation, "{}", { mode: 0o600 });
    chmodSync(generation, 0o600);
    expectWorkerError(
      invoke("apply", request, {}, 30_000),
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(readFileSync(generation, "utf8")).toBe("{}");
    expect(existsSync(join(f.quarantineRoot, transactionId, "journal.log"))).toBe(false);
  });

  it("rejects an undiscovered but syntactically valid precommit entry before publication", () => {
    const f = fixture();
    bases.push(f.base);
    const transactionId = "tx-undiscovered-precommit";
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    };
    const prepared = invoke("prepare-raw", request, {}, 30_000);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const foreign = join(
      f.quarantineRoot,
      transactionId,
      "inventories/pre/copy-9999.jsonl",
    );
    writeFileSync(foreign, "foreign", { mode: 0o600 });
    chmodSync(foreign, 0o600);
    expectWorkerError(
      invoke("apply", request, {}, 30_000),
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(readFileSync(foreign, "utf8")).toBe("foreign");
    expect(existsSync(join(
      f.quarantineRoot,
      transactionId,
      "inventories/pre/copy-0001.jsonl",
    ))).toBe(false);
  });

  it("returns the exact body-free INSPECTED summary without writing quarantine", async () => {
    const f = fixture();
    bases.push(f.base);
    const before = readFileSync(join(f.repoRoot, "notes 2.txt"));
    const worker = invoke("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const result = worker.result!;

    expect(worker.shape).toMatchObject({
      prototype: "null",
      keys: [
      "status",
      "totalEntries",
      "sourceCopies",
      "generatedRoots",
      "identicalCopies",
      "divergentCopies",
      "branch",
      "head",
      "sameDevice",
      ],
      frozen: true,
      extensible: false,
    });
    for (const descriptor of Object.values(worker.shape!.descriptors)) {
      expect(descriptor).toMatchObject({ enumerable: true, configurable: false, writable: false });
    }
    expect(worker.shape!.mutationStable).toBe(true);
    expect(result).toEqual({
      status: "INSPECTED",
      totalEntries: 3,
      sourceCopies: 1,
      generatedRoots: 2,
      identicalCopies: 1,
      divergentCopies: 0,
      branch: f.branch,
      head: f.head,
      sameDevice: true,
    });
    expect(readFileSync(join(f.repoRoot, "notes 2.txt"))).toEqual(before);
    expect(readdirSync(f.quarantineRoot)).toEqual([]);
  });

  it("snapshots closed options and emits only fixed sanitized usage errors", async () => {
    const f = fixture();
    bases.push(f.base);
    const options = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    };
    const getter = invoke("getter", options);
    if (!getter.ok) throw new Error(JSON.stringify(getter.error));
    expect(getter.reads).toBe(1);
    const invalid = invoke("inspect", { ...options, secretPath: "/do/not/leak" });
    expectWorkerError(invalid, "ERR_USAGE", "Invalid quarantine request.");
    expect(invalid.error!.leaksSecret).toBe(false);
    const missing = { ...options } as Partial<typeof options>;
    delete missing.repoRoot;
    expectWorkerError(invoke("inspect", missing), "ERR_USAGE", "Invalid quarantine request.");
  });

  it("creates and durably adopts only the fixed private layout", async () => {
    const f = fixture();
    bases.push(f.base);
    const request = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-slice-1",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true as const,
    };
    const firstWorker = invoke("prepare", request);
    const secondWorker = invoke("prepare", request);
    if (!firstWorker.ok) throw new Error(JSON.stringify(firstWorker.error));
    if (!secondWorker.ok) throw new Error(JSON.stringify(secondWorker.error));
    const first = firstWorker.result!;
    const second = secondWorker.result!;
    const firstShape = firstWorker.shape!;

    expect(firstWorker.phases).toEqual(["after-layout-sync"]);
    expect(secondWorker.phases).toEqual(["after-layout-sync"]);
    expect(firstShape.top).toMatchObject({
      prototype: "null",
      keys: [
      "status",
      "transactionId",
      "createdAt",
      "repoRoot",
      "quarantineRoot",
      "runRoot",
      "branch",
      "head",
      "entries",
      "fsSource",
      ],
      frozen: true,
      extensible: false,
    });
    expect(first.status).toBe("LAYOUT_READY");
    expect(first.runRoot).toBe(join(f.quarantineRoot, "tx-slice-1"));
    expect(first.entries).toHaveLength(3);
    expect(first.entries!.map((entry) => entry.id)).toEqual([
      "generated-next",
      "generated-node-modules",
      "copy-0001",
    ]);
    expect(firstShape.entries).toMatchObject({ prototype: "array", frozen: true, extensible: false });
    expect(firstShape.entries!.descriptors.length).toMatchObject({
      enumerable: false, writable: false, configurable: false,
    });
    expect(firstShape.fsSource).toMatchObject({
      prototype: "null", keys: [...FS_METHODS], frozen: true, extensible: false,
    });
    expect(firstShape.fsCallable).toBe(true);
    expect(firstShape.fsStable).toBe(true);
    expect(firstShape.mutationStable).toBe(true);
    expect(firstShape.entries!.keys).toEqual(["0", "1", "2", "length"]);
    for (const descriptor of Object.values(firstShape.top!.descriptors)) {
      expect(descriptor).toMatchObject({ enumerable: true, writable: false, configurable: false });
    }
    for (const [key, descriptor] of Object.entries(firstShape.entries!.descriptors)) {
      expect(descriptor).toMatchObject({
        enumerable: key !== "length", writable: false, configurable: false,
      });
    }
    for (const descriptor of Object.values(firstShape.fsSource!.descriptors)) {
      expect(descriptor).toMatchObject({
        enumerable: true, writable: false, configurable: false, callable: true,
      });
    }
    for (const shape of [...firstShape.entryShapes!, ...firstShape.identityShapes!.flat().filter((value): value is ValueShape => value !== null)]) {
      expect(shape).toMatchObject({ prototype: "null", frozen: true, extensible: false });
      for (const descriptor of Object.values(shape.descriptors)) {
        expect(descriptor).toMatchObject({ enumerable: true, writable: false, configurable: false });
      }
    }
    expect(firstShape.entryShapes!.map((shape) => shape.keys)).toEqual([
      ["id", "kind", "relativePath", "sourceIdentity"],
      ["id", "kind", "relativePath", "sourceIdentity"],
      [
        "id", "kind", "relativePath", "canonicalRelativePath", "sourceIdentity",
        "canonicalIdentity", "classification", "historyMatch",
      ],
    ]);
    expect(firstShape.identityShapes!.map((pair) => pair.map((shape) => shape?.keys ?? null))).toEqual([
      [["dev", "ino", "mode"], null],
      [["dev", "ino", "mode"], null],
      [
        ["dev", "ino", "mode", "size", "sha256"],
        ["dev", "ino", "mode", "size", "sha256"],
      ],
    ]);
    expect(second.entries).toEqual(first.entries);

    for (const relativePath of LAYOUT_RELATIVES) {
      const stats = statSync(relativePath === "" ? first.runRoot! : join(first.runRoot!, relativePath));
      expect(stats.isDirectory()).toBe(true);
      expect(stats.mode & 0o7777).toBe(0o700);
    }
  });

  it.each(LAYOUT_RELATIVES)("adopts and re-syncs prefix %s after parent sync fails", (failureRelative) => {
    const f = fixture();
    bases.push(f.base);
    const worker = invoke("layout-retry", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-retry",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
      failureRelative,
    });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect(worker.firstCode).toBe("ERR_PREFLIGHT");
    expect(worker.runRootOpenAttempts).toBeGreaterThanOrEqual(2);
    expect(worker.result).toMatchObject({ status: "LAYOUT_READY", transactionId: "tx-retry" });
  });

  it("hands the exact captured filesystem source to a revocable run capability", () => {
    const f = fixture();
    bases.push(f.base);
    const worker = invoke("capability-handoff", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-capability",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect(worker).toMatchObject({
      active: { callable: true, distinctRejected: true },
      revoked: true,
      sourceFrozen: true,
    });
  });

  it("rejects writer work before attestation and preserves a foreign partial layout", async () => {
    const f = fixture();
    bases.push(f.base);
    const baseRequest = {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-slice-1",
      createdAt: "2026-07-16T00:00:00.000Z",
    };
    expectWorkerError(
      invoke("prepare-raw", { ...baseRequest, writersStopped: false }),
      "ERR_USAGE",
      "Invalid quarantine request.",
    );
    expect(readdirSync(f.quarantineRoot)).toEqual([]);

    const runRoot = join(f.quarantineRoot, "tx-slice-1");
    privateDirectory(runRoot);
    writeFileSync(join(runRoot, "foreign"), "preserve me");
    expectWorkerError(
      invoke("prepare-raw", { ...baseRequest, writersStopped: true }),
      "ERR_INTEGRITY",
      "Quarantine evidence failed integrity validation.",
    );
    expect(readFileSync(join(runRoot, "foreign"), "utf8")).toBe("preserve me");
    expect(readdirSync(runRoot)).toEqual(["foreign"]);
  });

  it.each(["file", "wrong-mode", "symlink"] as const)(
    "preserves and rejects an invalid existing layout child of kind %s",
    (kind) => {
      const f = fixture();
      bases.push(f.base);
      const runRoot = join(f.quarantineRoot, "tx-invalid-layout");
      privateDirectory(runRoot);
      const child = join(runRoot, "manifests");
      if (kind === "file") writeFileSync(child, "foreign-file");
      if (kind === "wrong-mode") {
        privateDirectory(child);
        chmodSync(child, 0o755);
      }
      if (kind === "symlink") {
        const target = join(f.base, "external-layout");
        privateDirectory(target);
        writeFileSync(join(target, "sentinel"), "preserve");
        symlinkSync(target, child);
      }
      expectWorkerError(invoke("prepare-raw", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId: "tx-invalid-layout",
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      }), "ERR_INTEGRITY", "Quarantine evidence failed integrity validation.");
      expect(existsSync(child)).toBe(true);
      if (kind === "file") expect(readFileSync(child, "utf8")).toBe("foreign-file");
    },
  );

  it("detects and preserves a run-root replacement during bootstrap", () => {
    const f = fixture();
    bases.push(f.base);
    const runRoot = join(f.quarantineRoot, "tx-layout-replacement");
    expectWorkerError(invoke("layout-replacement", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-layout-replacement",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }), "ERR_INTEGRITY", "Quarantine evidence failed integrity validation.");
    expect(existsSync(runRoot)).toBe(true);
    expect(existsSync(`${runRoot}.owned`)).toBe(true);
  });

  it("fails closed when either discovery pass observes workspace drift", async () => {
    const f = fixture();
    bases.push(f.base);
    const result = invoke("drift", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId: "tx-drift",
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
    });
    expectWorkerError(result, "ERR_PREFLIGHT", "Workspace preflight failed.");
    expect(readdirSync(f.quarantineRoot)).toEqual([]);
  });

  it("revalidates and compares both root identities for each discovery pass", () => {
    const f = fixture();
    bases.push(f.base);
    expectWorkerError(invoke("root-replacement", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }), "ERR_PREFLIGHT", "Workspace preflight failed.");
    expect(readFileSync(join(f.quarantineRoot, "replacement-sentinel"), "utf8")).toBe("preserve");
    expect(existsSync(`${f.quarantineRoot}.owned`)).toBe(true);
  });

  it("accepts an exact Git top-level path containing an interior newline", () => {
    const f = fixture({ repoName: "repo\nwith-newline" });
    bases.push(f.base);
    const worker = invoke("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect(worker.result).toMatchObject({ status: "INSPECTED", head: f.head });
  });

  it.each([
    ["branch mismatch", { expectedBranch: "other-branch" }, "ERR_PREFLIGHT"],
    ["head mismatch", { expectedHead: "0".repeat(40) }, "ERR_PREFLIGHT"],
    ["count mismatch", { expectedCount: 0 }, "ERR_PREFLIGHT"],
    ["count overflow", { expectedCount: 10_000 }, "ERR_USAGE"],
    ["uppercase head", { expectedHead: "A".repeat(40) }, "ERR_USAGE"],
    ["branch NUL", { expectedBranch: "bad\0branch" }, "ERR_USAGE"],
    ["relative repository", { repoRoot: "relative/repo" }, "ERR_USAGE"],
    ["relative quarantine", { quarantineRoot: "relative/quarantine" }, "ERR_USAGE"],
  ] as Array<[string, Record<string, unknown>, string]>)(
    "rejects identity option case %s",
    (_label, override, code) => {
      const f = fixture();
      bases.push(f.base);
      expectWorkerError(invoke("inspect", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        ...override,
      }), code, code === "ERR_USAGE" ? "Invalid quarantine request." : "Workspace preflight failed.");
    },
  );

  it("rejects detached HEAD even when the caller names HEAD", () => {
    const f = fixture();
    bases.push(f.base);
    git(f.repoRoot, "checkout", "--detach", f.head);
    expectWorkerError(invoke("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: "HEAD",
      expectedHead: f.head,
      expectedCount: 1,
    }), "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it("rejects a quarantine root contained by the repository", () => {
    const f = fixture();
    bases.push(f.base);
    const contained = join(f.repoRoot, ".contained-quarantine");
    privateDirectory(contained);
    expectWorkerError(invoke("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: contained,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }), "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it.each(["missing", "file", "symlink"] as const)(
    "rejects generated root case %s",
    (kind) => {
      const f = fixture();
      bases.push(f.base);
      const generated = join(f.repoRoot, ".next");
      rmSync(generated, { recursive: true, force: true });
      if (kind === "file") writeFileSync(generated, "not a directory");
      if (kind === "symlink") {
        const target = join(f.base, "external-generated");
        privateDirectory(target);
        writeFileSync(join(target, "sentinel"), "preserve");
        symlinkSync(target, generated);
      }
      expectWorkerError(invoke("inspect", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
      }), "ERR_PREFLIGHT", "Workspace preflight failed.");
    },
  );

  it.each(["source", "canonical"] as const)("rejects a %s file symlink", (kind) => {
    const f = fixture();
    bases.push(f.base);
    const external = join(f.base, `external-${kind}.txt`);
    writeFileSync(external, "preserve");
    if (kind === "source") {
      rmSync(join(f.repoRoot, "notes 2.txt"));
      symlinkSync(external, join(f.repoRoot, "notes 2.txt"));
    } else {
      rmSync(join(f.repoRoot, "notes.txt"));
      symlinkSync(external, join(f.repoRoot, "notes.txt"));
      git(f.repoRoot, "add", "notes.txt");
      git(f.repoRoot, "commit", "-m", "canonical symlink");
      f.head = git(f.repoRoot, "rev-parse", "HEAD");
    }
    expectWorkerError(invoke("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }), "ERR_PREFLIGHT", "Workspace preflight failed.");
    expect(readFileSync(external, "utf8")).toBe("preserve");
  });

  it("rejects a repository-root symlink without touching its target", () => {
    const f = fixture();
    bases.push(f.base);
    const owned = `${f.repoRoot}-owned`;
    renameSync(f.repoRoot, owned);
    writeFileSync(join(owned, "root-symlink-sentinel"), "preserve");
    symlinkSync(owned, f.repoRoot);
    expectWorkerError(invoke("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }), "ERR_PREFLIGHT", "Workspace preflight failed.");
    expect(readFileSync(join(owned, "root-symlink-sentinel"), "utf8")).toBe("preserve");
  });

  it("rejects a symlinked repository ancestor without touching its target", () => {
    const f = fixture({ repoName: "nested/repo" });
    bases.push(f.base);
    const ancestor = join(f.base, "nested");
    const owned = join(f.base, "nested-owned");
    renameSync(ancestor, owned);
    writeFileSync(join(owned, "ancestor-symlink-sentinel"), "preserve");
    symlinkSync(owned, ancestor);
    expectWorkerError(invoke("inspect", {
      repoRoot: join(ancestor, "repo"),
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }), "ERR_PREFLIGHT", "Workspace preflight failed.");
    expect(readFileSync(join(owned, "ancestor-symlink-sentinel"), "utf8")).toBe("preserve");
  });

  it.each(["source", "canonical"] as const)(
    "rejects same-content %s inode drift between complete passes",
    (kind) => {
      const f = fixture();
      bases.push(f.base);
      expectWorkerError(invoke("file-identity-drift", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        driftKind: kind,
      }), "ERR_PREFLIGHT", "Workspace preflight failed.");
      const owned = `${f.quarantineRoot}.${kind}-owned`;
      expect(existsSync(owned)).toBe(true);
      expect(readFileSync(owned, "utf8")).toBe("canonical\n");
      expect(readFileSync(join(f.repoRoot, kind === "canonical" ? "notes.txt" : "notes 2.txt"), "utf8"))
        .toBe("canonical\n");
    },
  );

  it("rejects generated-root identity drift between complete passes", () => {
    const f = fixture();
    bases.push(f.base);
    expectWorkerError(invoke("generated-drift", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }), "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it.each(["branch", "head", "status"] as const)(
    "rejects %s drift observed by repeated Git snapshots",
    (target) => {
      const f = fixture();
      bases.push(f.base);
      const bin = join(f.base, `git-drift-${target}`);
      privateDirectory(bin);
      const counter = join(bin, "count");
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      const expected = target === "branch"
        ? "-c core.fsmonitor=false symbolic-ref --quiet --short HEAD"
        : target === "head"
          ? "-c core.fsmonitor=false rev-parse --verify HEAD"
          : "-c core.fsmonitor=false status --porcelain=v1 -z --untracked-files=all";
      const trigger = target === "status" ? 2 : 3;
      const replacement = target === "branch"
        ? "printf 'other-branch\\n'"
        : target === "head"
          ? `printf '${"0".repeat(40)}\\n'`
          : "printf '?? notes 2.txt\\0?? other 2.txt\\0'";
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\nif [ "$*" = ${JSON.stringify(expected)} ]; then\n  count=0\n  [ ! -f ${JSON.stringify(counter)} ] || count=$(cat ${JSON.stringify(counter)})\n  count=$((count + 1))\n  printf '%s' "$count" > ${JSON.stringify(counter)}\n  if [ "$count" -eq ${trigger} ]; then ${replacement}; exit 0; fi\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
        { mode: 0o700 },
      );
      chmodSync(join(bin, "git"), 0o700);
      expectWorkerError(invoke("inspect", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
      }, { PATH: `${bin}:${process.env.PATH ?? ""}` }),
      "ERR_PREFLIGHT", "Workspace preflight failed.");
    },
  );

  it("uses only sanitized globally fsmonitor-disabled Git children and preserves the index", () => {
    const f = fixture();
    bases.push(f.base);
    const bin = join(f.base, "bin");
    privateDirectory(bin);
    const log = join(f.base, "git-calls.log");
    const sentinel = join(f.base, "fsmonitor-called");
    const hook = join(f.base, "hostile-fsmonitor.sh");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(hook, `#!/bin/sh\n: > ${JSON.stringify(sentinel)}\nexit 0\n`, { mode: 0o700 });
    chmodSync(hook, 0o700);
    git(f.repoRoot, "config", "core.fsmonitor", hook);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nprintf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$GIT_OPTIONAL_LOCKS" "$GIT_NO_LAZY_FETCH" "$GIT_LITERAL_PATHSPECS" "\${UNSAFE_TEST-unset}" "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    const indexPath = join(f.repoRoot, ".git", "index");
    const gitDirectory = join(f.repoRoot, ".git");
    const lockResidueBefore = listLockResidue(gitDirectory);
    const before = statSync(indexPath, { bigint: true });
    const worker = invoke("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      UNSAFE_TEST: "must-not-reach-git",
    });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const after = statSync(indexPath, { bigint: true });
    for (const key of ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"] as const) {
      expect(after[key]).toBe(before[key]);
    }
    expect(existsSync(sentinel)).toBe(false);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls.length).toBeGreaterThanOrEqual(16);
    for (const call of calls) {
      const [optionalLocks, noLazyFetch, literalPathspecs, unsafe, args] = call.split("\t");
      expect([optionalLocks, noLazyFetch, literalPathspecs, unsafe]).toEqual(["0", "1", "1", "unset"]);
      expect(args.startsWith("-c core.fsmonitor=false ")).toBe(true);
    }
    expect(calls.some((call) => call.endsWith("status --porcelain=v1 -z --untracked-files=all"))).toBe(true);
    expect(existsSync(join(f.repoRoot, ".git", "index.lock"))).toBe(false);
    expect(listLockResidue(gitDirectory)).toEqual(lockResidueBefore);
  });

  it("passes the exact closed environment and argv prefix to every Git child", () => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const bin = join(f.base, "exact-git-environment");
    privateDirectory(bin);
    const log = join(f.base, "exact-git-environment.jsonl");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!${process.execPath}\nconst { appendFileSync } = require("node:fs");\nconst { spawnSync } = require("node:child_process");\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + "\\n");\nconst child = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: "inherit", env: process.env });\nprocess.exit(child.status ?? 1);\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    const path = `${bin}:${process.env.PATH ?? ""}`;
    const worker = invoke("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, {
      PATH: path,
      GIT_ASKPASS: "/do/not/inherit",
      HTTP_PROXY: "http://do.not.inherit.invalid",
      UNSAFE_TEST: "do-not-inherit",
    });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const expectedKeys = [
      "PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "ComSpec", "PATHEXT",
      "LANG", "LC_ALL", "LC_CTYPE",
    ].filter((key) => typeof ({ ...process.env, PATH: path } as Record<string, unknown>)[key] === "string" &&
      String(({ ...process.env, PATH: path } as Record<string, unknown>)[key]).length > 0);
    expectedKeys.push("GIT_OPTIONAL_LOCKS", "GIT_NO_LAZY_FETCH", "GIT_LITERAL_PATHSPECS");
    expectedKeys.sort();
    const records = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.length).toBeGreaterThanOrEqual(20);
    for (const record of records) {
      expect(record.argv.slice(0, 2)).toEqual(["-c", "core.fsmonitor=false"]);
      const observedKeys = Object.keys(record.env).filter((key) => key !== "__CF_USER_TEXT_ENCODING").sort();
      expect(observedKeys).toEqual(expectedKeys);
      if (process.platform === "darwin") {
        expect(record.env.__CF_USER_TEXT_ENCODING).toMatch(/^0x[0-9A-F]+:0x[0-9A-F]+:0x[0-9A-F]+$/u);
      }
      expect(record.env).toMatchObject({
        GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_LITERAL_PATHSPECS: "1",
      });
    }
  });

  it("does not invoke a remote helper when a promisor blob is unavailable", () => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const missingBlob = git(f.repoRoot, "rev-parse", `${f.historyHead}:notes.txt`);
    const objectPath = join(f.repoRoot, ".git", "objects", missingBlob.slice(0, 2), missingBlob.slice(2));
    expect(existsSync(objectPath)).toBe(true);
    rmSync(objectPath);
    git(f.repoRoot, "config", "extensions.partialClone", "sentinel");
    git(f.repoRoot, "config", "remote.sentinel.promisor", "true");
    git(f.repoRoot, "config", "remote.sentinel.partialclonefilter", "blob:none");
    git(f.repoRoot, "config", "remote.sentinel.url", "sentinel::missing");
    const bin = join(f.base, "remote-helper");
    privateDirectory(bin);
    const sentinel = join(f.base, "remote-helper-called");
    writeFileSync(
      join(bin, "git-remote-sentinel"),
      `#!/bin/sh\n: > ${JSON.stringify(sentinel)}\nexit 9\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git-remote-sentinel"), 0o700);
    expectWorkerError(invoke("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` }),
    "ERR_PREFLIGHT", "Workspace preflight failed.");
    expect(existsSync(sentinel)).toBe(false);
  });

  it.each([
    ["missing-final-nul", Buffer.from("?? notes 2.txt", "utf8")],
    ["empty-interior-frame", Buffer.from("?? notes 2.txt\0\0", "utf8")],
    ["fatal-utf8", Buffer.from([0xff, 0x00])],
    ["tracked", Buffer.from(" M notes.txt\0", "utf8")],
    ["staged", Buffer.from("M  notes.txt\0", "utf8")],
    ["rename", Buffer.from("R  notes.txt\0notes 2.txt\0", "utf8")],
    ["unrelated", Buffer.from("?? unrelated.txt\0", "utf8")],
    ["suffix-one", Buffer.from("?? notes 1.txt\0", "utf8")],
    ["parent-component", Buffer.from("?? dir/../notes 2.txt\0", "utf8")],
    ["backslash", Buffer.from("?? dir\\notes 2.txt\0", "utf8")],
    ["non-nfc", Buffer.from("?? cafe\u0301 2.txt\0", "utf8")],
  ] as Array<[string, Buffer]>)("rejects closed porcelain status case %s", (label, output) => {
    const f = fixture();
    bases.push(f.base);
    const path = installGitOutputOverride(
      f,
      label,
      "-c core.fsmonitor=false status --porcelain=v1 -z --untracked-files=all",
      output,
    );
    expectWorkerError(invoke("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, { PATH: path }), "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it("accepts exact zero-byte porcelain status as an empty source set", () => {
    const f = fixture();
    bases.push(f.base);
    const path = installGitOutputOverride(
      f,
      "empty-status",
      "-c core.fsmonitor=false status --porcelain=v1 -z --untracked-files=all",
      Buffer.alloc(0),
    );
    const worker = invoke("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 0,
    }, { PATH: path });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect(worker.result).toMatchObject({ totalEntries: 2, sourceCopies: 0, generatedRoots: 2 });
  });

  it("streams a valid 9999-record porcelain status larger than one MiB", () => {
    const f = fixture();
    bases.push(f.base);
    const paths = Array.from({ length: 9999 }, (_, index) =>
      `virtual-${String(index).padStart(4, "0")}-${"x".repeat(100)} 2.txt`);
    const status = Buffer.from(`${paths.map((path) => `?? ${path}`).join("\0")}\0`, "utf8");
    expect(status.length).toBeGreaterThan(1024 * 1024);
    const path = installGitOutputOverride(
      f,
      "large-valid-status",
      "-c core.fsmonitor=false status --porcelain=v1 -z --untracked-files=all",
      status,
    );
    const worker = invoke("virtual-files", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: paths.length,
    }, { PATH: path }, 60_000);
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect(worker.result).toMatchObject({
      status: "INSPECTED", totalEntries: 10_001, sourceCopies: 9999, generatedRoots: 2,
    });
  });

  it("accepts a status record whose body including the prefix is exactly one MiB", () => {
    const f = fixture();
    bases.push(f.base);
    const fixed = "virtual-" + " 2.txt";
    const pathRecord = `virtual-${"x".repeat(STATUS_RECORD_LIMIT - 3 - fixed.length)} 2.txt`;
    const record = Buffer.from(`?? ${pathRecord}`, "utf8");
    expect(record.length).toBe(STATUS_RECORD_LIMIT);
    const path = installGitOutputOverride(
      f,
      "status-record-exact-boundary",
      "-c core.fsmonitor=false status --porcelain=v1 -z --untracked-files=all",
      Buffer.concat([record, Buffer.from([0])]),
    );
    const worker = invoke("virtual-files", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, { PATH: path }, 30_000);
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect(worker.result).toMatchObject({ status: "INSPECTED", sourceCopies: 1 });
  });

  it("kills and settles status on byte 1,048,577 before a record NUL", () => {
    const f = fixture();
    bases.push(f.base);
    const bin = join(f.base, "status-record-overflow");
    privateDirectory(bin);
    const payload = join(bin, "payload.bin");
    const body = Buffer.concat([
      Buffer.from("?? ", "utf8"),
      Buffer.alloc(STATUS_RECORD_LIMIT - 2, 0x61),
    ]);
    expect(body.length).toBe(STATUS_RECORD_LIMIT + 1);
    writeFileSync(payload, body);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nif [ "$*" = "-c core.fsmonitor=false status --porcelain=v1 -z --untracked-files=all" ]; then\n  /bin/cat ${JSON.stringify(payload)}\n  parent=$PPID\n  while kill -0 "$parent" 2>/dev/null; do sleep 0.05; done\n  exit 0\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    expectWorkerError(invoke("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` }, 3_000),
    "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it.each(["stdout", "stderr"] as const)(
    "kills and settles a Git child after the %s control limit is exceeded",
    (stream) => {
      const f = fixture();
      bases.push(f.base);
      const bin = join(f.base, `overflow-${stream}`);
      privateDirectory(bin);
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      const redirect = stream === "stderr" ? " >&2" : "";
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\nif [ "$*" = "-c core.fsmonitor=false rev-parse --show-toplevel" ]; then\n  while :; do printf '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'${redirect}; done\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
        { mode: 0o700 },
      );
      chmodSync(join(bin, "git"), 0o700);

      expectWorkerError(invoke("inspect", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
      }, { PATH: `${bin}:${process.env.PATH ?? ""}` }, 3_000),
      "ERR_PREFLIGHT", "Workspace preflight failed.");
    },
  );

  it("parses and rejects an invalid history OID before a hanging log child exits", () => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const bin = join(f.base, "invalid-history");
    privateDirectory(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nif [ "$*" = "-c core.fsmonitor=false log --all --format=%H -z -- notes.txt" ]; then\n  printf 'bad\\0'\n  parent=$PPID\n  while kill -0 "$parent" 2>/dev/null; do sleep 0.05; done\n  exit 0\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    expectWorkerError(invoke("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` }, 3_000),
    "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it.each([
    ["missing-final-nul", Buffer.from("a".repeat(40), "utf8")],
    ["empty-interior", Buffer.from(`${"a".repeat(40)}\0\0`, "utf8")],
    ["fatal-utf8", Buffer.from([0xff, 0x00])],
  ] as Array<[string, Buffer]>)("rejects incremental history log case %s", (label, output) => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const path = installGitOutputOverride(
      f,
      `history-${label}`,
      "-c core.fsmonitor=false log --all --format=%H -z -- notes.txt",
      output,
    );
    expectWorkerError(invoke("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, { PATH: path }), "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it("accepts an exact 64-byte lowercase history OID body plus NUL", () => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const bin = join(f.base, "history-64-byte-body");
    privateDirectory(bin);
    const commitOid = "a".repeat(HISTORY_OID_BODY_LIMIT);
    const blobOid = "b".repeat(HISTORY_OID_BODY_LIMIT);
    const logPayload = join(bin, "log.bin");
    const treePayload = join(bin, "tree.bin");
    writeFileSync(logPayload, Buffer.from(`${commitOid}\0`, "utf8"));
    writeFileSync(treePayload, Buffer.from(`100644 blob ${blobOid}\tnotes.txt\0`, "utf8"));
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in\n  "-c core.fsmonitor=false log --all --format=%H -z -- notes.txt") exec /bin/cat ${JSON.stringify(logPayload)} ;;\n  "-c core.fsmonitor=false ls-tree -z --full-tree ${commitOid} -- notes.txt") exec /bin/cat ${JSON.stringify(treePayload)} ;;\n  "-c core.fsmonitor=false cat-file blob ${blobOid}") printf 'canonical\\n'; exit 0 ;;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    const worker = invoke("prepare", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-history-64-byte-body",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const source = worker.result!.entries!.find((entry) => entry.kind === "source-copy")!;
    expect(source.historyMatch).toBe(commitOid);
  });

  it("kills and settles history on a 65th OID body byte before NUL", () => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const bin = join(f.base, "history-65-byte-body");
    privateDirectory(bin);
    const payload = join(bin, "payload.bin");
    writeFileSync(payload, Buffer.alloc(HISTORY_OID_BODY_LIMIT + 1, 0x61));
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nif [ "$*" = "-c core.fsmonitor=false log --all --format=%H -z -- notes.txt" ]; then\n  /bin/cat ${JSON.stringify(payload)}\n  parent=$PPID\n  while kill -0 "$parent" 2>/dev/null; do sleep 0.05; done\n  exit 0\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    expectWorkerError(invoke("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` }, 3_000),
    "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it("retains duplicate history OIDs in their emitted order", () => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const bin = join(f.base, "duplicate-history-order");
    privateDirectory(bin);
    const first = "a".repeat(40);
    const matching = "b".repeat(40);
    const blobOid = "c".repeat(40);
    const calls = join(bin, "ls-tree-calls");
    const logPayload = join(bin, "log.bin");
    const treePayload = join(bin, "tree.bin");
    writeFileSync(logPayload, Buffer.from(`${first}\0${first}\0${matching}\0`, "utf8"));
    writeFileSync(treePayload, Buffer.from(`100644 blob ${blobOid}\tnotes.txt\0`, "utf8"));
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in\n  "-c core.fsmonitor=false log --all --format=%H -z -- notes.txt") exec /bin/cat ${JSON.stringify(logPayload)} ;;\n  "-c core.fsmonitor=false ls-tree -z --full-tree ${first} -- notes.txt") printf '%s\\n' ${JSON.stringify(first)} >> ${JSON.stringify(calls)}; exit 0 ;;\n  "-c core.fsmonitor=false ls-tree -z --full-tree ${matching} -- notes.txt") printf '%s\\n' ${JSON.stringify(matching)} >> ${JSON.stringify(calls)}; exec /bin/cat ${JSON.stringify(treePayload)} ;;\n  "-c core.fsmonitor=false cat-file blob ${blobOid}") printf 'canonical\\n'; exit 0 ;;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    const worker = invoke("prepare", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-duplicate-order",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
      first, first, matching, first, first, matching,
    ]);
  });

  it("retains exactly 4096 unique history OIDs in emitted order", () => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const bin = join(f.base, "history-boundary");
    privateDirectory(bin);
    const commits = Array.from({ length: HISTORY_FRAME_LIMIT }, (_, index) =>
      index.toString(16).padStart(HISTORY_OID_BODY_LIMIT, "0"));
    const logPayload = join(bin, "log.bin");
    const treePayload = join(bin, "tree.bin");
    const blobOid = "b".repeat(HISTORY_OID_BODY_LIMIT);
    const historyBody = Buffer.from(`${commits.join("\0")}\0`, "utf8");
    expect(historyBody.length).toBe(HISTORY_FRAME_LIMIT * (HISTORY_OID_BODY_LIMIT + 1));
    writeFileSync(logPayload, historyBody);
    writeFileSync(treePayload, Buffer.from(`100644 blob ${blobOid}\tnotes.txt\0`, "utf8"));
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in\n  "-c core.fsmonitor=false log --all --format=%H -z -- notes.txt") exec /bin/cat ${JSON.stringify(logPayload)} ;;\n  "-c core.fsmonitor=false ls-tree -z --full-tree ${commits[0]} -- notes.txt") exec /bin/cat ${JSON.stringify(treePayload)} ;;\n  "-c core.fsmonitor=false cat-file blob ${blobOid}") printf 'canonical\\n'; exit 0 ;;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    const worker = invoke("prepare", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-history-boundary",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const source = worker.result!.entries!.find((entry) => entry.kind === "source-copy")!;
    expect(source.historyMatch).toBe(commits[0]);
  });

  it("kills and settles history on a 4,097th complete OID frame", () => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const bin = join(f.base, "history-frame-overflow");
    privateDirectory(bin);
    const payload = join(bin, "payload.bin");
    const oid = "a".repeat(HISTORY_OID_BODY_LIMIT);
    const historyBody = Buffer.from(`${Array(HISTORY_FRAME_LIMIT + 1).fill(oid).join("\0")}\0`, "utf8");
    expect(historyBody.length).toBe((HISTORY_FRAME_LIMIT + 1) * (HISTORY_OID_BODY_LIMIT + 1));
    writeFileSync(payload, historyBody);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nif [ "$*" = "-c core.fsmonitor=false log --all --format=%H -z -- notes.txt" ]; then\n  /bin/cat ${JSON.stringify(payload)}\n  parent=$PPID\n  while kill -0 "$parent" 2>/dev/null; do sleep 0.05; done\n  exit 0\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    expectWorkerError(invoke("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` }, 3_000),
    "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it.each([
    ["bad-mode-type", `100644 tree ${"a".repeat(40)}\tnotes.txt\0`],
    ["bad-mode-width", `10064 blob ${"a".repeat(40)}\tnotes.txt\0`],
    ["bad-tree-pair", `040000 blob ${"a".repeat(40)}\tnotes.txt\0`],
    ["uppercase-oid", `100644 blob ${"A".repeat(40)}\tnotes.txt\0`],
    ["mismatched-path", `100644 blob ${"a".repeat(40)}\tother.txt\0`],
    ["missing-nul", `100644 blob ${"a".repeat(40)}\tnotes.txt`],
    ["multiple", `100644 blob ${"a".repeat(40)}\tnotes.txt\0` +
      `100644 blob ${"b".repeat(40)}\tnotes.txt\0`],
  ] as Array<[string, string]>)("rejects ls-tree control case %s", (label, output) => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const commit = git(f.repoRoot, "log", "--all", "--format=%H", "--", "notes.txt").split("\n")[0];
    const path = installGitOutputOverride(
      f,
      `ls-tree-${label}`,
      `-c core.fsmonitor=false ls-tree -z --full-tree ${commit} -- notes.txt`,
      Buffer.from(output, "utf8"),
    );
    expectWorkerError(invoke("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, { PATH: path }), "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it.each([
    ["exact-one-mib", 1024 * 1024],
    ["one-byte-over", 1024 * 1024 + 1],
  ] as Array<[string, number]>)("rejects malformed ls-tree control payload at %s", (label, size) => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const commit = git(f.repoRoot, "log", "--all", "--format=%H", "--", "notes.txt").split("\n")[0];
    const path = installGitOutputOverride(
      f,
      `ls-tree-control-${label}`,
      `-c core.fsmonitor=false ls-tree -z --full-tree ${commit} -- notes.txt`,
      Buffer.alloc(size, 0x61),
    );
    expectWorkerError(invoke("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, { PATH: path }, 3_000), "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it("treats exact zero-byte ls-tree output as a skipped history candidate", () => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const bin = join(f.base, "empty-ls-tree");
    privateDirectory(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in\n  "-c core.fsmonitor=false ls-tree -z --full-tree"*) exit 0 ;;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    const worker = invoke("prepare", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-empty-ls-tree",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const source = worker.result!.entries!.find((entry) => entry.kind === "source-copy")!;
    expect(source.historyMatch).toBeNull();
  });

  it.each(["nonzero", "oversized"] as const)(
    "settles and rejects an ls-tree child with %s output",
    (kind) => {
      const f = fixture({ divergent: true });
      bases.push(f.base);
      const bin = join(f.base, `ls-tree-${kind}`);
      privateDirectory(bin);
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      const action = kind === "nonzero"
        ? "printf 'failure' >&2; exit 9"
        : "while :; do printf '0123456789abcdef0123456789abcdef'; done";
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\ncase "$*" in\n  "-c core.fsmonitor=false ls-tree -z --full-tree"*) ${action} ;;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`,
        { mode: 0o700 },
      );
      chmodSync(join(bin, "git"), 0o700);
      expectWorkerError(invoke("inspect", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
      }, { PATH: `${bin}:${process.env.PATH ?? ""}` }, 3_000),
      "ERR_PREFLIGHT", "Workspace preflight failed.");
    },
  );

  it.each([
    ["040000", "tree"],
    ["120000", "blob"],
    ["160000", "commit"],
  ] as Array<[string, string]>)("skips the exact nonregular ls-tree pair %s %s", (mode, type) => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const bin = join(f.base, `skip-${mode}`);
    privateDirectory(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const catSentinel = join(f.base, `cat-${mode}`);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in\n  "-c core.fsmonitor=false ls-tree -z --full-tree"*) printf '${mode} ${type} ${"a".repeat(40)}\\tnotes.txt\\0'; exit 0 ;;\n  "-c core.fsmonitor=false cat-file blob"*) : > ${JSON.stringify(catSentinel)}; exit 9 ;;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    const worker = invoke("prepare", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: `tx-skip-${mode}`,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const source = worker.result!.entries!.find((entry) => entry.kind === "source-copy")!;
    expect(source.historyMatch).toBeNull();
    expect(existsSync(catSentinel)).toBe(false);
  });

  it("handles newline and pathspec punctuation as one literal history argument", () => {
    const canonicalPath = "dir\nline/lit[*].ts";
    const copyPath = "dir\nline/lit[*] 2.ts";
    const f = fixture({ divergent: true, canonicalPath, copyPath });
    bases.push(f.base);
    const worker = invoke("prepare", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-literal-pathspec",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const source = worker.result!.entries!.find((entry) => entry.kind === "source-copy")!;
    expect(source.historyMatch).toBe(f.historyHead);
  });

  it.each(["log", "ls-tree", "cat-file"] as const)(
    "settles and sanitizes a signaled history %s child",
    (target) => {
      const f = fixture({ divergent: true });
      bases.push(f.base);
      const commit = git(f.repoRoot, "log", "--all", "--format=%H", "--", "notes.txt").split("\n")[0];
      const tree = git(f.repoRoot, "ls-tree", commit, "--", "notes.txt").split(/\s+/u);
      const blobOid = tree[2];
      const expected = target === "log"
        ? "-c core.fsmonitor=false log --all --format=%H -z -- notes.txt"
        : target === "ls-tree"
          ? `-c core.fsmonitor=false ls-tree -z --full-tree ${commit} -- notes.txt`
          : `-c core.fsmonitor=false cat-file blob ${blobOid}`;
      const bin = join(f.base, `signal-${target}`);
      privateDirectory(bin);
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\nif [ "$*" = ${JSON.stringify(expected)} ]; then kill -TERM $$; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
        { mode: 0o700 },
      );
      chmodSync(join(bin, "git"), 0o700);
      expectWorkerError(invoke("inspect", {
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
      }, { PATH: `${bin}:${process.env.PATH ?? ""}` }),
      "ERR_PREFLIGHT", "Workspace preflight failed.");
    },
  );

  it("kills and settles a cat-file child after its stderr limit is exceeded", () => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const bin = join(f.base, "cat-stderr-overflow");
    privateDirectory(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in\n  "-c core.fsmonitor=false cat-file blob"*) while :; do printf '0123456789abcdef0123456789abcdef' >&2; done ;;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    expectWorkerError(invoke("inspect", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` }, 3_000),
    "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it("streams a multi-megabyte cat-file blob through the exact 64 KiB child pipe", () => {
    const f = fixture();
    bases.push(f.base);
    const largeBody = Buffer.alloc(2 * 1024 * 1024 + 17, 0x78);
    writeFileSync(join(f.repoRoot, "notes.txt"), largeBody);
    git(f.repoRoot, "add", "notes.txt");
    git(f.repoRoot, "commit", "-m", "large canonical history");
    const largeCommit = git(f.repoRoot, "rev-parse", "HEAD");
    writeFileSync(join(f.repoRoot, "notes.txt"), "new canonical\n");
    git(f.repoRoot, "add", "notes.txt");
    git(f.repoRoot, "commit", "-m", "replace large canonical");
    f.head = git(f.repoRoot, "rev-parse", "HEAD");
    writeFileSync(join(f.repoRoot, "notes 2.txt"), largeBody);
    const worker = invoke("prepare", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-large-cat-file",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, {}, 30_000);
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const source = worker.result!.entries!.find((entry) => entry.kind === "source-copy")!;
    expect(source.historyMatch).toBe(largeCommit);
  });

  it("accepts an exact 100755 blob and stores the candidate commit OID", () => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const bin = join(f.base, "eligible-executable");
    privateDirectory(bin);
    const commitOid = "c".repeat(40);
    const blobOid = "d".repeat(40);
    const logPayload = join(bin, "log.bin");
    const treePayload = join(bin, "tree.bin");
    writeFileSync(logPayload, Buffer.from(`${commitOid}\0`, "utf8"));
    writeFileSync(treePayload, Buffer.from(`100755 blob ${blobOid}\tnotes.txt\0`, "utf8"));
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in\n  "-c core.fsmonitor=false log --all --format=%H -z -- notes.txt") exec /bin/cat ${JSON.stringify(logPayload)} ;;\n  "-c core.fsmonitor=false ls-tree -z --full-tree ${commitOid} -- notes.txt") exec /bin/cat ${JSON.stringify(treePayload)} ;;\n  "-c core.fsmonitor=false cat-file blob ${blobOid}") printf 'canonical\\n'; exit 0 ;;\nesac\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(bin, "git"), 0o700);
    const worker = invoke("prepare", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-executable",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    }, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const source = worker.result!.entries!.find((entry) => entry.kind === "source-copy")!;
    expect(source.historyMatch).toBe(commitOid);
  });

  it("captures every filesystem getter and receiver once", () => {
    const f = fixture();
    bases.push(f.base);
    const worker = invoke("fs-capture", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect(worker.counts).toEqual(Object.fromEntries(FS_METHODS.map((method) => [method, 1])));
    expect(worker.wrongReceiver).toBe(0);
  });

  it("rejects a missing filesystem method before discovery", () => {
    const f = fixture();
    bases.push(f.base);
    expectWorkerError(invoke("missing-fs-method", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }), "ERR_USAGE", "Invalid quarantine request.");
  });

  it("is unaffected by source adapter mutation after all getters are captured", () => {
    const f = fixture();
    bases.push(f.base);
    const worker = invoke("fs-late-mutation", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect(worker.result).toMatchObject({ status: "INSPECTED", totalEntries: 3 });
  });

  it("persists only the matching historical commit OID for a divergent source", () => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const worker = invoke("prepare", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-history",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    const source = worker.result!.entries!.find((entry) => entry.kind === "source-copy")!;
    expect(source.classification).toBe("divergent");
    expect(source.historyMatch).toBe(f.historyHead);
    expect(source.historyMatch).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("maps mode and device failures and propagates the layout hook unchanged", () => {
    const modeFixture = fixture();
    bases.push(modeFixture.base);
    chmodSync(modeFixture.quarantineRoot, 0o755);
    expectWorkerError(invoke("inspect", {
      repoRoot: modeFixture.repoRoot,
      quarantineRoot: modeFixture.quarantineRoot,
      expectedBranch: modeFixture.branch,
      expectedHead: modeFixture.head,
      expectedCount: 1,
    }), "ERR_PREFLIGHT", "Workspace preflight failed.");

    const deviceFixture = fixture();
    bases.push(deviceFixture.base);
    expectWorkerError(invoke("device", {
      repoRoot: deviceFixture.repoRoot,
      quarantineRoot: deviceFixture.quarantineRoot,
      expectedBranch: deviceFixture.branch,
      expectedHead: deviceFixture.head,
      expectedCount: 1,
    }), "ERR_EXDEV", "Repository and quarantine must be on the same filesystem.");

    const hookFixture = fixture();
    bases.push(hookFixture.base);
    const hookResult = invoke("hook-error", {
      repoRoot: hookFixture.repoRoot,
      quarantineRoot: hookFixture.quarantineRoot,
      expectedBranch: hookFixture.branch,
      expectedHead: hookFixture.head,
      expectedCount: 1,
      transactionId: "tx-hook",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    });
    expect(hookResult).toMatchObject({
      ok: false,
      error: { name: "RangeError", message: "injected hook failure", frozen: false },
    });
  });

  it("propagates hook throw undefined only after the hook was actually invoked", () => {
    const f = fixture();
    bases.push(f.base);
    const worker = invoke("hook-sentinel", {
      variant: "hook-undefined",
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-hook-undefined",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    });
    expect(worker).toMatchObject({ ok: false, hookCalls: 1, thrownUndefined: true });
    expect(worker.error).toBeUndefined();
  });

  it("sanitizes a pre-hook internal throw undefined without invoking the hook", () => {
    const f = fixture();
    bases.push(f.base);
    const worker = invoke("hook-sentinel", {
      variant: "prehook-undefined",
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: "tx-prehook-undefined",
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    });
    expect(worker).toMatchObject({ hookCalls: 0, thrownUndefined: false });
    expectWorkerError(worker, "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it.each([
    ["stateful", "ERR_EXDEV", "Repository and quarantine must be on the same filesystem."],
    ["throw", "ERR_PREFLIGHT", "Workspace preflight failed."],
  ] as const)("snapshots a %s mkdir error code exactly once", (variant, code, message) => {
    const f = fixture();
    bases.push(f.base);
    const worker = invoke("mkdir-error-code", {
      variant,
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
      transactionId: `tx-mkdir-code-${variant}`,
      createdAt: "2026-07-16T00:00:00.000Z",
      writersStopped: true,
    });
    expect(worker.codeReads).toBe(1);
    expectWorkerError(worker, code, message);
  });

  it.each(["close-reject", "sync-reject"] as const)(
    "captures and invokes directory close exactly once for %s",
    (variant) => {
      const f = fixture();
      bases.push(f.base);
      const worker = invoke("sync-close-lifecycle", {
        variant,
        repoRoot: f.repoRoot,
        quarantineRoot: f.quarantineRoot,
        expectedBranch: f.branch,
        expectedHead: f.head,
        expectedCount: 1,
        transactionId: `tx-sync-close-${variant}`,
        createdAt: "2026-07-16T00:00:00.000Z",
        writersStopped: true,
      });
      expect(worker).toMatchObject({
        closeGetterReads: 1,
        closeCalls: 1,
        closeWrongReceiver: 0,
      });
      expectWorkerError(worker, "ERR_PREFLIGHT", "Workspace preflight failed.");
    },
  );

  it("rejects a non-safe source mode instead of framing a coerced value", () => {
    const f = fixture();
    bases.push(f.base);
    expectWorkerError(invoke("invalid-source-mode", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }), "ERR_PREFLIGHT", "Workspace preflight failed.");
  });

  it("rejects unknown symbol option keys before discovery", () => {
    const f = fixture();
    bases.push(f.base);
    expectWorkerError(invoke("symbol", {
      repoRoot: f.repoRoot,
      quarantineRoot: f.quarantineRoot,
      expectedBranch: f.branch,
      expectedHead: f.head,
      expectedCount: 1,
    }), "ERR_USAGE", "Invalid quarantine request.");
  });
});
