import { createHash, randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { dirname } from "node:path";

import { parseInventorySummary } from "./quarantine-inventory.mjs";
import {
  deriveRunPath,
  revalidateRunCapability,
} from "./quarantine-run-capability.mjs";

const ZERO_HASH = "0".repeat(64);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const ENVELOPE_KEYS = ["sequence", "previousHash", "event", "payload", "recordHash"];
const LOCK_KEYS = ["version", "ownerToken", "pid", "checksum"];
const OWNER_TOKEN_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const TOMBSTONE_TOKEN_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const LOCK_BODY_PREFIX = '{"version":1,"ownerToken":"';
const LOCK_BODY_AFTER_OWNER = '","pid":';
const LOCK_BODY_AFTER_PID = ',"checksum":"';
const LOCK_BODY_SUFFIX = '"}';
const OWNER_TOKEN_BYTES = 36;
const CHECKSUM_BYTES = 64;
const LOCK_BODY_FIXED_BYTES =
  LOCK_BODY_PREFIX.length +
  OWNER_TOKEN_BYTES +
  LOCK_BODY_AFTER_OWNER.length +
  LOCK_BODY_AFTER_PID.length +
  CHECKSUM_BYTES +
  LOCK_BODY_SUFFIX.length;
const MIN_LOCK_BODY_BYTES = LOCK_BODY_FIXED_BYTES + 1;
const MAX_LOCK_BODY_BYTES = LOCK_BODY_FIXED_BYTES + String(Number.MAX_SAFE_INTEGER).length;
const ENTRY_ID = /^(?:copy-(?!0000)[0-9]{4}|generated-next|generated-node-modules)$/u;
const TRANSACTION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;

export class IndeterminateJournalAppendError extends Error {
  constructor({ cause, expectedSequence, expectedRecordHash }) {
    super("journal append is indeterminate after mutation began", { cause });
    this.name = "IndeterminateJournalAppendError";
    this.code = "ERR_INDETERMINATE_JOURNAL_APPEND";
    this.expectedSequence = expectedSequence;
    this.expectedRecordHash = expectedRecordHash;
  }
}

function attachCleanupError(primaryError, cleanupError) {
  if (!(primaryError instanceof Error)) {
    return new AggregateError(
      [primaryError, cleanupError],
      "journal recovery and lock cleanup both failed",
    );
  }
  const causes =
    primaryError.cause instanceof AggregateError
      ? [...primaryError.cause.errors, cleanupError]
      : primaryError.cause === undefined
        ? [cleanupError]
        : [primaryError.cause, cleanupError];
  primaryError.cause = new AggregateError(
    causes,
    "journal recovery and lock cleanup both failed",
  );
  primaryError.cleanupError = cleanupError;
  return primaryError;
}

async function closePreservingPrimary(handle, primaryError) {
  let closeError;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError !== undefined) {
    throw closeError === undefined
      ? primaryError
      : attachCleanupError(primaryError, closeError);
  }
  if (closeError !== undefined) throw closeError;
}

async function withHandle(handle, callback) {
  let result;
  let primaryError;
  try {
    result = await callback(handle);
  } catch (error) {
    primaryError = error;
  }
  await closePreservingPrimary(handle, primaryError);
  return result;
}

const TRANSITIONS = new Map([
  ["<START>", new Map([["PREPARED", "PREPARED"]])],
  ["PREPARED", new Map([["MOVING", "MOVING"]])],
  [
    "MOVING",
    new Map([
      ["MOVE_INTENT", "MOVING"],
      ["MOVED", "MOVING"],
      ["VERIFYING", "VERIFYING"],
      ["RECOVERY_REQUIRED", "RECOVERY_REQUIRED"],
      ["INCOMPLETE_CONFLICT", "INCOMPLETE_CONFLICT"],
    ]),
  ],
  [
    "VERIFYING",
    new Map([
      ["QUARANTINED", "QUARANTINED"],
      ["RECOVERY_REQUIRED", "RECOVERY_REQUIRED"],
      ["INCOMPLETE_CONFLICT", "INCOMPLETE_CONFLICT"],
    ]),
  ],
  [
    "RECOVERY_REQUIRED",
    new Map([
      ["MOVING", "MOVING"],
      ["RESTORING", "RESTORING"],
      ["ROLLING_BACK", "ROLLING_BACK"],
      ["INCOMPLETE_CONFLICT", "INCOMPLETE_CONFLICT"],
    ]),
  ],
  [
    "ROLLING_BACK",
    new Map([
      ["ROLLBACK_INTENT", "ROLLING_BACK"],
      ["ROLLED_BACK_ENTRY", "ROLLING_BACK"],
      ["ROLLED_BACK", "ROLLED_BACK"],
      ["INCOMPLETE_CONFLICT", "INCOMPLETE_CONFLICT"],
    ]),
  ],
  [
    "QUARANTINED",
    new Map([
      ["VALIDATED", "VALIDATED"],
      ["RESTORE_PREPARED", "RESTORE_PREPARED"],
    ]),
  ],
  ["VALIDATED", new Map([["RESTORE_PREPARED", "RESTORE_PREPARED"]])],
  ["RESTORE_PREPARED", new Map([["RESTORING", "RESTORING"]])],
  [
    "RESTORING",
    new Map([
      ["RESTORE_INTENT", "RESTORING"],
      ["RESTORED_ENTRY", "RESTORING"],
      ["RESTORED", "RESTORED"],
      ["RECOVERY_REQUIRED", "RECOVERY_REQUIRED"],
      ["INCOMPLETE_CONFLICT", "INCOMPLETE_CONFLICT"],
    ]),
  ],
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON rejects non-finite numbers");
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError("payload is not canonical JSON");
  }
  if (seen.has(value)) throw new TypeError("canonical JSON rejects cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, seen));
    if (!isPlainObject(value)) throw new TypeError("payload must contain plain objects");
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (key !== key.normalize("NFC") || key.includes("\0")) {
        throw new TypeError("payload keys must be normalized");
      }
      result[key] = canonicalize(value[key], seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function canonicalHashInput(sequence, previousHash, event, payload) {
  return JSON.stringify({ sequence, previousHash, event, payload });
}

function assertPayloadKeys(payload, expectedKeys, event) {
  if (!isPlainObject(payload)) throw new TypeError(`${event} payload must be a plain object`);
  for (const key of Object.keys(payload)) {
    if (!expectedKeys.includes(key)) throw new TypeError(`unknown field in ${event} payload: ${key}`);
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(payload, key)) throw new TypeError(`missing field in ${event} payload: ${key}`);
  }
}

function parseEntryId(value) {
  if (typeof value !== "string" || value.length > 128 || !ENTRY_ID.test(value)) {
    throw new TypeError("journal payload entry ID is invalid");
  }
  return value;
}

function parseManifestSha256(value) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new TypeError("journal payload manifest hash is invalid");
  }
  return value;
}

