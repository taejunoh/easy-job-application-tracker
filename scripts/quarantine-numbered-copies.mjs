import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  inspectWorkspace,
  markQuarantineValidated,
  quarantineWorkspace,
  recoverQuarantine,
  recoverRestore,
  restoreQuarantine,
} from "./quarantine-numbered-copies-support.mjs";

const COMMANDS = new Set(["inspect", "apply", "recover", "mark-validated", "restore"]);
const ROOT_FLAGS = ["--repo-root", "--quarantine-root"];
const HEAD = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const COUNT = /^(?:0|[1-9][0-9]*)$/u;
const TRANSACTION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ERROR_MESSAGES = Object.freeze({
  ERR_USAGE: "Invalid quarantine request.",
  ERR_PREFLIGHT: "Workspace preflight failed.",
  ERR_RECOVERY_REQUIRED: "Explicit quarantine recovery is required.",
  ERR_INTEGRITY: "Quarantine evidence failed integrity validation.",
  ERR_EXDEV: "Repository and quarantine must be on the same filesystem.",
  ERR_INDETERMINATE_JOURNAL_APPEND: "Journal durability could not be determined.",
  ERR_CONFLICT: "Quarantine recovery found preserved conflicts.",
  ERR_INTERNAL: "Unexpected quarantine failure.",
});

function cliFailure(command, code = "ERR_USAGE") {
  return Object.freeze({ failure: true, command, code, message: ERROR_MESSAGES[code] });
}

function isAbsoluteRoot(value) {
  return typeof value === "string" && isAbsolute(value) && !value.includes("\0") && value === value.normalize("NFC");
}

function validTransactionId(value) {
  return typeof value === "string" && value !== "." && value !== ".." &&
    value === value.normalize("NFC") && TRANSACTION_ID.test(value) && !BARE_UUID.test(value);
}

