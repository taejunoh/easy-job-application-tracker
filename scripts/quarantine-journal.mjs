import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";

import {
  parseInventoryRecord,
  parseInventorySummary,
} from "./quarantine-inventory.mjs";
import {
  deriveRunPath,
  revalidateRunCapability,
} from "./quarantine-run-capability.mjs";
import { getRunFsContext } from "./quarantine-run-fs-context.mjs";

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
const RESTORE_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const GENERATED_IDS = Object.freeze(["generated-next", "generated-node-modules"]);
const MAX_INVENTORY_LINE_BYTES = 1024 * 1024;
const MAX_JOURNAL_ENTRY_IDS = 4096;

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
  [
    "PREPARED",
    new Map([
      ["MOVING", "MOVING"],
      ["RECOVERY_REQUIRED", "RECOVERY_REQUIRED"],
    ]),
  ],
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
      ["RESTORE_ROLLING_BACK", "RESTORE_ROLLING_BACK"],
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
  [
    "RESTORE_PREPARED",
    new Map([
      ["RESTORING", "RESTORING"],
      ["RECOVERY_REQUIRED", "RECOVERY_REQUIRED"],
    ]),
  ],
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
  [
    "RESTORE_ROLLING_BACK",
    new Map([
      ["RESTORE_ROLLBACK_INTENT", "RESTORE_ROLLING_BACK"],
      ["RESTORE_ROLLED_BACK_ENTRY", "RESTORE_ROLLING_BACK"],
      ["RESTORE_ABORTED_TO_QUARANTINED", "QUARANTINED"],
      ["RESTORE_ABORTED_TO_VALIDATED", "VALIDATED"],
      ["INCOMPLETE_CONFLICT", "INCOMPLETE_CONFLICT"],
    ]),
  ],
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotOptions(value, allowed, required, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      throw new TypeError(`${label} has an unknown field: ${String(key)}`);
    }
  }
  for (const key of required) {
    if (!keys.includes(key)) throw new TypeError(`${label} is missing field: ${key}`);
  }
  const snapshot = Object.create(null);
  for (const key of keys) snapshot[key] = value[key];
  return Object.freeze(snapshot);
}

function boundFsApi(input) {
  return Object.hasOwn(input, "fsApi")
    ? getRunFsContext(input.capability, input.fsApi)
    : getRunFsContext(input.capability);
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
    if (Array.isArray(value)) {
      const result = value.map((entry) => canonicalize(entry, seen));
      return Object.isFrozen(value) ? Object.freeze(result) : result;
    }
    if (!isPlainObject(value)) throw new TypeError("payload must contain plain objects");
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (key !== key.normalize("NFC") || key.includes("\0")) {
        throw new TypeError("payload keys must be normalized");
      }
      result[key] = canonicalize(value[key], seen);
    }
    return Object.isFrozen(value) ? Object.freeze(result) : result;
  } finally {
    seen.delete(value);
  }
}

function canonicalHashInput(sequence, previousHash, event, payload) {
  return JSON.stringify({ sequence, previousHash, event, payload });
}