function parseEmptyPayload(event, payload) {
  assertPayloadKeys(payload, [], event);
  return Object.freeze({});
}

function parseEntryPayload(event, payload) {
  assertPayloadKeys(payload, ["id"], event);
  return Object.freeze({ id: parseEntryId(payload.id) });
}

function parseSortedEntryIds(event, payload, key) {
  assertPayloadKeys(payload, [key], event);
  if (!Array.isArray(payload[key]) || payload[key].length === 0) {
    throw new TypeError(`${event} payload ${key} must be a non-empty array`);
  }
  const values = payload[key].map((value) => parseEntryId(value));
  for (let index = 1; index < values.length; index += 1) {
    if (Buffer.compare(Buffer.from(values[index - 1]), Buffer.from(values[index])) >= 0) {
      throw new TypeError(`${event} payload ${key} must be bytewise sorted and unique`);
    }
  }
  return Object.freeze({ [key]: Object.freeze(values) });
}

const EVENT_PAYLOAD_PARSERS = Object.freeze({
  PREPARED(payload) {
    assertPayloadKeys(payload, ["transactionId", "manifestSha256"], "PREPARED");
    if (
      typeof payload.transactionId !== "string" ||
      payload.transactionId === "." ||
      payload.transactionId === ".." ||
      payload.transactionId !== payload.transactionId.normalize("NFC") ||
      !TRANSACTION_ID.test(payload.transactionId)
    ) {
      throw new TypeError("PREPARED payload transaction ID is invalid");
    }
    return Object.freeze({
      manifestSha256: parseManifestSha256(payload.manifestSha256),
      transactionId: payload.transactionId,
    });
  },
  MOVING: (payload) => parseEmptyPayload("MOVING", payload),
  MOVE_INTENT(payload) {
    assertPayloadKeys(payload, ["id", "expected"], "MOVE_INTENT");
    return Object.freeze({
      expected: parseInventorySummary(payload.expected),
      id: parseEntryId(payload.id),
    });
  },
  MOVED(payload) {
    assertPayloadKeys(payload, ["id", "observed"], "MOVED");
    return Object.freeze({
      id: parseEntryId(payload.id),
      observed: parseInventorySummary(payload.observed),
    });
  },
  VERIFYING: (payload) => parseEmptyPayload("VERIFYING", payload),
  QUARANTINED: (payload) => parseEmptyPayload("QUARANTINED", payload),
  VALIDATED(payload) {
    assertPayloadKeys(payload, ["manifestSha256"], "VALIDATED");
    return Object.freeze({ manifestSha256: parseManifestSha256(payload.manifestSha256) });
  },
  RECOVERY_REQUIRED: (payload) =>
    parseSortedEntryIds("RECOVERY_REQUIRED", payload, "entryIds"),
  ROLLING_BACK: (payload) => parseEmptyPayload("ROLLING_BACK", payload),
  ROLLBACK_INTENT: (payload) => parseEntryPayload("ROLLBACK_INTENT", payload),
  ROLLED_BACK_ENTRY: (payload) => parseEntryPayload("ROLLED_BACK_ENTRY", payload),
  ROLLED_BACK: (payload) => parseEmptyPayload("ROLLED_BACK", payload),
  INCOMPLETE_CONFLICT: (payload) =>
    parseSortedEntryIds("INCOMPLETE_CONFLICT", payload, "conflictEntryIds"),
  RESTORE_PREPARED: (payload) => parseEmptyPayload("RESTORE_PREPARED", payload),
  RESTORING: (payload) => parseEmptyPayload("RESTORING", payload),
  RESTORE_INTENT: (payload) => parseEntryPayload("RESTORE_INTENT", payload),
  RESTORED_ENTRY: (payload) => parseEntryPayload("RESTORED_ENTRY", payload),
  RESTORED: (payload) => parseEmptyPayload("RESTORED", payload),
});

