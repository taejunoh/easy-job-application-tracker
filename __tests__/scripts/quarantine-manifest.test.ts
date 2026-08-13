import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const manifestModuleUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-manifest.mjs"),
).href;
const capabilityModuleUrl = pathToFileURL(
  join(__dirname, "../../scripts/quarantine-run-capability.mjs"),
).href;

const hash = (character: string) => character.repeat(64);
const inventory = (sha256: string, entries: number, bytes: number) => ({
  sha256,
  entries,
  bytes,
});

const validManifest = {
  schemaVersion: 1,
  transactionId: "tx-0001",
  state: "VALIDATED",
  repositoryRoot: "/repository",
  head: "1".repeat(40),
  createdAt: "2026-07-15T10:00:00.000Z",
  validatedAt: "2026-07-15T12:00:00.000Z",
  retentionDays: 4,
  deletionRequiresConfirmation: true,
  deleteAfter: "2026-07-19T12:00:00.000Z",
  deletionStatus: "retained",
  entries: [
    {
      id: "generated-next",
      kind: "generated-root",
      relativePath: ".next",
      mode: 0o755,
      preMoveInventory: inventory(hash("a"), 2, 20),
    },
    {
      id: "generated-node-modules",
      kind: "generated-root",
      relativePath: "node_modules",
      mode: 0o755,
      preMoveInventory: inventory(hash("b"), 3, 30),
    },
    {
      id: "copy-0001",
      kind: "source-copy",
      relativePath: "src/a 2.ts",
      canonicalRelativePath: "src/a.ts",
      mode: 0o644,
      size: 5,
      sha256: hash("c"),
      canonicalSize: 5,
      canonicalSha256: hash("c"),
      classification: "identical",
      historyMatch: null,
      preMoveInventory: inventory(hash("d"), 1, 5),
    },
    {
      id: "copy-0002",
      kind: "source-copy",
      relativePath: "src/z 2.ts",
      canonicalRelativePath: "src/z.ts",
      mode: 0o600,
      size: 7,
      sha256: hash("e"),
      canonicalSize: 9,
      canonicalSha256: hash("f"),
      classification: "divergent",
      historyMatch: "2".repeat(40),
      preMoveInventory: inventory(hash("0"), 1, 7),
    },
  ],
};
const preparedManifest = {
  ...validManifest,
  state: "PREPARED",
  validatedAt: null,
  retentionDays: 4,
  deleteAfter: null,
  deletionStatus: "retained",
};
const emptySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const validationAttempt = "attempt-123e4567-e89b-42d3-a456-426614174000";
const regeneratedEvidence = {
  "generated-next": {
    pass1Path: `inventories/validation-pass-1/${validationAttempt}-generated-next.jsonl`,
    pass1Summary: inventory(hash("7"), 3, 31),
    pass2Path: `inventories/validation-pass-2/${validationAttempt}-generated-next.jsonl`,
    pass2Summary: inventory(hash("7"), 3, 31),
  },
  "generated-node-modules": {
    pass1Path: `inventories/validation-pass-1/${validationAttempt}-generated-node-modules.jsonl`,
    pass1Summary: inventory(hash("8"), 4, 41),
    pass2Path: `inventories/validation-pass-2/${validationAttempt}-generated-node-modules.jsonl`,
    pass2Summary: inventory(hash("8"), 4, 41),
  },
};
const validManifestV2 = {
  ...validManifest,
  schemaVersion: 2,
  branch: "slice-one",
  repositoryIdentity: { dev: 100, ino: 200 },
  validationAttempt,
  regeneratedEvidence,
  entries: [
    ...validManifest.entries.slice(0, 2),
    {
      id: "temp-0001",
      kind: "temp-residue",
      relativePath: "src/.BC.T_aB09Zx",
      mode: 0o600,
      size: 0,
      sha256: emptySha256,
      preMoveInventory: inventory(emptySha256, 1, 0),
    },
    ...validManifest.entries.slice(2),
  ],
};
const preparedManifestV2 = {
  ...validManifestV2,
  state: "PREPARED",
  validatedAt: null,
  deleteAfter: null,
  validationAttempt: null,
  regeneratedEvidence: null,
};

type Outcome =
  | { ok: true; value: unknown }
  | { ok: false; error: { name: string; message: string; errors?: string[] } };