function assertPayloadKeys(payload, expectedKeys, event) {
  if (!isPlainObject(payload)) throw new TypeError(`${event} payload must be a plain object`);
  const keys = Reflect.ownKeys(payload);
  for (const key of keys) {
    if (typeof key !== "string" || !expectedKeys.includes(key)) {
      throw new TypeError(`unknown field in ${event} payload: ${String(key)}`);
    }
  }
  for (const key of expectedKeys) {
    if (!keys.includes(key)) throw new TypeError(`missing field in ${event} payload: ${key}`);
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

function snapshotDenseArray(value, label, expectedLength) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be an exact Array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, "value") ||
    lengthDescriptor.enumerable ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    throw new TypeError(`${label} length descriptor is invalid`);
  }
  const length = lengthDescriptor.value;
  if (length > MAX_JOURNAL_ENTRY_IDS) {
    throw new TypeError(`${label} exceeds the ${MAX_JOURNAL_ENTRY_IDS} entry-ID limit`);
  }
  if (expectedLength !== undefined && length !== expectedLength) {
    throw new TypeError(`${label} length descriptor is invalid`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) {
    throw new TypeError(`${label} must be dense and have no custom keys`);
  }
  for (let index = 0; index < length; index += 1) {
    if (keys[index] !== String(index)) {
      throw new TypeError(`${label} must be dense and have no custom keys`);
    }
  }
  if (keys[length] !== "length") {
    throw new TypeError(`${label} must have one non-enumerable length property`);
  }
  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      !descriptor.enumerable
    ) {
      throw new TypeError(`${label} entries must be own enumerable data properties`);
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function parseSortedEntryIds(event, payload, key, { allowEmpty = false } = {}) {
  assertPayloadKeys(payload, [key], event);
  const input = snapshotDenseArray(payload[key], `${event} payload ${key}`);
  if (!allowEmpty && input.length === 0) {
    throw new TypeError(
      `${event} payload ${key} must be ${allowEmpty ? "an array" : "a non-empty array"}`,
    );
  }
  const values = input.map((value) => parseEntryId(value));
  for (let index = 1; index < values.length; index += 1) {
    if (Buffer.compare(Buffer.from(values[index - 1]), Buffer.from(values[index])) >= 0) {
      throw new TypeError(`${event} payload ${key} must be bytewise sorted and unique`);
    }
  }
  return Object.freeze({ [key]: Object.freeze(values) });
}

function parseRestoreId(value) {
  if (typeof value !== "string" || !RESTORE_ID.test(value)) {
    throw new TypeError("RESTORE_PREPARED payload restore ID is invalid");
  }
  return value;
}

function parseActiveGenerated(value) {
  const input = snapshotDenseArray(
    value,
    "RESTORE_PREPARED activeGenerated",
    GENERATED_IDS.length,
  );
  return Object.freeze(input.map((entry, index) => {
    assertPayloadKeys(entry, ["id", "inventory"], "RESTORE_PREPARED activeGenerated record");
    if (entry.id !== GENERATED_IDS[index]) {
      throw new TypeError("RESTORE_PREPARED activeGenerated IDs are invalid or out of order");
    }
    return Object.freeze({
      id: entry.id,
      inventory: entry.inventory === null
        ? null
        : parseInventorySummary(entry.inventory),
    });
  }));
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
    parseSortedEntryIds("RECOVERY_REQUIRED", payload, "entryIds", { allowEmpty: true }),
  ROLLING_BACK: (payload) => parseEmptyPayload("ROLLING_BACK", payload),
  ROLLBACK_INTENT: (payload) => parseEntryPayload("ROLLBACK_INTENT", payload),
  ROLLED_BACK_ENTRY: (payload) => parseEntryPayload("ROLLED_BACK_ENTRY", payload),
  ROLLED_BACK: (payload) => parseEmptyPayload("ROLLED_BACK", payload),
  INCOMPLETE_CONFLICT: (payload) =>
    parseSortedEntryIds("INCOMPLETE_CONFLICT", payload, "conflictEntryIds"),
  RESTORE_PREPARED(payload) {
    assertPayloadKeys(payload, ["restoreId", "activeGenerated"], "RESTORE_PREPARED");
    return Object.freeze({
      activeGenerated: parseActiveGenerated(payload.activeGenerated),
      restoreId: parseRestoreId(payload.restoreId),
    });
  },
  RESTORING: (payload) => parseEmptyPayload("RESTORING", payload),
  RESTORE_INTENT: (payload) => parseEntryPayload("RESTORE_INTENT", payload),
  RESTORED_ENTRY: (payload) => parseEntryPayload("RESTORED_ENTRY", payload),
  RESTORED: (payload) => parseEmptyPayload("RESTORED", payload),
  RESTORE_ROLLING_BACK: (payload) => parseEmptyPayload("RESTORE_ROLLING_BACK", payload),
  RESTORE_ROLLBACK_INTENT: (payload) =>
    parseEntryPayload("RESTORE_ROLLBACK_INTENT", payload),
  RESTORE_ROLLED_BACK_ENTRY: (payload) =>
    parseEntryPayload("RESTORE_ROLLED_BACK_ENTRY", payload),
  RESTORE_ABORTED_TO_QUARANTINED: (payload) =>
    parseEmptyPayload("RESTORE_ABORTED_TO_QUARANTINED", payload),
  RESTORE_ABORTED_TO_VALIDATED: (payload) =>
    parseEmptyPayload("RESTORE_ABORTED_TO_VALIDATED", payload),
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

function assertExactEntryIds(actual, expected, label) {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(`${label} must equal all durable intent IDs in forward order`);
  }
}

function firstUnresolved(intents, completed) {
  return intents.find((id) => !completed.has(id));
}

function validateJournalSemantics(records) {
  let state = null;
  let recoveryContext = null;
  let preRestoreState = null;
  const applyIntents = [];
  const applyCompleted = new Set();
  let applyRollbackIndex = -1;
  let applyRollbackPending = null;
  let restoreIntents = [];
  let restoreCompleted = new Set();
  let restoreRollbackIndex = -1;
  let restoreRollbackPending = null;

  for (const record of records) {
    const previousState = state;
    state = validateTransition(previousState, record.event);

    if (record.event === "MOVE_INTENT") {
      if (applyIntents.includes(record.payload.id)) {
        throw new Error("duplicate MOVE_INTENT entry ID");
      }
      if (applyIntents.length >= MAX_JOURNAL_ENTRY_IDS) {
        throw new Error(
          `MOVE_INTENT ledger exceeds the ${MAX_JOURNAL_ENTRY_IDS} recoverable entry limit`,
        );
      }
      applyIntents.push(record.payload.id);
    } else if (record.event === "MOVED") {
      if (firstUnresolved(applyIntents, applyCompleted) !== record.payload.id) {
        throw new Error("MOVED must complete the next durable MOVE_INTENT");
      }
      applyCompleted.add(record.payload.id);
    } else if (record.event === "RESTORE_PREPARED") {
      preRestoreState = previousState;
      restoreIntents = [];
      restoreCompleted = new Set();
      restoreRollbackIndex = -1;
      restoreRollbackPending = null;
    } else if (record.event === "RESTORE_INTENT") {
      if (restoreIntents.includes(record.payload.id)) {
        throw new Error("duplicate RESTORE_INTENT entry ID");
      }
      if (restoreIntents.length >= MAX_JOURNAL_ENTRY_IDS) {
        throw new Error(
          `RESTORE_INTENT ledger exceeds the ${MAX_JOURNAL_ENTRY_IDS} recoverable entry limit`,
        );
      }
      restoreIntents.push(record.payload.id);
    } else if (record.event === "RESTORED_ENTRY") {
      if (firstUnresolved(restoreIntents, restoreCompleted) !== record.payload.id) {
        throw new Error("RESTORED_ENTRY must complete the next durable RESTORE_INTENT");
      }
      restoreCompleted.add(record.payload.id);
    } else if (record.event === "RECOVERY_REQUIRED") {
      const restoreContext =
        previousState === "RESTORE_PREPARED" || previousState === "RESTORING";
      recoveryContext = restoreContext ? "restore" : "apply";
      const intents = restoreContext ? restoreIntents : applyIntents;
      const noIntentState = restoreContext
        ? previousState === "RESTORE_PREPARED" || previousState === "RESTORING"
        : previousState === "PREPARED" || previousState === "MOVING";
      if (record.payload.entryIds.length === 0) {
        if (!noIntentState || intents.length !== 0) {
          throw new Error("empty RECOVERY_REQUIRED is legal only before the first durable intent");
        }
      } else {
        assertExactEntryIds(
          record.payload.entryIds,
          intents,
          "RECOVERY_REQUIRED entryIds",
        );
      }
    } else if (previousState === "RECOVERY_REQUIRED") {
      const applyEvent = record.event === "MOVING" || record.event === "ROLLING_BACK";
      const restoreEvent =
        record.event === "RESTORING" || record.event === "RESTORE_ROLLING_BACK";
      if (
        (recoveryContext === "apply" && restoreEvent) ||
        (recoveryContext === "restore" && applyEvent)
      ) {
        throw new Error("recovery transition does not match its durable apply/restore context");
      }
      if (record.event === "ROLLING_BACK") {
        applyRollbackIndex = applyIntents.length - 1;
        applyRollbackPending = null;
      } else if (record.event === "RESTORE_ROLLING_BACK") {
        restoreRollbackIndex = restoreIntents.length - 1;
        restoreRollbackPending = null;
      }
    }

    if (record.event === "VERIFYING") {
      if (
        applyIntents.length === 0 ||
        applyCompleted.size !== applyIntents.length ||
        firstUnresolved(applyIntents, applyCompleted) !== undefined
      ) {
        throw new Error("VERIFYING requires every durable MOVE_INTENT to be completed");
      }
    } else if (record.event === "RESTORED") {
      if (
        restoreIntents.length === 0 ||
        restoreCompleted.size !== restoreIntents.length ||
        firstUnresolved(restoreIntents, restoreCompleted) !== undefined
      ) {
        throw new Error("RESTORED requires every durable RESTORE_INTENT to be completed");
      }
    }

    if (record.event === "ROLLBACK_INTENT") {
      if (
        applyRollbackPending !== null ||
        applyRollbackIndex < 0 ||
        applyIntents[applyRollbackIndex] !== record.payload.id
      ) {
        throw new Error("ROLLBACK_INTENT must follow durable MOVE_INTENT IDs in reverse order");
      }
      applyRollbackPending = record.payload.id;
    } else if (record.event === "ROLLED_BACK_ENTRY") {
      if (applyRollbackPending !== record.payload.id) {
        throw new Error("ROLLED_BACK_ENTRY must match its durable ROLLBACK_INTENT");
      }
      applyRollbackPending = null;
      applyRollbackIndex -= 1;
    } else if (record.event === "ROLLED_BACK") {
      if (applyRollbackPending !== null || applyRollbackIndex !== -1) {
        throw new Error("ROLLED_BACK requires every durable MOVE_INTENT to be reversed");
      }
    } else if (record.event === "RESTORE_ROLLBACK_INTENT") {
      if (
        restoreRollbackPending !== null ||
        restoreRollbackIndex < 0 ||
        restoreIntents[restoreRollbackIndex] !== record.payload.id
      ) {
        throw new Error(
          "RESTORE_ROLLBACK_INTENT must follow durable RESTORE_INTENT IDs in reverse order",
        );
      }
      restoreRollbackPending = record.payload.id;
    } else if (record.event === "RESTORE_ROLLED_BACK_ENTRY") {
      if (restoreRollbackPending !== record.payload.id) {
        throw new Error(
          "RESTORE_ROLLED_BACK_ENTRY must match its durable RESTORE_ROLLBACK_INTENT",
        );
      }
      restoreRollbackPending = null;
      restoreRollbackIndex -= 1;
    } else if (
      record.event === "RESTORE_ABORTED_TO_QUARANTINED" ||
      record.event === "RESTORE_ABORTED_TO_VALIDATED"
    ) {
      if (restoreRollbackPending !== null || restoreRollbackIndex !== -1) {
        throw new Error("restore abort requires every durable RESTORE_INTENT to be reversed");
      }
      const expected = preRestoreState === "QUARANTINED"
        ? "RESTORE_ABORTED_TO_QUARANTINED"
        : preRestoreState === "VALIDATED"
          ? "RESTORE_ABORTED_TO_VALIDATED"
          : null;
      if (record.event !== expected) {
        throw new Error("restore abort event does not return to the pre-restore durable state");
      }
    }
  }
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
  validateJournalSemantics(records);
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
const DURABLE_TIP_SETTLEMENTS = new Map([
  ["QUARANTINED", "QUARANTINED"],
  ["VALIDATED", "VALIDATED"],
  ["RESTORE_ABORTED_TO_QUARANTINED", "QUARANTINED"],
  ["RESTORE_ABORTED_TO_VALIDATED", "VALIDATED"],
]);
const TOMBSTONE_PREFIX = "journal.lock.tombstone.";

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertPrivateRegularFile(stat, label) {
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    (stat.mode & 0o7777) !== 0o600
  ) {
    throw new Error(`${label} must be a non-symlink regular file with exact mode 0600`);
  }
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

function addInventoryRecord(line, observed) {
  if (line.length === 0) throw new Error("restore-active inventory has an empty JSONL record");
  let value;
  try {
    value = JSON.parse(line.toString("utf8"));
  } catch (error) {
    throw new Error("restore-active inventory has malformed JSONL", { cause: error });
  }
  const record = parseInventoryRecord(value);
  if (!line.equals(Buffer.from(JSON.stringify(record)))) {
    throw new Error("restore-active inventory record is not canonical");
  }
  observed.entries += 1;
  observed.bytes += record.size;
  if (!Number.isSafeInteger(observed.entries) || !Number.isSafeInteger(observed.bytes)) {
    throw new Error("restore-active inventory summary exceeds safe integer bounds");
  }
}

async function summarizeRestoreInventory(path, fsApi) {
  const before = await fsApi.lstat(path);
  assertPrivateRegularFile(before, "restore-active inventory");
  const stream = fsApi.createReadStream(path, { highWaterMark: 64 * 1024 });
  const digest = createHash("sha256");
  const observed = { entries: 0, bytes: 0 };
  let pending = Buffer.alloc(0);
  let totalBytes = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    digest.update(chunk);
    totalBytes += chunk.length;
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      const part = chunk.subarray(start, index);
      if (pending.length + part.length > MAX_INVENTORY_LINE_BYTES) {
        throw new Error("restore-active inventory record is too large");
      }
      const line = pending.length === 0
        ? part
        : Buffer.concat([pending, part], pending.length + part.length);
      addInventoryRecord(line, observed);
      pending = Buffer.alloc(0);
      start = index + 1;
    }
    const tail = chunk.subarray(start);
    if (pending.length + tail.length > MAX_INVENTORY_LINE_BYTES) {
      throw new Error("restore-active inventory record is too large");
    }
    if (tail.length > 0) {
      pending = pending.length === 0
        ? Buffer.from(tail)
        : Buffer.concat([pending, tail], pending.length + tail.length);
    }
  }
  if (totalBytes > 0 && pending.length !== 0) {
    throw new Error("restore-active inventory must end with a JSONL newline");
  }
  const after = await fsApi.lstat(path);
  assertPrivateRegularFile(after, "restore-active inventory");
  if (!sameIdentity(before, after) || before.size !== after.size) {
    throw new Error("restore-active inventory changed while being streamed");
  }
  return parseInventorySummary({
    sha256: digest.digest("hex"),
    entries: observed.entries,
    bytes: observed.bytes,
  });
}

