import process from "node:process";

const requestText = process.env.QUARANTINE_CHILD_REQUEST;
if (typeof requestText !== "string") {
  throw new Error("QUARANTINE_CHILD_REQUEST is required");
}

const parsed = JSON.parse(requestText);
if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
  throw new Error("child request must be an object");
}
const REQUEST_KEYS = Object.freeze(["operation", "options", "killAt"]);
if (Reflect.ownKeys(parsed).some((key) => typeof key !== "string" || !REQUEST_KEYS.includes(key))) {
  throw new Error("unsupported quarantine child request field");
}
if (typeof parsed.operation !== "string" || parsed.options === null ||
    typeof parsed.options !== "object" || Array.isArray(parsed.options) ||
    (parsed.killAt !== undefined && typeof parsed.killAt !== "string")) {
  throw new Error("invalid quarantine child request");
}
const request = Object.freeze({
  operation: parsed.operation,
  options: Object.freeze({ ...parsed.options }),
  killAt: parsed.killAt,
});

const transaction = await import("../../../scripts/quarantine-transaction.mjs");
const transactionOperations = Object.freeze({
  quarantineWorkspace: transaction.quarantineWorkspace,
  recoverQuarantine: transaction.recoverQuarantine,
});
const restoreOperations = Object.freeze(["restoreQuarantine", "recoverRestore"]);
const operation = Object.hasOwn(transactionOperations, request.operation)
  ? transactionOperations[request.operation]
  : restoreOperations.includes(request.operation)
    ? (await import("../../../scripts/quarantine-numbered-copies-support.mjs"))[request.operation]
    : undefined;
if (typeof operation !== "function") {
  throw new Error("unsupported quarantine child operation");
}

const killAt = request.killAt;
const options = request.options;
const result = await operation({
  ...options,
  faultHook: async (phase) => {
    if (phase === killAt) process.kill(process.pid, "SIGKILL");
  },
});
process.stdout.write(JSON.stringify(result));
