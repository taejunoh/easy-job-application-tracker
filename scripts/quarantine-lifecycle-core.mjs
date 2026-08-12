import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  readCurrentManifestPointer,
  readManifestGeneration,
} from "./quarantine-manifest.mjs";
import { replayJournal } from "./quarantine-journal.mjs";
import { summarizeInventoryDirectory, hashVerifiedRegularFile } from "./quarantine-inventory-reader.mjs";
import { captureRunFsSource, getRunFsContext } from "./quarantine-run-fs-context.mjs";
import { deriveRunPath, withQuarantineRunCapability } from "./quarantine-run-capability.mjs";
import { buildRestoreLedger } from "./quarantine-restore-ledger.mjs";
import { isRestoreRecoveryCallback } from "./quarantine-lifecycle-recovery-context.mjs";

const OPTION_KEYS = Object.freeze([
  "repoRoot", "quarantineRoot", "transactionId", "writersStopped", "fsApi",
]);

function frozenRecord(entries) {
  const result = Object.create(null);
  for (const [key, value] of entries) {
    Object.defineProperty(result, key, {
      value, enumerable: true, configurable: false, writable: false,
    });
  }
  return Object.freeze(result);
}

function snapshotOptions(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("existing quarantine run options must be a plain object");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("existing quarantine run options must be a plain object");
  }
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string" || !OPTION_KEYS.includes(key)) ||
      OPTION_KEYS.slice(0, 4).some((key) => !keys.includes(key))) {
    throw new TypeError("existing quarantine run options are invalid");
  }
  const result = Object.create(null);
  for (const key of OPTION_KEYS) if (keys.includes(key)) result[key] = input[key];
  if (result.writersStopped !== true) {
    throw new TypeError("writers-stopped attestation must be true");
  }
  return Object.freeze(result);
}

function gitEvidence(repoRoot) {
  const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head)) {
    throw new Error("repository HEAD is invalid");
  }
  return { topLevel, head };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function repositoryEvidence(repoRoot, fsApi) {
  const before = await fsApi.lstat(repoRoot);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error("repository root identity is invalid");
  }
  const realPath = await fsApi.realpath(repoRoot);
  if (realPath !== repoRoot) throw new Error("repository root is not canonical");
  const git = gitEvidence(repoRoot);
  if (git.topLevel !== repoRoot) throw new Error("repository root is not the Git top level");
  const after = await fsApi.lstat(repoRoot);
  if (!sameIdentity(before, after)) throw new Error("repository root identity changed");
  return frozenRecord([
    ["dev", before.dev],
    ["ino", before.ino],
    ["realPath", realPath],
    ["head", git.head],
  ]);
}

function journalTip(replayed) {
  const record = replayed.records.at(-1);
  if (record === undefined || replayed.state === null) throw new Error("quarantine journal is empty");
  return frozenRecord([
    ["sequence", record.sequence],
    ["recordHash", record.recordHash],
    ["event", record.event],
    ["state", replayed.state],
    ["payload", Object.freeze(record.payload)],
  ]);
}

function restoreProvenance(replayed) {
  let state = null;
  let restored = null;
  let restoreActive = false;
  for (const record of replayed.records) {
    if (record.event === "RESTORE_PREPARED") {
      restored = state;
      restoreActive = true;
    }
    state = record.event === "PREPARED" ? "PREPARED" : state;
    // replayJournal has already established transition correctness. These are
    // the only provenance states accepted at this boundary.
    if (record.event === "QUARANTINED" || record.event === "RESTORE_ABORTED_TO_QUARANTINED") state = "QUARANTINED";
    if (record.event === "VALIDATED" || record.event === "RESTORE_ABORTED_TO_VALIDATED") state = "VALIDATED";
    if (record.event === "RESTORE_PREPARED") state = "RESTORE_PREPARED";
    if (record.event === "RESTORED" || record.event.startsWith("RESTORE_ABORTED_")) {
      restoreActive = false;
    }
  }
  return { active: restoreActive, state: restored };
}

function modeOf(stat) { return stat.mode & 0o7777; }

