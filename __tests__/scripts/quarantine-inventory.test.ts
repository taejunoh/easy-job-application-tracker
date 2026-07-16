import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
const RESTORE_ID = "restore-123e4567-e89b-42d3-a456-426614174000";

const RUN_DIRECTORIES = [
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

function publicationId(entryId: string, phase: string) {
  const digest = createHash("sha256")
    .update("quarantine-inventory-publication\0")
    .update(entryId)
    .update("\0")
    .update(phase)
    .digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
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
import { Readable } from "node:stream";

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
const capabilityFsMethods = [
  "lstat", "realpath", "mkdir", "open", "readdir", "rm", "rename", "unlink", "link",
  "opendir", "readlink", "createReadStream", "lstatSync", "realpathSync",
];

function instrumentedAdapter() {
  const counts = Object.fromEntries(capabilityFsMethods.map((method) => [method, 0]));
  const adapter = Object.fromEntries(capabilityFsMethods.map((method) => [
    method,
    (...args) => {
      counts[method] += 1;
      return Reflect.apply(baseFsApi[method], baseFsApi, args);
    },
  ]));
  return { adapter, counts };
}

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
      let repeated;
      if (request.repeat) {
        repeated = await inventory.writeInventoryJsonl({
          capability,
          root: request.root,
          entryId: request.entryId ?? "generated-next",
          phase: request.phase ?? "pre",
          fsApi: baseFsApi,
          metrics: {},
        });
      }
      const output = deriveRunPath(capability, {
        purpose: "inventory",
        id: request.entryId ?? "generated-next",
        phase: request.phase ?? "pre",
      });
      const workProbe = deriveRunPath(capability, {
        purpose: "inventory-work", id: "123e4567-e89b-42d3-a456-426614174000",
      });
      return {
        summary,
        repeated,
        metrics,
        output,
        workNames: await fsPromises.readdir(join(workProbe, "..")),
      };
    });
  } else if (request.operation === "fsync") {
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
    result = await withCapability(async (capability) => {
      const entryId = request.entryId ?? "generated-next";
      const purpose = request.purpose ?? "payload";
      const pathRequest = purpose === "rollback-entry"
        ? { purpose, id: request.restoreId, phase: entryId }
        : { purpose, id: entryId };
      const root = purpose === "rollback-entry" && request.root !== undefined
        ? request.root
        : deriveRunPath(capability, pathRequest);
      const metrics = {};
      await inventory.fsyncTree({
        capability,
        root,
        entryId,
        purpose,
        ...(purpose === "rollback-entry" ? { restoreId: request.restoreId } : {}),
        fsApi,
        metrics,
      });
      return { events, metrics };
    }, fsApi);
  } else if (request.operation === "rollback-invalid") {
    const sourceA = instrumentedAdapter();
    const sourceB = instrumentedAdapter();
    result = await withCapability(async (capability) => {
      const validRoot = deriveRunPath(capability, {
        purpose: "rollback-entry",
        id: request.restoreId,
        phase: "generated-next",
      });
      const options = {
        capability,
        root: request.case === "foreign-root" ? request.root : validRoot,
        purpose: "rollback-entry",
        restoreId: request.restoreId,
        entryId: "generated-next",
        metrics: {},
      };
      if (request.case === "unknown") options.unknown = true;
      if (request.case === "symbol") options[Symbol("unknown")] = true;
      if (request.case === "missing-restore") delete options.restoreId;
      if (request.case === "missing-entry") delete options.entryId;
      if (request.case === "bad-entry") options.entryId = "copy-0001";
      if (request.case === "payload-restore") options.purpose = "payload";
      if (request.case === "undefined-adapter") options.fsApi = undefined;
      if (request.case === "distinct-adapter") options.fsApi = sourceB.adapter;
      const before = { ...sourceA.counts };
      let outcome;
      try {
        outcome = { ok: true, value: await inventory.fsyncTree(options) };
      } catch (error) {
        outcome = { ok: false, error: { message: error?.message ?? String(error) } };
      }
      const after = { ...sourceA.counts };
      return {
        outcome,
        delta: Object.fromEntries(
          Object.keys(after).map((method) => [method, after[method] - before[method]]),
        ),
        distinctCalls: { ...sourceB.counts },
      };
    }, sourceA.adapter);
  } else if (request.operation === "bound-adapter-contract") {
    const sourceA = instrumentedAdapter();
    const sourceB = instrumentedAdapter();
    result = await withCapability(async (capability) => {
      const fsyncPurpose = request.purpose ?? "payload";
      const root = request.writer === "write"
        ? request.root
        : deriveRunPath(capability, fsyncPurpose === "rollback-entry"
            ? { purpose: fsyncPurpose, id: request.restoreId, phase: "generated-next" }
            : { purpose: fsyncPurpose, id: "generated-next" });
      const before = { ...sourceA.counts };
      if (request.mutateSource) {
        for (const method of capabilityFsMethods) {
          sourceA.adapter[method] = () => { throw new Error("mutated source method used: " + method); };
        }
      }
      const options = request.writer === "write"
        ? {
            capability,
            root,
            entryId: "generated-next",
            phase: "pre",
            metrics: {},
          }
        : {
            capability,
            root,
            entryId: "generated-next",
            purpose: fsyncPurpose,
            ...(fsyncPurpose === "rollback-entry" ? { restoreId: request.restoreId } : {}),
            metrics: {},
          };
      if (request.adapterMode === "same") options.fsApi = sourceA.adapter;
      if (request.adapterMode === "distinct") options.fsApi = sourceB.adapter;
      if (request.adapterMode === "undefined") options.fsApi = undefined;
      let outcome;
      try {
        outcome = {
          ok: true,
          value: request.writer === "write"
            ? await inventory.writeInventoryJsonl(options)
            : await inventory.fsyncTree(options),
        };
      } catch (error) {
        outcome = { ok: false, error: { message: error?.message ?? String(error) } };
      }
      return {
        outcome,
        before,
        after: { ...sourceA.counts },
        distinctCalls: { ...sourceB.counts },
        outputNames: await fsPromises.readdir(join(
          request.quarantineRoot,
          request.transactionId,
          "inventories/pre",
        )),
        workNames: await fsPromises.readdir(join(
          request.quarantineRoot,
          request.transactionId,
          "inventories/work",
        )),
      };
    }, sourceA.adapter);
  } else if (request.operation === "deep-fsync") {
    const depth = request.depth;
    const root = request.root ?? join(
      realpathSync(request.quarantineRoot),
      request.transactionId,
      "payload/generated/.next",
    );
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
        capability,
        root,
        entryId: "generated-next",
        purpose: request.purpose ?? "payload",
        ...(request.purpose === "rollback-entry" ? { restoreId: request.restoreId } : {}),
        fsApi: hybrid,
        metrics,
      });
      return { metrics, openDirectories };
    }, hybrid);
  } else if (request.operation === "cleanup-replacement") {
    let firstWorkPath;
    let ownedOriginalBytes;
    let readStreamCount = 0;
    const workLstatCounts = new Map();
    const fsApi = {
      ...baseFsApi,
      createReadStream: (path, options) => {
        readStreamCount += 1;
        const stream = createReadStream(path, options);
        if (readStreamCount === 2) {
          setImmediate(() => stream.destroy(new Error("primary publish failure")));
        }
        return stream;
      },
      lstat: async (path) => {
        if (path.includes("/inventories/work/") && !path.endsWith(".owned")) {
          const count = (workLstatCounts.get(path) ?? 0) + 1;
          workLstatCounts.set(path, count);
          firstWorkPath ??= path;
          if (path === firstWorkPath && count === 3) {
            ownedOriginalBytes = await fsPromises.readFile(path, "utf8");
            await fsPromises.rename(path, path + ".owned");
            await fsPromises.writeFile(path, "foreign", { mode: 0o600 });
            await fsPromises.chmod(path, 0o600);
          }
        }
        return fsPromises.lstat(path);
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
        ownedOriginalBytes,
      };
    }, fsApi);
  } else if (request.operation === "output-cleanup") {
    let outputPath;
    let publicationTempPath;
    let workCreateCount = 0;
    let outputLstatCount = 0;
    let outputWriteCount = 0;
    let faultActive = true;
    let streamsOpened = 0;
    let streamsClosed = 0;
    const fsApi = {
      ...baseFsApi,
      createReadStream: (path, options) => {
        streamsOpened += 1;
        const stream = createReadStream(path, options);
        stream.once("close", () => { streamsClosed += 1; });
        return stream;
      },
      lstat: async (path) => {
        if (path === publicationTempPath) {
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
        if (flags === "wx" && path.includes("/inventories/work/")) {
          workCreateCount += 1;
          if (workCreateCount === 2) publicationTempPath = path;
        }
        if (path !== publicationTempPath || !faultActive) return handle;
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
        await new Promise((resolve) => setImmediate(resolve));
        return {
          failure,
          foreignBytes: await fsPromises.readFile(publicationTempPath, "utf8"),
          ownedBytes: await fsPromises.readFile(publicationTempPath + ".owned", "utf8"),
          streamsOpened,
          streamsClosed,
        };
      }
      const retry = await inventory.writeInventoryJsonl({
        capability, root: request.root, entryId: "generated-next", phase: "pre",
        fsApi, metrics: {},
      });
      await new Promise((resolve) => setImmediate(resolve));
      return {
        failure,
        retry,
        outputBytes: await fsPromises.readFile(outputPath, "utf8"),
        streamsOpened,
        streamsClosed,
      };
    }, fsApi);
  } else if (request.operation === "durable-output-replacement") {
    let outputPath;
    let publicationTempPath;
    let workCreateCount = 0;
    let replacementMade = false;
    const fsApi = {
      ...baseFsApi,
      open: async (path, flags, mode) => {
        const handle = await fsPromises.open(path, flags, mode);
        if (flags === "wx" && path.includes("/inventories/work/")) {
          workCreateCount += 1;
          if (workCreateCount === 2) publicationTempPath = path;
        }
        if (!path.endsWith("/inventories/pre") || flags !== "r") return handle;
        return {
          sync: async () => {
            await handle.sync();
            if (!replacementMade) {
              replacementMade = true;
              await fsPromises.unlink(outputPath);
              await fsPromises.writeFile(outputPath, "foreign-durable", {
                flag: "wx", mode: 0o600,
              });
              await fsPromises.chmod(outputPath, 0o600);
            }
          },
          close: (...args) => handle.close(...args),
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
      const readIfPresent = async (path) => {
        try { return await fsPromises.readFile(path, "utf8"); }
        catch (error) { if (error?.code === "ENOENT") return null; throw error; }
      };
      return {
        failure,
        foreignBytes: await readIfPresent(outputPath),
        ownedBytes: await readIfPresent(publicationTempPath),
        workNames: await fsPromises.readdir(join(publicationTempPath, "..")),
      };
    }, fsApi);
  } else if (request.operation === "work-setup-fault") {
    let faultActive = true;
    let workPath;
    let statCalls = 0;
    let lstatFaulted = false;
    const fsApi = {
      ...baseFsApi,
      lstat: async (path) => {
        if (
          faultActive &&
          !lstatFaulted &&
          path === workPath &&
          request.case === "lstat"
        ) {
          lstatFaulted = true;
          throw new Error("injected work lstat failure");
        }
        return fsPromises.lstat(path);
      },
      open: async (path, flags, mode) => {
        const handle = await fsPromises.open(path, flags, mode);
        if (!path.includes("/inventories/work/")) return handle;
        workPath ??= path;
        return {
          write: (...args) => handle.write(...args),
          sync: (...args) => handle.sync(...args),
          close: (...args) => handle.close(...args),
          chmod: async (...args) => {
            if (faultActive && request.case === "chmod") {
              throw new Error("injected work chmod failure");
            }
            return handle.chmod(...args);
          },
          stat: async (...args) => {
            statCalls += 1;
            if (
              faultActive &&
              ((request.case === "stat-transient" && statCalls === 1) ||
                request.case === "stat-permanent")
            ) {
              throw new Error("injected work stat failure");
            }
            return handle.stat(...args);
          },
        };
      },
    };
    result = await withCapability(async (capability) => {
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
      if (request.case === "stat-transient") {
        const workProbe = deriveRunPath(capability, {
          purpose: "inventory-work", id: "123e4567-e89b-42d3-a456-426614174000",
        });
        return {
          failure,
          workNames: await fsPromises.readdir(join(workProbe, "..")),
        };
      }
      if (request.case === "stat-permanent") {
        const workProbe = deriveRunPath(capability, {
          purpose: "inventory-work", id: "123e4567-e89b-42d3-a456-426614174000",
        });
        return {
          failure,
          workNames: await fsPromises.readdir(join(workProbe, "..")),
        };
      }
      faultActive = false;
      const retry = await inventory.writeInventoryJsonl({
        capability, root: request.root, entryId: "generated-next", phase: "pre",
        fsApi, metrics: {},
      });
      const workProbe = deriveRunPath(capability, {
        purpose: "inventory-work", id: "123e4567-e89b-42d3-a456-426614174000",
      });
      return {
        failure,
        retry,
        workNames: await fsPromises.readdir(join(workProbe, "..")),
      };
    }, fsApi);
  } else if (request.operation === "crash-publication") {
    let workCreateCount = 0;
    let publicationTempPath;
    let linked = false;
    const fsApi = {
      ...baseFsApi,
      open: async (path, flags, mode) => {
        const handle = await fsPromises.open(path, flags, mode);
        if (flags === "wx" && path.includes("/inventories/work/")) {
          workCreateCount += 1;
          if (workCreateCount === 2) publicationTempPath = path;
        }
        return handle;
      },
      link: async (source, destination) => {
        if (request.boundary === "pre-link") {
          await new Promise((resolve) => process.stdout.write("pre-link-kill-ready\\n", resolve));
          process.kill(process.pid, "SIGKILL");
          await new Promise(() => {});
        }
        await fsPromises.link(source, destination);
        linked = true;
        if (request.boundary === "link") process.kill(process.pid, "SIGKILL");
      },
      unlink: async (path) => {
        await fsPromises.unlink(path);
        if (
          linked &&
          path === publicationTempPath &&
          request.boundary === "temp-unlink"
        ) {
          process.kill(process.pid, "SIGKILL");
        }
      },
    };
    await withCapability((capability) => inventory.writeInventoryJsonl({
      capability,
      root: request.root,
      entryId: "generated-next",
      phase: "pre",
      fsApi,
      metrics: {},
    }), fsApi);
  } else if (request.operation === "fresh-read-count") {
    let workReads = 0;
    const fsApi = {
      ...baseFsApi,
      createReadStream: (path, options) => {
        if (path.includes("/inventories/work/")) workReads += 1;
        return createReadStream(path, options);
      },
    };
    result = await withCapability(async (capability) => {
      const summary = await inventory.writeInventoryJsonl({
        capability, root: request.root, entryId: "generated-next", phase: "pre",
        fsApi, metrics: {},
      });
      return { summary, workReads };
    }, fsApi);
  } else if (request.operation === "stream-teardown") {
    let opened = 0;
    let closed = 0;
    let active = 0;
    let workCreateCount = 0;
    let publicationTempPath;
    const fsApi = {
      ...baseFsApi,
      createReadStream: (path, options) => {
        opened += 1;
        active += 1;
        let stream;
        if (path.includes("/inventories/work/")) {
          const underlying = createReadStream(path, { ...options, highWaterMark: 32 });
          stream = Readable.from((async function* () {
            for await (const chunk of underlying) {
              yield chunk;
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
          })());
          if (options?.encoding) stream.setEncoding(options.encoding);
        } else {
          stream = createReadStream(path, options);
        }
        stream.once("close", () => {
          closed += 1;
          active -= 1;
        });
        return stream;
      },
      open: async (path, flags, mode) => {
        const handle = await fsPromises.open(path, flags, mode);
        if (flags === "wx" && path.includes("/inventories/work/")) {
          workCreateCount += 1;
          if (workCreateCount === 2) publicationTempPath = path;
        }
        if (path !== publicationTempPath) return handle;
        return {
          chmod: (...args) => handle.chmod(...args),
          stat: (...args) => handle.stat(...args),
          sync: (...args) => handle.sync(...args),
          close: (...args) => handle.close(...args),
          write: async () => { throw new Error("injected consumer output failure"); },
        };
      },
    };
    result = await withCapability(async (capability) => {
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
      await new Promise((resolve) => setImmediate(resolve));
      const workProbe = deriveRunPath(capability, {
        purpose: "inventory-work", id: "123e4567-e89b-42d3-a456-426614174000",
      });
      return {
        failure,
        opened,
        closed,
        active,
        workNames: await fsPromises.readdir(join(workProbe, "..")),
      };
    }, fsApi);
  } else if (request.operation === "public-exports") {
    result = Object.keys(inventory).sort();
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
  } else if (request.operation === "parse-record-link-target-accessor") {
    let getterReads = 0;
    const value = {
      scope: "relative",
      path: "src/link",
      type: "symlink",
      mode: 0o777,
      size: 1,
    };
    Object.defineProperty(value, "linkTarget", {
      enumerable: true,
      get() {
        getterReads += 1;
        return getterReads === 1 ? request.linkTarget : { poisoned: true };
      },
    });
    const record = inventory.parseInventoryRecord(value);
    result = { getterReads, record };
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
  if (request.expectSignal) {
    const child = spawnSync(
      process.execPath,
      ["--expose-gc", "--input-type=module", "--eval", source],
      {
        encoding: "utf8",
        input: JSON.stringify(request),
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return { result: { signal: child.signal, stdout: child.stdout }, peakRssBytes: 0 };
  }
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
    expect(result.firstMetrics.maxCoordinatorReferences).toBeLessThanOrEqual(4096);
    expect(lstatSync(result.firstOutput).mode & 0o7777).toBe(0o600);
    const records = readFileSync(result.firstOutput, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const paths = records.map((record) => record.path);
    expect(paths).toEqual([...paths].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));
    expect(records.find((record) => record.path.endsWith("leaf-link"))).toMatchObject({
      type: "symlink", linkTarget: "../../../outside-must-not-be-followed",
    });
  });

  it("publishes distinct generated inventories for restore and validation phases", () => {
    const nextTransaction = "inventory-restore-validation-phases";
    createRun(quarantineRoot, nextTransaction);
    const source = join(repoRoot, "restore-validation-source");
    privateDirectory(source);
    writeFileSync(join(source, "file"), "phase");
    const cases = [
      ["restore-active", "generated-next"],
      ["restore-active", "generated-node-modules"],
      ["validation-pass-1", "generated-next"],
      ["validation-pass-2", "generated-node-modules"],
    ] as const;
    const outputs = cases.map(([phase, entryId]) => {
      const result = runWorker({
        operation: "one-pass",
        repoRoot,
        quarantineRoot,
        transactionId: nextTransaction,
        root: source,
        phase,
        entryId,
      }).result as { output: string; summary: { entries: number } };
      expect(result.summary.entries).toBe(1);
      return result.output;
    });
    expect(new Set(outputs).size).toBe(cases.length);
    expect(outputs).toEqual(cases.map(([phase, entryId]) =>
      join(realpathSync(quarantineRoot), nextTransaction, "inventories", phase, `${entryId}.jsonl`)));
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

  it("snapshots a symlink inventory record linkTarget accessor once", () => {
    const linkTarget = "../target";
    expect(runWorker({
      operation: "parse-record-link-target-accessor",
      linkTarget,
    }).result).toEqual({
      getterReads: 1,
      record: {
        scope: "relative",
        path: "src/link",
        type: "symlink",
        mode: 0o777,
        size: 1,
        linkTarget,
      },
    });
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

  it("reuses an exact published inventory and leaves no deterministic work temp", () => {
    const nextTransaction = "inventory-repeat-publication";
    createRun(quarantineRoot, nextTransaction);
    const source = join(repoRoot, "repeat-publication.txt");
    writeFileSync(source, "repeat");
    const result = runWorker({
      operation: "one-pass",
      repeat: true,
      repoRoot,
      quarantineRoot,
      transactionId: nextTransaction,
      root: source,
    }).result as {
      summary: Record<string, unknown>;
      repeated: Record<string, unknown>;
      workNames: string[];
    };
    expect(result.repeated).toEqual(result.summary);
    expect(result.workNames).toEqual([]);
  });

  it("reads final merge inputs exactly once on a fresh publication path", () => {
    const nextTransaction = "inventory-fresh-single-pass";
    createRun(quarantineRoot, nextTransaction);
    const source = join(repoRoot, "fresh-single-pass.txt");
    writeFileSync(source, "single-pass");
    const result = runWorker({
      operation: "fresh-read-count",
      repoRoot,
      quarantineRoot,
      transactionId: nextTransaction,
      root: source,
    }).result as { summary: { entries: number }; workReads: number };
    expect(result.summary.entries).toBe(1);
    expect(result.workReads).toBe(1);
  });

  it("closes every merge input when a multi-line consumer throws after the first line", () => {
    const nextTransaction = "inventory-stream-teardown";
    createRun(quarantineRoot, nextTransaction);
    const source = join(repoRoot, "stream-teardown");
    privateDirectory(source);
    for (let index = 0; index < 64; index += 1) {
      writeFileSync(join(source, `file-${String(index).padStart(2, "0")}`), "x");
    }
    const result = runWorker({
      operation: "stream-teardown",
      repoRoot,
      quarantineRoot,
      transactionId: nextTransaction,
      root: source,
    }).result as {
      failure: { errors: string[] };
      opened: number;
      closed: number;
      active: number;
      workNames: string[];
    };
    expect(result.failure.errors[0]).toBe("injected consumer output failure");
    expect(result.opened).toBe(result.closed);
    expect(result.active).toBe(0);
    expect(result.workNames).toEqual([]);
  });

  it.each(["pre-link", "link", "temp-unlink"])(
    "recovers an exact inventory after a real SIGKILL at the %s boundary",
    (boundary) => {
      const nextTransaction = `inventory-crash-${boundary}`;
      createRun(quarantineRoot, nextTransaction);
      const source = join(repoRoot, `crash-${boundary}.txt`);
      writeFileSync(source, "crash-recovery");
      const crashed = runWorker({
        operation: "crash-publication",
        expectSignal: true,
        boundary,
        repoRoot,
        quarantineRoot,
        transactionId: nextTransaction,
        root: source,
      });
      const crashResult = crashed.result as { signal: string; stdout: string };
      expect(crashResult.signal).toBe("SIGKILL");
      if (boundary === "pre-link") {
        expect(crashResult.stdout).toContain("pre-link-kill-ready");
      }
      const recovered = runWorker({
        operation: "one-pass",
        repoRoot,
        quarantineRoot,
        transactionId: nextTransaction,
        root: source,
      }).result as {
        summary: { entries: number; bytes: number; sha256: string };
        workNames: string[];
        output: string;
      };
      expect(recovered.summary).toMatchObject({ entries: 1, bytes: 14 });
      expect(recovered.summary.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(recovered.workNames).toEqual([]);
      expect(readFileSync(recovered.output, "utf8").endsWith("\n")).toBe(true);
      expect(readdirSync(join(recovered.output, ".."))).toEqual(["generated-next.jsonl"]);
    },
  );

  it("replaces an incomplete deterministic temp but never an existing mismatched final", () => {
    const staleTransaction = "inventory-stale-publication";
    const staleRun = createRun(quarantineRoot, staleTransaction);
    const source = join(repoRoot, "stale-publication.txt");
    writeFileSync(source, "complete");
    const stalePath = join(
      staleRun,
      "inventories/work",
      `${publicationId("generated-next", "pre")}.bin`,
    );
    writeFileSync(stalePath, "partial", { mode: 0o600 });
    chmodSync(stalePath, 0o600);
    const recovered = runWorker({
      operation: "one-pass",
      repoRoot,
      quarantineRoot,
      transactionId: staleTransaction,
      root: source,
    }).result as { workNames: string[] };
    expect(recovered.workNames).toEqual([]);

    const conflictTransaction = "inventory-final-conflict";
    const conflictRun = createRun(quarantineRoot, conflictTransaction);
    const finalPath = join(conflictRun, "inventories/pre/generated-next.jsonl");
    writeFileSync(finalPath, "foreign-final", { mode: 0o600 });
    chmodSync(finalPath, 0o600);
    expect(() => runWorker({
      operation: "one-pass",
      repoRoot,
      quarantineRoot,
      transactionId: conflictTransaction,
      root: source,
    })).toThrow(/conflict|published inventory/i);
    expect(readFileSync(finalPath, "utf8")).toBe("foreign-final");
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
        coordinatorReferences: 1_000_000,
      },
    }).result as { metrics: Record<string, number> };
    expect(result.metrics.sortChunkRecordLimit).toBeLessThanOrEqual(4096);
    expect(result.metrics.sortChunkByteLimit).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(result.metrics.frontierRecordLimit).toBeLessThanOrEqual(1024);
    expect(result.metrics.frontierByteLimit).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(result.metrics.mergeFanInLimit).toBeLessThanOrEqual(32);
    expect(result.metrics.coordinatorReferenceLimit).toBeLessThanOrEqual(4096);
  }, 120_000);

  it("fails closed and cleans active work at a lowered coordinator-cap seam", () => {
    const nextTransaction = "inventory-coordinator-seam";
    const nextRun = createRun(quarantineRoot, nextTransaction);
    const source = join(repoRoot, "coordinator-seam");
    privateDirectory(source);
    for (let index = 0; index < 8; index += 1) {
      writeFileSync(join(source, `file-${index}`), "x");
    }
    expect(() => runWorker({
      operation: "one-pass",
      repoRoot,
      quarantineRoot,
      transactionId: nextTransaction,
      root: source,
      limits: { sortChunkRecords: 1, coordinatorReferences: 4 },
    })).toThrow(/reference ceiling|work files/i);
    expect(readdirSync(join(nextRun, "inventories/work"))).toEqual([]);
  });

  it("hashes file bodies through createReadStream and reports handle counts", () => {
    expect(runWorker({ operation: "hash", root: join(leaf, "file-00001.txt") }).result).toEqual({
      sha256: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
      bytes: 1,
      handles: 0,
      maxHandles: 1,
    });
  });

  it("keeps the inventory public surface at exactly six exports", () => {
    expect(runWorker({ operation: "public-exports" }).result).toEqual([
      "compareInventorySummary",
      "fsyncTree",
      "hashFileStream",
      "parseInventoryRecord",
      "parseInventorySummary",
      "writeInventoryJsonl",
    ]);
  });

  it.each(["write", "fsync"])(
    "%s uses the capability-bound adapter when fsApi is omitted and ignores later source mutation",
    (writer) => {
      const nextTransaction = `inventory-bound-omit-${writer}`;
      const nextRun = createRun(quarantineRoot, nextTransaction);
      const source = writer === "write"
        ? join(repoRoot, `bound-omit-${writer}`)
        : join(nextRun, "payload/generated/.next");
      privateDirectory(source);
      writeFileSync(join(source, "file"), "bound");
      if (writer === "write") symlinkSync("file", join(source, "link"));
      const result = runWorker({
        operation: "bound-adapter-contract",
        adapterMode: "omit",
        mutateSource: true,
        writer,
        repoRoot,
        quarantineRoot,
        transactionId: nextTransaction,
        root: source,
      }).result as {
        outcome: { ok: boolean };
        before: Record<string, number>;
        after: Record<string, number>;
        outputNames: string[];
        workNames: string[];
      };
      expect(result.outcome.ok).toBe(true);
      const required = writer === "write"
        ? ["lstat", "opendir", "readlink", "open", "link", "unlink", "createReadStream"]
        : ["lstat", "opendir", "open", "unlink", "createReadStream"];
      for (const method of required) {
        expect(result.after[method]).toBeGreaterThan(result.before[method]);
      }
      expect(result.workNames).toEqual([]);
      expect(result.outputNames).toEqual(writer === "write" ? ["generated-next.jsonl"] : []);
    },
  );

  it.each([
    ["omit", true],
    ["same", false],
  ])(
    "rollback fsync accepts the %s capability adapter form",
    (adapterMode, mutateSource) => {
      const nextTransaction = `inventory-rollback-bound-${adapterMode}`;
      const nextRun = createRun(quarantineRoot, nextTransaction);
      const rollbackRoot = join(
        nextRun,
        "rollback/regenerated-before-restore",
        RESTORE_ID,
        ".next",
      );
      privateDirectory(rollbackRoot);
      writeFileSync(join(rollbackRoot, "file"), "bound");
      const result = runWorker({
        operation: "bound-adapter-contract",
        adapterMode,
        mutateSource,
        writer: "fsync",
        purpose: "rollback-entry",
        restoreId: RESTORE_ID,
        repoRoot,
        quarantineRoot,
        transactionId: nextTransaction,
      }).result as {
        outcome: { ok: boolean };
        before: Record<string, number>;
        after: Record<string, number>;
        workNames: string[];
      };
      expect(result.outcome.ok).toBe(true);
      for (const method of ["lstat", "opendir", "open", "unlink", "createReadStream"]) {
        expect(result.after[method]).toBeGreaterThan(result.before[method]);
      }
      expect(result.workNames).toEqual([]);
    },
  );

  it.each(["write", "fsync"])(
    "%s accepts only the exact capability source when fsApi is present",
    (writer) => {
      const nextTransaction = `inventory-bound-same-${writer}`;
      const nextRun = createRun(quarantineRoot, nextTransaction);
      const source = writer === "write"
        ? join(repoRoot, `bound-same-${writer}.txt`)
        : join(nextRun, "payload/generated/.next");
      if (writer === "write") writeFileSync(source, "same");
      else {
        privateDirectory(source);
        writeFileSync(join(source, "file"), "same");
      }
      const result = runWorker({
        operation: "bound-adapter-contract",
        adapterMode: "same",
        writer,
        repoRoot,
        quarantineRoot,
        transactionId: nextTransaction,
        root: source,
      }).result as { outcome: { ok: boolean }; workNames: string[] };
      expect(result.outcome.ok).toBe(true);
      expect(result.workNames).toEqual([]);
    },
  );

  it.each(["write", "fsync"])(
    "%s rejects an equal-looking distinct adapter before traversal or mutation",
    (writer) => {
      const nextTransaction = `inventory-bound-distinct-${writer}`;
      const nextRun = createRun(quarantineRoot, nextTransaction);
      const source = writer === "write"
        ? join(repoRoot, `bound-distinct-${writer}.txt`)
        : join(nextRun, "payload/generated/.next");
      if (writer === "write") writeFileSync(source, "distinct");
      else {
        privateDirectory(source);
        writeFileSync(join(source, "file"), "distinct");
      }
      const result = runWorker({
        operation: "bound-adapter-contract",
        adapterMode: "distinct",
        writer,
        repoRoot,
        quarantineRoot,
        transactionId: nextTransaction,
        root: source,
      }).result as {
        outcome: { ok: boolean; error: { message: string } };
        distinctCalls: Record<string, number>;
        outputNames: string[];
        workNames: string[];
      };
      expect(result.outcome).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/filesystem|source|context/i) },
      });
      expect(Object.values(result.distinctCalls).every((count) => count === 0)).toBe(true);
      expect(result.outputNames).toEqual([]);
      expect(result.workNames).toEqual([]);
    },
  );

  it.each(["write", "fsync"])(
    "%s rejects explicit undefined fsApi instead of treating it as omitted",
    (writer) => {
      const nextTransaction = `inventory-bound-undefined-${writer}`;
      const nextRun = createRun(quarantineRoot, nextTransaction);
      const source = writer === "write"
        ? join(repoRoot, `bound-undefined-${writer}.txt`)
        : join(nextRun, "payload/generated/.next");
      if (writer === "write") writeFileSync(source, "undefined");
      else {
        privateDirectory(source);
        writeFileSync(join(source, "file"), "undefined");
      }
      const result = runWorker({
        operation: "bound-adapter-contract",
        adapterMode: "undefined",
        writer,
        repoRoot,
        quarantineRoot,
        transactionId: nextTransaction,
        root: source,
      }).result as {
        outcome: { ok: boolean; error: { message: string } };
        outputNames: string[];
        workNames: string[];
      };
      expect(result.outcome).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/filesystem|source|context/i) },
      });
      expect(result.outputNames).toEqual([]);
      expect(result.workNames).toEqual([]);
    },
  );

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

  it("round-trips the same prefixed restore ID through capability path and inventory fsync", () => {
    const nextTransaction = "inventory-rollback-fsync";
    const nextRun = createRun(quarantineRoot, nextTransaction);
    const rollbackRoot = join(
      nextRun,
      "rollback/regenerated-before-restore",
      RESTORE_ID,
      ".next",
    );
    const nested = join(rollbackRoot, "nested");
    privateDirectory(nested);
    writeFileSync(join(nested, "file"), "rollback");
    const result = runWorker({
      operation: "fsync",
      repoRoot,
      quarantineRoot,
      transactionId: nextTransaction,
      purpose: "rollback-entry",
      restoreId: RESTORE_ID,
      entryId: "generated-next",
      root: realpathSync(rollbackRoot),
    }).result as { events: [string, string][]; metrics: Record<string, number> };
    expect(realpathSync(rollbackRoot).split("/")).toContain(RESTORE_ID);
    const synced = result.events
      .filter(([event, path]) => event === "sync" && path.startsWith(realpathSync(rollbackRoot)))
      .map(([, path]) => path);
    expect(synced).toEqual([
      join(realpathSync(nested), "file"),
      realpathSync(nested),
      realpathSync(rollbackRoot),
    ]);
    expect(result.metrics.maxOpenDirectoryHandles).toBeLessThanOrEqual(1);
    expect(result.metrics.maxTraversalAndHashHandles).toBeLessThanOrEqual(2);
  });

  it("handles a virtual 10,000-deep rollback tree within the fixed bounds", () => {
    const nextTransaction = "inventory-rollback-deep";
    const nextRun = createRun(quarantineRoot, nextTransaction);
    const rollbackRoot = join(
      realpathSync(nextRun),
      "rollback/regenerated-before-restore",
      RESTORE_ID,
      ".next",
    );
    const result = runWorker({
      operation: "deep-fsync",
      repoRoot,
      quarantineRoot,
      transactionId: nextTransaction,
      depth: 10_000,
      purpose: "rollback-entry",
      restoreId: RESTORE_ID,
      root: rollbackRoot,
    }).result as { metrics: Record<string, number>; openDirectories: number };
    expect(result.openDirectories).toBe(0);
    expect(result.metrics.maxOpenDirectoryHandles).toBeLessThanOrEqual(1);
    expect(result.metrics.maxTraversalAndHashHandles).toBeLessThanOrEqual(2);
    expect(result.metrics.maxPostorderFrames).toBeLessThanOrEqual(1024);
    expect(result.metrics.maxPostorderBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(result.metrics.postorderSpills).toBeGreaterThan(0);
  }, 120_000);

  it("rejects closed rollback fsync options before traversal or mutation", () => {
    const nextTransaction = "inventory-rollback-invalid";
    createRun(quarantineRoot, nextTransaction);
    const foreignRoot = join(fixture, "foreign-rollback-root");
    privateDirectory(foreignRoot);
    writeFileSync(join(foreignRoot, "sentinel"), "keep");
    for (const invalidCase of [
      "foreign-root",
      "unknown",
      "symbol",
      "missing-restore",
      "missing-entry",
      "bad-entry",
      "payload-restore",
      "undefined-adapter",
      "distinct-adapter",
    ]) {
      const result = runWorker({
        operation: "rollback-invalid",
        case: invalidCase,
        repoRoot,
        quarantineRoot,
        transactionId: nextTransaction,
        restoreId: RESTORE_ID,
        root: foreignRoot,
      }).result as {
        outcome: { ok: boolean; error: { message: string } };
        delta: Record<string, number>;
        distinctCalls: Record<string, number>;
      };
      expect(result.outcome).toMatchObject({
        ok: false,
        error: { message: expect.any(String) },
      });
      expect(result.delta.open).toBe(0);
      expect(result.delta.opendir).toBe(0);
      expect(result.delta.createReadStream).toBe(0);
      expect(Object.values(result.distinctCalls).every((count) => count === 0)).toBe(true);
      if (invalidCase !== "foreign-root") {
        expect(Object.values(result.delta).every((count) => count === 0)).toBe(true);
      }
    }
    expect(readFileSync(join(foreignRoot, "sentinel"), "utf8")).toBe("keep");
  });

  it("rejects a rollback-entry symlink root without touching its target", () => {
    const nextTransaction = "inventory-rollback-symlink";
    const nextRun = createRun(quarantineRoot, nextTransaction);
    const external = join(fixture, "rollback-symlink-target");
    privateDirectory(external);
    writeFileSync(join(external, "sentinel"), "keep");
    const rollbackRoot = join(
      nextRun,
      "rollback/regenerated-before-restore",
      RESTORE_ID,
      ".next",
    );
    symlinkSync(external, rollbackRoot);
    expect(() => runWorker({
      operation: "fsync",
      repoRoot,
      quarantineRoot,
      transactionId: nextTransaction,
      purpose: "rollback-entry",
      restoreId: RESTORE_ID,
      entryId: "generated-next",
      root: join(realpathSync(nextRun), "rollback/regenerated-before-restore", RESTORE_ID, ".next"),
    })).toThrow(/symlink|root/i);
    expect(readFileSync(join(external, "sentinel"), "utf8")).toBe("keep");
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
      ownedOriginalBytes: string;
    };
    expect(result.failure.errors).toEqual([
      "primary publish failure",
      expect.stringMatching(/ownership|foreign replacement/i),
    ]);
    expect(result.foreignBytes).toBe("foreign");
    expect(result.ownedBytes).toBe(result.ownedOriginalBytes);
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
      expect((result as typeof result & { streamsOpened: number }).streamsOpened).toBe(
        (result as typeof result & { streamsClosed: number }).streamsClosed,
      );
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

  it("rejects a foreign final replacement after parent sync and preserves publication evidence", () => {
    const nextTransaction = "inventory-durable-output-replacement";
    createRun(quarantineRoot, nextTransaction);
    const source = join(repoRoot, "durable-output-replacement.txt");
    writeFileSync(source, "source");
    const result = runWorker({
      operation: "durable-output-replacement",
      repoRoot,
      quarantineRoot,
      transactionId: nextTransaction,
      root: source,
    }).result as {
      failure?: { errors: string[] };
      foreignBytes: string | null;
      ownedBytes: string | null;
      workNames: string[];
    };
    expect(result.failure?.errors[0]).toMatch(/published inventory|ownership|identity/i);
    expect(result.foreignBytes).toBe("foreign-durable");
    expect(result.ownedBytes).toContain('"type":"file"');
    expect(result.workNames).toEqual([`${publicationId("generated-next", "pre")}.bin`]);
  });

  it.each(["chmod", "lstat"])(
    "removes an early-owned work file after %s setup failure so retry is clean",
    (failureCase) => {
      const nextTransaction = `inventory-work-${failureCase}`;
      createRun(quarantineRoot, nextTransaction);
      const source = join(repoRoot, `work-${failureCase}.txt`);
      writeFileSync(source, "work");
      const result = runWorker({
        operation: "work-setup-fault",
        case: failureCase,
        repoRoot,
        quarantineRoot,
        transactionId: nextTransaction,
        root: source,
      }).result as {
        failure: { message: string };
        retry: { entries: number };
        workNames: string[];
      };
      expect(result.failure.message).toMatch(new RegExp(failureCase, "i"));
      expect(result.retry.entries).toBe(1);
      expect(result.workNames).toEqual([]);
    },
  );

  it("retries the first handle stat while open before any setup mutation", () => {
    const nextTransaction = "inventory-work-stat-transient";
    createRun(quarantineRoot, nextTransaction);
    const source = join(repoRoot, "work-stat-transient.txt");
    writeFileSync(source, "work");
    const result = runWorker({
      operation: "work-setup-fault",
      case: "stat-transient",
      repoRoot,
      quarantineRoot,
      transactionId: nextTransaction,
      root: source,
    }).result as { failure?: unknown; workNames: string[] };
    expect(result.failure).toBeUndefined();
    expect(result.workNames).toEqual([]);
  });

  it("preserves evidence when an exclusive handle identity cannot be established", () => {
    const nextTransaction = "inventory-work-stat-permanent";
    createRun(quarantineRoot, nextTransaction);
    const source = join(repoRoot, "work-stat-permanent.txt");
    writeFileSync(source, "work");
    const result = runWorker({
      operation: "work-setup-fault",
      case: "stat-permanent",
      repoRoot,
      quarantineRoot,
      transactionId: nextTransaction,
      root: source,
    }).result as { failure: { message: string; errors: string[] }; workNames: string[] };
    expect(result.failure.message).toMatch(/identity|stat/i);
    expect(result.workNames).toHaveLength(1);
  });
});
