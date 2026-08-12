import process from "node:process";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";

const requestText = process.env.QUARANTINE_CHILD_REQUEST;
if (typeof requestText !== "string") {
  throw new Error("QUARANTINE_CHILD_REQUEST is required");
}

const parsed = JSON.parse(requestText);
if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
  throw new Error("child request must be an object");
}
const REQUEST_KEYS = Object.freeze(["operation", "options", "killAt", "hangAt"]);
if (Reflect.ownKeys(parsed).some((key) => typeof key !== "string" || !REQUEST_KEYS.includes(key))) {
  throw new Error("unsupported quarantine child request field");
}
if (typeof parsed.operation !== "string" || parsed.options === null ||
    typeof parsed.options !== "object" || Array.isArray(parsed.options) ||
    (parsed.killAt !== undefined && typeof parsed.killAt !== "string") ||
    (parsed.hangAt !== undefined && typeof parsed.hangAt !== "string")) {
  throw new Error("invalid quarantine child request");
}
const request = Object.freeze({
  operation: parsed.operation,
  options: Object.freeze({ ...parsed.options }),
  killAt: parsed.killAt,
  hangAt: parsed.hangAt,
});

const transaction = await import("../../../scripts/quarantine-transaction.mjs");
const transactionOperations = Object.freeze({
  quarantineWorkspace: transaction.quarantineWorkspace,
  recoverQuarantine: transaction.recoverQuarantine,
});
const restoreOperations = Object.freeze(["restoreQuarantine", "recoverRestore"]);
const restore = restoreOperations.includes(request.operation)
  ? await import("../../../scripts/quarantine-restore.mjs")
  : null;
const operation = Object.hasOwn(transactionOperations, request.operation)
  ? transactionOperations[request.operation]
  : restoreOperations.includes(request.operation)
    ? restore[request.operation]
    : undefined;
if (typeof operation !== "function") {
  throw new Error("unsupported quarantine child operation");
}

const killAt = request.killAt;
const hangAt = request.hangAt;
const options = request.options;
const phaseTracePath = process.env.QUARANTINE_CHILD_PHASE_TRACE;
function tracePhase(phase) {
  if (phaseTracePath === undefined) return;
  const descriptor = openSync(phaseTracePath, "a", 0o600);
  try {
    writeSync(descriptor, `${phase}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
const result = await operation({
  ...options,
  faultHook: async (phase) => {
    tracePhase(phase);
    if (phase === killAt) process.kill(process.pid, "SIGKILL");
    if (phase === hangAt) await new Promise(() => setInterval(() => {}, 1_000));
  },
});
process.stdout.write(JSON.stringify(result));
