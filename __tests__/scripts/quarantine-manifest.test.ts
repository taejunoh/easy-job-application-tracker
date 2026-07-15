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

type Outcome =
  | { ok: true; value: unknown }
  | { ok: false; error: { name: string; message: string; errors?: string[] } };

const workerSource = `
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
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
const baseFsApi = { ...fsPromises, lstatSync, realpathSync };
const adapterEvents = [];
const adapterState = { failLink: false, failTemporaryUnlink: false };
const fsApi = {
  ...baseFsApi,
  async open(path, flags, mode) {
    if (request.operation === "activation-order" && path.includes("/.current.")) {
      adapterEvents.push("pointer-temp-open");
    }
    return baseFsApi.open(path, flags, mode);
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
        appendValidated: async () => {},
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
    if (request.operation === "fault-matrix") {
      const oldManifest = manifestApi.buildValidatedManifest(request.oldValue);
      const oldWritten = await manifestApi.writeManifestGeneration({
        capability, manifest: oldManifest, fsApi,
      });
      await manifestApi.activateManifestGeneration({
        capability,
        transactionId,
        manifestSha256: oldWritten.manifestSha256,
        appendValidated: async () => {},
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
          appendValidated: async () => {},
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
        appendValidated: async (payload) => adapterEvents.push(["append", payload]),
        fsApi,
      });
      return adapterEvents;
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
        appendValidated: async () => {},
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
    if (request.operation === "reader-handle-mismatch") {
      const pointer = Buffer.from(JSON.stringify({
        schemaVersion: 1,
        transactionId,
        manifestSha256: "a".repeat(64),
      }) + "\\n");
      const path = deriveRunPath(capability, { purpose: "current-pointer" });
      await fsPromises.writeFile(path, pointer, { mode: 0o600 });
      await fsPromises.chmod(path, 0o600);
      const mismatchFs = {
        ...fsApi,
        async open(openPath, flags) {
          const handle = await fsApi.open(openPath, flags);
          if (openPath !== path) return handle;
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
        },
      };
      return capture(() => manifestApi.readCurrentManifestPointer({
        capability, fsApi: mismatchFs,
      }));
    }
    throw new Error("unknown operation");
  });
})();
process.stdout.write(JSON.stringify(result));
`;

function invoke(request: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "quarantine-manifest-"));
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", workerSource], {
      encoding: "utf8",
      input: JSON.stringify({ ...request, root }),
    });
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
