import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-run-capability.mjs"),
).href;
const contextModuleUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-run-fs-context.mjs"),
).href;
const REQUIRED_FS_METHODS = [
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
const TRANSACTION_ID = "cleanup.2026-07-15_A";
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const RESTORE_ID = "restore-123e4567-e89b-42d3-a456-426614174000";
const DIGEST = "a".repeat(64);

type Fixture = {
  base: string;
  repoRoot: string;
  quarantineRoot: string;
  runRoot: string;
};

type WorkerResult = {
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string };
};

const runDirectories = [
  "manifests",
  "inventories/pre",
  "inventories/moved-pass-1",
  "inventories/moved-pass-2",
  "inventories/restore-active",
  "inventories/validation-pass-1",
  "inventories/validation-pass-2",
  "inventories/work",
  "payload/source-copies",
  "payload/generated",
  "rollback/regenerated-before-restore",
  `rollback/regenerated-before-restore/${RESTORE_ID}`,
  "conflicts",
  "divergent-diffs",
];

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function createRunDirectories(runRoot: string) {
  for (const relativePath of runDirectories) {
    privateDirectory(join(runRoot, relativePath));
  }
}

function createFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "quarantine-capability-"));
  const repoRoot = join(base, "repo");
  const quarantineRoot = join(base, "quarantine");
  const runRoot = join(quarantineRoot, TRANSACTION_ID);
  privateDirectory(repoRoot);
  privateDirectory(quarantineRoot);
  privateDirectory(runRoot);
  createRunDirectories(runRoot);
  return {
    base: realpathSync(base),
    repoRoot: realpathSync(repoRoot),
    quarantineRoot: realpathSync(quarantineRoot),
    runRoot: realpathSync(runRoot),
  };
}

