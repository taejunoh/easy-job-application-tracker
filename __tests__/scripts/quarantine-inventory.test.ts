import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
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

const inventoryUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-inventory.mjs"),
).href;
const capabilityUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-run-capability.mjs"),
).href;

const RUN_DIRECTORIES = [
  "inventories/pre",
  "inventories/moved-pass-1",
  "inventories/moved-pass-2",
  "inventories/restore-active",
  "inventories/work",
  "payload/source-copies",
  "payload/generated",
];

type WorkerResult = {
  result: unknown;
  peakRssBytes: number;
};

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function createRun(quarantineRoot: string, transactionId: string) {
  const runRoot = join(quarantineRoot, transactionId);
  privateDirectory(runRoot);
  for (const path of RUN_DIRECTORIES) privateDirectory(join(runRoot, path));
  return runRoot;
}

function runWorker(request: Record<string, unknown>): WorkerResult {
  const source = `
import * as inventory from ${JSON.stringify(inventoryUrl)};
import {
  deriveRunPath,
  withQuarantineRunCapability,
} from ${JSON.stringify(capabilityUrl)};
import { createReadStream, lstatSync, realpathSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
let peakRssBytes = process.memoryUsage().rss;
const sampler = setInterval(() => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
}, 2);
const baseFsApi = {
  ...fsPromises,
  createReadStream,
  lstatSync,
  realpathSync,
  readFile: async () => { throw new Error("payload readFile is forbidden"); },
};

async function withCapability(callback, fsApi = baseFsApi) {
  return withQuarantineRunCapability({
    repoRoot: request.repoRoot,
    quarantineRoot: request.quarantineRoot,
    transactionId: request.transactionId,
    writersStopped: true,
    fsApi,
  }, callback);
}

try {
  if (global.gc) global.gc();
  let result;
  if (request.operation === "two-passes") {
    result = await withCapability(async (capability) => {
      const firstMetrics = {};
      const secondMetrics = {};
      const first = await inventory.writeInventoryJsonl({
        capability,
        root: request.root,
        entryId: "generated-next",
        phase: "pre",
        fsApi: baseFsApi,
        metrics: firstMetrics,
      });
      const second = await inventory.writeInventoryJsonl({
        capability,
        root: request.root,
        entryId: "generated-next",
        phase: "moved-pass-1",
        fsApi: baseFsApi,
        metrics: secondMetrics,
      });
      return {
        first,
        second,
        firstMetrics,
        secondMetrics,
        firstOutput: deriveRunPath(capability, {
          purpose: "inventory", id: "generated-next", phase: "pre",
        }),
        secondOutput: deriveRunPath(capability, {
          purpose: "inventory", id: "generated-next", phase: "moved-pass-1",
        }),
      };
    });
  } else if (request.operation === "one-pass") {
    result = await withCapability(async (capability) => {
      const metrics = {};
      const summary = await inventory.writeInventoryJsonl({
        capability,
        root: request.root,
        entryId: request.entryId ?? "generated-next",
        phase: request.phase ?? "pre",
        fsApi: baseFsApi,
        limits: request.limits,
        metrics,
        ...(request.injectOutput ? { outputPath: request.injectOutput } : {}),
      });
      const output = deriveRunPath(capability, {
        purpose: "inventory",
        id: request.entryId ?? "generated-next",
        phase: request.phase ?? "pre",
      });
      return { summary, metrics, output };
    });
  } else if (request.operation === "fsync") {
    result = await withCapability(async (capability) => {
      const root = deriveRunPath(capability, { purpose: "payload", id: "generated-next" });
      const events = [];
      const fsApi = {
        ...baseFsApi,
        open: async (path, flags, mode) => {
          events.push(["open", path]);
          const handle = await fsPromises.open(path, flags, mode);
          return new Proxy(handle, {
            get(target, property, receiver) {
              if (property === "sync") return async () => {
                events.push(["sync", path]);
                return target.sync();
              };
              return Reflect.get(target, property, receiver);
            },
          });
        },
      };
      const metrics = {};
      await inventory.fsyncTree({
        capability,
        root,
        entryId: "generated-next",
        purpose: "payload",
        fsApi,
        metrics,
      });
      return { events, metrics };
    });
  } else if (request.operation === "deep-fsync") {
    const depth = request.depth;
    const root = join(realpathSync(request.quarantineRoot), request.transactionId, "payload/generated/.next");
    const fakeDirectoryStat = (level) => ({
      dev: 1, ino: level + 100, mode: 0o40700, size: 0,
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
    });
    const realPrefix = request.quarantineRoot;
    const levelOf = (path) => path === root ? 0 : path.slice(root.length + 1).split("/").length;
    let openDirectories = 0;
    const hybrid = {
      ...baseFsApi,
      lstat: async (path) => path.startsWith(root) ? fakeDirectoryStat(levelOf(path)) : fsPromises.lstat(path),
      opendir: async (path) => {
        const level = levelOf(path);
        openDirectories += 1;
        let yielded = false;
        let closed = false;
        return {
          async next() {
            if (!yielded && level < depth) {
              yielded = true;
              return { done: false, value: { name: "d", isDirectory: () => true } };
            }
            if (!closed) { closed = true; openDirectories -= 1; }
            return { done: true };
          },
          async return() { if (!closed) { closed = true; openDirectories -= 1; } return { done: true }; },
          [Symbol.asyncIterator]() { return this; },
        };
      },
      open: async (path, flags, mode) => {
        if (path.startsWith(root)) return { sync: async () => {}, close: async () => {} };
        return fsPromises.open(path, flags, mode);
      },
    };
    result = await withCapability(async (capability) => {
      const metrics = {};
      await inventory.fsyncTree({
        capability, root, entryId: "generated-next", purpose: "payload", fsApi: hybrid, metrics,
      });
      return { metrics, openDirectories };
    }, hybrid);
  } else if (request.operation === "cleanup-replacement") {
    let firstWorkPath;
    const workLstatCounts = new Map();
    const fsApi = {
      ...baseFsApi,
      lstat: async (path) => {
        if (path.includes("/inventories/work/") && !path.endsWith(".owned")) {
          const count = (workLstatCounts.get(path) ?? 0) + 1;
          workLstatCounts.set(path, count);
          firstWorkPath ??= path;
          if (path === firstWorkPath && count === 3) {
            await fsPromises.rename(path, path + ".owned");
            await fsPromises.writeFile(path, "foreign", { mode: 0o600 });
            await fsPromises.chmod(path, 0o600);
          }
        }
        return fsPromises.lstat(path);
      },
      open: async (path, flags, mode) => {
        if (path.endsWith(".jsonl")) throw new Error("primary publish failure");
        return fsPromises.open(path, flags, mode);
      },
    };
    result = await withCapability(async (capability) => {
      let failure;
      try {
        await inventory.writeInventoryJsonl({
          capability, root: request.root, entryId: "generated-next", phase: "pre",
          fsApi, limits: { sortChunkRecords: 1 }, metrics: {},
        });
      } catch (error) {
        failure = {
          message: error.message,
          errors: error.errors?.map((item) => item.message) ?? [error.message],
        };
      }
      return {
        failure,
        foreignBytes: await fsPromises.readFile(firstWorkPath, "utf8"),
        ownedBytes: await fsPromises.readFile(firstWorkPath + ".owned", "utf8"),
      };
    }, fsApi);
  } else if (request.operation === "output-cleanup") {
    let outputPath;
    let outputLstatCount = 0;
    let outputWriteCount = 0;
    let faultActive = true;
    const fsApi = {
      ...baseFsApi,
      lstat: async (path) => {
        if (path === outputPath) {
          outputLstatCount += 1;
          if (faultActive && request.case === "foreign" && outputLstatCount === 2) {
            await fsPromises.rename(path, path + ".owned");
            await fsPromises.writeFile(path, "foreign", { mode: 0o600 });
            await fsPromises.chmod(path, 0o600);
          }
        }
        return fsPromises.lstat(path);
      },
      open: async (path, flags, mode) => {
        const handle = await fsPromises.open(path, flags, mode);
        if (path !== outputPath || !faultActive) return handle;
        return {
          chmod: (...args) => handle.chmod(...args),
          stat: (...args) => handle.stat(...args),
          sync: (...args) => handle.sync(...args),
          write: async (buffer, offset, length, position) => {
            outputWriteCount += 1;
            if (request.case === "partial" && outputWriteCount === 1) {
              return handle.write(buffer, offset, 1, position);
            }
            throw new Error("injected output write failure");
          },
          close: async () => {
            await handle.close();
            if (request.case === "close-primary") throw new Error("injected close failure");
          },
        };
      },
    };
    result = await withCapability(async (capability) => {
      outputPath = deriveRunPath(capability, {
        purpose: "inventory", id: "generated-next", phase: "pre",
      });
      let failure;
      try {
        await inventory.writeInventoryJsonl({
          capability, root: request.root, entryId: "generated-next", phase: "pre",
          fsApi, metrics: {},
        });
      } catch (error) {
        failure = {
          message: error.message,
          errors: error.errors?.map((item) => item.message) ?? [error.message],
        };
      }
      faultActive = false;
      if (request.case === "foreign") {
        return {
          failure,
          foreignBytes: await fsPromises.readFile(outputPath, "utf8"),
          ownedBytes: await fsPromises.readFile(outputPath + ".owned", "utf8"),
        };
      }
      const retry = await inventory.writeInventoryJsonl({
        capability, root: request.root, entryId: "generated-next", phase: "pre",
        fsApi, metrics: {},
      });
      return { failure, retry, outputBytes: await fsPromises.readFile(outputPath, "utf8") };
    }, fsApi);
  } else if (request.operation === "hash") {
    let handles = 0;
    let maxHandles = 0;
    result = await inventory.hashFileStream(request.root, {
      fsApi: baseFsApi,
      onHandleCount: (count) => { handles = count; maxHandles = Math.max(maxHandles, count); },
    });
    result = { ...result, handles, maxHandles };
  } else if (request.operation === "parse-record") {
    result = inventory.parseInventoryRecord(request.value);
  } else if (request.operation === "parse-summary") {
    result = inventory.parseInventorySummary(request.value);
  } else if (request.operation === "compare") {
    result = await inventory.compareInventorySummary(request.expected, request.observed);
  }
  if (global.gc) global.gc();
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  process.stdout.write(JSON.stringify({ ok: true, result, peakRssBytes }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: { message: error?.message ?? String(error), errors: error?.errors?.map((item) => item.message) },
    peakRssBytes,
  }));
} finally {
  clearInterval(sampler);
}
`;
  const child = JSON.parse(
    execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "--eval", source], {
      encoding: "utf8",
      input: JSON.stringify(request),
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  if (!child.ok) {
    const error = new Error(child.error.message);
    Object.assign(error, child.error);
    throw error;
  }
  return child;
}

describe("bounded quarantine inventory", () => {
  const fixture = mkdtempSync(join(tmpdir(), "quarantine-inventory-"));
  const repoRoot = join(fixture, "repo");
  const quarantineRoot = join(fixture, "quarantine");
  const transactionId = "inventory-main";
  const root = join(repoRoot, "payload");
  const leaf = join(root, "files", "nested");
  let twoPasses: WorkerResult;

  beforeAll(() => {
    privateDirectory(repoRoot);
    privateDirectory(quarantineRoot);
    createRun(quarantineRoot, transactionId);
    mkdirSync(leaf, { recursive: true });
    for (let index = 0; index < 38_975; index += 1) {
      writeFileSync(join(leaf, `file-${String(index).padStart(5, "0")}.txt`), "x");
    }
    for (let index = 0; index < 1_025; index += 1) {
      mkdirSync(join(leaf, `directory-${String(index).padStart(4, "0")}`));
    }
    chmodSync(join(leaf, "file-00000.txt"), 0o640);
    symlinkSync("../../../outside-must-not-be-followed", join(leaf, "leaf-link"));
    twoPasses = runWorker({
      operation: "two-passes", repoRoot, quarantineRoot, transactionId, root,
    });
  }, 120_000);

  afterAll(() => rmSync(fixture, { recursive: true, force: true }));

  it("writes identical deterministic JSONL twice below 160 MiB without payload readFile", () => {
    const result = twoPasses.result as {
      first: { sha256: string; entries: number; bytes: number };
      second: { sha256: string; entries: number; bytes: number };
      firstOutput: string;
      secondOutput: string;
      firstMetrics: Record<string, number>;
      secondMetrics: Record<string, number>;
    };
    expect(result.second).toEqual(result.first);
    expect(result.second).toMatchObject({ entries: 40_003, bytes: 39_012 });
    expect(readFileSync(result.secondOutput)).toEqual(readFileSync(result.firstOutput));
    expect(result.second.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(twoPasses.peakRssBytes).toBeLessThan(160 * 1024 * 1024);
    expect(result.firstMetrics.maxOpenDirectoryHandles).toBeLessThanOrEqual(1);
    expect(result.firstMetrics.maxTraversalAndHashHandles).toBeLessThanOrEqual(2);
    expect(result.firstMetrics.maxMergeReaders).toBeLessThanOrEqual(32);
    expect(result.firstMetrics.sortChunkRecordLimit).toBe(4096);
    expect(result.firstMetrics.sortChunkByteLimit).toBe(8 * 1024 * 1024);
    expect(result.firstMetrics.frontierRecordLimit).toBe(1024);
    expect(result.firstMetrics.frontierByteLimit).toBe(8 * 1024 * 1024);
    expect(result.firstMetrics.frontierSpills).toBeGreaterThan(0);
    expect(lstatSync(result.firstOutput).mode & 0o7777).toBe(0o600);
    const records = readFileSync(result.firstOutput, "utf8").trimEnd().split("\n").map(JSON.parse);
    const paths = records.map((record) => record.path);
    expect(paths).toEqual([...paths].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));
    expect(records.find((record) => record.path.endsWith("leaf-link"))).toMatchObject({
      type: "symlink", linkTarget: "../../../outside-must-not-be-followed",
    });
  });

  it("accepts only the exact RootFileRecord and safe RelativeRecord union", () => {
    const rootFile = { scope: "root", type: "file", mode: 0o640, size: 1, sha256: "a".repeat(64) };
    const relative = { ...rootFile, scope: "relative", path: "src/file.ts" };
    for (const value of [
      rootFile,
      relative,
      { scope: "relative", path: "src", type: "directory", mode: 0o755, size: 0 },
      { scope: "relative", path: "src/link", type: "symlink", mode: 0o777, size: 1, linkTarget: "x" },
    ]) expect(runWorker({ operation: "parse-record", value }).result).toEqual(value);
    for (const value of [
      { ...rootFile, path: "x" },
      { ...rootFile, type: "unknown" },
      { ...relative, scope: undefined },
      { ...relative, path: undefined },
      { ...relative, path: "" },
      { ...relative, path: "." },
      { ...relative, path: ".." },
      { ...relative, path: "a/../b" },
      { ...relative, path: "/tmp/x" },
      { ...relative, path: "a\\b" },
      { ...relative, path: "a\0b" },
      { ...relative, path: "a//b" },
      { ...relative, path: "cafe\u0301" },
    ]) expect(() => runWorker({ operation: "parse-record", value })).toThrow(/inventory record/u);
  });

  it("parses and compares only exact inventory summaries", () => {
    const summary = { sha256: "b".repeat(64), entries: 1, bytes: 2 };
    expect(runWorker({ operation: "parse-summary", value: summary }).result).toEqual(summary);
    expect(runWorker({ operation: "compare", expected: summary, observed: summary }).result).toBe(true);
    expect(() => runWorker({ operation: "parse-summary", value: { ...summary, extra: true } })).toThrow(/summary/u);
    expect(() => runWorker({ operation: "compare", expected: summary, observed: { ...summary, bytes: 3 } })).toThrow(/summary/u);
  });

  it("derives output from capability, entry ID, and phase and rejects caller output paths", () => {
    const nextTransaction = "inventory-output-injection";
    createRun(quarantineRoot, nextTransaction);
    const sentinel = join(fixture, "external-sentinel");
    writeFileSync(sentinel, "sentinel");
    expect(() => runWorker({
      operation: "one-pass", repoRoot, quarantineRoot, transactionId: nextTransaction,
      root, injectOutput: sentinel,
    })).toThrow(/unknown|invalid|output/i);
    expect(readFileSync(sentinel, "utf8")).toBe("sentinel");
  });

  it("limits a multipass merge to 32 readers", () => {
    const nextTransaction = "inventory-many-chunks";
    createRun(quarantineRoot, nextTransaction);
    const result = runWorker({
      operation: "one-pass", repoRoot, quarantineRoot, transactionId: nextTransaction,
      root: leaf, limits: { sortChunkRecords: 1000 },
    }).result as { metrics: Record<string, number> };
    expect(result.metrics.chunkFiles).toBeGreaterThan(32);
    expect(result.metrics.maxMergeReaders).toBeLessThanOrEqual(32);
    expect(result.metrics.mergePasses).toBeGreaterThan(1);
  }, 120_000);

  it("treats configured limits as lower-only overrides of hard ceilings", () => {
    const nextTransaction = "inventory-hard-ceilings";
    createRun(quarantineRoot, nextTransaction);
    const result = runWorker({
      operation: "one-pass",
      repoRoot,
      quarantineRoot,
      transactionId: nextTransaction,
      root: leaf,
      limits: {
        sortChunkRecords: 1_000_000,
        sortChunkBytes: 64 * 1024 * 1024,
        frontierRecords: 100_000,
        frontierBytes: 64 * 1024 * 1024,
        mergeFanIn: 1_000,
      },
    }).result as { metrics: Record<string, number> };
    expect(result.metrics.sortChunkRecordLimit).toBeLessThanOrEqual(4096);
    expect(result.metrics.sortChunkByteLimit).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(result.metrics.frontierRecordLimit).toBeLessThanOrEqual(1024);
    expect(result.metrics.frontierByteLimit).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(result.metrics.mergeFanInLimit).toBeLessThanOrEqual(32);
  }, 120_000);

  it("hashes file bodies through createReadStream and reports handle counts", () => {
    expect(runWorker({ operation: "hash", root: join(leaf, "file-00001.txt") }).result).toEqual({
      sha256: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
      bytes: 1,
      handles: 0,
      maxHandles: 1,
    });
  });

  it("fsyncs files before nested directories and skips symlink targets", () => {
    const nextTransaction = "inventory-fsync";
    const nextRun = createRun(quarantineRoot, nextTransaction);
    const payload = join(nextRun, "payload/generated/.next");
    const nested = join(payload, "nested");
    const external = join(fixture, "external-target");
    privateDirectory(nested);
    writeFileSync(join(nested, "file"), "x");
    writeFileSync(external, "external");
    symlinkSync(external, join(nested, "link"));
    const result = runWorker({
      operation: "fsync", repoRoot, quarantineRoot, transactionId: nextTransaction, root: payload,
    }).result as { events: [string, string][]; metrics: Record<string, number> };
    const canonicalPayload = realpathSync(payload);
    const canonicalNested = join(canonicalPayload, "nested");
    const synced = result.events
      .filter(([event, path]) => event === "sync" && path.startsWith(canonicalPayload))
      .map(([, path]) => path);
    expect(synced).toEqual([join(canonicalNested, "file"), canonicalNested, canonicalPayload]);
    expect(result.events.some(([, path]) => path === join(canonicalNested, "link"))).toBe(false);
    expect(result.events.some(([, path]) => path === external)).toBe(false);
    expect(result.metrics.maxOpenDirectoryHandles).toBeLessThanOrEqual(1);
  });

  it("handles a virtual 10,000-deep tree without recursion or leaked directory handles", () => {
    const nextTransaction = "inventory-deep";
    createRun(quarantineRoot, nextTransaction);
    const result = runWorker({
      operation: "deep-fsync", repoRoot, quarantineRoot, transactionId: nextTransaction, depth: 10_000,
    }).result as { metrics: Record<string, number>; openDirectories: number };
    expect(result.openDirectories).toBe(0);
    expect(result.metrics.maxOpenDirectoryHandles).toBeLessThanOrEqual(1);
    expect(result.metrics.maxTraversalAndHashHandles).toBeLessThanOrEqual(2);
    expect(result.metrics.maxPostorderFrames).toBeLessThanOrEqual(1024);
    expect(result.metrics.maxPostorderBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(result.metrics.postorderSpills).toBeGreaterThan(0);
  }, 120_000);

  it("rejects a symlink root and an output-parent symlink without touching external data", () => {
    const source = join(fixture, "symlink-source");
    const rootLink = join(fixture, "symlink-root");
    writeFileSync(source, "secret");
    symlinkSync(source, rootLink);
    const rootTransaction = "inventory-root-link";
    createRun(quarantineRoot, rootTransaction);
    expect(() => runWorker({
      operation: "one-pass", repoRoot, quarantineRoot, transactionId: rootTransaction, root: rootLink,
    })).toThrow(/root|symlink/i);

    const parentTransaction = "inventory-parent-link";
    const parentRun = createRun(quarantineRoot, parentTransaction);
    const external = join(fixture, "external-output");
    privateDirectory(external);
    writeFileSync(join(external, "sentinel"), "sentinel");
    rmSync(join(parentRun, "inventories/pre"), { recursive: true });
    symlinkSync(external, join(parentRun, "inventories/pre"));
    expect(() => runWorker({
      operation: "one-pass", repoRoot, quarantineRoot, transactionId: parentTransaction, root,
    })).toThrow(/parent|symlink|identity/i);
    expect(readFileSync(join(external, "sentinel"), "utf8")).toBe("sentinel");
  });

  it("normalizes output and work files to exact 0600 even under umask 0777", () => {
    const nextTransaction = "inventory-private-modes";
    createRun(quarantineRoot, nextTransaction);
    const oldUmask = process.umask(0o777);
    try {
      const result = runWorker({
        operation: "one-pass", repoRoot, quarantineRoot, transactionId: nextTransaction,
        root: leaf, limits: { sortChunkRecords: 1000 },
      }).result as { output: string; metrics: Record<string, number> };
      expect(lstatSync(result.output).mode & 0o7777).toBe(0o600);
      expect(result.metrics.maxWorkFileMode).toBe(0o600);
      expect(result.metrics.minWorkFileMode).toBe(0o600);
    } finally {
      process.umask(oldUmask);
    }
  }, 120_000);

  it("preserves a foreign work-file replacement and the primary failure", () => {
    const nextTransaction = "inventory-cleanup-ownership";
    createRun(quarantineRoot, nextTransaction);
    const smallRoot = join(repoRoot, "cleanup-root");
    privateDirectory(smallRoot);
    writeFileSync(join(smallRoot, "a"), "a");
    writeFileSync(join(smallRoot, "b"), "b");
    const result = runWorker({
      operation: "cleanup-replacement",
      repoRoot,
      quarantineRoot,
      transactionId: nextTransaction,
      root: smallRoot,
    }).result as {
      failure: { errors: string[] };
      foreignBytes: string;
      ownedBytes: string;
    };
    expect(result.failure.errors).toEqual([
      "primary publish failure",
      expect.stringMatching(/ownership|foreign replacement/i),
    ]);
    expect(result.foreignBytes).toBe("foreign");
    expect(result.ownedBytes).toContain('"path":"a"');
  });

  it.each(["zero-byte", "partial", "close-primary"])(
    "removes an owned %s output failure so an exact retry succeeds",
    (failureCase) => {
      const nextTransaction = `inventory-output-${failureCase}`;
      createRun(quarantineRoot, nextTransaction);
      const source = join(repoRoot, `${failureCase}.txt`);
      writeFileSync(source, "retry-body");
      const result = runWorker({
        operation: "output-cleanup",
        case: failureCase,
        repoRoot,
        quarantineRoot,
        transactionId: nextTransaction,
        root: source,
      }).result as {
        failure: { errors: string[] };
        retry: { entries: number; bytes: number; sha256: string };
        outputBytes: string;
      };
      expect(result.failure.errors[0]).toBe("injected output write failure");
      if (failureCase === "close-primary") {
        expect(result.failure.errors).toEqual([
          "injected output write failure",
          "injected close failure",
        ]);
      }
      expect(result.retry).toMatchObject({ entries: 1, bytes: 10 });
      expect(result.outputBytes.endsWith("\n")).toBe(true);
    },
    120_000,
  );

  it("preserves a foreign partial-output replacement and aggregates cleanup failure", () => {
    const nextTransaction = "inventory-output-foreign";
    createRun(quarantineRoot, nextTransaction);
    const source = join(repoRoot, "foreign-output.txt");
    writeFileSync(source, "source");
    const result = runWorker({
      operation: "output-cleanup",
      case: "foreign",
      repoRoot,
      quarantineRoot,
      transactionId: nextTransaction,
      root: source,
    }).result as {
      failure: { errors: string[] };
      foreignBytes: string;
      ownedBytes: string;
    };
    expect(result.failure.errors).toEqual([
      "injected output write failure",
      expect.stringMatching(/ownership|foreign replacement/i),
    ]);
    expect(result.foreignBytes).toBe("foreign");
    expect(result.ownedBytes).toBe("");
  });
});
