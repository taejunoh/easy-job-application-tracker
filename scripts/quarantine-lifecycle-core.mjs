import { execFileSync } from "node:child_process";
import { createReadStream, lstatSync, realpathSync } from "node:fs";
import {
  link, lstat, mkdir, open, opendir, readdir, readlink, realpath, rename, rm, unlink,
} from "node:fs/promises";
import { dirname } from "node:path";

import {
  readCurrentManifestPointer,
  readManifestGeneration,
} from "./quarantine-manifest.mjs";
import { replayJournal } from "./quarantine-journal.mjs";
import { getRunFsContext } from "./quarantine-run-fs-context.mjs";
import { deriveRunPath, withQuarantineRunCapability } from "./quarantine-run-capability.mjs";

const METHODS = Object.freeze([
  "lstat", "realpath", "mkdir", "open", "readdir", "rm", "rename", "unlink", "link",
  "opendir", "readlink", "createReadStream", "lstatSync", "realpathSync",
]);
const DEFAULT_FS = Object.freeze({
  lstat, realpath, mkdir, open, readdir, rm, rename, unlink, link, opendir, readlink,
  createReadStream, lstatSync, realpathSync,
});
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

/* Capture before the first await.  The captured record is deliberately the
 * source passed to the capability boundary: a later caller mutation can never
 * change either the receiver or implementation used by this lifecycle. */
function captureFsSource(candidate) {
  const original = candidate === undefined ? DEFAULT_FS : candidate;
  if (original === null || typeof original !== "object" || Array.isArray(original)) {
    throw new TypeError("filesystem adapter must be a plain object");
  }
  const prototype = Object.getPrototypeOf(original);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("filesystem adapter must be a plain object");
  }
  const entries = [];
  for (const name of METHODS) {
    const method = original[name];
    if (typeof method !== "function") throw new TypeError(`filesystem adapter must provide ${name}`);
    entries.push([name, (...args) => Reflect.apply(method, original, args)]);
  }
  return frozenRecord(entries);
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

async function readPointer(capability) {
  try {
    return await readCurrentManifestPointer({ capability });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function validateExistingRun(capability, options, fsApi) {
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
    "RESTORE_PREPARED", "RESTORING", "RECOVERY_REQUIRED", "RESTORE_ROLLING_BACK",
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
  const source = captureFsSource(input.fsApi);
  return withQuarantineRunCapability({
    repoRoot: input.repoRoot,
    quarantineRoot: input.quarantineRoot,
    transactionId: input.transactionId,
    writersStopped: true,
    fsApi: source,
  }, async (capability) => {
    const fsApi = getRunFsContext(capability, source);
    const validated = await validateExistingRun(capability, input, fsApi);
    // Re-read every mutable evidence boundary immediately before capability
    // handoff.  This is cooperative TOCTOU detection; all reads still use the
    // exact adapter captured synchronously above.
    const stable = await validateExistingRun(capability, input, fsApi);
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