function invoke(fixture: Fixture, request: Record<string, unknown>): WorkerResult {
  const source = `
import * as capabilityModule from ${JSON.stringify(moduleUrl)};
import * as fsPromises from "node:fs/promises";
import {
  chmodSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const runDirectories = ${JSON.stringify(runDirectories)};
const requiredFsMethods = ${JSON.stringify(REQUIRED_FS_METHODS)};

function completeNodeAdapter(overrides = {}) {
  return {
    ...fsPromises,
    createReadStream,
    lstatSync,
    realpathSync,
    ...overrides,
  };
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function createRunDirectories(runRoot) {
  for (const relativePath of runDirectories) privateDirectory(join(runRoot, relativePath));
}

function errorDetails(error) {
  return { name: error?.name ?? "Error", message: error?.message ?? String(error) };
}

async function capture(callback) {
  try {
    return { threw: false, value: await callback() };
  } catch (error) {
    return { threw: true, error: errorDetails(error) };
  }
}

function changingProxy(sequences) {
  const counts = Object.fromEntries(Object.keys(sequences).map((key) => [key, 0]));
  const target = Object.freeze(
    Object.fromEntries(Object.entries(sequences).map(([key, values]) => [key, values[0]])),
  );
  return {
    counts,
    proxy: new Proxy(target, {
      get(current, property, receiver) {
        if (typeof property !== "string" || !Object.hasOwn(sequences, property)) {
          return Reflect.get(current, property, receiver);
        }
        const index = counts[property]++;
        const values = sequences[property];
        return values[Math.min(index, values.length - 1)];
      },
    }),
  };
}

function options(overrides = {}) {
  return {
    repoRoot: request.fixture.repoRoot,
    quarantineRoot: request.fixture.quarantineRoot,
    transactionId: request.transactionId ?? ${JSON.stringify(TRANSACTION_ID)},
    writersStopped: request.writersStopped ?? true,
    ...overrides,
  };
}

async function run() {
  const {
    deriveRunPath,
    revalidateRunCapability,
    withQuarantineRunCapability,
  } = capabilityModule;

  if (request.operation === "open") {
    return withQuarantineRunCapability(options(request.options), async () => "called");
  }
  if (request.operation === "derive-many") {
    return withQuarantineRunCapability(options(), async (capability) =>
      request.requests.map((pathRequest) => deriveRunPath(capability, pathRequest))
    );
  }
  if (request.operation === "derive-error") {
    return withQuarantineRunCapability(options(), async (capability) =>
      capture(() => deriveRunPath(capability, request.pathRequest))
    );
  }
  if (request.operation === "forged") {
    return {
      derive: await capture(() => deriveRunPath({}, { purpose: "journal" })),
      revalidate: await capture(() => revalidateRunCapability({}, {
        purpose: "journal",
        boundary: "before-mutation",
      })),
    };
  }
  if (request.operation === "leak-resolve") {
    let leaked;
    const settlement = await capture(() => withQuarantineRunCapability(options(), async (capability) => {
      leaked = capability;
      deriveRunPath(capability, { purpose: "journal" });
      return "resolved";
    }));
    return {
      settlement,
      derive: await capture(() => deriveRunPath(leaked, { purpose: "journal" })),
      revalidate: await capture(() => revalidateRunCapability(leaked, {
        purpose: "journal",
        boundary: "after-sync",
      })),
    };
  }
  if (request.operation === "leak-reject") {
    let leaked;
    const settlement = await capture(() => withQuarantineRunCapability(options(), async (capability) => {
      leaked = capability;
      throw new Error("callback failed");
    }));
    return {
      settlement,
      derive: await capture(() => deriveRunPath(leaked, { purpose: "journal" })),
    };
  }
  if (request.operation === "device-mismatch") {
    const fsApi = completeNodeAdapter({
      lstat: async (path) => {
        const stat = await fsPromises.lstat(path);
        if (path !== request.fixture.quarantineRoot) return stat;
        return new Proxy(stat, {
          get(target, property) {
            if (property === "dev") return Number(target.dev) + 1;
            return Reflect.get(target, property, target);
          },
        });
      },
    });
    return withQuarantineRunCapability(options({ fsApi }), async () => "called");
  }
  if (request.operation === "snapshot-options") {
    const counts = {
      repoRoot: 0,
      quarantineRoot: 0,
      transactionId: 0,
      writersStopped: 0,
      fsApi: 0,
    };
    const firstValues = {
      repoRoot: request.fixture.repoRoot,
      quarantineRoot: request.fixture.quarantineRoot,
      transactionId: request.safeTransactionId,
      writersStopped: true,
      fsApi: completeNodeAdapter(),
    };
    const secondValues = {
      repoRoot: "/escaped/repository",
      quarantineRoot: "/escaped/quarantine",
      transactionId: ".",
      writersStopped: false,
      fsApi: {},
    };
    const hostileOptions = Object.create(null);
    for (const key of Object.keys(counts)) {
      Object.defineProperty(hostileOptions, key, {
        enumerable: true,
        get() {
          counts[key] += 1;
          return counts[key] === 1 ? firstValues[key] : secondValues[key];
        },
      });
    }
    Object.freeze(hostileOptions);
    const outcome = await capture(() => withQuarantineRunCapability(
      hostileOptions,
      async (capability) => deriveRunPath(capability, { purpose: "journal" }),
    ));
    return { counts, frozen: Object.isFrozen(hostileOptions), outcome };
  }
  if (request.operation === "snapshot-requests") {
    return withQuarantineRunCapability(options(), async (capability) => {
      const sha = changingProxy({
        purpose: ["manifest-generation"],
        id: [request.safeDigest, "../../../escaped"],
      });
      const purpose = changingProxy({
        purpose: ["manifest-generation", "journal"],
        id: [request.safeDigest],
      });
      const phase = changingProxy({
        purpose: ["inventory"],
        id: ["copy-0001"],
        phase: ["pre", "../../../escaped"],
      });
      const boundary = changingProxy({
        purpose: ["journal"],
        boundary: ["before-mutation", "invalid"],
      });
      return {
        sha: {
          counts: sha.counts,
          frozen: Object.isFrozen(sha.proxy),
          outcome: await capture(() => deriveRunPath(capability, sha.proxy)),
        },
        purpose: {
          counts: purpose.counts,
          frozen: Object.isFrozen(purpose.proxy),
          outcome: await capture(() => deriveRunPath(capability, purpose.proxy)),
        },
        phase: {
          counts: phase.counts,
          frozen: Object.isFrozen(phase.proxy),
          outcome: await capture(() => deriveRunPath(capability, phase.proxy)),
        },
        boundary: {
          counts: boundary.counts,
          frozen: Object.isFrozen(boundary.proxy),
          outcome: await capture(() => revalidateRunCapability(capability, boundary.proxy)),
        },
      };
    });
  }
  if (request.operation === "virtual-adapter") {
    const virtual = {
      repoRoot: "/virtual/repository",
      quarantineRoot: "/virtual/quarantine",
      runRoot: "/virtual/quarantine/transaction-1",
      manifests: "/virtual/quarantine/transaction-1/manifests",
    };
    const inodeByPath = new Map([
      [virtual.repoRoot, 1],
      [virtual.quarantineRoot, 2],
      [virtual.runRoot, 3],
      [virtual.manifests, 4],
    ]);
    const calls = { lstat: [], realpath: [], mkdir: [], lstatSync: [], realpathSync: [] };
    const statFor = (path) => {
      if (!inodeByPath.has(path)) {
        const error = new Error("virtual ENOENT: " + path);
        error.code = "ENOENT";
        throw error;
      }
      return {
        dev: 9,
        ino: inodeByPath.get(path),
        mode: 0o40700,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      };
    };
    const fsApi = {
      ...completeNodeAdapter(),
      async lstat(path) {
        calls.lstat.push(path);
        return statFor(path);
      },
      async realpath(path) {
        calls.realpath.push(path);
        statFor(path);
        return path;
      },
      async mkdir(path) {
        calls.mkdir.push(path);
      },
      lstatSync(path) {
        calls.lstatSync.push(path);
        return statFor(path);
      },
      realpathSync(path) {
        calls.realpathSync.push(path);
        statFor(path);
        return path;
      },
    };
    const path = await withQuarantineRunCapability({
      repoRoot: virtual.repoRoot,
      quarantineRoot: virtual.quarantineRoot,
      transactionId: "transaction-1",
      writersStopped: true,
      fsApi,
    }, async (capability) => {
      const derived = deriveRunPath(capability, {
        purpose: "manifest-generation",
        id: request.safeDigest,
      });
      await revalidateRunCapability(capability, {
        purpose: "manifest-generation",
        id: request.safeDigest,
        boundary: "before-mutation",
      });
      return derived;
    });
    return { calls, path, virtual };
  }
  if (request.operation === "binding-contract") {
    const { getRunFsContext } = await import(${JSON.stringify(contextModuleUrl)});
    const base = completeNodeAdapter();
    const getterCounts = Object.fromEntries(requiredFsMethods.map((method) => [method, 0]));
    const receiverCounts = Object.fromEntries(requiredFsMethods.map((method) => [method, 0]));
    const fsApi = Object.create(null);
    for (const method of requiredFsMethods) {
      Object.defineProperty(fsApi, method, {
        configurable: true,
        enumerable: true,
        get() {
          getterCounts[method] += 1;
          const implementation = base[method];
          return function (...args) {
            if (this !== fsApi) throw new Error("filesystem receiver changed: " + method);
            receiverCounts[method] += 1;
            if (args[0] === "__probe__") return method;
            return Reflect.apply(implementation, base, args);
          };
        },
      });
    }
    let leaked;
    const inside = await withQuarantineRunCapability(options({ fsApi }), async (capability) => {
      leaked = capability;
      const bound = getRunFsContext(capability);
      const repeated = getRunFsContext(capability);
      const asserted = getRunFsContext(capability, fsApi);
      const explicitUndefined = await capture(() => getRunFsContext(capability, undefined));
      const distinct = Object.fromEntries(requiredFsMethods.map((method) => [method, () => {}]));
      const distinctLookup = await capture(() => getRunFsContext(capability, distinct));
      for (const method of requiredFsMethods) {
        Object.defineProperty(fsApi, method, {
          configurable: true,
          enumerable: true,
          value() { throw new Error("mutated filesystem method used: " + method); },
        });
      }
      const derived = deriveRunPath(capability, { purpose: "journal" });
      await revalidateRunCapability(capability, {
        purpose: "journal",
        boundary: "before-mutation",
      });
      const probes = Object.fromEntries(
        requiredFsMethods.map((method) => [method, bound[method]("__probe__")]),
      );
      return {
        frozen: Object.isFrozen(bound),
        keys: Object.keys(bound),
        sameLookup: bound === repeated && bound === asserted,
        explicitUndefined,
        distinctLookup,
        derived,
        probes,
      };
    });
    return {
      inside,
      getterCounts,
      receiverCounts,
      after: await capture(() => getRunFsContext(leaked)),
    };
  }
  if (request.operation === "binding-reject") {
    const { getRunFsContext } = await import(${JSON.stringify(contextModuleUrl)});
    let leaked;
    const settlement = await capture(() => withQuarantineRunCapability(
      options({ fsApi: completeNodeAdapter() }),
      async (capability) => {
        leaked = capability;
        throw new Error("binding callback rejected");
      },
    ));
    return {
      settlement,
      after: await capture(() => getRunFsContext(leaked)),
    };
  }
  if (request.operation === "adapter-lifecycle") {
    const { getRunFsContext } = await import(${JSON.stringify(contextModuleUrl)});
    const base = completeNodeAdapter();
    const sourceCalls = Object.fromEntries(requiredFsMethods.map((method) => [method, 0]));
    let completeInFlight;
    const inFlightGate = new Promise((resolve) => { completeInFlight = resolve; });
    const fsApi = Object.fromEntries(requiredFsMethods.map((method) => [
      method,
      (...args) => {
        sourceCalls[method] += 1;
        if (method === "readdir" && args[0] === "__in_flight__") return inFlightGate;
        if (args[0] === "__after__") return "source-called-after-settlement";
        return Reflect.apply(base[method], base, args);
      },
    ]));
    let adapter;
    let inFlight;
    const settlement = await capture(() => withQuarantineRunCapability(
      options({ fsApi }),
      async (capability) => {
        adapter = getRunFsContext(capability);
        inFlight = adapter.readdir("__in_flight__");
        if (request.settlement === "reject") throw new Error("lifecycle callback rejected");
        return "lifecycle callback resolved";
      },
    ));
    const countsBeforeRevokedCalls = { ...sourceCalls };
    const revokedCalls = {};
    for (const method of requiredFsMethods) {
      revokedCalls[method] = await capture(() => adapter[method]("__after__"));
    }
    const countsAfterRevokedCalls = { ...sourceCalls };
    completeInFlight("in-flight-completed");
    return {
      settlement,
      inFlight: await inFlight,
      revokedCalls,
      countsBeforeRevokedCalls,
      countsAfterRevokedCalls,
    };
  }
  if (request.operation === "missing-adapter-method") {
    const fsApi = completeNodeAdapter();
    delete fsApi[request.method];
    return withQuarantineRunCapability(options({ fsApi }), async () => "called");
  }
  if (request.operation === "invalid-adapter-source") {
    let fsApi;
    if (request.shape === "function") fsApi = function Adapter() {};
    if (request.shape === "array") fsApi = [];
    if (request.shape === "class") fsApi = new (class Adapter {})();
    if (request.shape === "custom-prototype") fsApi = Object.create({ adapter: true });
    let getterReads = 0;
    for (const method of requiredFsMethods) {
      Object.defineProperty(fsApi, method, {
        enumerable: true,
        get() {
          getterReads += 1;
          return () => {};
        },
      });
    }
    return {
      outcome: await capture(() => withQuarantineRunCapability(
        options({ fsApi }),
        async () => "called",
      )),
      getterReads,
    };
  }
  if (request.operation === "public-exports") {
    return Object.keys(capabilityModule).sort();
  }
  if (request.operation === "replace-root") {
    return withQuarantineRunCapability(options(), async (capability) => {
      const replacedPath = request.target === "quarantine"
        ? request.fixture.quarantineRoot
        : request.fixture.runRoot;
      renameSync(replacedPath, replacedPath + ".original");
      privateDirectory(replacedPath);
      if (request.target === "quarantine") privateDirectory(request.fixture.runRoot);
      createRunDirectories(request.fixture.runRoot);
      return {
        derive: await capture(() => deriveRunPath(capability, { purpose: "journal" })),
        revalidate: await capture(() => revalidateRunCapability(capability, {
          purpose: "journal",
          boundary: "before-mutation",
        })),
      };
    });
  }
  if (request.operation === "replace-parent") {
    return withQuarantineRunCapability(options(), async (capability) => {
      const derived = deriveRunPath(capability, request.pathRequest);
      const parent = dirname(derived);
      renameSync(parent, parent + ".original");
      symlinkSync(request.external, parent);
      return {
        parent,
        derive: await capture(() => deriveRunPath(capability, request.pathRequest)),
        before: await capture(() => revalidateRunCapability(capability, {
          ...request.pathRequest,
          boundary: "before-mutation",
        })),
        after: await capture(() => revalidateRunCapability(capability, {
          ...request.pathRequest,
          boundary: "after-sync",
        })),
      };
    });
  }
  if (request.operation === "parent-mode") {
    return withQuarantineRunCapability(options(), async (capability) => {
      const derived = deriveRunPath(capability, request.pathRequest);
      chmodSync(dirname(derived), 0o755);
      return {
        derive: await capture(() => deriveRunPath(capability, request.pathRequest)),
        before: await capture(() => revalidateRunCapability(capability, {
          ...request.pathRequest,
          boundary: "before-mutation",
        })),
        after: await capture(() => revalidateRunCapability(capability, {
          ...request.pathRequest,
          boundary: "after-sync",
        })),
      };
    });
  }
  throw new Error("unknown worker operation");
}

try {
  process.stdout.write(JSON.stringify({ ok: true, value: await run() }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: errorDetails(error) }));
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
    input: JSON.stringify({ ...request, fixture }),
  });
  if (result.status !== 0) {
    throw new Error(`capability worker failed (${result.status}): ${result.stderr}`);
  }
  expect(result.stderr).toBe("");
  const parsed = JSON.parse(result.stdout) as WorkerResult;
  expect(typeof parsed.ok).toBe("boolean");
  if (parsed.ok) {
    expect(parsed).toHaveProperty("value");
  } else {
    expect(parsed.error).toEqual({
      name: expect.any(String),
      message: expect.any(String),
    });
  }
  return parsed;
}

function workerValue(result: WorkerResult) {
  expect(result.ok).toBe(true);
  return result.value as Record<string, unknown>;
}

function expectCapturedError(value: unknown, pattern: RegExp) {
  expect(value).toMatchObject({
    threw: true,
    error: { name: expect.any(String), message: expect.stringMatching(pattern) },
  });
}

describe("callback-scoped quarantine run capability", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    rmSync(fixture.base, { recursive: true, force: true });
  });

  it("derives the complete closed path table from the approved real roots", () => {
    const requests = [
      { purpose: "journal" },
      { purpose: "journal-lock" },
      { purpose: "journal-tombstone", id: UUID },
      { purpose: "manifest-generation", id: DIGEST },
      { purpose: "manifest-temporary", id: UUID },
      { purpose: "current-pointer" },
      { purpose: "current-temporary", id: UUID },
      { purpose: "inventory", phase: "pre", id: "copy-0001" },
      { purpose: "inventory", phase: "restore-active", id: "generated-next" },
      { purpose: "inventory", phase: "restore-active", id: "generated-node-modules" },
      { purpose: "inventory", phase: "validation-pass-1", id: "generated-next" },
      { purpose: "inventory", phase: "validation-pass-1", id: "generated-node-modules" },
      { purpose: "inventory", phase: "validation-pass-2", id: "generated-next" },
      { purpose: "inventory", phase: "validation-pass-2", id: "generated-node-modules" },
      { purpose: "inventory-work", id: UUID },
      { purpose: "payload", id: "copy-0001" },
      { purpose: "payload", id: "generated-next" },
      { purpose: "payload", id: "generated-node-modules" },
      { purpose: "rollback", id: RESTORE_ID },
      { purpose: "rollback-entry", id: RESTORE_ID, phase: "generated-next" },
      { purpose: "rollback-entry", id: RESTORE_ID, phase: "generated-node-modules" },
      { purpose: "conflict", id: "generated-node-modules" },
      { purpose: "divergent-diff", id: "copy-0042" },
    ];
    const expected = [
      join(fixture.runRoot, "journal.log"),
      join(fixture.runRoot, "journal.lock"),
      join(fixture.runRoot, `journal.lock.tombstone.${UUID}`),
      join(fixture.runRoot, "manifests", `${DIGEST}.json`),
      join(fixture.runRoot, "manifests", `.${UUID}.tmp`),
      join(fixture.quarantineRoot, "current"),
      join(fixture.quarantineRoot, `.current.${UUID}.tmp`),
      join(fixture.runRoot, "inventories", "pre", "copy-0001.jsonl"),
      join(fixture.runRoot, "inventories", "restore-active", "generated-next.jsonl"),
      join(fixture.runRoot, "inventories", "restore-active", "generated-node-modules.jsonl"),
      join(fixture.runRoot, "inventories", "validation-pass-1", "generated-next.jsonl"),
      join(fixture.runRoot, "inventories", "validation-pass-1", "generated-node-modules.jsonl"),
      join(fixture.runRoot, "inventories", "validation-pass-2", "generated-next.jsonl"),
      join(fixture.runRoot, "inventories", "validation-pass-2", "generated-node-modules.jsonl"),
      join(fixture.runRoot, "inventories", "work", `${UUID}.bin`),
      join(fixture.runRoot, "payload", "source-copies", "copy-0001"),
      join(fixture.runRoot, "payload", "generated", ".next"),
      join(fixture.runRoot, "payload", "generated", "node_modules"),
      join(fixture.runRoot, "rollback", "regenerated-before-restore", RESTORE_ID),
      join(fixture.runRoot, "rollback", "regenerated-before-restore", RESTORE_ID, ".next"),
      join(
        fixture.runRoot,
        "rollback",
        "regenerated-before-restore",
        RESTORE_ID,
        "node_modules",
      ),
      join(fixture.runRoot, "conflicts", "generated-node-modules"),
      join(fixture.runRoot, "divergent-diffs", "copy-0042.patch"),
    ];

    expect(workerValue(invoke(fixture, { operation: "derive-many", requests }))).toEqual(expected);

    const callerPath = join(fixture.base, "caller-selected");
    const injected = workerValue(
      invoke(fixture, {
        operation: "derive-error",
        pathRequest: { purpose: "journal", path: callerPath },
      }),
    );
    expectCapturedError(injected, /field|request/u);
    expect(expected).not.toContain(callerPath);
  });

  it("snapshots every capability option exactly once before validation", () => {
    const value = workerValue(
      invoke(fixture, {
        operation: "snapshot-options",
        safeTransactionId: TRANSACTION_ID,
      }),
    );
    expect(value).toMatchObject({
      counts: {
        repoRoot: 1,
        quarantineRoot: 1,
        transactionId: 1,
        writersStopped: 1,
        fsApi: 1,
      },
      frozen: true,
      outcome: {
        threw: false,
        value: join(fixture.runRoot, "journal.log"),
      },
    });
  });

  it("snapshots hostile request proxies once and derives only approved paths", () => {
    const value = workerValue(
      invoke(fixture, {
        operation: "snapshot-requests",
        safeDigest: DIGEST,
      }),
    );
    expect(value).toMatchObject({
      sha: {
        counts: { purpose: 1, id: 1 },
        frozen: true,
        outcome: {
          threw: false,
          value: join(fixture.runRoot, "manifests", `${DIGEST}.json`),
        },
      },
      purpose: {
        counts: { purpose: 1, id: 1 },
        frozen: true,
        outcome: {
          threw: false,
          value: join(fixture.runRoot, "manifests", `${DIGEST}.json`),
        },
      },
      phase: {
        counts: { purpose: 1, id: 1, phase: 1 },
        frozen: true,
        outcome: {
          threw: false,
          value: join(fixture.runRoot, "inventories", "pre", "copy-0001.jsonl"),
        },
      },
      boundary: {
        counts: { purpose: 1, boundary: 1 },
        frozen: true,
        outcome: { threw: false },
      },
    });
  });

  it("uses one virtual filesystem adapter for open, derive, and revalidation", () => {
    const value = workerValue(
      invoke(fixture, {
        operation: "virtual-adapter",
        safeDigest: DIGEST,
      }),
    );
    expect(value).toMatchObject({
      path: `/virtual/quarantine/transaction-1/manifests/${DIGEST}.json`,
      calls: {
        lstat: [
          "/virtual/repository",
          "/virtual/quarantine",
          "/virtual/quarantine/transaction-1",
          "/virtual/quarantine",
          "/virtual/quarantine/transaction-1",
          "/virtual/quarantine/transaction-1/manifests",
        ],
        realpath: [
          "/virtual/repository",
          "/virtual/quarantine",
          "/virtual/quarantine/transaction-1",
          "/virtual/quarantine",
          "/virtual/quarantine/transaction-1",
          "/virtual/quarantine/transaction-1/manifests",
        ],
        mkdir: [],
        lstatSync: [
          "/virtual/quarantine",
          "/virtual/quarantine/transaction-1",
          "/virtual/quarantine/transaction-1/manifests",
        ],
        realpathSync: [
          "/virtual/quarantine",
          "/virtual/quarantine/transaction-1",
          "/virtual/quarantine/transaction-1/manifests",
        ],
      },
    });
  });

  it("captures and freezes one complete filesystem context for preflight and capability use", () => {
    const value = workerValue(invoke(fixture, { operation: "binding-contract" }));
    expect(value).toMatchObject({
      inside: {
        frozen: true,
        keys: REQUIRED_FS_METHODS,
        sameLookup: true,
        explicitUndefined: {
          threw: true,
          error: { message: expect.stringMatching(/filesystem|source|context/i) },
        },
        distinctLookup: {
          threw: true,
          error: { message: expect.stringMatching(/filesystem|source|context/i) },
        },
        derived: join(fixture.runRoot, "journal.log"),
        probes: Object.fromEntries(REQUIRED_FS_METHODS.map((method) => [method, method])),
      },
      getterCounts: Object.fromEntries(REQUIRED_FS_METHODS.map((method) => [method, 1])),
      after: {
        threw: true,
        error: { message: expect.stringMatching(/inactive|context|capability/i) },
      },
    });
    for (const method of REQUIRED_FS_METHODS) {
      expect((value.receiverCounts as Record<string, number>)[method]).toBeGreaterThan(0);
    }
  });

  it("removes the filesystem binding before a rejected callback settles", () => {
    const value = workerValue(invoke(fixture, { operation: "binding-reject" }));
    expectCapturedError(value.settlement, /binding callback rejected/i);
    expectCapturedError(value.after, /inactive|context|capability/i);
  });

  it.each(["resolve", "reject"])(
    "revokes captured filesystem adapter methods after callback %s while allowing active calls to finish",
    (settlement) => {
      const value = workerValue(invoke(fixture, { operation: "adapter-lifecycle", settlement }));
      if (settlement === "resolve") {
        expect(value.settlement).toEqual({
          threw: false,
          value: "lifecycle callback resolved",
        });
      } else {
        expectCapturedError(value.settlement, /lifecycle callback rejected/i);
      }
      expect(value.inFlight).toBe("in-flight-completed");
      for (const method of REQUIRED_FS_METHODS) {
        expectCapturedError(
          (value.revokedCalls as Record<string, unknown>)[method],
          /inactive|settled|revoked|context/i,
        );
      }
      expect(value.countsAfterRevokedCalls).toEqual(value.countsBeforeRevokedCalls);
    },
  );

  it.each(REQUIRED_FS_METHODS)("requires the complete filesystem adapter method: %s", (method) => {
    const result = invoke(fixture, { operation: "missing-adapter-method", method });
    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(new RegExp(method, "i")) },
    });
  });

  it.each(["function", "array", "class", "custom-prototype"])(
    "rejects a complete %s adapter before reading any method getter",
    (shape) => {
      const value = workerValue(invoke(fixture, { operation: "invalid-adapter-source", shape }));
      expectCapturedError(value.outcome, /plain object|filesystem adapter/i);
      expect(value.getterReads).toBe(0);
    },
  );

  it("keeps the run capability public surface at exactly three exports", () => {
    expect(workerValue(invoke(fixture, { operation: "public-exports" }))).toEqual([
      "deriveRunPath",
      "revalidateRunCapability",
      "withQuarantineRunCapability",
    ]);
  });

  it.each([false, null, 1, "true"])(
    "requires literal writersStopped=true: %p",
    (writersStopped) => {
      const result = invoke(fixture, {
        operation: "open",
        options: { writersStopped },
      });
      expect(result).toMatchObject({ ok: false, error: { message: expect.stringMatching(/writers|attest/u) } });
    },
  );

  it("rejects forged capabilities", () => {
    const value = workerValue(invoke(fixture, { operation: "forged" }));
    expectCapturedError(value.derive, /capability/u);
    expectCapturedError(value.revalidate, /capability/u);
  });

  it.each(["leak-resolve", "leak-reject"])(
    "deactivates leaked capabilities after %s callback settlement",
    (operation) => {
      const value = workerValue(invoke(fixture, { operation }));
      expectCapturedError(value.derive, /inactive|capability/u);
      if (operation === "leak-resolve") {
        expect(value.settlement).toMatchObject({ threw: false, value: "resolved" });
        expectCapturedError(value.revalidate, /inactive|capability/u);
      } else {
        expectCapturedError(value.settlement, /callback failed/u);
      }
    },
  );

  it.each([
    { purpose: "unknown" },
    { purpose: "journal", id: UUID },
    { purpose: "journal", phase: "pre" },
    { purpose: "manifest-generation" },
    { purpose: "manifest-generation", id: DIGEST, phase: "pre" },
    { purpose: "inventory", id: "copy-0001" },
    { purpose: "inventory", phase: "pre" },
    { purpose: "inventory", id: "copy-0001", phase: "later" },
    { purpose: "inventory-work", id: UUID, phase: "pre" },
    { purpose: "rollback-entry" },
    { purpose: "rollback-entry", id: RESTORE_ID },
    { purpose: "rollback-entry", phase: "generated-next" },
    {
      purpose: "rollback-entry",
      id: RESTORE_ID,
      phase: "generated-next",
      entryId: "generated-next",
    },
  ])("rejects invalid purpose/id/phase combinations: %o", (pathRequest) => {
    const value = workerValue(invoke(fixture, { operation: "derive-error", pathRequest }));
    expectCapturedError(value, /purpose|request|phase|field/u);
  });

  it.each([
    { purpose: "journal-tombstone", id: UUID.toUpperCase() },
    { purpose: "manifest-generation", id: "A".repeat(64) },
    { purpose: "manifest-generation", id: "a".repeat(63) },
    { purpose: "manifest-temporary", id: "not-a-uuid" },
    { purpose: "current-temporary", id: "123e4567-e89b-12d3-a456-426614174000" },
    { purpose: "inventory-work", id: "123e4567-e89b-42d3-c456-426614174000" },
    { purpose: "payload", id: "copy-001" },
    { purpose: "payload", id: "generated-dist" },
    { purpose: "rollback", id: UUID },
    { purpose: "rollback-entry", id: UUID, phase: "generated-next" },
    { purpose: "rollback-entry", id: null, phase: "generated-next" },
    { purpose: "rollback-entry", id: RESTORE_ID, phase: null },
    { purpose: "rollback-entry", id: RESTORE_ID.toUpperCase(), phase: "generated-next" },
    {
      purpose: "rollback-entry",
      id: "restore-123e4567-e89b-12d3-a456-426614174000",
      phase: "generated-next",
    },
    { purpose: "rollback-entry", id: RESTORE_ID, phase: "copy-0001" },
    { purpose: "rollback-entry", id: RESTORE_ID, phase: "generated-dist" },
    { purpose: "conflict", id: RESTORE_ID },
    { purpose: "divergent-diff", id: "generated-next" },
    { purpose: "inventory", phase: "pre", id: RESTORE_ID },
    { purpose: "inventory", phase: "restore-active", id: "copy-0001" },
    { purpose: "inventory", phase: "restore-active", id: RESTORE_ID },
    { purpose: "inventory", phase: "validation-pass-1", id: "copy-0001" },
    { purpose: "inventory", phase: "validation-pass-2", id: RESTORE_ID },
  ])("enforces purpose-specific ID grammar: %o", (pathRequest) => {
    const value = workerValue(invoke(fixture, { operation: "derive-error", pathRequest }));
    expectCapturedError(value, /ID|identifier|request/u);
  });

  it.each([
    { purpose: "payload", id: "copy-0000" },
    { purpose: "conflict", id: "copy-0000" },
    { purpose: "divergent-diff", id: "copy-0000" },
    { purpose: "inventory", phase: "pre", id: "copy-0000" },
    { purpose: "inventory", phase: "moved-pass-1", id: "copy-0000" },
    { purpose: "inventory", phase: "moved-pass-2", id: "copy-0000" },
  ])("rejects the reserved zero copy ID: %o", (pathRequest) => {
    const value = workerValue(invoke(fixture, { operation: "derive-error", pathRequest }));
    expectCapturedError(value, /ID|identifier|request/u);
  });

  it.each(["../escape", ".", "..", "-leading", "trailing-", "Cafe\u0301"])(
    "rejects unsafe transaction ID: %s",
    (transactionId) => {
      const result = invoke(fixture, { operation: "open", transactionId });
      expect(result).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/transaction/u) },
      });
    },
  );

  it("rejects quarantine inside the repository", () => {
    const quarantineRoot = join(fixture.repoRoot, "quarantine");
    privateDirectory(quarantineRoot);
    privateDirectory(join(quarantineRoot, TRANSACTION_ID));
    const result = invoke(
      { ...fixture, quarantineRoot, runRoot: join(quarantineRoot, TRANSACTION_ID) },
      { operation: "open" },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/outside|repository/u) },
    });
  });

  it("rejects symlink quarantine and run roots", () => {
    const realQuarantine = join(fixture.base, "real-quarantine");
    privateDirectory(realQuarantine);
    privateDirectory(join(realQuarantine, TRANSACTION_ID));
    const quarantineLink = join(fixture.base, "quarantine-link");
    symlinkSync(realQuarantine, quarantineLink);
    expect(
      invoke({ ...fixture, quarantineRoot: quarantineLink }, { operation: "open" }),
    ).toMatchObject({ ok: false, error: { message: expect.stringMatching(/symlink/u) } });

    const realRunRoot = join(fixture.base, "real-run");
    privateDirectory(realRunRoot);
    symlinkSync(realRunRoot, join(fixture.quarantineRoot, "linked-run"));
    expect(
      invoke(fixture, { operation: "open", transactionId: "linked-run" }),
    ).toMatchObject({ ok: false, error: { message: expect.stringMatching(/symlink/u) } });
  });

  it.each(["quarantine", "run"])("rejects non-0700 %s root mode", (target) => {
    chmodSync(target === "quarantine" ? fixture.quarantineRoot : fixture.runRoot, 0o755);
    expect(invoke(fixture, { operation: "open" })).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/0700|mode/u) },
    });
  });

  it("rejects repository/quarantine device mismatch", () => {
    expect(invoke(fixture, { operation: "device-mismatch" })).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/device/u) },
    });
  });

  it.each(["quarantine", "run"])("rejects %s root inode replacement", (target) => {
    const value = workerValue(invoke(fixture, { operation: "replace-root", target }));
    expectCapturedError(value.derive, /identity|inode/u);
    expectCapturedError(value.revalidate, /identity|inode/u);
  });

  it.each([
    ["journal", { purpose: "journal" }, ""],
    ["inventory", { purpose: "inventory", phase: "pre", id: "copy-0001" }, "inventories/pre"],
    ["manifest", { purpose: "manifest-generation", id: DIGEST }, "manifests"],
    [
      "rollback entry",
      { purpose: "rollback-entry", id: RESTORE_ID, phase: "generated-next" },
      `rollback/regenerated-before-restore/${RESTORE_ID}`,
    ],
  ] as const)(
    "rejects symlink replacement of derived %s parent without touching its target",
    (_label, pathRequest, parentRelativePath) => {
      const external = join(fixture.base, "external");
      privateDirectory(external);
      const sentinel = join(external, "sentinel.txt");
      writeFileSync(sentinel, "unchanged");
      const value = workerValue(
        invoke(fixture, { operation: "replace-parent", pathRequest, external }),
      );
      expect(value.parent).toBe(
        parentRelativePath === "" ? fixture.runRoot : join(fixture.runRoot, parentRelativePath),
      );
      expectCapturedError(value.derive, /symlink|identity/u);
      expectCapturedError(value.before, /symlink|identity/u);
      expectCapturedError(value.after, /symlink|identity/u);
      expect(readFileSync(sentinel, "utf8")).toBe("unchanged");
    },
  );

  it.each([
    ["manifest", { purpose: "manifest-generation", id: DIGEST }],
    [
      "rollback entry",
      { purpose: "rollback-entry", id: RESTORE_ID, phase: "generated-next" },
    ],
  ])("rejects non-0700 selected %s parent at derivation and both boundaries", (_label, pathRequest) => {
    const value = workerValue(invoke(fixture, { operation: "parent-mode", pathRequest }));
    expectCapturedError(value.derive, /0700|mode/u);
    expectCapturedError(value.before, /0700|mode/u);
    expectCapturedError(value.after, /0700|mode/u);
  });
});
