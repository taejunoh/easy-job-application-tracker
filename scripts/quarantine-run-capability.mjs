import {
  lstatSync as nodeLstatSync,
  realpathSync as nodeRealpathSync,
} from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Cooperative quarantine writer boundary. Downstream writers must use the same
 * supplied filesystem adapter and revalidate immediately before mutation and
 * after durability sync. These boundary checks detect replacement but cannot
 * eliminate a hostile TOCTOU race between a check and a filesystem operation.
 */

const activeCapabilities = new WeakSet();
const capabilityState = new WeakMap();

const TRANSACTION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RESTORE_ID = /^restore-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COPY_ID = /^copy-(?!0000)[0-9]{4}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const GENERATED_IDS = new Set(["generated-next", "generated-node-modules"]);
const INVENTORY_PHASES = new Set([
  "pre",
  "moved-pass-1",
  "moved-pass-2",
  "restore-active",
]);
const BOUNDARIES = new Set(["before-mutation", "after-sync"]);
const FS_METHODS = ["lstat", "realpath", "mkdir", "lstatSync", "realpathSync"];
const DEFAULT_FS_ADAPTER = Object.freeze({
  lstat,
  realpath,
  mkdir,
  lstatSync: nodeLstatSync,
  realpathSync: nodeRealpathSync,
});

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function snapshotPublicRecord(value, allowed, required, label) {
  assertPlainObject(value, label);
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      throw new TypeError(`${label} has an unknown field: ${key}`);
    }
  }
  for (const key of required) {
    if (!keys.includes(key)) {
      throw new TypeError(`${label} is missing field: ${key}`);
    }
  }
  const snapshot = Object.create(null);
  for (const key of keys) snapshot[key] = value[key];
  return Object.freeze(snapshot);
}

function normalizeFsAdapter(value) {
  assertPlainObject(value, "filesystem adapter");
  const normalized = Object.create(null);
  for (const methodName of FS_METHODS) {
    const method = value[methodName];
    if (typeof method !== "function") {
      throw new TypeError(`filesystem adapter must provide ${methodName}`);
    }
    normalized[methodName] = (...args) => Reflect.apply(method, value, args);
  }
  return Object.freeze(normalized);
}

function assertAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new TypeError(`${label} must be an absolute path`);
  }
}

function assertTransactionId(value) {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFC") ||
    value === "." ||
    value === ".." ||
    !TRANSACTION_ID.test(value)
  ) {
    throw new TypeError("transaction ID is invalid");
  }
}

