import { lstatSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const activeCapabilities = new WeakSet();
const capabilityState = new WeakMap();

const TRANSACTION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RESTORE_ID = /^restore-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COPY_ID = /^copy-[0-9]{4}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const GENERATED_IDS = new Set(["generated-next", "generated-node-modules"]);
const INVENTORY_PHASES = new Set([
  "pre",
  "moved-pass-1",
  "moved-pass-2",
  "restore-active",
]);
const BOUNDARIES = new Set(["before-mutation", "after-sync"]);

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertExactKeys(value, allowed, required, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`${label} has an unknown field: ${key}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`${label} is missing field: ${key}`);
    }
  }
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

function validateRequest(request) {
  assertPlainObject(request, "run path request");
  assertExactKeys(request, ["purpose", "id", "phase"], ["purpose"], "run path request");
  if (typeof request.purpose !== "string" || !Object.hasOwn(PURPOSES, request.purpose)) {
    throw new TypeError("run path request purpose is invalid");
  }

  switch (request.purpose) {
    case "journal":
    case "journal-lock":
    case "current-pointer":
      assertNoIdOrPhase(request);
      break;
    case "journal-tombstone":
    case "manifest-temporary":
    case "current-temporary":
    case "inventory-work":
      assertIdOnly(request, (id) => assertIdentifier(id, UUID_V4, "opaque"));
      break;
    case "manifest-generation":
      assertIdOnly(request, (id) => assertIdentifier(id, SHA256, "manifest generation"));
      break;
    case "payload":
    case "conflict":
      assertIdOnly(request, assertEntryId);
      break;
    case "rollback":
      assertIdOnly(request, (id) => assertIdentifier(id, RESTORE_ID, "restore"));
      break;
    case "divergent-diff":
      assertIdOnly(request, (id) => assertIdentifier(id, COPY_ID, "source copy"));
      break;
    case "inventory":
      if (!Object.hasOwn(request, "id") || !Object.hasOwn(request, "phase")) {
        throw new TypeError("request has an invalid purpose/ID/phase combination");
      }
      if (typeof request.phase !== "string" || !INVENTORY_PHASES.has(request.phase)) {
        throw new TypeError("inventory phase is invalid");
      }
      if (request.phase === "restore-active") {
        assertIdentifier(request.id, RESTORE_ID, "restore");
      } else {
        assertEntryId(request.id);
      }
      break;
  }

  return request;
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

function assertRecordedDirectorySync(path, recorded, label) {
  const stat = lstatSync(path);
  assertDirectoryStat(stat, label, true);
  if (!sameIdentity(stat, recorded)) {
    throw new Error(`${label} identity changed`);
  }
  if (realpathSync(path) !== recorded.realPath) {
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
  const stat = lstatSync(derived.parent);
  assertDirectoryStat(stat, "selected path parent", true);
  const resolvedParent = realpathSync(derived.parent);
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
  return PURPOSES[request.purpose]({
    quarantineRoot: state.quarantine.realPath,
    runRoot: state.run.realPath,
    id: request.id,
    phase: request.phase,
  });
}

export async function withQuarantineRunCapability(options, callback) {
  assertPlainObject(options, "run capability options");
  assertExactKeys(
    options,
    ["repoRoot", "quarantineRoot", "transactionId", "writersStopped", "fsApi"],
    ["repoRoot", "quarantineRoot", "transactionId", "writersStopped"],
    "run capability options",
  );
  if (options.writersStopped !== true) {
    throw new TypeError("writers-stopped attestation must be true");
  }
  if (typeof callback !== "function") {
    throw new TypeError("run capability callback must be a function");
  }
  assertAbsolutePath(options.repoRoot, "repository root");
  assertAbsolutePath(options.quarantineRoot, "quarantine root");
  assertTransactionId(options.transactionId);

  const fsApi = options.fsApi ?? { lstat, realpath };
  if (typeof fsApi?.lstat !== "function" || typeof fsApi?.realpath !== "function") {
    throw new TypeError("fsApi must provide lstat and realpath functions");
  }

  const repoStat = await fsApi.lstat(options.repoRoot);
  const quarantineStat = await fsApi.lstat(options.quarantineRoot);
  assertDirectoryStat(repoStat, "repository root", false);
  assertDirectoryStat(quarantineStat, "quarantine root", true);
  const repoRealPath = await fsApi.realpath(options.repoRoot);
  const quarantineRealPath = await fsApi.realpath(options.quarantineRoot);
  if (
    isWithinOrEqual(repoRealPath, quarantineRealPath) ||
    isWithinOrEqual(quarantineRealPath, repoRealPath)
  ) {
    throw new TypeError("quarantine root must be outside the repository");
  }
  if (repoStat.dev !== quarantineStat.dev) {
    throw new Error("repository and quarantine root are on different devices");
  }

  const runPath = join(quarantineRealPath, options.transactionId);
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
  );
  assertRecordedDirectorySync(state.run.path, state.run, "quarantine run root");
  assertSelectedParentSync(state, derived);
  return derived.path;
}

export async function revalidateRunCapability(capability, request) {
  const state = requireActiveCapability(capability);
  assertPlainObject(request, "run capability revalidation request");
  assertExactKeys(
    request,
    ["purpose", "id", "phase", "boundary"],
    ["purpose", "boundary"],
    "run capability revalidation request",
  );
  if (typeof request.boundary !== "string" || !BOUNDARIES.has(request.boundary)) {
    throw new TypeError("revalidation boundary is invalid");
  }
  const pathRequest = { purpose: request.purpose };
  if (Object.hasOwn(request, "id")) pathRequest.id = request.id;
  if (Object.hasOwn(request, "phase")) pathRequest.phase = request.phase;
  const validatedRequest = validateRequest(pathRequest);
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