for (const transitions of TRANSITIONS.values()) {
  for (const event of transitions.keys()) {
    if (!Object.hasOwn(EVENT_PAYLOAD_PARSERS, event)) {
      throw new Error(`journal transition has no payload parser: ${event}`);
    }
  }
}

function parseEventPayload(event, payload) {
  const parser = EVENT_PAYLOAD_PARSERS[event];
  if (parser === undefined) throw new Error(`journal event has no payload parser: ${event}`);
  return parser(payload);
}

function hashRecord(sequence, previousHash, event, payload) {
  return createHash("sha256")
    .update(canonicalHashInput(sequence, previousHash, event, payload))
    .digest("hex");
}

function assertExactEnvelope(value) {
  if (!isPlainObject(value)) throw new Error("malformed journal envelope");
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!ENVELOPE_KEYS.includes(key)) throw new Error(`unknown field: ${key}`);
  }
  if (keys.length !== ENVELOPE_KEYS.length || keys.some((key, index) => key !== ENVELOPE_KEYS[index])) {
    throw new Error("journal envelope is not canonical");
  }
}

export function validateTransition(state, event) {
  if (state !== null && typeof state !== "string") {
    throw new TypeError("journal state is invalid");
  }
  if (typeof event !== "string") throw new TypeError("journal event is invalid");
  const nextState = TRANSITIONS.get(state ?? "<START>")?.get(event);
  if (nextState === undefined) {
    throw new Error(`illegal journal transition: ${state ?? "<START>"} -> ${event}`);
  }
  return nextState;
}

function validateFrame(record, rawBody, expectedSequence, expectedPreviousHash, state) {
  assertExactEnvelope(record);
  if (!Number.isSafeInteger(record.sequence) || record.sequence !== expectedSequence) {
    throw new Error("journal sequence gap");
  }
  if (typeof record.previousHash !== "string" || record.previousHash !== expectedPreviousHash) {
    throw new Error("journal previous hash mismatch");
  }
  if (typeof record.event !== "string") throw new Error("journal event is invalid");
  if (!isPlainObject(record.payload)) throw new Error("journal payload must be a plain object");
  if (typeof record.recordHash !== "string" || !HASH_PATTERN.test(record.recordHash)) {
    throw new Error("journal record hash is invalid");
  }

  const payload = canonicalize(parseEventPayload(record.event, record.payload));
  const canonicalRecord = {
    sequence: record.sequence,
    previousHash: record.previousHash,
    event: record.event,
    payload,
    recordHash: record.recordHash,
  };
  if (!rawBody.equals(Buffer.from(JSON.stringify(canonicalRecord)))) {
    throw new Error("journal frame is not canonical");
  }
  const expectedHash = hashRecord(
    record.sequence,
    record.previousHash,
    record.event,
    payload,
  );
  if (record.recordHash !== expectedHash) throw new Error("journal record hash mismatch");
  return { record: canonicalRecord, state: validateTransition(state, record.event) };
}

function replayJournalBuffer(input) {
  const records = [];
  let state = null;
  let offset = 0;
  let truncatedTail = false;
  while (offset < input.length) {
    if (input.length - offset < 4) {
      truncatedTail = true;
      break;
    }
    const frameLength = input.readUInt32BE(offset);
    if (frameLength > MAX_FRAME_BYTES) throw new Error("journal frame is too large");
    const bodyStart = offset + 4;
    const bodyEnd = bodyStart + frameLength;
    if (bodyEnd > input.length) {
      truncatedTail = true;
      break;
    }
    const rawBody = input.subarray(bodyStart, bodyEnd);
    let parsed;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch (error) {
      throw new Error(`malformed journal frame at sequence ${records.length + 1}`, {
        cause: error,
      });
    }
    const validated = validateFrame(
      parsed,
      rawBody,
      records.length + 1,
      records.at(-1)?.recordHash ?? ZERO_HASH,
      state,
    );
    records.push(validated.record);
    state = validated.state;
    offset = bodyEnd;
  }
  return { records, state, validEndOffset: offset, truncatedTail };
}

async function writeComplete(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer.subarray(offset));
    if (bytesWritten <= 0) throw new Error("durable write made no progress");
    offset += bytesWritten;
  }
}

async function readCompleteFile(handle, maxBytes = MAX_FRAME_BYTES) {
  const before = await handle.stat();
  if (!before.isFile()) throw new Error("journal must be a regular file");
  if (before.size > maxBytes) throw new Error("journal is too large");
  const input = Buffer.alloc(before.size);
  let offset = 0;
  while (offset < input.length) {
    const { bytesRead } = await handle.read(input, offset, input.length - offset, offset);
    if (bytesRead <= 0) throw new Error("journal changed while being read");
    offset += bytesRead;
  }
  const after = await handle.stat();
  if (after.size !== before.size) throw new Error("journal changed while being read");
  return input;
}

