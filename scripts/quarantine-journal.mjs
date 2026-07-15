import { createHash, randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { parseInventorySummary } from "./quarantine-inventory.mjs";

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
const ENTRY_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
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
  QUARANTINED(payload) {
    assertPayloadKeys(payload, ["manifestSha256"], "QUARANTINED");
    return Object.freeze({ manifestSha256: parseManifestSha256(payload.manifestSha256) });
  },
  VALIDATED: (payload) => parseEmptyPayload("VALIDATED", payload),
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

export async function replayJournal(journalPath, fsApi = fsPromises) {
  let input;
  try {
    input = await fsApi.readFile(journalPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { records: [], state: null, validEndOffset: 0, truncatedTail: false };
    }
    throw error;
  }
  return replayJournalBuffer(input);
}

async function writeComplete(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer.subarray(offset));
    if (bytesWritten <= 0) throw new Error("durable write made no progress");
    offset += bytesWritten;
  }
}

async function readCompleteFile(handle) {
  const before = await handle.stat();
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
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
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

async function createJournalLock(lockPath, fsApi) {
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
    return { handle, metadata: encoded.metadata };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function appendUnderHeldLock({ journalPath, event, payload, fsApi, assertLockOwned }) {
  if (!isPlainObject(payload)) throw new TypeError("journal payload must be a plain object");
  let record;
  let mutationStarted = false;
  try {
    await assertLockOwned?.();
    const handle = await fsApi.open(journalPath, "a+", 0o600);
    try {
      await handle.chmod(0o600);
      const replayed = replayJournalBuffer(await readCompleteFile(handle));
      validateTransition(replayed.state, event);
      const canonicalPayload = canonicalize(parseEventPayload(event, payload));
      const sequence = replayed.records.length + 1;
      const previousHash = replayed.records.at(-1)?.recordHash ?? ZERO_HASH;
      const recordHash = hashRecord(sequence, previousHash, event, canonicalPayload);
      record = {
        sequence,
        previousHash,
        event,
        payload: canonicalPayload,
        recordHash,
      };
      const body = Buffer.from(JSON.stringify(record));
      if (body.length > MAX_FRAME_BYTES) throw new Error("journal frame is too large");
      const length = Buffer.alloc(4);
      length.writeUInt32BE(body.length);

      if (replayed.truncatedTail) {
        await assertLockOwned?.();
        mutationStarted = true;
        await handle.truncate(replayed.validEndOffset);
        await handle.sync();
        await fsyncDirectory(dirname(journalPath), fsApi);
      }
      await assertLockOwned?.();
      mutationStarted = true;
      await writeComplete(handle, Buffer.concat([length, body]));
      await handle.sync();
      await assertLockOwned?.();
    } finally {
      await handle.close();
    }
    await fsyncDirectory(dirname(journalPath), fsApi);
    await assertLockOwned?.();
    return record;
  } catch (error) {
    if (mutationStarted && record !== undefined) {
      if (error instanceof IndeterminateJournalAppendError) throw error;
      throw new IndeterminateJournalAppendError({
        cause: error,
        expectedSequence: record.sequence,
        expectedRecordHash: record.recordHash,
      });
    }
    throw error;
  }
}

async function readStaleLock(lockPath, fsApi) {
  const before = await fsApi.lstat(lockPath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("journal lock must be a non-symlink regular file");
  }
  if (before.size > 4 + MAX_LOCK_BODY_BYTES) {
    throw new Error("journal lock is too large");
  }

  const handle = await fsApi.open(lockPath, "r");
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw new Error("journal lock changed while being inspected");
    }
    return parseLockFrame(await readCompleteFile(handle));
  } finally {
    await handle.close();
  }
}

async function validatedTombstoneResidues(lockPath, fsApi) {
  const parentPath = dirname(lockPath);
  const prefix = `${basename(lockPath)}.reclaim-`;
  const entries = await fsApi.readdir(parentPath, { withFileTypes: true });
  const residues = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) continue;
    const ownerToken = entry.name.slice(prefix.length);
    if (!TOMBSTONE_TOKEN_PATTERN.test(ownerToken)) {
      throw new Error(`malformed journal lock tombstone name: ${entry.name}`);
    }
    const residuePath = join(parentPath, entry.name);
    try {
      await readStaleLock(residuePath, fsApi);
    } catch (error) {
      throw new Error(`invalid journal lock tombstone: ${entry.name}`, { cause: error });
    }
    residues.push(residuePath);
  }
  return residues.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

