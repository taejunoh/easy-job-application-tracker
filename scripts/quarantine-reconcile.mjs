import { execFileSync } from "node:child_process";
import { isAbsolute, join, relative, sep } from "node:path";

import {
  hashVerifiedRegularFile,
  InventoryStructuralError,
  summarizeInventoryDirectory,
  verifyPublishedInventory,
} from "./quarantine-inventory-reader.mjs";
import { replayJournal } from "./quarantine-journal.mjs";
import { readCurrentManifestPointer, readManifestGeneration } from "./quarantine-manifest.mjs";
import { buildRestoreLedger } from "./quarantine-restore-ledger.mjs";
import { getRunFsContext } from "./quarantine-run-fs-context.mjs";
import { deriveRunPath, withQuarantineRunCapability } from "./quarantine-run-capability.mjs";

const OPTION_KEYS = Object.freeze([
  "repoRoot", "quarantineRoot", "transactionId", "writersStopped", "fsApi",
]);
const REQUIRED_KEYS = Object.freeze([
  "repoRoot", "quarantineRoot", "transactionId", "writersStopped",
]);
const TRANSACTION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ENDPOINT_CONTENT_MISMATCH = Symbol("endpoint-content-mismatch");
const DIRECTIVES = new Map([
  ["PREPARED", [false, "recover_required"]],
  ["MOVING", [false, "recover_required"]],
  ["VERIFYING", [false, "recover_required"]],
  ["ROLLING_BACK", [false, "recover_required"]],
  ["QUARANTINED", [false, "mark_validated"]],
  ["VALIDATED", [false, "retain_and_review"]],
  ["RESTORE_PREPARED", [false, "recover_required"]],
  ["RESTORING", [false, "recover_required"]],
  ["RESTORE_ROLLING_BACK", [false, "recover_required"]],
  ["RECOVERY_REQUIRED", [false, "recover_required"]],
  ["INCOMPLETE_CONFLICT", [false, "investigate_conflict"]],
  ["RESTORED", [true, "none"]],
  ["ROLLED_BACK", [true, "none"]],
]);

class ReconciliationError extends Error {
  constructor(code, message) {
    super(message);
    Object.defineProperty(this, "code", { value: code, enumerable: false });
  }
}

function fail(code, message) {
  throw new ReconciliationError(code, message);
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotOptions(value) {
  if (!plainObject(value)) fail("ERR_USAGE", "reconciliation options must be a plain object");
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !OPTION_KEYS.includes(key)) ||
    REQUIRED_KEYS.some((key) => !keys.includes(key))
  ) fail("ERR_USAGE", "reconciliation options are invalid");
  const input = Object.create(null);
  for (const key of OPTION_KEYS) if (keys.includes(key)) input[key] = value[key];
  if (
    typeof input.repoRoot !== "string" || !isAbsolute(input.repoRoot) ||
    input.repoRoot.includes("\0") || input.repoRoot !== input.repoRoot.normalize("NFC") ||
    typeof input.quarantineRoot !== "string" || !isAbsolute(input.quarantineRoot) ||
    input.quarantineRoot.includes("\0") || input.quarantineRoot !== input.quarantineRoot.normalize("NFC") ||
    typeof input.transactionId !== "string" || input.transactionId !== input.transactionId.normalize("NFC") ||
    input.transactionId === "." || input.transactionId === ".." || !TRANSACTION_ID.test(input.transactionId) ||
    input.writersStopped !== true
  ) fail("ERR_USAGE", "reconciliation options are invalid");
  return Object.freeze(input);
}

function sameSummary(left, right) {
  return left !== null && right !== null && left.sha256 === right.sha256 &&
    left.entries === right.entries && left.bytes === right.bytes;
}

function modeOf(stat) {
  return stat.mode & 0o7777;
}