async function fsyncDirectory(path, fsApi) {
  const parent = await fsApi.open(path, "r");
  await withHandle(parent, (handle) => handle.sync());
}

function lockChecksum(version, ownerToken, pid) {
  return createHash("sha256")
    .update(JSON.stringify({ version, ownerToken, pid }))
    .digest("hex");
}

function encodeLockFrame() {
  const version = 1;
  const ownerToken = randomUUID();
  const pid = process.pid;
  const checksum = lockChecksum(version, ownerToken, pid);
  const metadata = { version, ownerToken, pid, checksum };
  const body = Buffer.from(JSON.stringify(metadata));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return { metadata, frame: Buffer.concat([length, body]) };
}

function malformedLock(message, cause) {
  return new Error(`malformed journal lock: ${message}`, cause === undefined ? undefined : { cause });
}

function lockLengthPrefixIsPossible(input) {
  for (let bodyLength = MIN_LOCK_BODY_BYTES; bodyLength <= MAX_LOCK_BODY_BYTES; bodyLength += 1) {
    const encoded = Buffer.alloc(4);
    encoded.writeUInt32BE(bodyLength);
    if (encoded.subarray(0, input.length).equals(input)) return true;
  }
  return false;
}

function canonicalLockBodyPattern(pidDigits) {
  const exact = (value) => [...value].map((character) => `=${character}`);
  const pattern = [...exact(LOCK_BODY_PREFIX)];
  for (let index = 0; index < OWNER_TOKEN_BYTES; index += 1) {
    if ([8, 13, 18, 23].includes(index)) pattern.push("=-");
    else if (index === 14) pattern.push("uuid-version");
    else if (index === 19) pattern.push("uuid-variant");
    else pattern.push("hex");
  }
  pattern.push(...exact(LOCK_BODY_AFTER_OWNER));
  pattern.push("pid-first", ...Array.from({ length: pidDigits - 1 }, () => "digit"));
  pattern.push(...exact(LOCK_BODY_AFTER_PID));
  pattern.push(...Array.from({ length: CHECKSUM_BYTES }, () => "hex"));
  pattern.push(...exact(LOCK_BODY_SUFFIX));
  return pattern;
}

function lockPatternCharacterIsValid(pattern, character) {
  if (pattern.startsWith("=")) return character === pattern.slice(1);
  if (pattern === "hex") return /^[a-f0-9]$/u.test(character);
  if (pattern === "uuid-version") return /^[1-5]$/u.test(character);
  if (pattern === "uuid-variant") return /^[89ab]$/u.test(character);
  if (pattern === "pid-first") return /^[1-9]$/u.test(character);
  if (pattern === "digit") return /^[0-9]$/u.test(character);
  return false;
}

function assertPossibleCanonicalLockBodyPrefix(rawBody, bodyLength) {
  if ([...rawBody].some((byte) => byte > 0x7f)) {
    throw malformedLock("torn body is not a canonical ASCII prefix");
  }
  const pidDigits = bodyLength - LOCK_BODY_FIXED_BYTES;
  const pattern = canonicalLockBodyPattern(pidDigits);
  if (pattern.length !== bodyLength) throw malformedLock("declared length is impossible");
  const prefix = rawBody.toString("ascii");
  for (let index = 0; index < prefix.length; index += 1) {
    if (!lockPatternCharacterIsValid(pattern[index], prefix[index])) {
      throw malformedLock("torn body is not a canonical prefix");
    }
  }

  const ownerStart = LOCK_BODY_PREFIX.length;
  const ownerEnd = ownerStart + OWNER_TOKEN_BYTES;
  const pidStart = ownerEnd + LOCK_BODY_AFTER_OWNER.length;
  const pidEnd = pidStart + pidDigits;
  const observedPid = prefix.slice(pidStart, Math.min(prefix.length, pidEnd));
  if (observedPid.length > 0) {
    const remainingDigits = pidDigits - observedPid.length;
    const minimumCompletion = BigInt(`${observedPid}${"0".repeat(remainingDigits)}`);
    if (minimumCompletion > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw malformedLock("torn PID prefix cannot complete safely");
    }
  }

  const checksumStart = pidEnd + LOCK_BODY_AFTER_PID.length;
  const observedChecksum = prefix.slice(
    checksumStart,
    Math.min(prefix.length, checksumStart + CHECKSUM_BYTES),
  );
  if (observedChecksum.length > 0) {
    const ownerToken = prefix.slice(ownerStart, ownerEnd);
    const pid = Number(prefix.slice(pidStart, pidEnd));
    if (!lockChecksum(1, ownerToken, pid).startsWith(observedChecksum)) {
      throw malformedLock("torn checksum prefix cannot complete with valid integrity");
    }
  }
}