async function validateRestorePreparedBacking(record, capability, fsApi) {
  if (record.event !== "RESTORE_PREPARED") return;
  for (const active of record.payload.activeGenerated) {
    if (active.inventory === null) continue;
    const path = deriveRunPath(capability, {
      purpose: "inventory",
      phase: "restore-active",
      id: active.id,
    });
    let observed;
    try {
      observed = await summarizeRestoreInventory(path, fsApi);
    } catch (error) {
      throw new Error(
        `RESTORE_PREPARED inventory backing is invalid for ${active.id}: ${error.message}`,
        { cause: error },
      );
    }
    if (
      observed.sha256 !== active.inventory.sha256 ||
      observed.entries !== active.inventory.entries ||
      observed.bytes !== active.inventory.bytes
    ) {
      throw new Error(`RESTORE_PREPARED inventory backing mismatch for ${active.id}`);
    }
  }
}

async function validateRestorePreparedBackings(records, capability, fsApi) {
  for (const record of records) {
    await validateRestorePreparedBacking(record, capability, fsApi);
  }
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
  assertPrivateRegularFile(before, "journal");
  if (before.size > maxBytes) throw new Error("journal is too large");
  const handle = await fsApi.open(journalPath, "r");
  return withHandle(handle, async (openedHandle) => {
    const opened = await openedHandle.stat();
    assertPrivateRegularFile(opened, "opened journal");
    if (!sameIdentity(before, opened) || opened.size !== before.size) {
      throw new Error("journal changed while being inspected");
    }
    const bytes = await readCompleteFile(openedHandle, maxBytes);
    const replayed = replayJournalBuffer(bytes);
    await validateRestorePreparedBackings(replayed.records, capability, fsApi);
    return {
      bytes,
      identity: { dev: opened.dev, ino: opened.ino },
      journalPath,
      replayed,
    };
  });
}

