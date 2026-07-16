import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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
  active?: { callable: boolean; distinctRejected: boolean };
  revoked?: boolean;
  sourceFrozen?: boolean;
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
import { getRunFsContext } from ${JSON.stringify(fsContextUrl)};
import * as fsPromises from "node:fs/promises";
import {
  chmodSync, createReadStream, lstatSync, mkdirSync, realpathSync, renameSync,
  writeFileSync,
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

  it("exposes only the advisory inspection API", async () => {
    const exports = invoke("exports", {});
    expect(exports.exports).toEqual(["inspectWorkspace"]);
    expect(exports.runtimeExports).toEqual(["inspectWorkspace", "prepareQuarantineWorkspace"]);
    expect(exports.legacyExports).not.toContain("prepareQuarantineWorkspace");
    const packageJson = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8"));
    expect(Object.hasOwn(packageJson, "exports")).toBe(false);
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
    ["over-4096", Buffer.from(`${Array.from({ length: 4097 }, (_, index) =>
      index.toString(16).padStart(40, "0")).join("\0")}\0`, "utf8")],
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

  it.each([
    ["exact-one-mib", 1024 * 1024],
    ["one-byte-over", 1024 * 1024 + 1],
  ] as Array<[string, number]>)("rejects malformed history control payload at %s", (label, size) => {
    const f = fixture({ divergent: true });
    bases.push(f.base);
    const path = installGitOutputOverride(
      f,
      `history-control-${label}`,
      "-c core.fsmonitor=false log --all --format=%H -z -- notes.txt",
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
    const commits = Array.from({ length: 4096 }, (_, index) => index.toString(16).padStart(40, "0"));
    const logPayload = join(bin, "log.bin");
    const treePayload = join(bin, "tree.bin");
    const blobOid = "b".repeat(40);
    writeFileSync(logPayload, Buffer.from(`${commits.join("\0")}\0`, "utf8"));
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