function assertIdentifier(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${label} ID is invalid`);
  }
}

function assertEntryId(value) {
  if (typeof value !== "string" || (!COPY_ID.test(value) && !GENERATED_IDS.has(value))) {
    throw new TypeError("manifest entry ID is invalid");
  }
}

function assertNoIdOrPhase(request) {
  if (Object.hasOwn(request, "id") || Object.hasOwn(request, "phase")) {
    throw new TypeError("request has an invalid purpose/ID/phase combination");
  }
}

function assertIdOnly(request, validator) {
  if (!Object.hasOwn(request, "id") || Object.hasOwn(request, "phase")) {
    throw new TypeError("request has an invalid purpose/ID/phase combination");
  }
  validator(request.id);
}

function payloadPath(runRoot, id) {
  assertEntryId(id);
  if (COPY_ID.test(id)) {
    return join(runRoot, "payload", "source-copies", id);
  }
  return join(
    runRoot,
    "payload",
    "generated",
    id === "generated-next" ? ".next" : "node_modules",
  );
}

const PURPOSES = Object.freeze({
  journal: ({ runRoot }) => ({
    path: join(runRoot, "journal.log"),
    parent: runRoot,
    parentRoot: "run",
  }),
  "journal-lock": ({ runRoot }) => ({
    path: join(runRoot, "journal.lock"),
    parent: runRoot,
    parentRoot: "run",
  }),
  "journal-tombstone": ({ runRoot, id }) => ({
    path: join(runRoot, `journal.lock.tombstone.${id}`),
    parent: runRoot,
    parentRoot: "run",
  }),
  "manifest-generation": ({ runRoot, id }) => ({
    path: join(runRoot, "manifests", `${id}.json`),
    parent: join(runRoot, "manifests"),
    parentRoot: "run",
  }),
  "manifest-temporary": ({ runRoot, id }) => ({
    path: join(runRoot, "manifests", `.${id}.tmp`),
    parent: join(runRoot, "manifests"),
    parentRoot: "run",
  }),
  "current-pointer": ({ quarantineRoot }) => ({
    path: join(quarantineRoot, "current"),
    parent: quarantineRoot,
    parentRoot: "quarantine",
  }),
  "current-temporary": ({ quarantineRoot, id }) => ({
    path: join(quarantineRoot, `.current.${id}.tmp`),
    parent: quarantineRoot,
    parentRoot: "quarantine",
  }),
  inventory: ({ runRoot, id, phase }) => ({
    path: join(runRoot, "inventories", phase, `${id}.jsonl`),
    parent: join(runRoot, "inventories", phase),
    parentRoot: "run",
  }),
  "inventory-work": ({ runRoot, id }) => ({
    path: join(runRoot, "inventories", "work", `${id}.bin`),
    parent: join(runRoot, "inventories", "work"),
    parentRoot: "run",
  }),
  payload: ({ runRoot, id }) => {
    const path = payloadPath(runRoot, id);
    return { path, parent: resolve(path, ".."), parentRoot: "run" };
  },
  rollback: ({ runRoot, id }) => ({
    path: join(runRoot, "rollback", "regenerated-before-restore", id),
    parent: join(runRoot, "rollback", "regenerated-before-restore"),
    parentRoot: "run",
  }),
  conflict: ({ runRoot, id }) => ({
    path: join(runRoot, "conflicts", id),
    parent: join(runRoot, "conflicts"),
    parentRoot: "run",
  }),
  "divergent-diff": ({ runRoot, id }) => ({
    path: join(runRoot, "divergent-diffs", `${id}.patch`),
    parent: join(runRoot, "divergent-diffs"),
    parentRoot: "run",
  }),
});

function validateRequest(request, includeBoundary = false) {
  const label = includeBoundary
    ? "run capability revalidation request"
    : "run path request";
  const normalized = snapshotPublicRecord(
    request,
    includeBoundary
      ? ["purpose", "id", "phase", "boundary"]
      : ["purpose", "id", "phase"],
    includeBoundary ? ["purpose", "boundary"] : ["purpose"],
    label,
  );
  if (
    typeof normalized.purpose !== "string" ||
    !Object.hasOwn(PURPOSES, normalized.purpose)
  ) {
    throw new TypeError("run path request purpose is invalid");
  }
  if (
    includeBoundary &&
    (typeof normalized.boundary !== "string" || !BOUNDARIES.has(normalized.boundary))
  ) {
    throw new TypeError("revalidation boundary is invalid");
  }

  switch (normalized.purpose) {
    case "journal":
    case "journal-lock":
    case "current-pointer":
      assertNoIdOrPhase(normalized);
      break;
    case "journal-tombstone":
    case "manifest-temporary":
    case "current-temporary":
    case "inventory-work":
      assertIdOnly(normalized, (id) => assertIdentifier(id, UUID_V4, "opaque"));
      break;
    case "manifest-generation":
      assertIdOnly(normalized, (id) => assertIdentifier(id, SHA256, "manifest generation"));
      break;
    case "payload":
    case "conflict":
      assertIdOnly(normalized, assertEntryId);
      break;
    case "rollback":
      assertIdOnly(normalized, (id) => assertIdentifier(id, RESTORE_ID, "restore"));
      break;
    case "divergent-diff":
      assertIdOnly(normalized, (id) => assertIdentifier(id, COPY_ID, "source copy"));
      break;
    case "inventory":
      if (!Object.hasOwn(normalized, "id") || !Object.hasOwn(normalized, "phase")) {
        throw new TypeError("request has an invalid purpose/ID/phase combination");
      }
      if (
        typeof normalized.phase !== "string" ||
        !INVENTORY_PHASES.has(normalized.phase)
      ) {
        throw new TypeError("inventory phase is invalid");
      }
      if (normalized.phase === "restore-active") {
        assertIdentifier(normalized.id, RESTORE_ID, "restore");
      } else {
        assertEntryId(normalized.id);
      }
      break;
  }

  return normalized;
}

function isWithinOrEqual(root, candidate) {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

function assertDirectoryStat(stat, label, requirePrivateMode) {
  if (stat.isSymbolicLink()) {
    throw new TypeError(`${label} must not be a symlink`);
  }
  if (!stat.isDirectory()) {
    throw new TypeError(`${label} must be a directory`);
  }
  if (requirePrivateMode && (stat.mode & 0o7777) !== 0o700) {
    throw new TypeError(`${label} must have mode 0700`);
  }
}

function sameIdentity(stat, recorded) {
  return stat.dev === recorded.dev && stat.ino === recorded.ino;
}

function assertRecordedDirectorySync(path, recorded, label, fsApi) {
  const stat = fsApi.lstatSync(path);
  assertDirectoryStat(stat, label, true);
  if (!sameIdentity(stat, recorded)) {
    throw new Error(`${label} identity changed`);
  }
  if (fsApi.realpathSync(path) !== recorded.realPath) {
    throw new Error(`${label} real path changed`);
  }
}

async function assertRecordedDirectory(path, recorded, label, fsApi) {
  const stat = await fsApi.lstat(path);
  assertDirectoryStat(stat, label, true);
  if (!sameIdentity(stat, recorded)) {
    throw new Error(`${label} identity changed`);
  }
  if ((await fsApi.realpath(path)) !== recorded.realPath) {
    throw new Error(`${label} real path changed`);
  }
}

function expectedParentRoot(state, derived) {
  return derived.parentRoot === "quarantine" ? state.quarantine : state.run;
}

function assertSelectedParentSync(state, derived) {
  const root = expectedParentRoot(state, derived);
  const stat = state.fsApi.lstatSync(derived.parent);
  assertDirectoryStat(stat, "selected path parent", true);
  const resolvedParent = state.fsApi.realpathSync(derived.parent);
  if (
    stat.dev !== root.dev ||
    resolvedParent !== resolve(derived.parent) ||
    !isWithinOrEqual(root.realPath, resolvedParent)
  ) {
    throw new Error("selected path parent identity or containment changed");
  }
}

async function assertSelectedParent(state, derived) {
  const root = expectedParentRoot(state, derived);
  const stat = await state.fsApi.lstat(derived.parent);
  assertDirectoryStat(stat, "selected path parent", true);
  const resolvedParent = await state.fsApi.realpath(derived.parent);
  if (
    stat.dev !== root.dev ||
    resolvedParent !== resolve(derived.parent) ||
    !isWithinOrEqual(root.realPath, resolvedParent)
  ) {
    throw new Error("selected path parent identity or containment changed");
  }
}

function requireActiveCapability(capability) {
  if (
    capability === null ||
    (typeof capability !== "object" && typeof capability !== "function") ||
    !activeCapabilities.has(capability)
  ) {
    throw new TypeError("quarantine run capability is forged or inactive");
  }
  return capabilityState.get(capability);
}

function deriveForState(state, request) {
  const derived = PURPOSES[request.purpose]({
    quarantineRoot: state.quarantine.realPath,
    runRoot: state.run.realPath,
    id: request.id,
    phase: request.phase,
  });
  const approvedRoot = expectedParentRoot(state, derived).realPath;
  const lexicalPath = resolve(derived.path);
  const lexicalParent = dirname(lexicalPath);
  if (
    lexicalPath !== derived.path ||
    lexicalParent !== derived.parent ||
    !isWithinOrEqual(approvedRoot, derived.parent) ||
    !isWithinOrEqual(approvedRoot, lexicalPath)
  ) {
    throw new Error("derived path escaped its approved parent or root");
  }
  return derived;
}

export async function withQuarantineRunCapability(options, callback) {
  const normalizedOptions = snapshotPublicRecord(
    options,
    ["repoRoot", "quarantineRoot", "transactionId", "writersStopped", "fsApi"],
    ["repoRoot", "quarantineRoot", "transactionId", "writersStopped"],
    "run capability options",
  );
  if (normalizedOptions.writersStopped !== true) {
    throw new TypeError("writers-stopped attestation must be true");
  }
  if (typeof callback !== "function") {
    throw new TypeError("run capability callback must be a function");
  }
  assertAbsolutePath(normalizedOptions.repoRoot, "repository root");
  assertAbsolutePath(normalizedOptions.quarantineRoot, "quarantine root");
  assertTransactionId(normalizedOptions.transactionId);

  const fsApi = normalizeFsAdapter(
    normalizedOptions.fsApi === undefined
      ? DEFAULT_FS_ADAPTER
      : normalizedOptions.fsApi,
  );
  const repoStat = await fsApi.lstat(normalizedOptions.repoRoot);
  const quarantineStat = await fsApi.lstat(normalizedOptions.quarantineRoot);
  assertDirectoryStat(repoStat, "repository root", false);
  assertDirectoryStat(quarantineStat, "quarantine root", true);
  const repoRealPath = await fsApi.realpath(normalizedOptions.repoRoot);
  const quarantineRealPath = await fsApi.realpath(normalizedOptions.quarantineRoot);
  if (
    isWithinOrEqual(repoRealPath, quarantineRealPath) ||
    isWithinOrEqual(quarantineRealPath, repoRealPath)
  ) {
    throw new TypeError("quarantine root must be outside the repository");
  }
  if (repoStat.dev !== quarantineStat.dev) {
    throw new Error("repository and quarantine root are on different devices");
  }

  const runPath = join(quarantineRealPath, normalizedOptions.transactionId);
  const runStat = await fsApi.lstat(runPath);
  assertDirectoryStat(runStat, "quarantine run root", true);
  const runRealPath = await fsApi.realpath(runPath);
  if (
    runRealPath !== resolve(runPath) ||
    !isWithinOrEqual(quarantineRealPath, runRealPath) ||
    quarantineStat.dev !== runStat.dev
  ) {
    throw new Error("quarantine run root identity or containment is invalid");
  }

  const capability = Object.freeze(Object.create(null));
  const state = Object.freeze({
    fsApi,
    quarantine: Object.freeze({
      path: quarantineRealPath,
      realPath: quarantineRealPath,
      dev: quarantineStat.dev,
      ino: quarantineStat.ino,
      mode: quarantineStat.mode,
    }),
    run: Object.freeze({
      path: runPath,
      realPath: runRealPath,
      dev: runStat.dev,
      ino: runStat.ino,
      mode: runStat.mode,
    }),
  });
  capabilityState.set(capability, state);
  activeCapabilities.add(capability);

  try {
    return await callback(capability);
  } finally {
    activeCapabilities.delete(capability);
    capabilityState.delete(capability);
  }
}

export function deriveRunPath(capability, request) {
  const state = requireActiveCapability(capability);
  const validatedRequest = validateRequest(request);
  const derived = deriveForState(state, validatedRequest);
  assertRecordedDirectorySync(
    state.quarantine.path,
    state.quarantine,
    "quarantine root",
    state.fsApi,
  );
  assertRecordedDirectorySync(
    state.run.path,
    state.run,
    "quarantine run root",
    state.fsApi,
  );
  assertSelectedParentSync(state, derived);
  return derived.path;
}

export async function revalidateRunCapability(capability, request) {
  const state = requireActiveCapability(capability);
  const validatedRequest = validateRequest(request, true);
  const derived = deriveForState(state, validatedRequest);
  await assertRecordedDirectory(
    state.quarantine.path,
    state.quarantine,
    "quarantine root",
    state.fsApi,
  );
  await assertRecordedDirectory(
    state.run.path,
    state.run,
    "quarantine run root",
    state.fsApi,
  );
  await assertSelectedParent(state, derived);
}