export async function replayJournal(options) {
  const input = snapshotOptions(
    options,
    ["capability", "fsApi", "maxBytes"],
    ["capability"],
    "journal replay options",
  );
  const fsApi = boundFsApi(input);
  const maxBytes = input.maxBytes === undefined ? MAX_FRAME_BYTES : input.maxBytes;
  return (await readJournalSnapshot({ capability: input.capability, fsApi, maxBytes })).replayed;
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
    const owned = await handle.stat();
    assertPrivateRegularFile(owned, "opened journal lock");
    const pathOwned = await fsApi.lstat(lockPath);
    assertPrivateRegularFile(pathOwned, "journal lock");
    if (!sameIdentity(owned, pathOwned)) {
      throw new Error("journal lock ownership changed during creation");
    }
    const encoded = encodeLockFrame();
    await writeComplete(handle, encoded.frame);
    await handle.sync();
    await fsyncDirectory(dirname(lockPath), fsApi);
    await revalidateRunCapability(capability, {
      purpose: "journal-lock",
      boundary: "after-sync",
    });
    const stat = await handle.stat();
    assertPrivateRegularFile(stat, "durable journal lock");
    const durablePath = await fsApi.lstat(lockPath);
    assertPrivateRegularFile(durablePath, "durable journal lock path");
    if (!sameIdentity(stat, durablePath)) {
      throw new Error("journal lock ownership changed after sync");
    }
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
  assertPrivateRegularFile(current, label);
  if (current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error(`${label} ownership mismatch`);
  }
}