function parseLockFrame(input) {
  if (input.length === 0) return { torn: true, metadata: null };
  if (input.length < 4) {
    if (!lockLengthPrefixIsPossible(input)) throw malformedLock("length prefix is impossible");
    return { torn: true, metadata: null };
  }

  const bodyLength = input.readUInt32BE(0);
  if (bodyLength < MIN_LOCK_BODY_BYTES || bodyLength > MAX_LOCK_BODY_BYTES) {
    throw malformedLock("declared length is impossible");
  }
  const frameLength = 4 + bodyLength;
  if (input.length < frameLength) {
    assertPossibleCanonicalLockBodyPrefix(input.subarray(4), bodyLength);
    return { torn: true, metadata: null };
  }
  if (input.length !== frameLength) throw malformedLock("frame has trailing bytes");

  const rawBody = input.subarray(4);
  let value;
  try {
    value = JSON.parse(rawBody.toString("utf8"));
  } catch (error) {
    throw malformedLock("frame is not JSON", error);
  }
  if (!isPlainObject(value)) throw malformedLock("metadata must be an object");
  const keys = Object.keys(value);
  if (keys.length !== LOCK_KEYS.length || keys.some((key, index) => key !== LOCK_KEYS[index])) {
    throw malformedLock("metadata schema is invalid");
  }
  if (value.version !== 1) throw malformedLock("version is invalid");
  if (typeof value.ownerToken !== "string" || !OWNER_TOKEN_PATTERN.test(value.ownerToken)) {
    throw malformedLock("owner token is invalid");
  }
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw malformedLock("PID is invalid");
  }
  if (typeof value.checksum !== "string" || !HASH_PATTERN.test(value.checksum)) {
    throw malformedLock("checksum is invalid");
  }
  const expectedChecksum = lockChecksum(value.version, value.ownerToken, value.pid);
  if (value.checksum !== expectedChecksum) throw malformedLock("checksum mismatch");
  const metadata = {
    version: value.version,
    ownerToken: value.ownerToken,
    pid: value.pid,
    checksum: value.checksum,
  };
  if (!rawBody.equals(Buffer.from(JSON.stringify(metadata)))) {
    throw malformedLock("metadata is not canonical");
  }
  return { torn: false, metadata };
}

const heldLockState = new WeakMap();
const TERMINAL_CLEANUP_STATES = new Set([
  "ROLLED_BACK",
  "RESTORED",
  "INCOMPLETE_CONFLICT",
]);
const TOMBSTONE_PREFIX = "journal.lock.tombstone.";

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function indeterminate(candidate, cause) {
  if (cause instanceof IndeterminateJournalAppendError) return cause;
  return new IndeterminateJournalAppendError({
    cause,
    expectedSequence: candidate.sequence,
    expectedRecordHash: candidate.recordHash,
  });
}

async function invokeFaultHook(faultHook, phase) {
  if (faultHook === undefined) return;
  if (typeof faultHook !== "function") throw new TypeError("journal fault hook must be a function");
  await faultHook(phase);
}

async function readJournalSnapshot({ capability, fsApi, maxBytes = MAX_FRAME_BYTES }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("journal maximum bytes must be a non-negative safe integer");
  }
  const journalPath = deriveRunPath(capability, { purpose: "journal" });
  let before;
  try {
    before = await fsApi.lstat(journalPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        bytes: Buffer.alloc(0),
        identity: null,
        journalPath,
        replayed: { records: [], state: null, validEndOffset: 0, truncatedTail: false },
      };
    }
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("journal must be a non-symlink regular file");
  }
  if (before.size > maxBytes) throw new Error("journal is too large");
  const handle = await fsApi.open(journalPath, "r");
  return withHandle(handle, async (openedHandle) => {
    const opened = await openedHandle.stat();
    if (!opened.isFile() || !sameIdentity(before, opened) || opened.size !== before.size) {
      throw new Error("journal changed while being inspected");
    }
    const bytes = await readCompleteFile(openedHandle, maxBytes);
    return {
      bytes,
      identity: { dev: opened.dev, ino: opened.ino },
      journalPath,
      replayed: replayJournalBuffer(bytes),
    };
  });
}

export async function replayJournal({
  capability,
  fsApi = fsPromises,
  maxBytes = MAX_FRAME_BYTES,
}) {
  return (await readJournalSnapshot({ capability, fsApi, maxBytes })).replayed;
}

async function createJournalLock({ capability, fsApi }) {
  const lockPath = deriveRunPath(capability, { purpose: "journal-lock" });
  await revalidateRunCapability(capability, {
    purpose: "journal-lock",
    boundary: "before-mutation",
  });
  let handle;
  try {
    handle = await fsApi.open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("journal append lock already exists", { cause: error });
    }
    throw error;
  }
  try {
    await handle.chmod(0o600);
    const encoded = encodeLockFrame();
    await writeComplete(handle, encoded.frame);
    await handle.sync();
    await fsyncDirectory(dirname(lockPath), fsApi);
    await revalidateRunCapability(capability, {
      purpose: "journal-lock",
      boundary: "after-sync",
    });
    const stat = await handle.stat();
    return {
      handle,
      identity: { dev: stat.dev, ino: stat.ino },
      lockPath,
      metadata: encoded.metadata,
    };
  } catch (error) {
    return closePreservingPrimary(handle, error);
  }
}