async function optionalStat(path, fsApi) {
  try {
    return await fsApi.lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function workspaceAncestors(repoRoot, endpoint, fsApi) {
  const relativeEndpoint = relative(repoRoot, endpoint);
  if (
    relativeEndpoint === "" || relativeEndpoint === ".." ||
    relativeEndpoint.startsWith(`..${sep}`) || isAbsolute(relativeEndpoint)
  ) fail("ERR_INTEGRITY", "manifest endpoint escapes the repository");
  let current = repoRoot;
  const rootStat = await fsApi.lstat(repoRoot);
  const identities = [Object.freeze({
    path: repoRoot,
    dev: Number(rootStat.dev),
    ino: Number(rootStat.ino),
    mode: modeOf(rootStat),
    type: "directory",
    canonicalRealpath: repoRoot,
  })];
  for (const component of relativeEndpoint.split(sep).slice(0, -1)) {
    current = join(current, component);
    const stat = await fsApi.lstat(current);
    const realPath = await fsApi.realpath(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || realPath !== current) {
      fail("ERR_INTEGRITY", "manifest endpoint ancestor is unsafe");
    }
    identities.push(Object.freeze({
      path: current,
      dev: Number(stat.dev),
      ino: Number(stat.ino),
      mode: modeOf(stat),
      type: "directory",
      canonicalRealpath: realPath,
    }));
  }
  return identities;
}

async function observeEntry(
  path,
  entry,
  fsApi,
  ancestors = undefined,
  allowContentMismatch = false,
) {
  const stat = await optionalStat(path, fsApi);
  if (stat === null) return null;
  if (stat.isSymbolicLink()) fail("ERR_INTEGRITY", "quarantine endpoint is a symlink");
  if (entry.kind === "generated-root") {
    if (!stat.isDirectory()) fail("ERR_INTEGRITY", "generated endpoint is not a directory");
    try {
      return await summarizeInventoryDirectory(path, { fsApi });
    } catch (error) {
      if (error instanceof InventoryStructuralError) {
        fail("ERR_INTEGRITY", "generated endpoint is structurally unsafe");
      }
      throw error;
    }
  }
  if (!stat.isFile()) {
    fail("ERR_INTEGRITY", "file endpoint metadata does not match the manifest");
  }
  try {
    const observed = await hashVerifiedRegularFile(path, stat, fsApi, ancestors ?? Object.freeze([]));
    if (
      modeOf(stat) !== entry.mode || Number(stat.size) !== entry.size ||
      observed.sha256 !== entry.sha256 || observed.bytes !== entry.size
    ) {
      if (allowContentMismatch) return ENDPOINT_CONTENT_MISMATCH;
      fail("ERR_INTEGRITY", "file endpoint content does not match the manifest");
    }
    return entry.preMoveInventory;
  } catch (error) {
    if (error instanceof InventoryStructuralError) {
      fail("ERR_INTEGRITY", "file endpoint is structurally unsafe");
    }
    throw error;
  }
}

function assertMatches(entry, observed, label) {
  if (!sameSummary(entry.preMoveInventory, observed)) {
    fail("ERR_INTEGRITY", `${label} does not match the manifest inventory`);
  }
}

function buildApplyLedger(replayed, manifest) {
  const intents = [];
  const completed = new Set();
  const rollbackIntents = new Set();
  const rollbackCompleted = new Set();
  let rollbackPending = null;
  for (const record of replayed.records) {
    if (record.event === "MOVE_INTENT") {
      const entry = manifest.entries[intents.length];
      if (entry?.id !== record.payload.id || !sameSummary(entry.preMoveInventory, record.payload.expected)) {
        fail("ERR_INTEGRITY", "apply intent does not match manifest order");
      }
      intents.push(entry);
    } else if (record.event === "MOVED") {
      if (intents[completed.size]?.id !== record.payload.id) {
        fail("ERR_INTEGRITY", "apply completion does not match intent order");
      }
      completed.add(record.payload.id);
    } else if (record.event === "ROLLBACK_INTENT") {
      if (rollbackPending !== null) fail("ERR_INTEGRITY", "overlapping rollback intents");
      rollbackPending = record.payload.id;
      rollbackIntents.add(record.payload.id);
    } else if (record.event === "ROLLED_BACK_ENTRY") {
      if (rollbackPending !== record.payload.id) fail("ERR_INTEGRITY", "rollback completion is unbound");
      rollbackPending = null;
      rollbackCompleted.add(record.payload.id);
    }
  }
  return { intents, completed, rollbackIntents, rollbackCompleted, rollbackPending };
}

function hasRestoreEpoch(replayed) {
  return replayed.records.some((record) => record.event === "RESTORE_PREPARED");
}

function preRestoreState(replayed) {
  const index = replayed.records.findLastIndex((record) => record.event === "RESTORE_PREPARED");
  if (index < 1) return null;
  return replayed.records[index - 1].event;
}

async function validateApplyLayout({ capability, fsApi, input, replayed, manifest }) {
  const ledger = buildApplyLedger(replayed, manifest);
  if (
    new Set(["QUARANTINED", "VALIDATED"]).has(replayed.state) &&
    (ledger.intents.length !== manifest.entries.length ||
      ledger.completed.size !== manifest.entries.length)
  ) fail("ERR_INTEGRITY", "settled apply journal does not cover the manifest");
  const intended = new Set(ledger.intents.map((entry) => entry.id));
  const layouts = [];
  for (const entry of manifest.entries) {
    const source = join(input.repoRoot, ...entry.relativePath.split("/"));
    const ancestors = await workspaceAncestors(input.repoRoot, source, fsApi);
    const payload = deriveRunPath(capability, { purpose: "payload", id: entry.id });
    const sourceObserved = await observeEntry(source, entry, fsApi, ancestors);
    const payloadObserved = await observeEntry(payload, entry, fsApi);
    if (sourceObserved !== null) {
      if (
        entry.kind === "generated-root" && manifest.state === "VALIDATED" &&
        manifest.schemaVersion === 2
      ) {
        const expected = manifest.regeneratedEvidence?.[entry.id]?.pass1Summary;
        if (!sameSummary(expected, sourceObserved)) {
          fail("ERR_INTEGRITY", "regenerated workspace endpoint does not match validation evidence");
        }
      } else if (
        entry.kind !== "generated-root" ||
        !new Set(["QUARANTINED", "VALIDATED"]).has(replayed.state)
      ) {
        assertMatches(entry, sourceObserved, "workspace endpoint");
      }
    }
    if (payloadObserved !== null) assertMatches(entry, payloadObserved, "payload endpoint");
    const inSource = sourceObserved !== null;
    const inPayload = payloadObserved !== null;
    let legal;
    if (replayed.state === "ROLLED_BACK") {
      legal = inSource && !inPayload;
    } else if (ledger.rollbackCompleted.has(entry.id)) {
      legal = inSource && !inPayload;
    } else if (ledger.rollbackIntents.has(entry.id)) {
      legal = inSource !== inPayload;
    } else if (!intended.has(entry.id)) {
      legal = inSource && !inPayload;
    } else if (ledger.completed.has(entry.id)) {
      legal = inPayload && (entry.kind === "generated-root" &&
        new Set(["QUARANTINED", "VALIDATED"]).has(replayed.state) ? true : !inSource);
    } else {
      legal = inSource !== inPayload;
    }
    if (!legal) fail("ERR_INTEGRITY", "apply physical layout conflicts with the journal");
    layouts.push([entry.id, inSource && inPayload ? "source+payload" : inSource ? "source" : "payload"]);
  }
  if (
    new Set(["VERIFYING", "QUARANTINED", "VALIDATED"]).has(replayed.state) &&
    layouts.some(([entryId, location]) => {
      const entry = manifest.entries.find((candidate) => candidate.id === entryId);
      return entry.kind === "generated-root"
        ? location !== "payload" && location !== "source+payload"
        : location !== "payload";
    })
  ) fail("ERR_INTEGRITY", "settled quarantine payload is incomplete");
  return layouts;
}

async function validateRestoreLayout({ capability, fsApi, input, replayed, manifest }) {
  let ledger;
  try {
    ledger = buildRestoreLedger(replayed, manifest);
  } catch {
    fail("ERR_INTEGRITY", "restore ledger is invalid");
  }
  const intended = new Set(ledger.intents);
  const conflictIds = replayed.state === "INCOMPLETE_CONFLICT"
    ? new Set(replayed.records.at(-1)?.payload.conflictEntryIds)
    : new Set();
  const observedConflicts = new Set();
  const layouts = [];
  for (const entry of manifest.entries) {
    const journalConflict = conflictIds.has(entry.id);
    const source = join(input.repoRoot, ...entry.relativePath.split("/"));
    const ancestors = await workspaceAncestors(input.repoRoot, source, fsApi);
    const payload = deriveRunPath(capability, { purpose: "payload", id: entry.id });
    const sourceObserved = await observeEntry(
      source, entry, fsApi, ancestors, journalConflict,
    );
    const payloadObserved = await observeEntry(payload, entry, fsApi);
    const rollbackRoot = deriveRunPath(capability, { purpose: "rollback", id: ledger.restoreId });
    const rollback = join(rollbackRoot, entry.relativePath === ".next" ? ".next" : "node_modules");
    const rollbackObserved = entry.kind === "generated-root"
      ? await observeEntry(rollback, entry, fsApi)
      : null;
    if (payloadObserved !== null) {
      assertMatches(entry, payloadObserved, "restore payload endpoint");
    }
    if (!journalConflict && sourceObserved !== null && entry.kind !== "generated-root") {
      assertMatches(entry, sourceObserved, "restored workspace endpoint");
    }
    const activeExpected = entry.kind === "generated-root" ? ledger.active.get(entry.id) : null;
    if (
      rollbackObserved !== null &&
      !sameSummary(activeExpected, rollbackObserved)
    ) fail("ERR_INTEGRITY", "restore rollback endpoint does not match active evidence");
    const workspaceForeign = entry.kind === "generated-root"
      ? sourceObserved !== null &&
        !sameSummary(entry.preMoveInventory, sourceObserved) &&
        !sameSummary(activeExpected, sourceObserved)
      : sourceObserved === ENDPOINT_CONTENT_MISMATCH;
    const initial = sameSummary(entry.preMoveInventory, payloadObserved) &&
      (activeExpected === null ? sourceObserved === null : sameSummary(activeExpected, sourceObserved)) &&
      rollbackObserved === null;
    const staging = sameSummary(entry.preMoveInventory, payloadObserved) && sourceObserved === null &&
      (activeExpected === null ? rollbackObserved === null : sameSummary(activeExpected, rollbackObserved));
    const final = payloadObserved === null && sameSummary(entry.preMoveInventory, sourceObserved) &&
      (activeExpected === null ? rollbackObserved === null : sameSummary(activeExpected, rollbackObserved));
    const rolledBack = ledger.rollbackCompleted.has(entry.id);
    const rollbackPending = ledger.rollbackIntents.has(entry.id) && !rolledBack;
    const forward = intended.has(entry.id) && !rolledBack;
    const legal = (!forward || rolledBack)
      ? initial
      : rollbackPending
        ? initial || staging || final
        : !ledger.completed.has(entry.id)
          ? initial || staging || final
          : final;
    if (!legal) {
      if (!conflictIds.has(entry.id) || !workspaceForeign) {
        fail("ERR_INTEGRITY", "restore physical layout conflicts with the journal");
      }
      if (payloadObserved === null && !ledger.completed.has(entry.id)) {
        fail("ERR_INTEGRITY", "restore conflict is missing protected payload evidence");
      }
      if (
        entry.kind === "generated-root" && activeExpected !== null &&
        ledger.completed.has(entry.id) && rollbackObserved === null
      ) fail("ERR_INTEGRITY", "restore conflict is missing protected rollback evidence");
      observedConflicts.add(entry.id);
    }
    layouts.push([entry.id, initial ? "initial" : staging ? "staging" : final ? "final" : "conflict"]);
  }
  if (
    observedConflicts.size !== conflictIds.size ||
    [...conflictIds].some((entryId) => !observedConflicts.has(entryId))
  ) fail("ERR_INTEGRITY", "restore conflict evidence does not match the journal");
  if (replayed.state === "RESTORED" && layouts.some(([, state]) => state !== "final")) {
    fail("ERR_INTEGRITY", "terminal restore layout is incomplete");
  }
  return layouts;
}

async function validatePublishedInventories({ capability, replayed, manifest }) {
  const phases = ["pre"];
  if (replayed.records.some((record) => record.event === "QUARANTINED")) {
    phases.push("moved-pass-2");
  }
  try {
    for (const phase of phases) {
      for (const entry of manifest.entries) {
        await verifyPublishedInventory({
          capability,
          entryId: entry.id,
          phase,
          expectedSummary: entry.preMoveInventory,
        });
      }
    }
  } catch {
    fail("ERR_INTEGRITY", "published quarantine inventory is invalid");
  }
}

async function repositorySnapshot(input, fsApi) {
  const before = await fsApi.lstat(input.repoRoot);
  const realPath = await fsApi.realpath(input.repoRoot);
  if (before.isSymbolicLink() || !before.isDirectory() || realPath !== input.repoRoot) {
    fail("ERR_INTEGRITY", "repository root identity is invalid");
  }
  let topLevel;
  let head;
  let branch;
  try {
    topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: input.repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: input.repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    branch = execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: input.repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    fail("ERR_INTEGRITY", "repository Git evidence is unavailable");
  }
  const after = await fsApi.lstat(input.repoRoot);
  if (
    topLevel !== input.repoRoot || !SHA256.test(head) && !/^[a-f0-9]{40}$/u.test(head) ||
    branch.length === 0 || branch.includes("\0") || branch !== branch.normalize("NFC") ||
    Number(before.dev) !== Number(after.dev) || Number(before.ino) !== Number(after.ino)
  ) fail("ERR_INTEGRITY", "repository evidence is inconsistent");
  return Object.freeze({ dev: Number(before.dev), ino: Number(before.ino), head, branch });
}

async function optionalPointer(capability) {
  try {
    return await readCurrentManifestPointer({ capability });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("ERR_INTEGRITY", "current manifest pointer is invalid");
  }
}

function selectedDigest(replayed) {
  const prepared = replayed.records.find((record) => record.event === "PREPARED");
  if (prepared === undefined) fail("ERR_INTEGRITY", "PREPARED provenance is missing");
  const beforeRestore = preRestoreState(replayed);
  const validated = [...replayed.records].reverse().find((record) => record.event === "VALIDATED");
  const usesValidated = beforeRestore === "VALIDATED" ||
    (beforeRestore === null && replayed.state === "VALIDATED");
  return {
    prepared,
    digest: usesValidated ? validated?.payload.manifestSha256 : prepared.payload.manifestSha256,
    manifestState: usesValidated ? "VALIDATED" : "PREPARED",
  };
}

async function validateSnapshot(capability, input, fsApi) {
  const repository = await repositorySnapshot(input, fsApi);
  let replayed;
  try {
    replayed = await replayJournal({ capability });
  } catch {
    fail("ERR_INTEGRITY", "journal evidence cannot be replayed");
  }
  if (replayed.truncatedTail || !DIRECTIVES.has(replayed.state)) {
    fail("ERR_INTEGRITY", "journal state is incomplete or unsupported");
  }
  const selection = selectedDigest(replayed);
  if (
    selection.prepared.payload.transactionId !== input.transactionId ||
    typeof selection.digest !== "string" || !SHA256.test(selection.digest)
  ) fail("ERR_INTEGRITY", "journal provenance is invalid");
  let manifest;
  try {
    manifest = await readManifestGeneration({ capability, manifestSha256: selection.digest });
  } catch {
    fail("ERR_INTEGRITY", "manifest evidence is invalid");
  }
  if (
    manifest.transactionId !== input.transactionId || manifest.repositoryRoot !== input.repoRoot ||
    manifest.state !== selection.manifestState || manifest.head !== repository.head ||
    (manifest.schemaVersion === 2 &&
      (replayed.schemaVersion !== 2 || manifest.branch !== repository.branch ||
       manifest.repositoryIdentity.dev !== repository.dev || manifest.repositoryIdentity.ino !== repository.ino)) ||
    (manifest.schemaVersion === 1 && replayed.schemaVersion === 2)
  ) fail("ERR_INTEGRITY", "journal, manifest, and repository provenance conflict");

  await validatePublishedInventories({ capability, replayed, manifest });

  const pointer = await optionalPointer(capability);
  if (selection.manifestState === "VALIDATED") {
    if (
      pointer === null || pointer.transactionId !== input.transactionId ||
      pointer.manifestSha256 !== selection.digest
    ) fail("ERR_INTEGRITY", "validated pointer evidence is missing or conflicting");
    if (
      manifest.retentionDays !== 4 || manifest.deletionRequiresConfirmation !== true ||
      manifest.deletionStatus !== "retained" ||
      manifest.deleteAfter !== new Date(Date.parse(manifest.validatedAt) + 96 * 60 * 60 * 1000).toISOString()
    ) fail("ERR_INTEGRITY", "validated retention evidence is invalid");
    if (manifest.schemaVersion === 2) {
      for (const entryId of ["generated-next", "generated-node-modules"]) {
        const evidence = manifest.regeneratedEvidence[entryId];
        const inventoryId = `${manifest.validationAttempt}-${entryId}`;
        try {
          await verifyPublishedInventory({
            capability, entryId: inventoryId, phase: "validation-pass-1",
            expectedSummary: evidence.pass1Summary,
          });
          await verifyPublishedInventory({
            capability, entryId: inventoryId, phase: "validation-pass-2",
            expectedSummary: evidence.pass2Summary,
          });
        } catch {
          fail("ERR_INTEGRITY", "regenerated validation inventory is invalid");
        }
      }
    }
  } else if (pointer !== null) {
    fail("ERR_INTEGRITY", "unvalidated run has an active manifest pointer");
  }

  const layouts = hasRestoreEpoch(replayed)
    ? await validateRestoreLayout({ capability, fsApi, input, replayed, manifest })
    : await validateApplyLayout({ capability, fsApi, input, replayed, manifest });
  const tip = replayed.records.at(-1);
  return Object.freeze({
    state: replayed.state,
    tip: tip.recordHash,
    manifestSha256: selection.digest,
    pointer,
    repository,
    layouts,
  });
}

function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function publicDirective(state) {
  const [complete, nextAction] = DIRECTIVES.get(state);
  return Object.freeze({ schemaVersion: 1, state, complete, nextAction });
}

export async function reconcileQuarantine(options) {
  const input = snapshotOptions(options);
  try {
    return await withQuarantineRunCapability({
      repoRoot: input.repoRoot,
      quarantineRoot: input.quarantineRoot,
      transactionId: input.transactionId,
      writersStopped: true,
      ...(input.fsApi === undefined ? {} : { fsApi: input.fsApi }),
    }, async (capability) => {
      const fsApi = getRunFsContext(capability);
      const first = await validateSnapshot(capability, input, fsApi);
      const second = await validateSnapshot(capability, input, fsApi);
      if (!sameSnapshot(first, second)) {
        fail("ERR_INTEGRITY", "quarantine evidence changed during reconciliation");
      }
      return publicDirective(second.state);
    });
  } catch (error) {
    if (error instanceof ReconciliationError) throw error;
    if (error?.code === "ERR_RUN_CAPABILITY_PREFLIGHT") {
      fail("ERR_PREFLIGHT", "repository or quarantine root is unavailable");
    }
    fail("ERR_INTEGRITY", "quarantine reconciliation failed closed");
  }
}