async function captureWorkspaceAncestors(repoRoot, endpoint, fsApi) {
  const relativeEndpoint = relative(repoRoot, endpoint);
  if (
    relativeEndpoint === "" || relativeEndpoint === ".." ||
    relativeEndpoint.startsWith(`..${sep}`) || isAbsolute(relativeEndpoint)
  ) throw new Error("restore workspace endpoint escapes repository");
  const paths = [repoRoot];
  let current = repoRoot;
  for (const component of relativeEndpoint.split(sep).slice(0, -1)) {
    current = join(current, component);
    paths.push(current);
  }
  const identities = [];
  for (const path of paths) {
    const stat = await fsApi.lstat(path);
    const resolved = await fsApi.realpath(path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || resolved !== path) {
      throw new Error("restore workspace ancestor is unsafe");
    }
    if (path !== repoRoot && !resolved.startsWith(`${repoRoot}${sep}`)) {
      throw new Error("restore workspace ancestor escapes repository");
    }
    identities.push(Object.freeze({
      path, dev: stat.dev, ino: stat.ino, mode: modeOf(stat),
      type: "directory", canonicalRealpath: resolved,
    }));
  }
  return identities;
}

async function assertWorkspaceAncestors(identities, fsApi) {
  for (const expected of identities) {
    const stat = await fsApi.lstat(expected.path);
    const resolved = await fsApi.realpath(expected.path);
    if (
      stat.isSymbolicLink() || !stat.isDirectory() || resolved !== expected.canonicalRealpath ||
      stat.dev !== expected.dev || stat.ino !== expected.ino || modeOf(stat) !== expected.mode
    ) throw new Error("restore workspace ancestor changed");
  }
}