const workerSource = `
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, realpathSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { dirname, join } from "node:path";
import * as manifestApi from ${JSON.stringify(manifestModuleUrl)};
import { deriveRunPath, withQuarantineRunCapability } from ${JSON.stringify(capabilityModuleUrl)};

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const capture = async (callback) => {
  try {
    return { ok: true, value: await callback() };
  } catch (error) {
    return {
      ok: false,
      error: {
        name: error?.name ?? typeof error,
        message: error?.message ?? String(error),
        errors: error instanceof AggregateError
          ? error.errors.map((entry) => entry?.message ?? String(entry))
          : undefined,
      },
    };
  }
};
const appendedResult = (payload) => ({ status: "appended", manifestSha256: payload.manifestSha256 });
const temporaryIdForDigest = (digest) =>
  digest.slice(0, 8) + "-" +
  digest.slice(8, 12) + "-4" + digest.slice(13, 16) +
  "-8" + digest.slice(17, 20) + "-" + digest.slice(20, 32);
const root = request.root;
const repoRoot = join(root, "repo");
const quarantineRoot = join(root, "quarantine");
const transactionId = "tx-0001";
const runRoot = join(quarantineRoot, transactionId);
const manifestsRoot = join(runRoot, "manifests");
await fsPromises.mkdir(repoRoot, { recursive: true });
await fsPromises.mkdir(manifestsRoot, { recursive: true, mode: 0o700 });
await fsPromises.chmod(quarantineRoot, 0o700);
await fsPromises.chmod(runRoot, 0o700);
await fsPromises.chmod(manifestsRoot, 0o700);
const baseFsApi = { ...fsPromises, createReadStream, lstatSync, realpathSync };
const adapterEvents = [];
const adapterState = {
  failLink: false,
  failTemporaryUnlink: false,
  temporaryTarget: null,
  chmodBoundary: null,
  staleSwapPath: null,
  staleSwapLstats: 0,
  durableSwap: null,
  readSwap: null,
};
const fsApi = {
  ...baseFsApi,
  async lstat(path) {
    if (path === adapterState.staleSwapPath) {
      adapterState.staleSwapLstats += 1;
      if (adapterState.staleSwapLstats === 2) {
        await baseFsApi.rename(path, path + ".owned");
        await baseFsApi.writeFile(path, "foreign", { mode: 0o600 });
        await baseFsApi.chmod(path, 0o600);
      }
    }
    return baseFsApi.lstat(path);
  },
  async open(path, flags, mode) {
    if (request.operation === "activation-order" && path.includes("/.current.")) {
      adapterEvents.push("pointer-temp-open");
    }
    const handle = await baseFsApi.open(path, flags, mode);
    if (
      flags === "r" &&
      adapterState.durableSwap !== null &&
      path === adapterState.durableSwap.directory &&
      !adapterState.durableSwap.complete
    ) {
      return new Proxy(handle, {
        get(target, property) {
          if (property === "sync") return async () => {
            await target.sync();
            if (adapterState.durableSwap.complete) return;
            adapterState.durableSwap.complete = true;
            const original = await baseFsApi.readFile(adapterState.durableSwap.path);
            await baseFsApi.rename(
              adapterState.durableSwap.path,
              adapterState.durableSwap.path + ".owned",
            );
            await baseFsApi.writeFile(
              adapterState.durableSwap.path,
              adapterState.durableSwap.foreign ? "foreign" : original,
              { mode: 0o600 },
            );
            await baseFsApi.chmod(adapterState.durableSwap.path, 0o600);
          };
          const member = Reflect.get(target, property, target);
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
    }
    if (
      flags === "r" &&
      adapterState.readSwap !== null &&
      path === adapterState.readSwap.path &&
      !adapterState.readSwap.complete
    ) {
      return new Proxy(handle, {
        get(target, property) {
          if (property === "read") return async (...args) => {
            const result = await target.read(...args);
            if (result.bytesRead === 0 || adapterState.readSwap.complete) return result;
            adapterState.readSwap.complete = true;
            if (adapterState.readSwap.replacement === "mode") {
              await baseFsApi.chmod(path, 0o644);
              return result;
            }
            const original = await baseFsApi.readFile(path);
            await baseFsApi.rename(path, path + ".owned");
            await baseFsApi.writeFile(
              path,
              adapterState.readSwap.replacement === "foreign" ? "foreign" : original,
              { mode: 0o600 },
            );
            await baseFsApi.chmod(path, 0o600);
            return result;
          };
          const member = Reflect.get(target, property, target);
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
    }
    if (
      request.operation === "reader-handle-mismatch" &&
      path === join(realpathSync(quarantineRoot), "current")
    ) {
      return new Proxy(handle, {
        get(target, property) {
          if (property === "stat") return async () => {
            const stat = await target.stat();
            return new Proxy(stat, {
              get(current, key) {
                if (key === "ino") return Number(current.ino) + 1;
                const member = Reflect.get(current, key, current);
                return typeof member === "function" ? member.bind(current) : member;
              },
            });
          };
          const member = Reflect.get(target, property, target);
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
    }
    const isSelectedTemporary =
      flags === "wx" &&
      ((adapterState.temporaryTarget === "generation" && path.includes("/manifests/.")) ||
        (adapterState.temporaryTarget === "pointer" && path.includes("/.current.")));
    if (!isSelectedTemporary || adapterState.chmodBoundary === null) return handle;
    return new Proxy(handle, {
      get(target, property) {
        if (property === "chmod") return async (requestedMode) => {
          if (adapterState.chmodBoundary === "before") {
            throw new Error("chmod:before");
          }
          await target.chmod(requestedMode);
          if (adapterState.chmodBoundary === "foreign-after") {
            await baseFsApi.rename(path, path + ".owned");
            await baseFsApi.writeFile(path, "foreign", { mode: 0o600 });
            await baseFsApi.chmod(path, 0o600);
            throw new Error("chmod:foreign-after");
          }
          throw new Error("chmod:after");
        };
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  },
  async link(source, destination) {
    if (adapterState.failLink) throw new Error("primary publish failure");
    return baseFsApi.link(source, destination);
  },
  async unlink(path) {
    if (adapterState.failTemporaryUnlink && path.endsWith(".tmp")) {
      throw new Error("cleanup failure");
    }
    return baseFsApi.unlink(path);
  },
};
const withCapability = (callback, adapter = fsApi) => withQuarantineRunCapability({
  repoRoot,
  quarantineRoot,
  transactionId,
  writersStopped: true,
  fsApi: adapter,
}, callback);
const validationMarker = join(root, "validated-marker.json");
const ensureValidatedDurably = async (payload) => {
  try {
    const existing = JSON.parse(await fsPromises.readFile(validationMarker, "utf8"));
    return { status: "already-present", manifestSha256: existing.manifestSha256 };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const handle = await fsPromises.open(validationMarker, "wx", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify(payload) + "\\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const rootHandle = await fsPromises.open(root, "r");
  try {
    await rootHandle.sync();
  } finally {
    await rootHandle.close();
  }
  return appendedResult(payload);
};

const result = await (async () => {
  if (request.operation === "builder") {
    return capture(() => manifestApi.buildValidatedManifest(request.value));
  }
  if (request.operation === "builder-snapshot") {
    const counts = Object.create(null);
    const makeSnapshotProxy = (value, label) => new Proxy(value, {
      get(target, property, receiver) {
        if (typeof property === "string" && Object.hasOwn(target, property)) {
          const key = label + "." + property;
          counts[key] = (counts[key] ?? 0) + 1;
          if (counts[key] > 1) throw new Error("getter read twice: " + key);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const entries = request.value.entries.map((entry, index) =>
      makeSnapshotProxy(entry, "entry" + index));
    const top = makeSnapshotProxy({ ...request.value, entries }, "manifest");
    const outcome = await capture(() => manifestApi.buildValidatedManifest(top));
    return { outcome, counts };
  }
  return withCapability(async (capability) => {
    if (request.operation === "round-trip") {
      const built = manifestApi.buildValidatedManifest(request.value);
      const written = await manifestApi.writeManifestGeneration({
        capability,
        manifest: built,
        fsApi,
      });
      const order = [];
      await manifestApi.activateManifestGeneration({
        capability,
        transactionId,
        manifestSha256: written.manifestSha256,
        appendValidated: async (payload) => {
          order.push({ event: "append", payload });
          const bytes = await fsPromises.readFile(deriveRunPath(capability, {
            purpose: "manifest-generation",
            id: written.manifestSha256,
          }));
          order.push({ event: "generation-present", bytes: bytes.length });
          return appendedResult(payload);
        },
        fsApi,
      });
      const pointer = await manifestApi.readCurrentManifestPointer({ capability, fsApi });
      const generation = await manifestApi.readManifestGeneration({
        capability,
        manifestSha256: pointer.manifestSha256,
        fsApi,
      });
      return {
        built,
        written,
        pointer,
        generation,
        order,
        names: (await fsPromises.readdir(manifestsRoot)).sort(),
        rootNames: (await fsPromises.readdir(quarantineRoot)).sort(),
      };
    }
    if (request.operation === "generation-only") {
      const built = manifestApi.buildValidatedManifest(request.value);
      const written = await manifestApi.writeManifestGeneration({
        capability,
        manifest: built,
        fsApi,
      });
      const generation = await manifestApi.readManifestGeneration({
        capability,
        manifestSha256: written.manifestSha256,
        fsApi,
      });
      return {
        written,
        generation,
        preparedJournalRecord: {
          event: "PREPARED",
          payload: { transactionId: built.transactionId, manifestSha256: written.manifestSha256 },
        },
      };
    }
    if (request.operation === "activate-prepared") {
      const built = manifestApi.buildValidatedManifest(request.value);
      const written = await manifestApi.writeManifestGeneration({
        capability,
        manifest: built,
        fsApi,
      });
      let ensureCalls = 0;
      const outcome = await capture(() => manifestApi.activateManifestGeneration({
        capability,
        transactionId,
        manifestSha256: written.manifestSha256,
        appendValidated: async (payload) => {
          ensureCalls += 1;
          return appendedResult(payload);
        },
        fsApi,
      }));
      return {
        outcome,
        ensureCalls,
        currentExists: await fsPromises.access(join(quarantineRoot, "current"))
          .then(() => true, () => false),
      };
    }
    if (request.operation === "read-pointer-bytes") {
      const path = deriveRunPath(capability, { purpose: "current-pointer" });
      await fsPromises.writeFile(path, Buffer.from(request.bytes, "base64"), { mode: 0o600 });
      await fsPromises.chmod(path, 0o600);
      return capture(() => manifestApi.readCurrentManifestPointer({
        capability,
        fsApi,
        maxBytes: request.maxBytes,
      }));
    }
    if (request.operation === "read-generation-bytes") {
      const path = deriveRunPath(capability, {
        purpose: "manifest-generation",
        id: request.digest,
      });
      await fsPromises.writeFile(path, Buffer.from(request.bytes, "base64"), { mode: 0o600 });
      await fsPromises.chmod(path, 0o600);
      return capture(() => manifestApi.readManifestGeneration({
        capability,
        manifestSha256: request.digest,
        fsApi,
        maxBytes: request.maxBytes,
      }));
    }
    if (request.operation === "existing-conflict") {
      const built = manifestApi.buildValidatedManifest(request.value);
      const bytes = Buffer.from(JSON.stringify(built) + "\\n");
      const digest = createHash("sha256").update(bytes).digest("hex");
      const path = deriveRunPath(capability, { purpose: "manifest-generation", id: digest });
      const prior = Buffer.from("foreign bytes");
      await fsPromises.writeFile(path, prior, { mode: 0o600 });
      const outcome = await capture(() => manifestApi.writeManifestGeneration({
        capability,
        manifest: built,
        fsApi,
      }));
      return { outcome, unchanged: (await fsPromises.readFile(path)).equals(prior) };
    }
    if (request.operation === "existing-public-mode") {
      const built = manifestApi.buildValidatedManifest(request.value);
      const prior = Buffer.from(JSON.stringify(built) + "\\n");
      const digest = createHash("sha256").update(prior).digest("hex");
      const path = deriveRunPath(capability, { purpose: "manifest-generation", id: digest });
      const requestedMode = request.mode ?? 0o644;
      await fsPromises.writeFile(path, prior, { mode: requestedMode });
      await fsPromises.chmod(path, requestedMode);
      const outcome = await capture(() => manifestApi.writeManifestGeneration({
        capability,
        manifest: built,
        fsApi,
      }));
      const after = await fsPromises.lstat(path);
      return {
        outcome,
        mode: after.mode & 0o7777,
        unchanged: (await fsPromises.readFile(path)).equals(prior),
      };
    }
    if (request.operation === "public-mode-readers") {
      const built = manifestApi.buildValidatedManifest(request.value);
      const written = await manifestApi.writeManifestGeneration({
        capability,
        manifest: built,
        fsApi,
      });
      await manifestApi.activateManifestGeneration({
        capability,
        transactionId,
        manifestSha256: written.manifestSha256,
        appendValidated: async (payload) => appendedResult(payload),
        fsApi,
      });
      const generationPath = deriveRunPath(capability, {
        purpose: "manifest-generation",
        id: written.manifestSha256,
      });
      const currentPath = deriveRunPath(capability, { purpose: "current-pointer" });
      const requestedMode = request.mode ?? 0o644;
      await fsPromises.chmod(generationPath, requestedMode);
      await fsPromises.chmod(currentPath, requestedMode);
      return {
        generation: await capture(() => manifestApi.readManifestGeneration({
          capability,
          manifestSha256: written.manifestSha256,
          fsApi,
        })),
        pointer: await capture(() => manifestApi.readCurrentManifestPointer({
          capability,
          fsApi,
        })),
        generationMode: (await fsPromises.lstat(generationPath)).mode & 0o7777,
        pointerMode: (await fsPromises.lstat(currentPath)).mode & 0o7777,
      };
    }
    if (request.operation === "mismatched-transaction") {
      return capture(() => manifestApi.writeManifestGeneration({
        capability,
        manifest: manifestApi.buildValidatedManifest(request.value),
        fsApi,
      }));
    }
    if (request.operation === "restrictive-umask-roundtrip") {
      let written;
      const previousUmask = process.umask(0o777);
      const outcome = await capture(async () => {
        try {
          written = await manifestApi.writeManifestGeneration({
            capability,
            manifest: manifestApi.buildValidatedManifest(request.value),
            fsApi,
          });
          await manifestApi.activateManifestGeneration({
            capability,
            transactionId,
            manifestSha256: written.manifestSha256,
            appendValidated: async (payload) => appendedResult(payload),
            fsApi,
          });
        } finally {
          process.umask(previousUmask);
        }
      });
      const manifestNames = (await fsPromises.readdir(manifestsRoot)).sort();
      const rootNames = (await fsPromises.readdir(quarantineRoot)).sort();
      return {
        outcome,
        generationMode: written === undefined
          ? null
          : (await fsPromises.lstat(join(manifestsRoot, written.manifestSha256 + ".json"))).mode & 0o7777,
        pointerMode: rootNames.includes("current")
          ? (await fsPromises.lstat(join(quarantineRoot, "current"))).mode & 0o7777
          : null,
        temporaryNames: [
          ...manifestNames.filter((name) => name.startsWith(".")),
          ...rootNames.filter((name) => name.startsWith(".current.")),
        ],
      };
    }
    if (request.operation === "sigkill-crash") {
      const oldBuilt = manifestApi.buildValidatedManifest(request.oldValue);
      const oldWritten = await manifestApi.writeManifestGeneration({
        capability, manifest: oldBuilt, fsApi,
      });
      await manifestApi.activateManifestGeneration({
        capability,
        transactionId,
        manifestSha256: oldWritten.manifestSha256,
        appendValidated: async (payload) => appendedResult(payload),
        fsApi,
      });
      const nextBuilt = manifestApi.buildValidatedManifest(request.newValue);
      const killAtBoundary = async (phase) => {
        if (phase === request.phase) process.kill(process.pid, "SIGKILL");
      };
      if (request.phase.startsWith("after-generation")) {
        await manifestApi.writeManifestGeneration({
          capability,
          manifest: nextBuilt,
          fsApi,
          faultHook: killAtBoundary,
        });
      } else {
        const nextWritten = await manifestApi.writeManifestGeneration({
          capability, manifest: nextBuilt, fsApi,
        });
        await manifestApi.activateManifestGeneration({
          capability,
          transactionId,
          manifestSha256: nextWritten.manifestSha256,
          appendValidated: ensureValidatedDurably,
          fsApi,
          faultHook: killAtBoundary,
        });
      }
      throw new Error("SIGKILL boundary was not reached");
    }
    if (request.operation === "sigkill-inspect-retry") {
      const oldBuilt = manifestApi.buildValidatedManifest(request.oldValue);
      const nextBuilt = manifestApi.buildValidatedManifest(request.newValue);
      const oldBytes = Buffer.from(JSON.stringify(oldBuilt) + "\\n");
      const nextBytes = Buffer.from(JSON.stringify(nextBuilt) + "\\n");
      const oldDigest = createHash("sha256").update(oldBytes).digest("hex");
      const nextDigest = createHash("sha256").update(nextBytes).digest("hex");
      const beforePointer = await manifestApi.readCurrentManifestPointer({ capability, fsApi });
      const beforeSelected = await manifestApi.readManifestGeneration({
        capability,
        manifestSha256: beforePointer.manifestSha256,
        fsApi,
      });
      const oldReadable = await manifestApi.readManifestGeneration({
        capability,
        manifestSha256: oldDigest,
        fsApi,
      });
      const nextWritten = await manifestApi.writeManifestGeneration({
        capability, manifest: nextBuilt, fsApi,
      });
      const retryEnsure = await manifestApi.activateManifestGeneration({
        capability,
        transactionId,
        manifestSha256: nextWritten.manifestSha256,
        appendValidated: async (payload) => {
          const result = await ensureValidatedDurably(payload);
          adapterEvents.push(result.status);
          return result;
        },
        fsApi,
      });
      const afterPointer = await manifestApi.readCurrentManifestPointer({ capability, fsApi });
      return {
        beforePointer,
        beforeSelectedState: beforeSelected.state,
        oldReadableState: oldReadable.state,
        oldDigest,
        nextDigest,
        retryEnsure,
        retryEnsureStatus: adapterEvents.at(-1),
        afterPointer,
        manifestTemps: (await fsPromises.readdir(manifestsRoot))
          .filter((name) => name.startsWith(".")),
        pointerTemps: (await fsPromises.readdir(quarantineRoot))
          .filter((name) => name.startsWith(".current.")),
      };
    }
    if (request.operation === "temporary-chmod-failure") {
      const built = manifestApi.buildValidatedManifest(request.value);
      let written;
      if (request.target === "pointer") {
        written = await manifestApi.writeManifestGeneration({
          capability,
          manifest: built,
          fsApi,
        });
      }
      adapterState.temporaryTarget = request.target;
      adapterState.chmodBoundary = request.boundary;
      const previousUmask = process.umask(0o777);
      let outcome;
      try {
        outcome = await capture(() => request.target === "generation"
          ? manifestApi.writeManifestGeneration({ capability, manifest: built, fsApi })
          : manifestApi.activateManifestGeneration({
              capability,
              transactionId,
              manifestSha256: written.manifestSha256,
              appendValidated: async (payload) => appendedResult(payload),
              fsApi,
            }));
      } finally {
        process.umask(previousUmask);
        adapterState.temporaryTarget = null;
        adapterState.chmodBoundary = null;
      }
      const parent = request.target === "generation" ? manifestsRoot : quarantineRoot;
      const prefix = request.target === "generation" ? "." : ".current.";
      const names = (await fsPromises.readdir(parent)).filter((name) => name.startsWith(prefix)).sort();
      const foreignName = names.some((name) => name.endsWith(".owned"))
        ? names.find((name) => name.endsWith(".tmp"))
        : undefined;
      return {
        outcome,
        temporaryNames: names,
        foreignBytes: foreignName === undefined
          ? null
          : await fsPromises.readFile(join(parent, foreignName), "utf8"),
      };
    }
    if (request.operation === "fault-matrix") {
      const oldManifest = manifestApi.buildValidatedManifest(request.oldValue);
      const oldWritten = await manifestApi.writeManifestGeneration({
        capability, manifest: oldManifest, fsApi,
      });
      await manifestApi.activateManifestGeneration({
        capability,
        transactionId,
        manifestSha256: oldWritten.manifestSha256,
        appendValidated: async (payload) => appendedResult(payload),
        fsApi,
      });
      const nextManifest = manifestApi.buildValidatedManifest(request.newValue);
      let nextWritten;
      let operationOutcome;
      const crash = async (phase) => {
        if (phase === request.phase) throw new Error("crash:" + phase);
      };
      if (request.phase.startsWith("after-generation")) {
        operationOutcome = await capture(async () => {
          nextWritten = await manifestApi.writeManifestGeneration({
            capability, manifest: nextManifest, fsApi, faultHook: crash,
          });
        });
      } else {
        nextWritten = await manifestApi.writeManifestGeneration({
          capability, manifest: nextManifest, fsApi,
        });
        operationOutcome = await capture(() => manifestApi.activateManifestGeneration({
          capability,
          transactionId,
          manifestSha256: nextWritten.manifestSha256,
          appendValidated: async (payload) => appendedResult(payload),
          fsApi,
          faultHook: crash,
        }));
      }
      const pointer = await manifestApi.readCurrentManifestPointer({ capability, fsApi });
      const selected = await manifestApi.readManifestGeneration({
        capability, manifestSha256: pointer.manifestSha256, fsApi,
      });
      const oldReadable = await manifestApi.readManifestGeneration({
        capability, manifestSha256: oldWritten.manifestSha256, fsApi,
      });
      return {
        operationOutcome,
        pointer,
        selectedTransactionId: selected.transactionId,
        oldReadable: oldReadable.transactionId,
        oldDigest: oldWritten.manifestSha256,
        nextDigest: nextWritten?.manifestSha256 ?? null,
      };
    }
    if (request.operation === "activation-order") {
      const built = manifestApi.buildValidatedManifest(request.value);
      const written = await manifestApi.writeManifestGeneration({
        capability, manifest: built, fsApi,
      });
      await manifestApi.activateManifestGeneration({
        capability,
        transactionId,
        manifestSha256: written.manifestSha256,
        appendValidated: async (payload) => {
          adapterEvents.push(["append", payload]);
          return appendedResult(payload);
        },
        fsApi,
      });
      return adapterEvents;
    }
    if (request.operation === "activation-retry") {
      const oldBuilt = manifestApi.buildValidatedManifest(request.oldValue);
      const oldWritten = await manifestApi.writeManifestGeneration({
        capability, manifest: oldBuilt, fsApi,
      });
      await manifestApi.activateManifestGeneration({
        capability,
        transactionId,
        manifestSha256: oldWritten.manifestSha256,
        appendValidated: async (payload) => appendedResult(payload),
        fsApi,
      });
      const nextBuilt = manifestApi.buildValidatedManifest(request.newValue);
      const nextWritten = await manifestApi.writeManifestGeneration({
        capability, manifest: nextBuilt, fsApi,
      });
      let ensuredDigest = null;
      let appended = 0;
      let calls = 0;
      const ensureValidated = async (payload) => {
        calls += 1;
        if (ensuredDigest === null) {
          ensuredDigest = payload.manifestSha256;
          appended += 1;
          return appendedResult(payload);
        }
        return { status: "already-present", manifestSha256: ensuredDigest };
      };
      const first = await capture(() => manifestApi.activateManifestGeneration({
        capability,
        transactionId,
        manifestSha256: nextWritten.manifestSha256,
        appendValidated: ensureValidated,
        fsApi,
        faultHook: async (phase) => {
          if (phase === request.phase) throw new Error("crash:" + phase);
        },
      }));
      const second = await capture(() => manifestApi.activateManifestGeneration({
        capability,
        transactionId,
        manifestSha256: nextWritten.manifestSha256,
        appendValidated: ensureValidated,
        fsApi,
      }));
      const pointer = await manifestApi.readCurrentManifestPointer({ capability, fsApi });
      return {
        first,
        second,
        pointer,
        expectedDigest: nextWritten.manifestSha256,
        calls,
        appended,
      };
    }
    if (request.operation === "activation-invalid-result") {
      const oldBuilt = manifestApi.buildValidatedManifest(request.oldValue);
      const oldWritten = await manifestApi.writeManifestGeneration({
        capability, manifest: oldBuilt, fsApi,
      });
      await manifestApi.activateManifestGeneration({
        capability,
        transactionId,
        manifestSha256: oldWritten.manifestSha256,
        appendValidated: async (payload) => appendedResult(payload),
        fsApi,
      });
      const nextBuilt = manifestApi.buildValidatedManifest(request.newValue);
      const nextWritten = await manifestApi.writeManifestGeneration({
        capability, manifest: nextBuilt, fsApi,
      });
      const callbackResult = {
        ...request.result,
        manifestSha256: request.result.manifestSha256 === "expected"
          ? nextWritten.manifestSha256
          : request.result.manifestSha256,
      };
      const outcome = await capture(() => manifestApi.activateManifestGeneration({
        capability,
        transactionId,
        manifestSha256: nextWritten.manifestSha256,
        appendValidated: async () => callbackResult,
        fsApi,
      }));
      const pointer = await manifestApi.readCurrentManifestPointer({ capability, fsApi });
      return {
        outcome,
        pointer,
        oldDigest: oldWritten.manifestSha256,
        nextDigest: nextWritten.manifestSha256,
      };
    }
    if (request.operation === "stale-temporary") {
      const built = manifestApi.buildValidatedManifest(request.value);
      const manifestBytes = Buffer.from(JSON.stringify(built) + "\\n");
      const digest = createHash("sha256").update(manifestBytes).digest("hex");
      let temporaryPath;
      let expectedBytes;
      if (request.target === "generation") {
        temporaryPath = deriveRunPath(capability, {
          purpose: "manifest-temporary",
          id: temporaryIdForDigest(digest),
        });
        expectedBytes = manifestBytes;
      } else {
        await manifestApi.writeManifestGeneration({ capability, manifest: built, fsApi });
        temporaryPath = deriveRunPath(capability, {
          purpose: "current-temporary",
          id: temporaryIdForDigest(digest),
        });
        expectedBytes = Buffer.from(JSON.stringify({
          schemaVersion: 1,
          transactionId,
          manifestSha256: digest,
        }) + "\\n");
      }
      const sentinel = join(root, "stale-sentinel");
      if (request.case === "symlink") {
        await fsPromises.writeFile(sentinel, "sentinel", { mode: 0o600 });
        await fsPromises.symlink(sentinel, temporaryPath);
      } else {
        const staleBytes = request.case === "mismatch" ? Buffer.from("foreign") : expectedBytes;
        await fsPromises.writeFile(temporaryPath, staleBytes, { mode: 0o600 });
        await fsPromises.chmod(temporaryPath, request.case === "public-mode" ? 0o644 : 0o600);
      }
      const before = request.case === "symlink"
        ? null
        : await fsPromises.readFile(temporaryPath);
      if (request.case === "swap") adapterState.staleSwapPath = temporaryPath;
      const outcome = await capture(() => request.target === "generation"
        ? manifestApi.writeManifestGeneration({ capability, manifest: built, fsApi })
        : manifestApi.activateManifestGeneration({
            capability,
            transactionId,
            manifestSha256: digest,
            appendValidated: async (payload) => appendedResult(payload),
            fsApi,
          }));
      adapterState.staleSwapPath = null;
      let afterKind = "missing";
      let unchanged = null;
      try {
        const after = await fsPromises.lstat(temporaryPath);
        afterKind = after.isSymbolicLink() ? "symlink" : "file";
        if (before !== null && after.isFile()) {
          unchanged = (await fsPromises.readFile(temporaryPath)).equals(before);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      return {
        outcome,
        afterKind,
        unchanged,
        afterBytes: afterKind === "file"
          ? await fsPromises.readFile(temporaryPath, "utf8")
          : null,
        ownedPresent: await fsPromises.access(temporaryPath + ".owned")
          .then(() => true, () => false),
        sentinel: request.case === "symlink"
          ? await fsPromises.readFile(sentinel, "utf8")
          : null,
      };
    }
    if (request.operation === "cleanup-aggregate") {
      const oldBuilt = manifestApi.buildValidatedManifest(request.oldValue);
      const oldWritten = await manifestApi.writeManifestGeneration({
        capability, manifest: oldBuilt, fsApi,
      });
      await manifestApi.activateManifestGeneration({
        capability,
        transactionId,
        manifestSha256: oldWritten.manifestSha256,
        appendValidated: async (payload) => appendedResult(payload),
        fsApi,
      });
      const pointerBefore = await fsPromises.readFile(join(quarantineRoot, "current"));
      const generationBefore = await fsPromises.readFile(join(
        manifestsRoot, oldWritten.manifestSha256 + ".json"));
      adapterState.failLink = true;
      adapterState.failTemporaryUnlink = true;
      const outcome = await capture(() => manifestApi.writeManifestGeneration({
        capability,
        manifest: manifestApi.buildValidatedManifest(request.newValue),
        fsApi,
      }));
      return {
        outcome,
        pointerUnchanged: (await fsPromises.readFile(join(quarantineRoot, "current"))).equals(pointerBefore),
        generationUnchanged: (await fsPromises.readFile(join(
          manifestsRoot, oldWritten.manifestSha256 + ".json"))).equals(generationBefore),
      };
    }
    if (request.operation === "replace-parent") {
      const external = join(root, "external");
      const sentinel = join(external, "sentinel");
      await fsPromises.mkdir(external, { mode: 0o700 });
      await fsPromises.writeFile(sentinel, "keep");
      await fsPromises.rename(manifestsRoot, manifestsRoot + ".original");
      await fsPromises.symlink(external, manifestsRoot);
      const outcome = await capture(() => manifestApi.writeManifestGeneration({
        capability,
        manifest: manifestApi.buildValidatedManifest(request.value),
        fsApi,
      }));
      return {
        outcome,
        sentinel: await fsPromises.readFile(sentinel, "utf8"),
        externalNames: (await fsPromises.readdir(external)).sort(),
      };
    }
    if (request.operation === "replace-root") {
      const external = join(root, "external-root");
      const sentinel = join(external, "sentinel");
      await fsPromises.mkdir(external, { mode: 0o700 });
      await fsPromises.writeFile(sentinel, "keep");
      await fsPromises.rename(quarantineRoot, quarantineRoot + ".original");
      await fsPromises.symlink(external, quarantineRoot);
      const outcome = await capture(() => manifestApi.writeManifestGeneration({
        capability,
        manifest: manifestApi.buildValidatedManifest(request.value),
        fsApi,
      }));
      return {
        outcome,
        sentinel: await fsPromises.readFile(sentinel, "utf8"),
        externalNames: (await fsPromises.readdir(external)).sort(),
      };
    }
    if (request.operation === "adapter-contract") {
      const built = manifestApi.buildValidatedManifest(request.value);
      const written = await manifestApi.writeManifestGeneration({
        capability,
        manifest: built,
        fsApi,
      });
      await manifestApi.activateManifestGeneration({
        capability,
        transactionId,
        manifestSha256: written.manifestSha256,
        appendValidated: async (payload) => appendedResult(payload),
        fsApi,
      });
      let distinctIo = 0;
      const distinctFs = Object.fromEntries(
        Object.entries(baseFsApi).map(([name, implementation]) => [name, (...args) => {
          distinctIo += 1;
          return implementation(...args);
        }]),
      );
      const calls = [
        ["write", (fsValue, includeFs) => manifestApi.writeManifestGeneration({
          capability,
          manifest: built,
          ...(includeFs ? { fsApi: fsValue } : {}),
        })],
        ["activate", (fsValue, includeFs) => manifestApi.activateManifestGeneration({
          capability,
          transactionId,
          manifestSha256: written.manifestSha256,
          appendValidated: async (payload) => appendedResult(payload),
          ...(includeFs ? { fsApi: fsValue } : {}),
        })],
        ["pointer", (fsValue, includeFs) => manifestApi.readCurrentManifestPointer({
          capability,
          ...(includeFs ? { fsApi: fsValue } : {}),
        })],
        ["generation", (fsValue, includeFs) => manifestApi.readManifestGeneration({
          capability,
          manifestSha256: written.manifestSha256,
          ...(includeFs ? { fsApi: fsValue } : {}),
        })],
      ];
      const distinct = [];
      const explicitUndefined = [];
      for (const [name, call] of calls) {
        distinct.push([name, await capture(() => call(distinctFs, true))]);
        explicitUndefined.push([name, await capture(() => call(undefined, true))]);
      }
      const originalMethods = Object.fromEntries(
        Object.keys(fsApi).map((name) => [name, fsApi[name]]),
      );
      for (const name of Object.keys(fsApi)) {
        fsApi[name] = () => { throw new Error("mutated source method: " + name); };
      }
      const omitted = [];
      try {
        for (const [name, call] of calls) {
          omitted.push([name, await capture(() => call(undefined, false))]);
        }
      } finally {
        Object.assign(fsApi, originalMethods);
      }
      return { distinct, explicitUndefined, omitted, distinctIo };
    }
    if (request.operation === "post-read-path-swap") {
      const built = manifestApi.buildValidatedManifest(request.value);
      const manifestBytes = Buffer.from(JSON.stringify(built) + "\\n");
      const digest = createHash("sha256").update(manifestBytes).digest("hex");
      let written;
      let path;
      if (request.target === "publication") {
        path = deriveRunPath(capability, {
          purpose: "manifest-generation",
          id: digest,
        });
      } else {
        written = await manifestApi.writeManifestGeneration({
          capability,
          manifest: built,
          fsApi,
        });
        if (request.target === "current") {
          await manifestApi.activateManifestGeneration({
            capability,
            transactionId,
            manifestSha256: written.manifestSha256,
            appendValidated: async (payload) => appendedResult(payload),
            fsApi,
          });
          path = deriveRunPath(capability, { purpose: "current-pointer" });
        } else {
          path = deriveRunPath(capability, {
            purpose: "manifest-generation",
            id: written.manifestSha256,
          });
        }
      }
      adapterState.readSwap = {
        path,
        replacement: request.case,
        complete: false,
      };
      const outcome = await capture(() => {
        if (request.target === "publication") {
          return manifestApi.writeManifestGeneration({ capability, manifest: built, fsApi });
        }
        if (request.target === "current") {
          return manifestApi.readCurrentManifestPointer({ capability, fsApi });
        }
        return manifestApi.readManifestGeneration({
          capability,
          manifestSha256: written.manifestSha256,
          fsApi,
        });
      });
      return {
        outcome,
        swapComplete: adapterState.readSwap.complete,
        liveBytes: await fsPromises.readFile(path, "utf8"),
        liveMode: (await fsPromises.lstat(path)).mode & 0o7777,
        ownedPresent: await fsPromises.access(path + ".owned")
          .then(() => true, () => false),
        temporaryNames: (await fsPromises.readdir(manifestsRoot))
          .filter((name) => name.startsWith(".")).sort(),
      };
    }
    if (request.operation === "generation-post-sync-swap") {
      const built = manifestApi.buildValidatedManifest(request.value);
      const manifestBytes = Buffer.from(JSON.stringify(built) + "\\n");
      const digest = createHash("sha256").update(manifestBytes).digest("hex");
      const generationPath = deriveRunPath(capability, {
        purpose: "manifest-generation",
        id: digest,
      });
      adapterState.durableSwap = {
        directory: dirname(generationPath),
        path: generationPath,
        foreign: false,
        complete: false,
      };
      const outcome = await capture(() => manifestApi.writeManifestGeneration({
        capability,
        manifest: built,
        fsApi,
      }));
      return {
        outcome,
        swapComplete: adapterState.durableSwap.complete,
        ownedPresent: await fsPromises.access(generationPath + ".owned")
          .then(() => true, () => false),
        temporaryNames: (await fsPromises.readdir(manifestsRoot))
          .filter((name) => name.startsWith(".")).sort(),
      };
    }
    if (request.operation === "activation-generation-post-sync-swap") {
      const built = manifestApi.buildValidatedManifest(request.value);
      const written = await manifestApi.writeManifestGeneration({
        capability,
        manifest: built,
        fsApi,
      });
      const generationPath = deriveRunPath(capability, {
        purpose: "manifest-generation",
        id: written.manifestSha256,
      });
      adapterState.durableSwap = {
        directory: dirname(generationPath),
        path: generationPath,
        foreign: false,
        complete: false,
      };
      let appendCalls = 0;
      const outcome = await capture(() => manifestApi.activateManifestGeneration({
        capability,
        transactionId,
        manifestSha256: written.manifestSha256,
        appendValidated: async (payload) => {
          appendCalls += 1;
          return appendedResult(payload);
        },
        fsApi,
      }));
      return {
        outcome,
        appendCalls,
        ownedPresent: await fsPromises.access(generationPath + ".owned")
          .then(() => true, () => false),
      };
    }
    if (request.operation === "pointer-post-sync-swap") {
      const built = manifestApi.buildValidatedManifest(request.value);
      const written = await manifestApi.writeManifestGeneration({
        capability,
        manifest: built,
        fsApi,
      });
      const currentPath = deriveRunPath(capability, { purpose: "current-pointer" });
      adapterState.durableSwap = {
        directory: dirname(currentPath),
        path: currentPath,
        foreign: true,
        complete: false,
      };
      let appendCalls = 0;
      const outcome = await capture(() => manifestApi.activateManifestGeneration({
        capability,
        transactionId,
        manifestSha256: written.manifestSha256,
        appendValidated: async (payload) => {
          appendCalls += 1;
          return appendedResult(payload);
        },
        fsApi,
      }));
      return {
        outcome,
        appendCalls,
        currentBytes: await fsPromises.readFile(currentPath, "utf8"),
        ownedPresent: await fsPromises.access(currentPath + ".owned")
          .then(() => true, () => false),
      };
    }
    if (request.operation === "reader-handle-mismatch") {
      const pointer = Buffer.from(JSON.stringify({
        schemaVersion: 1,
        transactionId,
        manifestSha256: "a".repeat(64),
      }) + "\\n");
      const path = deriveRunPath(capability, { purpose: "current-pointer" });
      await fsPromises.writeFile(path, pointer, { mode: 0o600 });
      await fsPromises.chmod(path, 0o600);
      return capture(() => manifestApi.readCurrentManifestPointer({
        capability, fsApi,
      }));
    }
    throw new Error("unknown operation");
  });
})();
process.stdout.write(JSON.stringify(result));
`;

