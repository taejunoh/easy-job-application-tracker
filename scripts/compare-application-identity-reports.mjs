import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

const REPORT_KEYS = [
  "schemaVersion",
  "mode",
  "rowCountBefore",
  "rowCountAfter",
  "stateTotals",
  "uniqueIndexVerified",
  "rows",
];
const STATE_TOTAL_KEYS = ["canonical", "legacy_duplicate", "legacy_unresolved"];
const ROW_KEYS = ["rowIdHash", "state"];
const DUPLICATE_ROW_KEYS = [...ROW_KEYS, "duplicateOfIdHash"];
const STATES = new Set(STATE_TOTAL_KEYS);
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const expected = await readReport(options.expectedPath, "dry-run");
  const actual = await readReport(options.actualPath, options.actualMode);

  if (!isDeepStrictEqual(invariant(expected), invariant(actual))) {
    throw new Error("Reports differ");
  }
  process.stdout.write("Application identity reports match.\n");
}

function parseArguments(args) {
  let expectedPath;
  let actualPath;
  let actualMode;
  const seen = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!Object.hasOwn({ "--expected": true, "--actual": true, "--actual-mode": true }, flag)
      || seen.has(flag)) {
      throw new Error("Invalid arguments");
    }
    seen.add(flag);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("Invalid arguments");
    index += 1;

    if (flag === "--expected") expectedPath = value;
    else if (flag === "--actual") actualPath = value;
    else actualMode = value;
  }

  if (!expectedPath || !actualPath || !actualMode
    || !isAbsolute(expectedPath) || !isAbsolute(actualPath)
    || (actualMode !== "dry-run" && actualMode !== "apply")) {
    throw new Error("Invalid arguments");
  }
  return { expectedPath, actualPath, actualMode };
}

async function readReport(path, requiredMode) {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  return validateReport(parsed, requiredMode);
}

function validateReport(value, requiredMode) {
  if (!hasExactKeys(value, REPORT_KEYS)
    || value.schemaVersion !== 1
    || value.mode !== requiredMode
    || !isCount(value.rowCountBefore)
    || !isCount(value.rowCountAfter)
    || value.rowCountBefore !== value.rowCountAfter
    || value.uniqueIndexVerified !== true
    || !hasExactKeys(value.stateTotals, STATE_TOTAL_KEYS)
    || !STATE_TOTAL_KEYS.every((key) => isCount(value.stateTotals[key]))
    || !Array.isArray(value.rows)
    || value.rows.length !== value.rowCountBefore
    || STATE_TOTAL_KEYS.reduce((sum, key) => sum + value.stateTotals[key], 0) !== value.rowCountBefore) {
    throw new Error("Invalid report");
  }

  const rows = value.rows.map(validateRow);
  const totals = Object.fromEntries(STATE_TOTAL_KEYS.map((state) => [state, 0]));
  const rowByHash = new Map();
  for (const row of rows) {
    if (rowByHash.has(row.rowIdHash)) throw new Error("Invalid report");
    rowByHash.set(row.rowIdHash, row);
    totals[row.state] += 1;
  }
  if (!isDeepStrictEqual(totals, value.stateTotals)) throw new Error("Invalid report");
  for (const row of rows) {
    if (row.state === "legacy_duplicate") {
      const target = rowByHash.get(row.duplicateOfIdHash);
      if (!target || target.state !== "canonical") throw new Error("Invalid report");
    }
  }
  return value;
}

function validateRow(value) {
  if (!isObject(value)
    || !HASH_PATTERN.test(value.rowIdHash)
    || !STATES.has(value.state)) {
    throw new Error("Invalid report");
  }
  if (value.state === "legacy_duplicate") {
    if (!hasExactKeys(value, DUPLICATE_ROW_KEYS)
      || !HASH_PATTERN.test(value.duplicateOfIdHash)
      || value.duplicateOfIdHash === value.rowIdHash) {
      throw new Error("Invalid report");
    }
  } else if (!hasExactKeys(value, ROW_KEYS)) {
    throw new Error("Invalid report");
  }
  return value;
}

function invariant(report) {
  return {
    schemaVersion: report.schemaVersion,
    rowCountBefore: report.rowCountBefore,
    rowCountAfter: report.rowCountAfter,
    stateTotals: report.stateTotals,
    uniqueIndexVerified: report.uniqueIndexVerified,
    rows: report.rows,
  };
}

function hasExactKeys(value, keys) {
  return isObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

main().catch(() => {
  process.stderr.write("Application identity report comparison failed.\n");
  process.exitCode = 1;
});
