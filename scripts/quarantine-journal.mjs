import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { dirname } from "node:path";

import { parseInventorySummary } from "./quarantine-inventory.mjs";

const ZERO_HASH = "0".repeat(64);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const ENVELOPE_KEYS = ["sequence", "previousHash", "event", "payload", "recordHash"];
const ENTRY_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const TRANSACTION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;

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
  const canonicalPayload = canonicalize(parseEventPayload(event, payload));
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