async function assertPathIdentity(path, identity, fsApi, label) {
  let current;
  try {
    current = await fsApi.lstat(path);
  } catch (error) {
    throw new Error(`${label} ownership cannot be verified`, { cause: error });
  }
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  ) {
    throw new Error(`${label} ownership mismatch`);
  }
}

async function assertHeldLockOwned(state) {
  if (!state.active) throw new Error("journal held-lock capability is inactive");
  const held = await state.handle.stat();
  if (!held.isFile() || held.dev !== state.identity.dev || held.ino !== state.identity.ino) {
    throw new Error("journal held lock identity changed");
  }
  await assertPathIdentity(state.lockPath, state.identity, state.fsApi, "journal held lock");
  if (!state.active) throw new Error("journal held-lock capability is inactive");
}

async function closeHeldLock(state, primaryError) {
  state.active = false;
  let closeError;
  try {
    await state.handle.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError !== undefined) {
    throw closeError === undefined ? primaryError : attachCleanupError(primaryError, closeError);
  }
  if (closeError !== undefined) throw closeError;
}

async function runWithJournalLock({ capability, fsApi, removeOnSuccess }, callback) {
  if (typeof callback !== "function") throw new TypeError("journal lock callback is required");
  const created = await createJournalLock({ capability, fsApi });
  const heldLock = Object.freeze(Object.create(null));
  const state = {
    ...created,
    active: true,
    appendInProgress: false,
    capability,
    durableAppends: 0,
    fsApi,
    lastCandidate: null,
  };
  heldLockState.set(heldLock, state);
  let result;
  let primaryError;
  let callbackCompleted = false;
  try {
    result = await callback(heldLock);
    callbackCompleted = true;
    if (state.appendInProgress) throw new Error("journal lock callback returned during an append");
    await assertHeldLockOwned(state);
  } catch (error) {
    primaryError =
      callbackCompleted && state.lastCandidate !== null
        ? indeterminate(state.lastCandidate, error)
        : error;
  }
  let settledError;
  try {
    await closeHeldLock(state, primaryError);
  } catch (error) {
    settledError = error;
  } finally {
    heldLockState.delete(heldLock);
  }
  if (
    removeOnSuccess &&
    !(settledError instanceof IndeterminateJournalAppendError)
  ) {
    try {
      await assertPathIdentity(state.lockPath, state.identity, fsApi, "journal held lock");
      await fsApi.rm(state.lockPath);
      await fsyncDirectory(dirname(state.lockPath), fsApi);
    } catch (error) {
      if (settledError !== undefined) throw attachCleanupError(settledError, error);
      throw state.lastCandidate === null ? error : indeterminate(state.lastCandidate, error);
    }
  }
  if (settledError !== undefined) throw settledError;
  return { created, result, state };
}

export async function withJournalLock({ capability, fsApi = fsPromises }, callback) {
  return (await runWithJournalLock({ capability, fsApi, removeOnSuccess: true }, callback)).result;
}

async function writeCompleteAt(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (bytesWritten <= 0) throw new Error("durable write made no progress");
    offset += bytesWritten;
  }
}

async function openJournalForMutation(snapshot, fsApi) {
  const flags = snapshot.identity === null ? "wx+" : "r+";
  if (snapshot.identity !== null) {
    await assertPathIdentity(
      snapshot.journalPath,
      snapshot.identity,
      fsApi,
      "journal",
    );
  }
  const handle = await fsApi.open(snapshot.journalPath, flags, 0o600);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      (snapshot.identity !== null && !sameIdentity(snapshot.identity, opened))
    ) {
      throw new Error("journal changed while being opened for mutation");
    }
    const observed = await readCompleteFile(handle);
    if (!observed.equals(snapshot.bytes)) {
      throw new Error("journal changed before mutation");
    }
    return handle;
  } catch (error) {
    return closePreservingPrimary(handle, error);
  }
}

