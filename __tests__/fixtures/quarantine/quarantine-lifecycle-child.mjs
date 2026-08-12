import process from "node:process";

const requestText = process.env.QUARANTINE_CHILD_REQUEST;
if (typeof requestText !== "string") {
  throw new Error("QUARANTINE_CHILD_REQUEST is required");
}

const request = JSON.parse(requestText);
if (request === null || typeof request !== "object" || Array.isArray(request)) {
  throw new Error("child request must be an object");
}

const transaction = await import("../../../scripts/quarantine-transaction.mjs");
let restore;
if (request.operation === "restoreQuarantine" || request.operation === "recoverRestore") {
  restore = await import("../../../scripts/quarantine-numbered-copies-support.mjs");
}
const operationTable = Object.freeze({
  quarantineWorkspace: transaction.quarantineWorkspace,
  recoverQuarantine: transaction.recoverQuarantine,
  restoreQuarantine: restore?.restoreQuarantine,
  recoverRestore: restore?.recoverRestore,
});

const operation = operationTable[request.operation];
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