function parseArgv(argv) {
  const [token, ...tokens] = argv;
  const command = COMMANDS.has(token) ? token : null;
  if (command === null) return cliFailure(null);
  const values = Object.create(null);
  const flags = new Set();
  const expectsValue = new Set(command === "inspect" || command === "apply"
    ? ["--repo-root", "--quarantine-root", "--expected-branch", "--expected-head", "--expected-count"]
    : command === "recover"
      ? ["--repo-root", "--quarantine-root", "--transaction-id", "--action"]
      : ["--repo-root", "--quarantine-root", "--transaction-id"]);
  const needsWritersStopped = command !== "inspect";
  for (let index = 0; index < tokens.length; index += 1) {
    const flag = tokens[index];
    if (typeof flag !== "string" || !flag.startsWith("--") || flags.has(flag)) return cliFailure(command);
    flags.add(flag);
    if (flag === "--writers-stopped") {
      if (!needsWritersStopped) return cliFailure(command);
      continue;
    }
    if (!expectsValue.has(flag)) return cliFailure(command);
    const value = tokens[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return cliFailure(command);
    values[flag] = value;
    index += 1;
  }
  if ([...expectsValue].some((flag) => !flags.has(flag)) ||
      (needsWritersStopped !== flags.has("--writers-stopped"))) return cliFailure(command);
  if (ROOT_FLAGS.some((flag) => !isAbsoluteRoot(values[flag]))) return cliFailure(command);
  if (command === "inspect" || command === "apply") {
    if (typeof values["--expected-branch"] !== "string" || values["--expected-branch"].length === 0 ||
        values["--expected-branch"].includes("\0") || values["--expected-branch"] !== values["--expected-branch"].normalize("NFC") ||
        !HEAD.test(values["--expected-head"]) || !COUNT.test(values["--expected-count"]) ||
        !Number.isSafeInteger(Number(values["--expected-count"]))) return cliFailure(command);
  } else if (!validTransactionId(values["--transaction-id"]) ||
      (command === "recover" && values["--action"] !== "resume" && values["--action"] !== "rollback")) {
    return cliFailure(command);
  }
  const common = Object.freeze({ repoRoot: values["--repo-root"], quarantineRoot: values["--quarantine-root"] });
  if (command === "inspect") {
    return Object.freeze({ command, ...common, expectedBranch: values["--expected-branch"], expectedHead: values["--expected-head"], expectedCount: Number(values["--expected-count"]) });
  }
  if (command === "apply") {
    return Object.freeze({ command, ...common, expectedBranch: values["--expected-branch"], expectedHead: values["--expected-head"], expectedCount: Number(values["--expected-count"]), writersStopped: true, transactionId: `cli-${randomUUID()}`, createdAt: new Date().toISOString() });
  }
  return Object.freeze({ command, ...common, transactionId: values["--transaction-id"], writersStopped: true, ...(command === "recover" ? { action: values["--action"] } : {}) });
}

function conflict(result) {
  return result?.status === "INCOMPLETE_CONFLICT" || Array.isArray(result?.conflictEntryIds);
}

function publicInspect(result) {
  return Object.freeze({ ok: true, command: "inspect", status: "INSPECTED", sourceCopies: result.sourceCopies,
    generatedRoots: 2, identicalCopies: result.identicalCopies, divergentCopies: result.divergentCopies });
}

function publicApply(result) {
  return Object.freeze({ ok: true, command: "apply", status: "QUARANTINED", transactionId: result.transactionId,
    movedEntries: result.movedEntries, manifestSha256: result.manifestSha256 });
}

function publicValidated(result) {
  return Object.freeze({ ok: true, command: "mark-validated", status: "VALIDATED", transactionId: result.transactionId,
    manifestSha256: result.manifestSha256, validatedAt: result.validatedAt, deleteAfter: result.deleteAfter,
    deletionRequiresConfirmation: true });
}

function publicRestore(result) {
  return Object.freeze({ ok: true, command: "restore", status: "RESTORED", transactionId: result.transactionId,
    restoreId: result.restoreId, restoredEntries: result.restoredEntries });
}

function publicRecovery(result) {
  if (conflict(result)) throw Object.freeze({ code: "ERR_CONFLICT" });
  const safe = Object.freeze({
    transactionId: result.transactionId,
    ...(typeof result.restoreId === "string" ? { restoreId: result.restoreId } : {}),
    status: result.status,
    action: result.action,
    reconciledEntries: result.reconciledEntries,
    ...(result.restoreAborted === true ? { restoreAborted: true } : {}),
  });
  return Object.freeze({ ok: true, command: "recover", result: safe });
}

async function dispatch(command) {
  const { command: name, ...options } = command;
  if (name === "inspect") return publicInspect(await inspectWorkspace(options));
  if (name === "apply") return publicApply(await quarantineWorkspace(options));
  if (name === "mark-validated") {
    return publicValidated(await markQuarantineValidated({ ...options, validatedAt: new Date().toISOString() }));
  }
  if (name === "restore") return publicRestore(await restoreQuarantine(options));
  try {
    return publicRecovery(await recoverQuarantine(options));
  } catch (applyError) {
    if (applyError?.code !== "ERR_INTEGRITY") throw applyError;
    let restoreResult;
    try {
      restoreResult = await recoverRestore(options);
    } catch (restoreError) {
      if (restoreError?.code === "ERR_RESTORE_RECOVERY_NOT_APPLICABLE") throw applyError;
      throw restoreError;
    }
    return publicRecovery(restoreResult);
  }
}

function exitCodeFor(code) {
  if (code === "ERR_USAGE" || code === "ERR_PREFLIGHT") return 2;
  if (code === "ERR_INDETERMINATE_JOURNAL_APPEND") return 4;
  if (code === "ERR_RECOVERY_REQUIRED" || code === "ERR_CONFLICT" || code === "ERR_INTEGRITY" || code === "ERR_EXDEV") return 3;
  return 1;
}

function errorCode(error) {
  return Object.hasOwn(ERROR_MESSAGES, error?.code) ? error.code : "ERR_INTERNAL";
}

function emitFailure(command, error) {
  const code = errorCode(error);
  process.stderr.write(`${JSON.stringify({ ok: false, command, code, message: ERROR_MESSAGES[code] })}\n`);
  process.exitCode = exitCodeFor(code);
}

function writeJsonl(value) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, (error) => error == null ? resolve() : reject(error));
  });
}

async function main() {
  const argv = Object.freeze([...process.argv.slice(2)]);
  const parsed = parseArgv(argv);
  if (parsed.failure === true) {
    emitFailure(parsed.command, parsed);
    return;
  }
  try {
    if (parsed.command === "apply") {
      await writeJsonl({ ok: true, command: "apply", status: "STARTING", transactionId: parsed.transactionId });
    }
    await writeJsonl(await dispatch(parsed));
  } catch (error) {
    emitFailure(parsed.command, error);
  }
}

await main();