async function appendUnderHeldLock({ capability, heldLock, event, payload, fsApi, faultHook }) {
  if (!isPlainObject(payload)) throw new TypeError("journal payload must be a plain object");
  const state = heldLockState.get(heldLock);
  if (state === undefined || !state.active) {
    throw new TypeError("journal held-lock capability is forged or inactive");
  }
  if (state.capability !== capability || state.fsApi !== fsApi) {
    throw new TypeError("journal held-lock capability does not match the append boundary");
  }
  if (state.appendInProgress) throw new Error("journal append is already in progress");
  state.appendInProgress = true;
  let candidate;
  let mutationStarted = false;
  let journal;
  let result;
  let primaryError;
  try {
    await assertHeldLockOwned(state);
    const snapshot = await readJournalSnapshot({ capability, fsApi });
    const replayed = snapshot.replayed;
    validateTransition(replayed.state, event);
    const canonicalPayload = canonicalize(parseEventPayload(event, payload));
    const sequence = replayed.records.length + 1;
    const previousHash = replayed.records.at(-1)?.recordHash ?? ZERO_HASH;
    const recordHash = hashRecord(sequence, previousHash, event, canonicalPayload);
    candidate = { sequence, previousHash, event, payload: canonicalPayload, recordHash };
    const body = Buffer.from(JSON.stringify(candidate));
    if (body.length > MAX_FRAME_BYTES) throw new Error("journal frame is too large");
    if (replayed.validEndOffset + 4 + body.length > MAX_FRAME_BYTES) {
      throw new Error("journal is too large");
    }
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);

    await invokeFaultHook(faultHook, "before-mutation");
    await assertHeldLockOwned(state);
    await revalidateRunCapability(capability, {
      purpose: "journal",
      boundary: "before-mutation",
    });
    mutationStarted = true;
    state.lastCandidate = candidate;
    const handle = await openJournalForMutation(snapshot, fsApi);
    journal = { handle, journalPath: snapshot.journalPath };
    await invokeFaultHook(faultHook, "after-journal-open");
    await journal.handle.chmod(0o600);
    if (replayed.truncatedTail) {
      await journal.handle.truncate(replayed.validEndOffset);
      await journal.handle.sync();
      await fsyncDirectory(dirname(journal.journalPath), fsApi);
      await assertHeldLockOwned(state);
    }
    await writeCompleteAt(
      journal.handle,
      Buffer.concat([length, body]),
      replayed.validEndOffset,
    );
    await journal.handle.sync();
    await invokeFaultHook(faultHook, "after-journal-sync");
    await assertHeldLockOwned(state);
    await revalidateRunCapability(capability, {
      purpose: "journal",
      boundary: "after-sync",
    });
    await fsyncDirectory(dirname(journal.journalPath), fsApi);
    await invokeFaultHook(faultHook, "before-lock-cleanup");
    await assertHeldLockOwned(state);
    state.durableAppends += 1;
    result = candidate;
  } catch (error) {
    primaryError =
      mutationStarted && candidate !== undefined
        ? indeterminate(candidate, error)
        : error;
  }
  state.appendInProgress = false;
  if (journal !== undefined) {
    try {
      await closePreservingPrimary(journal.handle, primaryError);
    } catch (error) {
      if (primaryError === undefined && mutationStarted && candidate !== undefined) {
        throw indeterminate(candidate, error);
      }
      throw error;
    }
  } else if (primaryError !== undefined) {
    throw primaryError;
  }
  return result;
}

export async function appendJournalRecord({
  capability,
  heldLock,
  event,
  payload,
  fsApi = fsPromises,
  faultHook,
}) {
  return appendUnderHeldLock({ capability, heldLock, event, payload, fsApi, faultHook });
}

async function readStaleLock(path, fsApi) {
  const before = await fsApi.lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("journal lock must be a non-symlink regular file");
  }
  if (before.size > 4 + MAX_LOCK_BODY_BYTES) throw new Error("journal lock is too large");
  const handle = await fsApi.open(path, "r");
  return withHandle(handle, async (openedHandle) => {
    const opened = await openedHandle.stat();
    if (!opened.isFile() || !sameIdentity(opened, before) || opened.size !== before.size) {
      throw new Error("journal lock changed while being inspected");
    }
    return {
      ...parseLockFrame(await readCompleteFile(openedHandle, 4 + MAX_LOCK_BODY_BYTES)),
      identity: { dev: opened.dev, ino: opened.ino },
      path,
    };
  });
}

async function readOptionalStaleLock(path, fsApi) {
  try {
    return await readStaleLock(path, fsApi);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function validatedTombstones(capability, fsApi) {
  const lockPath = deriveRunPath(capability, { purpose: "journal-lock" });
  const entries = await fsApi.readdir(dirname(lockPath), { withFileTypes: true });
  const artifacts = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(TOMBSTONE_PREFIX)) continue;
    const id = entry.name.slice(TOMBSTONE_PREFIX.length);
    if (!TOMBSTONE_TOKEN_PATTERN.test(id)) {
      throw new Error(`malformed journal lock tombstone name: ${entry.name}`);
    }
    const path = deriveRunPath(capability, { purpose: "journal-tombstone", id });
    try {
      artifacts.push(await readStaleLock(path, fsApi));
    } catch (error) {
      throw new Error(`invalid journal lock tombstone: ${entry.name}`, { cause: error });
    }
  }
  return artifacts.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
}

async function removeOwnedArtifacts(artifacts, fsApi) {
  for (const artifact of artifacts) {
    await assertPathIdentity(artifact.path, artifact.identity, fsApi, "journal lock artifact");
  }
  for (const artifact of artifacts) {
    await assertPathIdentity(artifact.path, artifact.identity, fsApi, "journal lock artifact");
    await fsApi.rm(artifact.path);
    await fsyncDirectory(dirname(artifact.path), fsApi);
  }
}

