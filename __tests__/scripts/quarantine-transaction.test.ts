import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const transactionUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-transaction.mjs"),
).href;
const runtimeUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-workspace-runtime.mjs"),
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

type Fixture = {
  base: string;
  repoRoot: string;
  quarantineRoot: string;
  branch: string;
  head: string;
  historyHead?: string;
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

function fixture({ divergent = false } = {}): Fixture {
  const base = mkdtempSync(join(tmpdir(), "quarantine-transaction-"));
  const repoRoot = join(base, "repo");
  const quarantineRoot = join(base, "quarantine");
  privateDirectory(repoRoot);
  privateDirectory(quarantineRoot);
  git(repoRoot, "init", "-b", "slice-one");
  git(repoRoot, "config", "user.name", "Test User");
  git(repoRoot, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repoRoot, ".gitignore"), ".next/\nnode_modules/\n");
  writeFileSync(join(repoRoot, "notes.txt"), "canonical\n");
  git(repoRoot, "add", ".gitignore", "notes.txt");
  git(repoRoot, "commit", "-m", "fixture");
  const historyHead = divergent ? git(repoRoot, "rev-parse", "HEAD") : undefined;
  if (divergent) {
    writeFileSync(join(repoRoot, "notes.txt"), "new canonical\n");
    git(repoRoot, "add", "notes.txt");
    git(repoRoot, "commit", "-m", "change canonical");
  }
  writeFileSync(
    join(repoRoot, "notes 2.txt"),
    "canonical\n",
  );
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
  [key: string]: unknown;
};

type WorkerResult = {
  ok: boolean;
  exports?: string[];
  runtimeExports?: string[];
  result?: WorkerValue;
  phases?: string[];
  reads?: number;
  counts?: Record<string, number>;
  wrongReceiver?: number;
  firstCode?: string;
  runRootOpenAttempts?: number;
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
import * as fsPromises from "node:fs/promises";
import { createReadStream, lstatSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  };
}

try {
  if (operation === "exports") {
    process.stdout.write(JSON.stringify({
      ok: true,
      exports: Object.keys(transaction),
      runtimeExports: Object.keys(runtime),
    }));
  } else if (operation === "inspect") {
    const result = await transaction.inspectWorkspace(request);
    process.stdout.write(JSON.stringify({ ok: true, result, shape: shape(result) }));
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
    const originalEntry = result.entries[0];
    const originalId = originalEntry.id;
    const originalDev = originalEntry.sourceIdentity.dev;
    const mutationResults = [
      Reflect.set(result, "status", "MUTATED"),
      Reflect.set(result.entries, 0, null),
      Reflect.set(originalEntry, "id", "mutated"),
      Reflect.set(originalEntry.sourceIdentity, "dev", -1),
      Reflect.set(result.fsSource, "lstat", null),
    ];
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
          result.status === originalStatus && result.entries[0] === originalEntry &&
          originalEntry.id === originalId && originalEntry.sourceIdentity.dev === originalDev,
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
    let runRootOpenAttempts = 0;
    const adapter = {
      ...fsPromises,
      async open(path, ...args) {
        if (path === join(request.quarantineRoot, request.transactionId)) {
          runRootOpenAttempts += 1;
          if (runRootOpenAttempts === 1) {
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
      await runtime.prepareQuarantineWorkspace({ ...request, fsApi: adapter });
    } catch (error) {
      firstCode = error?.code;
    }
    const result = await runtime.prepareQuarantineWorkspace({ ...request, fsApi: adapter });
    process.stdout.write(JSON.stringify({ ok: true, result, firstCode, runRootOpenAttempts }));
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
    expect(second.entries).toEqual(first.entries);

    const expectedLayout = [
      "manifests", "inventories", "inventories/pre", "inventories/moved-pass-1",
      "inventories/moved-pass-2", "inventories/restore-active",
      "inventories/validation-pass-1", "inventories/validation-pass-2",
      "inventories/work", "payload", "payload/source-copies", "payload/generated",
      "rollback", "rollback/regenerated-before-restore", "conflicts", "divergent-diffs",
    ];
    for (const relativePath of ["", ...expectedLayout]) {
      const stats = statSync(relativePath === "" ? first.runRoot! : join(first.runRoot!, relativePath));
      expect(stats.isDirectory()).toBe(true);
      expect(stats.mode & 0o7777).toBe(0o700);
    }
  });

  it("adopts and re-syncs an allowlisted prefix after parent sync fails", () => {
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
    });
    if (!worker.ok) throw new Error(JSON.stringify(worker.error));
    expect(worker.firstCode).toBe("ERR_PREFLIGHT");
    expect(worker.runRootOpenAttempts).toBeGreaterThanOrEqual(2);
    expect(worker.result).toMatchObject({ status: "LAYOUT_READY", transactionId: "tx-retry" });
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