async function removeValidatedLockResidues(paths, fsApi) {
  for (const path of paths) await readStaleLock(path, fsApi);
  for (const path of paths) await fsApi.rm(path);
  if (paths.length > 0) await fsyncDirectory(dirname(paths[0]), fsApi);
}

async function assertHeldLockOwnership(lockPath, lockHandle, fsApi) {
  let held;
  let current;
  try {
    [held, current] = await Promise.all([lockHandle.stat(), fsApi.lstat(lockPath)]);
  } catch (error) {
    throw new Error("journal recovery lock ownership cannot be verified", { cause: error });
  }
  if (
    !held.isFile() ||
    current.isSymbolicLink() ||
    !current.isFile() ||
    held.dev !== current.dev ||
    held.ino !== current.ino
  ) {
    throw new Error("journal recovery lock ownership mismatch");
  }
}

export async function appendJournalRecord({
  journalPath,
  event,
  payload,
  fsApi = fsPromises,
}) {
  if (typeof journalPath !== "string" || journalPath.length === 0) {
    throw new TypeError("journal path is required");
  }
  if (!isPlainObject(payload)) throw new TypeError("journal payload must be a plain object");
  await fsApi.mkdir(dirname(journalPath), { recursive: true, mode: 0o700 });
  const lockPath = `${journalPath}.lock`;
  let lock;
  try {
    lock = await createJournalLock(lockPath, fsApi);
    return await appendUnderHeldLock({ journalPath, event, payload, fsApi });
  } finally {
    if (lock !== undefined) {
      await lock.handle.close();
      await fsApi.rm(lockPath, { force: true });
      await fsyncDirectory(dirname(journalPath), fsApi);
    }
  }
}

export async function reclaimJournalLock({
  journalPath,
  writersStopped,
  recovery,
  fsApi = fsPromises,
}) {
  if (typeof journalPath !== "string" || journalPath.length === 0) {
    throw new TypeError("journal path is required");
  }
  if (writersStopped !== true) {
    throw new Error("journal lock recovery requires writers-stopped attestation");
  }
  if (typeof recovery !== "function") {
    throw new TypeError("journal lock recovery callback is required");
  }

  const lockPath = `${journalPath}.lock`;
  const priorTombstones = await validatedTombstoneResidues(lockPath, fsApi);
  const staleLock = await readStaleLock(lockPath, fsApi);
  const tombstonePath = `${lockPath}.reclaim-${randomUUID()}`;
  await fsApi.rename(lockPath, tombstonePath);
  await fsyncDirectory(dirname(journalPath), fsApi);

  let recoveryLock;
  let recoverySucceeded = false;
  try {
    recoveryLock = await createJournalLock(lockPath, fsApi);
    const capability = { active: true };
    let appendInProgress = false;
    let durableAppends = 0;
    const assertCapabilityOwnsLock = async () => {
      if (!capability.active) {
        throw new Error("journal recovery append capability is inactive");
      }
      await assertHeldLockOwnership(lockPath, recoveryLock.handle, fsApi);
      if (!capability.active) {
        throw new Error("journal recovery append capability is inactive");
      }
    };
    const append = async ({ event, payload }) => {
      if (!capability.active) {
        throw new Error("journal recovery append capability is inactive");
      }
      if (appendInProgress) throw new Error("journal recovery append is already in progress");
      appendInProgress = true;
      try {
        const record = await appendUnderHeldLock({
          journalPath,
          event,
          payload,
          fsApi,
          assertLockOwned: assertCapabilityOwnsLock,
        });
        durableAppends += 1;
        return record;
      } finally {
        appendInProgress = false;
      }
    };
    let result;
    try {
      result = await recovery({
        append,
        staleLock: staleLock.metadata,
        staleLockTorn: staleLock.torn,
      });
    } finally {
      capability.active = false;
    }
    if (appendInProgress) {
      throw new Error("journal recovery callback returned during an append");
    }
    if (durableAppends === 0) {
      throw new Error("journal lock recovery requires a durable journal append");
    }
    await assertHeldLockOwnership(lockPath, recoveryLock.handle, fsApi);
    recoverySucceeded = true;
    return result;
  } finally {
    await recoveryLock?.handle.close();
    if (recoverySucceeded) {
      await removeValidatedLockResidues(
        [lockPath, tombstonePath, ...priorTombstones],
        fsApi,
      );
    }
  }
}