async function assertPathAbsent(path, fsApi, label) {
  try {
    await fsApi.lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} unexpectedly exists after durable removal`);
}

async function assertHeldLockOwned(state) {
  if (!state.active) throw new Error("journal held-lock capability is inactive");
  const held = await state.handle.stat();
  assertPrivateRegularFile(held, "journal held lock");
  if (held.dev !== state.identity.dev || held.ino !== state.identity.ino) {
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
    candidateAttempts: 0,
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
      await revalidateRunCapability(capability, {
        purpose: "journal-lock",
        boundary: "before-mutation",
      });
      await assertPathIdentity(state.lockPath, state.identity, fsApi, "journal held lock");
      await fsApi.rm(state.lockPath);
      await fsyncDirectory(dirname(state.lockPath), fsApi);
      await revalidateRunCapability(capability, {
        purpose: "journal-lock",
        boundary: "after-sync",
      });
      await assertPathAbsent(state.lockPath, fsApi, "journal held lock");
    } catch (error) {
      if (settledError !== undefined) throw attachCleanupError(settledError, error);
      throw state.lastCandidate === null ? error : indeterminate(state.lastCandidate, error);
    }
  }
  if (settledError !== undefined) throw settledError;
  return { created, result, state };
}

export async function withJournalLock(options, callback) {
  const input = snapshotOptions(
    options,
    ["capability", "fsApi"],
    ["capability"],
    "journal lock options",
  );
  const fsApi = boundFsApi(input);
  return (await runWithJournalLock({
    capability: input.capability,
    fsApi,
    removeOnSuccess: true,
  }, callback)).result;
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
    if (snapshot.identity === null) await handle.chmod(0o600);
    const opened = await handle.stat();
    assertPrivateRegularFile(opened, "opened journal");
    if (
      (snapshot.identity !== null && !sameIdentity(snapshot.identity, opened))
    ) {
      throw new Error("journal changed while being opened for mutation");
    }
    const observed = await readCompleteFile(handle);
    if (!observed.equals(snapshot.bytes)) {
      throw new Error("journal changed before mutation");
    }
    const pathOwned = await fsApi.lstat(snapshot.journalPath);
    assertPrivateRegularFile(pathOwned, "journal path");
    if (!sameIdentity(opened, pathOwned)) {
      throw new Error("journal ownership changed while being opened for mutation");
    }
    return { handle, identity: { dev: opened.dev, ino: opened.ino } };
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
    validateJournalSemantics([...replayed.records, candidate]);
    await validateRestorePreparedBacking(candidate, capability, fsApi);
    const body = Buffer.from(JSON.stringify(candidate));
    if (body.length > MAX_FRAME_BYTES) throw new Error("journal frame is too large");
    if (replayed.validEndOffset + 4 + body.length > MAX_FRAME_BYTES) {
      throw new Error("journal is too large");
    }
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);

    state.candidateAttempts += 1;
    await invokeFaultHook(faultHook, "before-mutation");
    await assertHeldLockOwned(state);
    await revalidateRunCapability(capability, {
      purpose: "journal",
      boundary: "before-mutation",
    });
    mutationStarted = true;
    state.lastCandidate = candidate;
    const openedJournal = await openJournalForMutation(snapshot, fsApi);
    journal = { ...openedJournal, journalPath: snapshot.journalPath };
    await invokeFaultHook(faultHook, "after-journal-open");
    if (replayed.truncatedTail) {
      await journal.handle.truncate(replayed.validEndOffset);
      await journal.handle.sync();
      await fsyncDirectory(dirname(journal.journalPath), fsApi);
      await revalidateRunCapability(capability, {
        purpose: "journal",
        boundary: "after-sync",
      });
      await assertPathIdentity(journal.journalPath, journal.identity, fsApi, "journal");
      await assertHeldLockOwned(state);
      await revalidateRunCapability(capability, {
        purpose: "journal",
        boundary: "before-mutation",
      });
    }
    await writeCompleteAt(
      journal.handle,
      Buffer.concat([length, body]),
      replayed.validEndOffset,
    );
    await journal.handle.sync();
    await invokeFaultHook(faultHook, "after-journal-sync");
    await fsyncDirectory(dirname(journal.journalPath), fsApi);
    await revalidateRunCapability(capability, {
      purpose: "journal",
      boundary: "after-sync",
    });
    const durableJournal = await journal.handle.stat();
    assertPrivateRegularFile(durableJournal, "durable journal");
    if (!sameIdentity(durableJournal, journal.identity)) {
      throw new Error("journal handle identity changed after sync");
    }
    await assertPathIdentity(journal.journalPath, journal.identity, fsApi, "durable journal");
    await assertHeldLockOwned(state);
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

export async function appendJournalRecord(options) {
  const input = snapshotOptions(
    options,
    ["capability", "heldLock", "event", "payload", "fsApi", "faultHook"],
    ["capability", "heldLock", "event", "payload"],
    "journal append options",
  );
  const fsApi = boundFsApi(input);
  return appendUnderHeldLock({
    capability: input.capability,
    heldLock: input.heldLock,
    event: input.event,
    payload: input.payload,
    fsApi,
    faultHook: input.faultHook,
  });
}

async function readStaleLock(path, fsApi) {
  const before = await fsApi.lstat(path);
  assertPrivateRegularFile(before, "journal lock");
  if (before.size > 4 + MAX_LOCK_BODY_BYTES) throw new Error("journal lock is too large");
  const handle = await fsApi.open(path, "r");
  return withHandle(handle, async (openedHandle) => {
    const opened = await openedHandle.stat();
    assertPrivateRegularFile(opened, "opened journal lock");
    if (!sameIdentity(opened, before) || opened.size !== before.size) {
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

function lockArtifactBoundary(path, boundary) {
  const name = path.split("/").at(-1);
  if (name === "journal.lock") return { purpose: "journal-lock", boundary };
  if (name?.startsWith(TOMBSTONE_PREFIX)) {
    return {
      purpose: "journal-tombstone",
      id: name.slice(TOMBSTONE_PREFIX.length),
      boundary,
    };
  }
  throw new Error(`unknown journal lock artifact path: ${path}`);
}

async function removeOwnedArtifacts(capability, artifacts, fsApi) {
  const uniqueArtifacts = [...new Map(
    artifacts.map((artifact) => [artifact.path, artifact]),
  ).values()];
  for (const artifact of uniqueArtifacts) {
    await assertPathIdentity(artifact.path, artifact.identity, fsApi, "journal lock artifact");
  }
  for (const artifact of uniqueArtifacts) {
    await revalidateRunCapability(
      capability,
      lockArtifactBoundary(artifact.path, "before-mutation"),
    );
    await assertPathIdentity(artifact.path, artifact.identity, fsApi, "journal lock artifact");
    await fsApi.rm(artifact.path);
    await fsyncDirectory(dirname(artifact.path), fsApi);
    await revalidateRunCapability(
      capability,
      lockArtifactBoundary(artifact.path, "after-sync"),
    );
    await assertPathAbsent(artifact.path, fsApi, "journal lock artifact");
  }
}

async function readOptionalArtifact(path, fsApi, label) {
  try {
    const stat = await fsApi.lstat(path);
    assertPrivateRegularFile(stat, label);
    return stat;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function publishStaleLockTombstone({
  capability,
  fsApi,
  lockPath,
  staleLock,
  tombstoneId,
  tombstonePath,
}) {
  await assertPathIdentity(lockPath, staleLock.identity, fsApi, "stale journal lock");
  let destination = await readOptionalArtifact(
    tombstonePath,
    fsApi,
    "journal lock tombstone destination",
  );
  if (destination !== null && !sameIdentity(destination, staleLock.identity)) {
    throw new Error("journal lock tombstone destination is a foreign existing file");
  }
  await revalidateRunCapability(capability, {
    purpose: "journal-tombstone",
    id: tombstoneId,
    boundary: "before-mutation",
  });
  await assertPathIdentity(lockPath, staleLock.identity, fsApi, "stale journal lock");
  if (destination === null) {
    try {
      await fsApi.link(lockPath, tombstonePath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      destination = await readOptionalArtifact(
        tombstonePath,
        fsApi,
        "journal lock tombstone destination",
      );
      if (destination === null || !sameIdentity(destination, staleLock.identity)) {
        throw new Error("journal lock tombstone destination appeared with foreign ownership", {
          cause: error,
        });
      }
    }
  }
  await fsyncDirectory(dirname(lockPath), fsApi);
  await revalidateRunCapability(capability, {
    purpose: "journal-tombstone",
    id: tombstoneId,
    boundary: "after-sync",
  });
  await assertPathIdentity(lockPath, staleLock.identity, fsApi, "stale journal lock source");
  await assertPathIdentity(
    tombstonePath,
    staleLock.identity,
    fsApi,
    "published journal lock tombstone",
  );
  await revalidateRunCapability(capability, {
    purpose: "journal-lock",
    boundary: "before-mutation",
  });
  await assertPathIdentity(lockPath, staleLock.identity, fsApi, "stale journal lock source");
  await assertPathIdentity(
    tombstonePath,
    staleLock.identity,
    fsApi,
    "published journal lock tombstone",
  );
  await fsApi.unlink(lockPath);
  await fsyncDirectory(dirname(lockPath), fsApi);
  await revalidateRunCapability(capability, {
    purpose: "journal-lock",
    boundary: "after-sync",
  });
  await assertPathAbsent(lockPath, fsApi, "stale journal lock source");
  await assertPathIdentity(
    tombstonePath,
    staleLock.identity,
    fsApi,
    "durable journal lock tombstone",
  );
  return { ...staleLock, path: tombstonePath };
}

function parseDurableTipSettlement(value, replayed) {
  const outer = snapshotOptions(
    value,
    ["settleDurableTip"],
    ["settleDurableTip"],
    "journal lock recovery result",
  );
  const settlement = snapshotOptions(
    outer.settleDurableTip,
    ["sequence", "recordHash", "event", "state"],
    ["sequence", "recordHash", "event", "state"],
    "durable journal tip settlement",
  );
  if (!Number.isSafeInteger(settlement.sequence) || settlement.sequence < 1) {
    throw new TypeError("durable journal tip settlement sequence must be a positive safe integer");
  }
  if (typeof settlement.recordHash !== "string" || !HASH_PATTERN.test(settlement.recordHash)) {
    throw new TypeError("durable journal tip settlement recordHash must be a lowercase SHA-256 hash");
  }
  if (typeof settlement.event !== "string" || typeof settlement.state !== "string") {
    throw new TypeError("durable journal tip settlement event and state must be strings");
  }
  if (DURABLE_TIP_SETTLEMENTS.get(settlement.event) !== settlement.state) {
    throw new Error("durable journal tip settlement event/state pair is not allowed");
  }
  const tip = replayed.records.at(-1);
  if (
    tip === undefined ||
    settlement.sequence !== tip.sequence ||
    settlement.recordHash !== tip.recordHash ||
    settlement.event !== tip.event ||
    settlement.state !== replayed.state
  ) {
    throw new Error("durable journal tip settlement does not match the replayed tip");
  }
  return Object.freeze({
    settleDurableTip: Object.freeze({
      sequence: settlement.sequence,
      recordHash: settlement.recordHash,
      event: settlement.event,
      state: settlement.state,
    }),
  });
}

async function restoreRecoveryArtifacts({
  capability,
  fsApi,
  staleLock,
  moved,
  movedWasNew,
  created,
}) {
  await revalidateRunCapability(capability, {
    purpose: "journal-lock",
    boundary: "before-mutation",
  });
  await assertPathIdentity(created.lockPath, created.identity, fsApi, "journal held lock");
  await fsApi.rm(created.lockPath);
  await fsyncDirectory(dirname(created.lockPath), fsApi);
  await revalidateRunCapability(capability, {
    purpose: "journal-lock",
    boundary: "after-sync",
  });
  await assertPathAbsent(created.lockPath, fsApi, "journal held lock");
  if (staleLock === null) return;

  await assertPathIdentity(moved.path, staleLock.identity, fsApi, "stale journal lock tombstone");
  await revalidateRunCapability(capability, {
    purpose: "journal-lock",
    boundary: "before-mutation",
  });
  await fsApi.link(moved.path, created.lockPath);
  await fsyncDirectory(dirname(created.lockPath), fsApi);
  await revalidateRunCapability(capability, {
    purpose: "journal-lock",
    boundary: "after-sync",
  });
  await assertPathIdentity(created.lockPath, staleLock.identity, fsApi, "restored stale journal lock");
  if (movedWasNew) {
    await removeOwnedArtifacts(capability, [moved], fsApi);
  }
}

export async function reclaimJournalLock(options, callback) {
  const input = snapshotOptions(
    options,
    ["capability", "writersStopped", "fsApi"],
    ["capability", "writersStopped"],
    "journal lock recovery options",
  );
  const fsApi = boundFsApi(input);
  const capability = input.capability;
  if (input.writersStopped !== true) {
    throw new Error("journal lock recovery requires writers-stopped attestation");
  }
  if (typeof callback !== "function") {
    throw new TypeError("journal lock recovery callback is required");
  }
  const before = await readJournalSnapshot({ capability, fsApi });
  if (TERMINAL_CLEANUP_STATES.has(before.replayed.state)) {
    return cleanupTerminalJournalArtifactsCore({
      capability,
      writersStopped: input.writersStopped,
      fsApi,
    });
  }
  const lockPath = deriveRunPath(capability, { purpose: "journal-lock" });
  const priorTombstones = await validatedTombstones(capability, fsApi);
  const staleLock = await readOptionalStaleLock(lockPath, fsApi);
  if (staleLock === null && priorTombstones.length === 0) {
    throw new Error("journal lock recovery requires a stale lock or tombstone");
  }
  let moved = null;
  let movedWasNew = false;
  if (staleLock !== null) {
    const residue = priorTombstones.find((artifact) =>
      sameIdentity(artifact.identity, staleLock.identity));
    movedWasNew = residue === undefined;
    const tombstoneId = residue === undefined
      ? randomUUID()
      : residue.path.split("/").at(-1).slice(TOMBSTONE_PREFIX.length);
    const tombstonePath = residue?.path ?? deriveRunPath(capability, {
      purpose: "journal-tombstone",
      id: tombstoneId,
    });
    moved = await publishStaleLockTombstone({
      capability,
      fsApi,
      lockPath,
      staleLock,
      tombstoneId,
      tombstonePath,
    });
  }
  const staleEvidence = staleLock ?? priorTombstones.at(-1);
  let zeroAppendFailure;
  let settlementResult;
  const run = await runWithJournalLock(
    { capability, fsApi, removeOnSuccess: false },
    async (heldLock) => {
      const rechecked = await readJournalSnapshot({ capability, fsApi });
      if (!sameTerminalSnapshot(before, rechecked)) {
        throw new Error("journal tip changed during lock recovery");
      }
      let callbackResult;
      try {
        callbackResult = await callback(heldLock, Object.freeze({
          staleLock: staleEvidence.metadata,
          staleLockTorn: staleEvidence.torn,
        }));
      } catch (error) {
        const lockState = heldLockState.get(heldLock);
        if (lockState?.durableAppends !== 0 || lockState.lastCandidate !== null) throw error;
        zeroAppendFailure = error;
        return undefined;
      }
      const lockState = heldLockState.get(heldLock);
      if (lockState?.durableAppends === 0) {
        try {
          if (lockState.lastCandidate !== null || lockState.candidateAttempts !== 0) {
            throw new Error("durable journal tip settlement rejects prior append attempts");
          }
          if (rechecked.replayed.truncatedTail) {
            throw new Error("durable journal tip settlement rejects a torn journal tail");
          }
          settlementResult = parseDurableTipSettlement(callbackResult, rechecked.replayed);
          const settled = await readJournalSnapshot({ capability, fsApi });
          if (settled.replayed.truncatedTail || !sameTerminalSnapshot(rechecked, settled)) {
            throw new Error("journal tip changed during durable-tip settlement");
          }
        } catch (error) {
          zeroAppendFailure = error;
        }
      }
      return callbackResult;
    },
  );
  if (run.state.durableAppends === 0) {
    if (run.state.lastCandidate !== null || run.state.candidateAttempts !== 0) {
      const attemptError = zeroAppendFailure ?? new Error(
        "durable journal tip settlement rejects prior append attempts",
      );
      throw run.state.lastCandidate === null
        ? attemptError
        : indeterminate(run.state.lastCandidate, attemptError);
    }
    if (zeroAppendFailure !== undefined || settlementResult === undefined) {
      const primary = zeroAppendFailure ?? new Error(
        "journal lock recovery requires a durable journal append or exact tip settlement",
      );
      try {
        await restoreRecoveryArtifacts({
          capability,
          fsApi,
          staleLock,
          moved,
          movedWasNew,
          created: run.created,
        });
      } catch (error) {
        throw attachCleanupError(primary, error);
      }
      throw primary;
    }
  }
  try {
    await removeOwnedArtifacts(
      capability,
      [
        ...priorTombstones,
        ...(moved === null ? [] : [moved]),
        { path: run.created.lockPath, identity: run.created.identity },
      ],
      fsApi,
    );
  } catch (error) {
    if (run.state.durableAppends === 0) {
      try {
        await restoreRecoveryArtifacts({
          capability,
          fsApi,
          staleLock,
          moved,
          movedWasNew,
          created: run.created,
        });
      } catch (restoreError) {
        throw attachCleanupError(error, restoreError);
      }
    }
    throw run.state.lastCandidate === null ? error : indeterminate(run.state.lastCandidate, error);
  }
  return run.state.durableAppends === 0 ? settlementResult : run.result;
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

async function cleanupTerminalJournalArtifactsCore({ capability, writersStopped, fsApi }) {
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
    const residue = priorTombstones.find((artifact) =>
      sameIdentity(artifact.identity, staleLock.identity));
    const tombstoneId = residue === undefined
      ? randomUUID()
      : residue.path.split("/").at(-1).slice(TOMBSTONE_PREFIX.length);
    const tombstonePath = residue?.path ?? deriveRunPath(capability, {
      purpose: "journal-tombstone",
      id: tombstoneId,
    });
    moved = await publishStaleLockTombstone({
      capability,
      fsApi,
      lockPath,
      staleLock,
      tombstoneId,
      tombstonePath,
    });
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
    capability,
    [
      ...priorTombstones,
      ...(moved === null ? [] : [moved]),
      { path: run.created.lockPath, identity: run.created.identity },
    ],
    fsApi,
  );
  return run.result;
}

export async function cleanupTerminalJournalArtifacts(options) {
  const input = snapshotOptions(
    options,
    ["capability", "writersStopped", "fsApi"],
    ["capability", "writersStopped"],
    "terminal journal cleanup options",
  );
  const fsApi = boundFsApi(input);
  return cleanupTerminalJournalArtifactsCore({
    capability: input.capability,
    writersStopped: input.writersStopped,
    fsApi,
  });
}
