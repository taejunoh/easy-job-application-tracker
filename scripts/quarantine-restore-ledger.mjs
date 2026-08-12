function assertExactIds(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== expected.length ||
      actual.some((id, index) => id !== expected[index])) {
    throw new Error(`${label} does not match the current restore epoch`);
  }
}

/** Builds the ledger for the sole active restore epoch, never prior attempts. */
export function buildRestoreLedger(replayed, manifest) {
  const preparedIndex = replayed.records.findLastIndex((record) => record.event === "RESTORE_PREPARED");
  if (preparedIndex < 1) throw new Error("restore lifecycle provenance is missing");
  const predecessor = replayed.records[preparedIndex - 1];
  if (predecessor.event !== "QUARANTINED" && predecessor.event !== "VALIDATED") {
    throw new Error("RESTORE_PREPARED must immediately follow a terminal quarantine state");
  }
  const records = replayed.records.slice(preparedIndex);
  const prepared = records[0];
  if (typeof prepared.payload.restoreId !== "string" || !prepared.payload.restoreId.startsWith("restore-")) {
    throw new Error("restore lifecycle ID is invalid");
  }
  const generatedIds = manifest.entries.filter((entry) => entry.kind === "generated-root").map((entry) => entry.id);
  const active = prepared.payload.activeGenerated;
  if (!Array.isArray(active) || active.length !== generatedIds.length ||
      active.some((entry, index) => entry.id !== generatedIds[index])) {
    throw new Error("restore active-generated provenance does not match the manifest");
  }
  const orderedIds = manifest.entries.map((entry) => entry.id);
  const intents = records.filter((record) => record.event === "RESTORE_INTENT").map((record) => record.payload.id);
  if (intents.some((id, index) => id !== orderedIds[index])) {
    throw new Error("restore intent order does not match manifest provenance");
  }
  const completed = records.filter((record) => record.event === "RESTORED_ENTRY").map((record) => record.payload.id);
  if (completed.some((id, index) => id !== intents[index])) {
    throw new Error("restore completion order does not match restore intent order");
  }
  const rollbackIntents = records.filter((record) => record.event === "RESTORE_ROLLBACK_INTENT").map((record) => record.payload.id);
  const expectedRollback = [...intents].reverse();
  if (rollbackIntents.some((id, index) => id !== expectedRollback[index])) {
    throw new Error("restore rollback intent order does not match restore provenance");
  }
  const rollbackCompleted = records.filter((record) => record.event === "RESTORE_ROLLED_BACK_ENTRY").map((record) => record.payload.id);
  if (rollbackCompleted.some((id, index) => id !== rollbackIntents[index])) {
    throw new Error("restore rollback completion order does not match rollback intent order");
  }
  const seenIntents = [];
  for (const record of records) {
    if (record.event === "RESTORE_INTENT") seenIntents.push(record.payload.id);
    if (record.event === "RECOVERY_REQUIRED") {
      assertExactIds(record.payload.entryIds, seenIntents, "RECOVERY_REQUIRED entryIds");
    }
  }
  return Object.freeze({
    restoreId: prepared.payload.restoreId,
    preRestoreState: predecessor.event,
    active: new Map(active.map((entry) => [entry.id, entry.inventory])),
    intents: Object.freeze(intents),
    completed: new Set(completed),
    rollbackIntents: new Set(rollbackIntents),
    rollbackIntentIds: Object.freeze(rollbackIntents),
    rollbackCompleted: new Set(rollbackCompleted),
    records: Object.freeze(records),
  });
}
