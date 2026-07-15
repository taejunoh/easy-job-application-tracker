import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { dirname } from "node:path";

const ZERO_HASH = "0".repeat(64);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const ENVELOPE_KEYS = ["sequence", "previousHash", "event", "payload", "recordHash"];

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

  const payload = canonicalize(record.payload);
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

export async function replayJournal(journalPath, fsApi = fsPromises) {
  let input;
  try {
    input = await fsApi.readFile(journalPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { records: [], state: null };
    throw error;
  }

  const records = [];
  let state = null;
  let offset = 0;
  while (offset < input.length) {
    if (input.length - offset < 4) break;
    const frameLength = input.readUInt32BE(offset);
    if (frameLength > MAX_FRAME_BYTES) throw new Error("journal frame is too large");
    const bodyStart = offset + 4;
    const bodyEnd = bodyStart + frameLength;
    if (bodyEnd > input.length) break;
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
  return { records, state };
}

async function writeComplete(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer.subarray(offset));
    if (bytesWritten <= 0) throw new Error("journal append made no progress");
    offset += bytesWritten;
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
  const replayed = await replayJournal(journalPath, fsApi);
  validateTransition(replayed.state, event);
  const canonicalPayload = canonicalize(payload);
  const sequence = replayed.records.length + 1;
  const previousHash = replayed.records.at(-1)?.recordHash ?? ZERO_HASH;
  const recordHash = hashRecord(sequence, previousHash, event, canonicalPayload);
  const record = {
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

  await fsApi.mkdir(dirname(journalPath), { recursive: true, mode: 0o700 });
  const handle = await fsApi.open(journalPath, "a", 0o600);
  try {
    await handle.chmod(0o600);
    await writeComplete(handle, Buffer.concat([length, body]));
    await handle.sync();
  } finally {
    await handle.close();
  }

  const parent = await fsApi.open(dirname(journalPath), "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  return record;
}