export async function reclaimJournalLock(
  { capability, writersStopped, fsApi = fsPromises },
  callback,
) {
  if (writersStopped !== true) {
    throw new Error("journal lock recovery requires writers-stopped attestation");
  }
  if (typeof callback !== "function") {
    throw new TypeError("journal lock recovery callback is required");
  }
  const before = await readJournalSnapshot({ capability, fsApi });
  if (TERMINAL_CLEANUP_STATES.has(before.replayed.state)) {
    return cleanupTerminalJournalArtifacts({ capability, writersStopped, fsApi });
  }
  const lockPath = deriveRunPath(capability, { purpose: "journal-lock" });
  const priorTombstones = await validatedTombstones(capability, fsApi);
  const staleLock = await readOptionalStaleLock(lockPath, fsApi);
  if (staleLock === null && priorTombstones.length === 0) {
    throw new Error("journal lock recovery requires a stale lock or tombstone");
  }
  let moved = null;
  if (staleLock !== null) {
    const tombstoneId = randomUUID();
    const tombstonePath = deriveRunPath(capability, {
      purpose: "journal-tombstone",
      id: tombstoneId,
    });
    await assertPathIdentity(lockPath, staleLock.identity, fsApi, "stale journal lock");
    await revalidateRunCapability(capability, {
      purpose: "journal-lock",
      boundary: "before-mutation",
    });
    await fsApi.rename(lockPath, tombstonePath);
    await fsyncDirectory(dirname(lockPath), fsApi);
    await revalidateRunCapability(capability, {
      purpose: "journal-tombstone",
      id: tombstoneId,
      boundary: "after-sync",
    });
    moved = { ...staleLock, path: tombstonePath };
  }
  const staleEvidence = staleLock ?? priorTombstones.at(-1);
  const run = await runWithJournalLock(
    { capability, fsApi, removeOnSuccess: false },
    async (heldLock) => {
      const rechecked = await readJournalSnapshot({ capability, fsApi });
      if (!sameTerminalSnapshot(before, rechecked)) {
        throw new Error("journal tip changed during lock recovery");
      }
      return callback(heldLock, Object.freeze({
        staleLock: staleEvidence.metadata,
        staleLockTorn: staleEvidence.torn,
      }));
    },
  );
  if (run.state.durableAppends === 0) {
    throw new Error("journal lock recovery requires a durable journal append");
  }
  try {
    await removeOwnedArtifacts(
      [
        ...priorTombstones,
        ...(moved === null ? [] : [moved]),
        { path: run.created.lockPath, identity: run.created.identity },
      ],
      fsApi,
    );
  } catch (error) {
    throw run.state.lastCandidate === null ? error : indeterminate(run.state.lastCandidate, error);
  }
  return run.result;
}

function sameTerminalSnapshot(before, after) {
  const beforeTip = before.replayed.records.at(-1);
  const afterTip = after.replayed.records.at(-1);
  return (
    before.bytes.equals(after.bytes) &&
    before.replayed.state === after.replayed.state &&
    before.replayed.records.length === after.replayed.records.length &&
    beforeTip?.sequence === afterTip?.sequence &&
    beforeTip?.recordHash === afterTip?.recordHash
  );
}

export async function cleanupTerminalJournalArtifacts({
  capability,
  writersStopped,
  fsApi = fsPromises,
}) {
  if (writersStopped !== true) {
    throw new Error("terminal journal cleanup requires writers-stopped attestation");
  }
  const before = await readJournalSnapshot({ capability, fsApi });
  if (before.replayed.truncatedTail) {
    throw new Error("terminal journal cleanup rejects a torn journal tail");
  }
  if (!TERMINAL_CLEANUP_STATES.has(before.replayed.state)) {
    throw new Error("terminal journal cleanup requires a cleanup-only terminal state");
  }
  const lockPath = deriveRunPath(capability, { purpose: "journal-lock" });
  const priorTombstones = await validatedTombstones(capability, fsApi);
  const staleLock = await readOptionalStaleLock(lockPath, fsApi);
  if (staleLock === null && priorTombstones.length === 0) return before.replayed;

  let moved = null;
  if (staleLock !== null) {
    const tombstoneId = randomUUID();
    const tombstonePath = deriveRunPath(capability, {
      purpose: "journal-tombstone",
      id: tombstoneId,
    });
    await assertPathIdentity(lockPath, staleLock.identity, fsApi, "stale journal lock");
    await revalidateRunCapability(capability, {
      purpose: "journal-lock",
      boundary: "before-mutation",
    });
    await fsApi.rename(lockPath, tombstonePath);
    await fsyncDirectory(dirname(lockPath), fsApi);
    await revalidateRunCapability(capability, {
      purpose: "journal-tombstone",
      id: tombstoneId,
      boundary: "after-sync",
    });
    moved = { ...staleLock, path: tombstonePath };
  }

  const run = await runWithJournalLock(
    { capability, fsApi, removeOnSuccess: false },
    async () => {
      const after = await readJournalSnapshot({ capability, fsApi });
      if (after.replayed.truncatedTail || !sameTerminalSnapshot(before, after)) {
        throw new Error("terminal journal tip changed during cleanup");
      }
      return after.replayed;
    },
  );
  await removeOwnedArtifacts(
    [
      ...priorTombstones,
      ...(moved === null ? [] : [moved]),
      { path: run.created.lockPath, identity: run.created.identity },
    ],
    fsApi,
  );
  return run.result;
}