async function optionalStat(path, fsApi) {
  try { return await fsApi.lstat(path); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function privateTreeSummary(root, fsApi) {
  const rootStat = await optionalStat(root, fsApi);
  if (rootStat === null) return null;
  return summarizeInventoryDirectory(root, { fsApi });
}

function sameSummary(expected, observed) {
  return observed !== null && expected !== null &&
    expected.sha256 === observed.sha256 && expected.entries === observed.entries && expected.bytes === observed.bytes;
}

async function verifySourceEndpoint(path, entry, expectedPresent, fsApi, ancestorChain = Object.freeze([])) {
  const stat = await optionalStat(path, fsApi);
  if (!expectedPresent) {
    if (stat !== null) throw new Error("restore source endpoint should be absent");
    return;
  }
  if (stat === null || stat.isSymbolicLink() || !stat.isFile() || modeOf(stat) !== entry.mode || stat.size !== entry.size) {
    throw new Error("restore source endpoint is invalid");
  }
  const hashed = await hashVerifiedRegularFile(path, stat, fsApi, ancestorChain);
  if (hashed.bytes !== entry.size || hashed.sha256 !== entry.sha256) {
    throw new Error("restore source endpoint content is invalid");
  }
}

async function verifyRestoreLocations({ capability, repoRoot, manifest, ledger, fsApi }) {
  const intended = new Set(ledger.intents);
  for (const entry of manifest.entries) {
    const completed = ledger.completed.has(entry.id);
    const rollbackPending = ledger.rollbackIntents.has(entry.id) && !ledger.rollbackCompleted.has(entry.id);
    const rolledBack = ledger.rollbackCompleted.has(entry.id);
    const forward = intended.has(entry.id) && !rolledBack;
    const payload = deriveRunPath(capability, { purpose: "payload", id: entry.id });
    const active = join(repoRoot, ...entry.relativePath.split("/"));
    const ancestors = await captureWorkspaceAncestors(repoRoot, active, fsApi);
    if (entry.kind === "source-copy") {
      const payloadStat = await optionalStat(payload, fsApi);
      const activeStat = await optionalStat(active, fsApi);
      const payloadPresent = payloadStat !== null;
      const activePresent = activeStat !== null;
      const legal = (!forward || rolledBack)
        ? payloadPresent && !activePresent
        : rollbackPending
          ? (payloadPresent && !activePresent) || (!payloadPresent && activePresent)
          : !completed
            ? (payloadPresent && !activePresent) || (!payloadPresent && activePresent)
            : !payloadPresent && activePresent;
      if (!legal) throw new Error("restore source locations are inconsistent with its ledger state");
      await verifySourceEndpoint(payload, entry, payloadPresent, fsApi);
      await verifySourceEndpoint(active, entry, activePresent, fsApi, ancestors);
      await assertWorkspaceAncestors(ancestors, fsApi);
      continue;
    }
    const activeExpected = ledger.active.get(entry.id);
    const payloadObserved = await privateTreeSummary(payload, fsApi);
    const activeObserved = await privateTreeSummary(active, fsApi);
    // A crash before the active->rollback rename has no per-restore parent
    // yet.  Derive the stable rollback root first; rollback-entry deliberately
    // requires its parent to exist and is therefore only safe after creation.
    const rollbackObserved = activeExpected === null
      ? null
      : await privateTreeSummary(join(
        deriveRunPath(capability, { purpose: "rollback", id: ledger.restoreId }),
        entry.id === "generated-next" ? ".next" : "node_modules",
      ), fsApi);
    const original = entry.preMoveInventory;
    const initial = sameSummary(original, payloadObserved) &&
      (activeExpected === null ? activeObserved === null : sameSummary(activeExpected, activeObserved)) &&
      rollbackObserved === null;
    const staging = sameSummary(original, payloadObserved) && activeObserved === null &&
      (activeExpected === null ? rollbackObserved === null : sameSummary(activeExpected, rollbackObserved));
    const final = payloadObserved === null && sameSummary(original, activeObserved) &&
      (activeExpected === null ? rollbackObserved === null : sameSummary(activeExpected, rollbackObserved));
    const legal = (!forward || rolledBack)
      ? initial
      : rollbackPending
        ? initial || staging || final
        : !completed
          ? initial || staging || final
          : final;
    if (!legal) throw new Error("restore generated locations are inconsistent with its ledger state");
    await assertWorkspaceAncestors(ancestors, fsApi);
  }
}

async function readPointer(capability) {
  try {
    return await readCurrentManifestPointer({ capability });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function validateExistingRun(capability, options, fsApi, { allowRestoreLocationConflict = false } = {}) {
  const repository = await repositoryEvidence(options.repoRoot, fsApi);
  const replayed = await replayJournal({ capability });
  if (replayed.truncatedTail) {
    throw new Error("existing quarantine journal has a torn tail");
  }
  const prepared = replayed.records.find((record) => record.event === "PREPARED");
  if (prepared === undefined || prepared.payload.transactionId !== options.transactionId) {
    throw new Error("PREPARED journal provenance is invalid");
  }
  const restore = restoreProvenance(replayed);
  const restoreContext = restore.active && new Set([
    "RESTORE_PREPARED", "RESTORING", "RECOVERY_REQUIRED", "RESTORE_ROLLING_BACK", "INCOMPLETE_CONFLICT",
  ]).has(replayed.state);
  const provenanceState = restoreContext ? restore.state : replayed.state;
  if (provenanceState !== "QUARANTINED" && provenanceState !== "VALIDATED") {
    throw new Error("quarantine run is not in an existing lifecycle state");
  }
  const validated = provenanceState === "VALIDATED";
  const validatedRecord = validated
    ? [...replayed.records].reverse().find((record) => record.event === "VALIDATED")
    : undefined;
  if (validated && validatedRecord === undefined) throw new Error("VALIDATED provenance is missing");
  const manifestSha256 = validated ? validatedRecord.payload.manifestSha256 : prepared.payload.manifestSha256;
  const manifest = await readManifestGeneration({ capability, manifestSha256 });
  const expectedManifestState = validated ? "VALIDATED" : "PREPARED";
  if (
    manifest.transactionId !== options.transactionId ||
    manifest.repositoryRoot !== options.repoRoot ||
    manifest.state !== expectedManifestState ||
    manifest.head !== repository.head
  ) {
    throw new Error("quarantine lifecycle provenance does not match the live repository");
  }
  if (restoreContext && replayed.state !== "INCOMPLETE_CONFLICT") {
    const ledger = buildRestoreLedger(replayed, manifest);
    try {
      await verifyRestoreLocations({
        capability,
        repoRoot: options.repoRoot,
        manifest,
        ledger,
        fsApi,
      });
    } catch (error) {
      // Only recovery may inspect a durable-but-mismatched restore and turn it
      // into INCOMPLETE_CONFLICT.  Generic lifecycle callers retain the
      // fail-closed validation boundary; structural/provenance and ancestor
      // failures are always fatal.
      if (!allowRestoreLocationConflict ||
          !/restore (?:source|generated) locations are inconsistent|restore source endpoint is invalid|restore source endpoint content is invalid/u.test(error?.message ?? "")) {
        throw error;
      }
    }
  }

  const pointer = await readPointer(capability);
  if (!validated && pointer !== null) {
    throw new Error("QUARANTINED runs must not have an active manifest pointer");
  }
  if (validated && pointer !== null &&
      (pointer.transactionId !== options.transactionId || pointer.manifestSha256 !== manifestSha256)) {
    throw new Error("current manifest pointer does not match validated provenance");
  }
  if (validated) {
    const expectedDeleteAfter = new Date(
      Date.parse(manifest.validatedAt) + (4 * 24 * 60 * 60 * 1000),
    ).toISOString();
    if (
      manifest.retentionDays !== 4 ||
      manifest.deletionRequiresConfirmation !== true ||
      manifest.deletionStatus !== "retained" ||
      manifest.deleteAfter !== expectedDeleteAfter
    ) {
      throw new Error("VALIDATED retention evidence is invalid");
    }
  }

  const journalPath = deriveRunPath(capability, { purpose: "journal" });
  const runRoot = dirname(journalPath);
  return frozenRecord([
    ["repository", repository],
    ["runRoot", runRoot],
    ["head", manifest.head],
    ["journalTip", journalTip(replayed)],
    ["manifestGeneration", frozenRecord([
      ["manifestSha256", manifestSha256],
      ["state", manifest.state],
      ["manifest", manifest],
    ])],
    ["pointer", pointer],
  ]);
}

function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function withExistingQuarantineRun(options, callback) {
  const input = snapshotOptions(options);
  if (typeof callback !== "function") throw new TypeError("existing quarantine run callback must be a function");
  const recovery = Object.freeze({ allowRestoreLocationConflict: isRestoreRecoveryCallback(callback) });
  const source = captureRunFsSource(input.fsApi);
  return withQuarantineRunCapability({
    repoRoot: input.repoRoot,
    quarantineRoot: input.quarantineRoot,
    transactionId: input.transactionId,
    writersStopped: true,
    fsApi: source,
  }, async (capability) => {
    const fsApi = getRunFsContext(capability, source);
    const validated = await validateExistingRun(capability, input, fsApi, recovery);
    // Re-read every mutable evidence boundary immediately before capability
    // handoff.  This is cooperative TOCTOU detection; all reads still use the
    // exact adapter captured synchronously above.
    const stable = await validateExistingRun(capability, input, fsApi, recovery);
    if (
      !sameSnapshot(validated.repository, stable.repository) ||
      !sameSnapshot(validated.journalTip, stable.journalTip) ||
      !sameSnapshot(validated.manifestGeneration, stable.manifestGeneration) ||
      !sameSnapshot(validated.pointer, stable.pointer)
    ) {
      throw new Error("quarantine lifecycle evidence changed before callback");
    }
    const handoff = frozenRecord([
      ["capability", capability],
      ["repoRoot", input.repoRoot],
      ["quarantineRoot", input.quarantineRoot],
      ["runRoot", validated.runRoot],
      ["transactionId", input.transactionId],
      ["head", validated.head],
      ["journalTip", validated.journalTip],
      ["manifestGeneration", validated.manifestGeneration],
      ["fsApi", fsApi],
    ]);
    return callback(handoff);
  });
}