function spawnWorkerAtRoot(root: string, request: Record<string, unknown>) {
  return spawnSync(process.execPath, ["--input-type=module", "--eval", workerSource], {
    encoding: "utf8",
    input: JSON.stringify({ ...request, root }),
  });
}

function invoke(request: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "quarantine-manifest-"));
  try {
    const result = spawnWorkerAtRoot(root, request);
    if (result.status !== 0) {
      throw new Error(`manifest worker failed (${result.status}): ${result.stderr}`);
    }
    expect(result.stderr).toBe("");
    return JSON.parse(result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function bytes(value: string | Buffer): string {
  return Buffer.from(value).toString("base64");
}

function changedManifest(transactionId = "tx-0001") {
  return {
    ...validManifest,
    transactionId,
    validatedAt: "2026-07-16T12:00:00.000Z",
    deleteAfter: "2026-07-20T12:00:00.000Z",
  };
}

describe("immutable quarantine manifest generations", () => {
  it("builds the exact closed validated manifest without mutating its input", () => {
    const input = structuredClone(validManifest);
    const before = structuredClone(input);
    const outcome = invoke({ operation: "builder", value: input }) as Outcome;
    expect(outcome).toEqual({ ok: true, value: validManifest });
    expect(input).toEqual(before);
  });

  it("builds and round-trips an exact PREPARED generation for the initial journal payload", () => {
    const built = invoke({ operation: "builder", value: preparedManifest });
    expect(built).toEqual({ ok: true, value: preparedManifest });
    const result = invoke({ operation: "generation-only", value: preparedManifest });
    expect(result.generation).toEqual(preparedManifest);
    expect(result.preparedJournalRecord).toEqual({
      event: "PREPARED",
      payload: {
        transactionId: "tx-0001",
        manifestSha256: result.written.manifestSha256,
      },
    });
  });

  it("builds exact v2 temp-residue and attempt-scoped regenerated evidence", () => {
    expect(invoke({ operation: "builder", value: preparedManifestV2 })).toEqual({
      ok: true,
      value: preparedManifestV2,
    });
    expect(invoke({ operation: "builder", value: validManifestV2 })).toEqual({
      ok: true,
      value: validManifestV2,
    });
  });

  it.each([
    ["v1 rejects temp entries", { ...validManifest, entries: validManifestV2.entries }],
    ["v2 rejects nonempty temp hash", {
      ...validManifestV2,
      entries: validManifestV2.entries.map((entry) => entry.kind === "temp-residue"
        ? { ...entry, sha256: hash("9") }
        : entry),
    }],
    ["v2 rejects non-0600 temp mode", {
      ...validManifestV2,
      entries: validManifestV2.entries.map((entry) => entry.kind === "temp-residue"
        ? { ...entry, mode: 0o644 }
        : entry),
    }],
    ["v2 rejects mismatched regenerated passes", {
      ...validManifestV2,
      regeneratedEvidence: {
        ...regeneratedEvidence,
        "generated-next": {
          ...regeneratedEvidence["generated-next"],
          pass2Summary: inventory(hash("9"), 3, 31),
        },
      },
    }],
    ["v2 rejects cross-attempt inventory paths", {
      ...validManifestV2,
      regeneratedEvidence: {
        ...regeneratedEvidence,
        "generated-next": {
          ...regeneratedEvidence["generated-next"],
          pass1Path: "inventories/validation-pass-1/attempt-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-generated-next.jsonl",
        },
      },
    }],
    ["PREPARED v2 rejects published validation evidence", {
      ...preparedManifestV2,
      validationAttempt,
      regeneratedEvidence,
    }],
  ])("%s", (_label, value) => {
    expect(invoke({ operation: "builder", value })).toMatchObject({ ok: false });
  });

  it("does not activate a PREPARED generation", () => {
    const result = invoke({ operation: "activate-prepared", value: preparedManifest });
    expect(result.outcome).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/VALIDATED|state/i) },
    });
    expect(result.ensureCalls).toBe(0);
    expect(result.currentExists).toBe(false);
  });

  it.each([
    ["PREPARED validatedAt", { ...preparedManifest, validatedAt: validManifest.validatedAt }],
    ["PREPARED deleteAfter", { ...preparedManifest, deleteAfter: validManifest.deleteAfter }],
    ["PREPARED deleted status", { ...preparedManifest, deletionStatus: "deleted" }],
    ["PREPARED null retention", { ...preparedManifest, retentionDays: null }],
    ["VALIDATED null validatedAt", { ...validManifest, validatedAt: null }],
    ["VALIDATED null deleteAfter", { ...validManifest, deleteAfter: null }],
  ])("rejects the cross-state combination %s", (_label, value) => {
    expect(invoke({ operation: "builder", value })).toMatchObject({ ok: false });
  });

  it("snapshots public manifest and entry getters exactly once", () => {
    const result = invoke({ operation: "builder-snapshot", value: validManifest });
    expect(result.outcome).toEqual({ ok: true, value: validManifest });
    expect(Object.values(result.counts)).toEqual(
      expect.arrayContaining([1]),
    );
    expect(Object.values(result.counts).every((count) => count === 1)).toBe(true);
  });

  it.each([
    ["unknown top-level field", { ...validManifest, attackerPath: "../victim" }],
    ["non-validated state", { ...validManifest, state: "QUARANTINED" }],
    ["wrong four-day deadline", { ...validManifest, deleteAfter: "2026-07-19T11:59:59.999Z" }],
    ["missing generated root", { ...validManifest, entries: validManifest.entries.slice(1) }],
    ["duplicate entry ID", {
      ...validManifest,
      entries: validManifest.entries.map((entry, index) =>
        index === 3 ? { ...entry, id: "copy-0001" } : entry),
    }],
    ["duplicate relative path", {
      ...validManifest,
      entries: validManifest.entries.map((entry, index) =>
        index === 3 ? { ...entry, relativePath: "src/a 2.ts", canonicalRelativePath: "src/a.ts" } : entry),
    }],
    ["non-bytewise ordering", {
      ...validManifest,
      entries: [validManifest.entries[1], validManifest.entries[0], ...validManifest.entries.slice(2)],
    }],
    ["non-deterministic source ID", {
      ...validManifest,
      entries: validManifest.entries.map((entry, index) =>
        index === 2 ? { ...entry, id: "copy-0002" } : entry),
    }],
    ["generated ID/path mismatch", {
      ...validManifest,
      entries: validManifest.entries.map((entry, index) =>
        index === 0 ? { ...entry, id: "generated-node-modules" } : entry),
    }],
    ["source inventory mismatch", {
      ...validManifest,
      entries: validManifest.entries.map((entry, index) =>
        index === 2 ? { ...entry, preMoveInventory: inventory(hash("d"), 1, 4) } : entry),
    }],
    ["identical metadata mismatch", {
      ...validManifest,
      entries: validManifest.entries.map((entry, index) =>
        index === 2 ? { ...entry, canonicalSize: 6 } : entry),
    }],
    ["divergent hashes equal", {
      ...validManifest,
      entries: validManifest.entries.map((entry, index) =>
        index === 3 ? { ...entry, canonicalSha256: hash("e") } : entry),
    }],
  ])("rejects %s", (_label, value) => {
    expect(invoke({ operation: "builder", value })).toMatchObject({
      ok: false,
      error: { name: expect.any(String), message: expect.any(String) },
    });
  });

  it("writes, activates, and reads one canonical immutable generation", () => {
    const result = invoke({ operation: "round-trip", value: validManifest });
    const canonical = Buffer.from(`${JSON.stringify(validManifest)}\n`);
    const manifestSha256 = createHash("sha256").update(canonical).digest("hex");
    expect(result.written).toEqual({ manifestSha256 });
    expect(result.pointer).toEqual({ schemaVersion: 1, transactionId: "tx-0001", manifestSha256 });
    expect(result.generation).toEqual(validManifest);
    expect(result.order).toEqual([
      { event: "append", payload: { manifestSha256 } },
      { event: "generation-present", bytes: canonical.length },
    ]);
    expect(result.names).toEqual([`${manifestSha256}.json`]);
    expect(result.rootNames).toEqual(["current", "tx-0001"]);
  });

  it("binds every capability API to the original frozen filesystem context", () => {
    const result = invoke({ operation: "adapter-contract", value: validManifest });
    for (const outcomes of [result.distinct, result.explicitUndefined]) {
      expect(outcomes).toEqual([
        ["write", { ok: false, error: expect.objectContaining({ name: "TypeError" }) }],
        ["activate", { ok: false, error: expect.objectContaining({ name: "TypeError" }) }],
        ["pointer", { ok: false, error: expect.objectContaining({ name: "TypeError" }) }],
        ["generation", { ok: false, error: expect.objectContaining({ name: "TypeError" }) }],
      ]);
    }
    expect(result.distinctIo).toBe(0);
    expect(result.omitted).toEqual([
      ["write", { ok: true, value: expect.objectContaining({ manifestSha256: expect.any(String) }) }],
      ["activate", { ok: true, value: expect.objectContaining({ manifestSha256: expect.any(String) }) }],
      ["pointer", { ok: true, value: expect.objectContaining({ manifestSha256: expect.any(String) }) }],
      ["generation", { ok: true, value: validManifest }],
    ]);
  });

  it("rejects a generation inode swap after directory sync and preserves its temporary evidence", () => {
    const result = invoke({ operation: "generation-post-sync-swap", value: validManifest });
    expect(result.swapComplete).toBe(true);
    expect(result.outcome).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/identity|changed/i) },
    });
    expect(result.ownedPresent).toBe(true);
    expect(result.temporaryNames).toHaveLength(1);
  });

  it("revalidates the same generation inode across directory sync before VALIDATED append", () => {
    const result = invoke({
      operation: "activation-generation-post-sync-swap",
      value: validManifest,
    });
    expect(result.outcome).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/identity|changed/i) },
    });
    expect(result.appendCalls).toBe(0);
    expect(result.ownedPresent).toBe(true);
  });

  it("rejects a foreign current replacement after root sync", () => {
    const result = invoke({ operation: "pointer-post-sync-swap", value: validManifest });
    expect(result.outcome).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/identity|canonical|changed/i) },
    });
    expect(result.appendCalls).toBe(1);
    expect(result.currentBytes).toBe("foreign");
    expect(result.ownedPresent).toBe(true);
  });

  it.each([
    ["current", "foreign"],
    ["generation", "same"],
  ])(
    "rejects and preserves a %s pathname replacement after its old handle is read",
    (target, replacement) => {
      const result = invoke({
        operation: "post-read-path-swap",
        target,
        case: replacement,
        value: validManifest,
      });
      expect(result.swapComplete).toBe(true);
      expect(result.outcome).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/identity|path|changed/i) },
      });
      expect(result.ownedPresent).toBe(true);
      expect(result.liveBytes).toBe(
        target === "current" ? "foreign" : `${JSON.stringify(validManifest)}\n`,
      );
    },
  );

  it("rejects a pathname mode change after reading the old generation bytes", () => {
    const result = invoke({
      operation: "post-read-path-swap",
      target: "generation",
      case: "mode",
      value: validManifest,
    });
    expect(result.swapComplete).toBe(true);
    expect(result.outcome).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/mode|changed|private/i) },
    });
    expect(result.liveMode).toBe(0o644);
    expect(result.ownedPresent).toBe(false);
  });

  it("preserves publication evidence when the generation pathname changes after read", () => {
    const result = invoke({
      operation: "post-read-path-swap",
      target: "publication",
      case: "same",
      value: validManifest,
    });
    expect(result.swapComplete).toBe(true);
    expect(result.outcome).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/identity|path|changed/i) },
    });
    expect(result.ownedPresent).toBe(true);
    expect(result.liveBytes).toBe(`${JSON.stringify(validManifest)}\n`);
    expect(result.temporaryNames).toHaveLength(1);
  });

  it.each([
    ["unknown field", { schemaVersion: 1, transactionId: "tx-0001", manifestSha256: hash("a"), path: "../x" }],
    ["missing field", { schemaVersion: 1, transactionId: "tx-0001" }],
    ["uppercase digest", { schemaVersion: 1, transactionId: "tx-0001", manifestSha256: "A".repeat(64) }],
    ["malformed digest", { schemaVersion: 1, transactionId: "tx-0001", manifestSha256: "bad" }],
  ])("rejects a current pointer with %s", (_label, pointer) => {
    const result = invoke({
      operation: "read-pointer-bytes",
      bytes: bytes(`${JSON.stringify(pointer)}\n`),
    });
    expect(result).toMatchObject({ ok: false, error: { message: expect.any(String) } });
  });

  it("rejects malformed, non-canonical, oversized, and handle-swapped pointers", () => {
    for (const value of ["{", '{"transactionId":"tx-0001","schemaVersion":1,"manifestSha256":"' + hash("a") + '"}\n']) {
      expect(invoke({ operation: "read-pointer-bytes", bytes: bytes(value) })).toMatchObject({ ok: false });
    }
    expect(invoke({
      operation: "read-pointer-bytes",
      bytes: bytes(Buffer.alloc(4097, 0x20)),
    })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/large|size/i) } });
    expect(invoke({ operation: "reader-handle-mismatch" })).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/changed|identity/i) },
    });
    const validPointer = {
      schemaVersion: 1,
      transactionId: "tx-0001",
      manifestSha256: hash("a"),
    };
    expect(invoke({
      operation: "read-pointer-bytes",
      bytes: bytes(`${JSON.stringify(validPointer)}\n`),
      maxBytes: null,
    })).toMatchObject({ ok: false, error: { name: "TypeError" } });
  });

  it("rejects oversized, non-canonical, and digest-mismatched generations", () => {
    expect(invoke({
      operation: "read-generation-bytes",
      digest: hash("a"),
      bytes: bytes(Buffer.alloc(4 * 1024 * 1024 + 1, 0x20)),
    })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/large|size/i) } });
    const canonical = Buffer.from(`${JSON.stringify(validManifest)}\n`);
    const digest = createHash("sha256").update(canonical).digest("hex");
    expect(invoke({
      operation: "read-generation-bytes",
      digest,
      bytes: bytes(JSON.stringify(validManifest)),
    })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/digest|canonical/i) } });
    expect(invoke({
      operation: "read-generation-bytes",
      digest: hash("f"),
      bytes: bytes(canonical),
    })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/digest/i) } });
  });

  it("never lets caller maxBytes raise the hard pointer or generation ceilings", () => {
    expect(invoke({
      operation: "read-pointer-bytes",
      bytes: bytes(Buffer.alloc(4097, 0x20)),
      maxBytes: 1024 * 1024,
    })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/large|maximum|4096/i) } });
    const oversized = Buffer.alloc(4 * 1024 * 1024 + 1, 0x20);
    expect(invoke({
      operation: "read-generation-bytes",
      digest: createHash("sha256").update(oversized).digest("hex"),
      bytes: bytes(oversized),
      maxBytes: 8 * 1024 * 1024,
    })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/large|maximum/i) } });
  });

  it("never overwrites an existing digest name containing different bytes", () => {
    expect(invoke({ operation: "existing-conflict", value: validManifest })).toEqual({
      outcome: { ok: false, error: expect.objectContaining({ message: expect.any(String) }) },
      unchanged: true,
    });
  });

  it("rejects 0644 current and generation files without repairing their modes", () => {
    const result = invoke({ operation: "public-mode-readers", value: validManifest });
    expect(result.pointer).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/mode|0600|private/i) },
    });
    expect(result.generation).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/mode|0600|private/i) },
    });
    expect(result.pointerMode).toBe(0o644);
    expect(result.generationMode).toBe(0o644);
  });

  it("rejects identical EEXIST generation bytes at 0644 without repair or replacement", () => {
    const result = invoke({ operation: "existing-public-mode", value: validManifest });
    expect(result.outcome).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/mode|0600|private/i) },
    });
    expect(result.mode).toBe(0o644);
    expect(result.unchanged).toBe(true);
  });

  it.each([
    ["setuid", 0o4600],
    ["setgid", 0o2600],
    ["sticky", 0o1600],
  ])("rejects %s mode bits on current and generation readers", (_label, mode) => {
    const result = invoke({ operation: "public-mode-readers", value: validManifest, mode });
    expect(result.pointer).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/mode|0600|private/i) },
    });
    expect(result.generation).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/mode|0600|private/i) },
    });
    expect(result.pointerMode).toBe(mode);
    expect(result.generationMode).toBe(mode);
  });

  it.each([
    ["setuid", 0o4600],
    ["setgid", 0o2600],
    ["sticky", 0o1600],
  ])("rejects identical EEXIST generation bytes with %s mode without repair", (_label, mode) => {
    const result = invoke({
      operation: "existing-public-mode",
      value: validManifest,
      mode,
    });
    expect(result.outcome).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/mode|0600|private/i) },
    });
    expect(result.mode).toBe(mode);
    expect(result.unchanged).toBe(true);
  });

  it("normalizes generation and pointer temporaries to 0600 under umask 0777", () => {
    const result = invoke({ operation: "restrictive-umask-roundtrip", value: validManifest });
    expect(result.outcome).toEqual({ ok: true });
    expect(result.generationMode).toBe(0o600);
    expect(result.pointerMode).toBe(0o600);
    expect(result.temporaryNames).toEqual([]);
  });

  it.each([
    ["generation", "before"],
    ["generation", "after"],
    ["pointer", "before"],
    ["pointer", "after"],
  ])("cleans its %s temporary after a %s-chmod failure under umask 0777", (target, boundary) => {
    const result = invoke({
      operation: "temporary-chmod-failure",
      value: validManifest,
      target,
      boundary,
    });
    expect(result.outcome).toEqual({
      ok: false,
      error: {
        name: "Error",
        message: `chmod:${boundary}`,
      },
    });
    expect(result.temporaryNames).toEqual([]);
  });

  it.each(["generation", "pointer"])(
    "preserves a foreign replacement of the %s temporary after chmod",
    (target) => {
      const result = invoke({
        operation: "temporary-chmod-failure",
        value: validManifest,
        target,
        boundary: "foreign-after",
      });
      expect(result.outcome).toMatchObject({
        ok: false,
        error: {
          name: "AggregateError",
          errors: [
            "chmod:foreign-after",
            expect.stringMatching(/ownership|mode changed/i),
          ],
        },
      });
      expect(result.temporaryNames).toHaveLength(2);
      expect(result.temporaryNames.some((name: string) => name.endsWith(".owned"))).toBe(true);
      expect(result.foreignBytes).toBe("foreign");
    },
  );

  it.each(["generation", "pointer"])(
    "rejects a post-read inode swap of an exact stale %s temporary",
    (target) => {
      const result = invoke({
        operation: "stale-temporary",
        target,
        case: "swap",
        value: validManifest,
      });
      expect(result.outcome).toMatchObject({ ok: false });
      expect(result.afterKind).toBe("file");
      expect(result.afterBytes).toBe("foreign");
      expect(result.ownedPresent).toBe(true);
    },
  );

  it.each([
    "after-ensure-validated",
    "after-pointer-temporary-sync",
    "after-pointer-rename",
    "after-quarantine-root-sync",
  ])("retries activation after %s without duplicating VALIDATED", (phase) => {
    const result = invoke({
      operation: "activation-retry",
      phase,
      oldValue: validManifest,
      newValue: changedManifest(),
    });
    expect(result.first).toMatchObject({ ok: false, error: { message: `crash:${phase}` } });
    expect(result.second).toMatchObject({ ok: true });
    expect(result.pointer.manifestSha256).toBe(result.expectedDigest);
    expect(result.calls).toBe(2);
    expect(result.appended).toBe(1);
  });

  it.each([
    ["conflicting digest", { status: "already-present", manifestSha256: hash("f") }],
    ["final conflict status", { status: "final-conflict", manifestSha256: "expected" }],
    ["unknown result field", { status: "appended", manifestSha256: "expected", path: "../x" }],
  ])("rejects ensure-validated result with %s before pointer mutation", (_label, resultValue) => {
    const result = invoke({
      operation: "activation-invalid-result",
      oldValue: validManifest,
      newValue: changedManifest(),
      result: resultValue,
    });
    expect(result.outcome).toMatchObject({ ok: false, error: { message: expect.any(String) } });
    expect(result.pointer.manifestSha256).toBe(result.oldDigest);
    expect(result.pointer.manifestSha256).not.toBe(result.nextDigest);
  });

  it.each(["generation", "pointer"])(
    "reuses an exact deterministic stale %s temporary",
    (target) => {
      const result = invoke({
        operation: "stale-temporary",
        target,
        case: "exact",
        value: validManifest,
      });
      expect(result.outcome).toMatchObject({ ok: true });
      expect(result.afterKind).toBe("missing");
    },
  );

  it.each([
    ["generation", "mismatch"],
    ["generation", "public-mode"],
    ["generation", "symlink"],
    ["pointer", "mismatch"],
    ["pointer", "public-mode"],
    ["pointer", "symlink"],
  ])(
    "preserves and rejects a %s %s deterministic stale temporary",
    (target, staleCase) => {
      const result = invoke({
        operation: "stale-temporary",
        target,
        case: staleCase,
        value: validManifest,
      });
      expect(result.outcome).toMatchObject({ ok: false });
      expect(result.afterKind).toBe(staleCase === "symlink" ? "symlink" : "file");
      if (staleCase === "symlink") expect(result.sentinel).toBe("sentinel");
      else expect(result.unchanged).toBe(true);
    },
  );

  it("rejects a manifest transaction ID that differs from the live capability", () => {
    expect(invoke({
      operation: "mismatched-transaction",
      value: changedManifest("tx-0002"),
    })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/transaction/i) } });
  });

  it.each([
    "after-generation-temporary-sync",
    "after-generation-publish",
    "after-generation-directory-sync",
    "after-pointer-temporary-sync",
    "after-pointer-rename",
    "after-quarantine-root-sync",
  ])("keeps readers on an old or new complete generation after %s", (phase) => {
    const result = invoke({
      operation: "fault-matrix",
      phase,
      oldValue: validManifest,
      newValue: changedManifest(),
    });
    expect(result.operationOutcome).toMatchObject({ ok: false, error: { message: `crash:${phase}` } });
    expect([result.oldDigest, result.nextDigest]).toContain(result.pointer.manifestSha256);
    expect(result.selectedTransactionId).toBe("tx-0001");
    expect(result.oldReadable).toBe("tx-0001");
  });

  it.each([
    "after-generation-temporary-sync",
    "after-generation-publish",
    "after-generation-directory-sync",
    "after-ensure-validated",
    "after-pointer-temporary-sync",
    "after-pointer-rename",
    "after-quarantine-root-sync",
  ])("reconciles an actual SIGKILL at %s in a fresh capability", (phase) => {
    const root = mkdtempSync(join(tmpdir(), "quarantine-manifest-sigkill-"));
    try {
      const request = {
        phase,
        oldValue: validManifest,
        newValue: changedManifest(),
      };
      const crashed = spawnWorkerAtRoot(root, { operation: "sigkill-crash", ...request });
      expect(crashed.status).toBeNull();
      expect(crashed.signal).toBe("SIGKILL");

      const recovered = spawnWorkerAtRoot(root, {
        operation: "sigkill-inspect-retry",
        ...request,
      });
      expect(recovered.status).toBe(0);
      expect(recovered.stderr).toBe("");
      const result = JSON.parse(recovered.stdout);
      expect([result.oldDigest, result.nextDigest]).toContain(
        result.beforePointer.manifestSha256,
      );
      expect(result.beforeSelectedState).toBe("VALIDATED");
      expect(result.oldReadableState).toBe("VALIDATED");
      expect(result.retryEnsure).toEqual({
        schemaVersion: 1,
        transactionId: "tx-0001",
        manifestSha256: result.nextDigest,
      });
      expect(result.retryEnsureStatus).toBe(
        phase.startsWith("after-generation") ? "appended" : "already-present",
      );
      expect(result.afterPointer.manifestSha256).toBe(result.nextDigest);
      expect(result.manifestTemps).toEqual([]);
      expect(result.pointerTemps).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("appends VALIDATED exactly once before opening the pointer temporary", () => {
    const events = invoke({ operation: "activation-order", value: validManifest });
    expect(events).toEqual([
      ["append", { manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }],
      "pointer-temp-open",
    ]);
  });

  it("preserves primary then cleanup errors and never deletes old evidence", () => {
    const result = invoke({
      operation: "cleanup-aggregate",
      oldValue: validManifest,
      newValue: changedManifest(),
    });
    expect(result.outcome).toEqual({
      ok: false,
      error: {
        name: "AggregateError",
        message: expect.any(String),
        errors: ["primary publish failure", "cleanup failure"],
      },
    });
    expect(result.pointerUnchanged).toBe(true);
    expect(result.generationUnchanged).toBe(true);
  });

  it("rejects a replaced manifest parent without touching an external sentinel", () => {
    const result = invoke({ operation: "replace-parent", value: validManifest });
    expect(result.outcome).toMatchObject({ ok: false });
    expect(result.sentinel).toBe("keep");
    expect(result.externalNames).toEqual(["sentinel"]);
  });

  it("rejects a symlink-replaced capability root without touching an external sentinel", () => {
    const result = invoke({ operation: "replace-root", value: validManifest });
    expect(result.outcome).toMatchObject({ ok: false });
    expect(result.sentinel).toBe("keep");
    expect(result.externalNames).toEqual(["sentinel"]);
  });
});
