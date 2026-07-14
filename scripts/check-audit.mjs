import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultExceptionsPath = resolve(
  root,
  "docs/operations/npm-audit-exceptions.json",
);
const severityNames = ["info", "low", "moderate", "high", "critical"];

let counts;
let exceptionCount = 0;

try {
  const options = parseArguments(process.argv.slice(2));
  const audit = loadAudit(options.auditFile);
  counts = validateAuditCounts(audit);
  const policy = readJson(options.exceptionsFile ?? defaultExceptionsPath);
  exceptionCount = Array.isArray(policy?.exceptions)
    ? policy.exceptions.length
    : 0;

  if (counts.high > 0 || counts.critical > 0) throw new Error("blocked severity");

  validatePolicyDates(policy, options.today);
  const actual = mapConcreteAdvisories(audit.vulnerabilities);
  validateExceptions(policy.exceptions, actual);

  console.log(formatResult("passed", counts, exceptionCount));
} catch {
  console.error(
    counts
      ? formatResult("failed", counts, exceptionCount)
      : "Audit policy failed: counts unavailable",
  );
  process.exitCode = 1;
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!value) throw new Error("missing argument value");
    if (flag === "--audit-file") options.auditFile = resolve(value);
    else if (flag === "--exceptions-file") options.exceptionsFile = resolve(value);
    else if (flag === "--today") options.today = value;
    else throw new Error("unknown argument");
  }
  if (options.today && !options.auditFile) throw new Error("test date requires fixture");
  return options;
}

function loadAudit(auditFile) {
  if (auditFile) return readJson(auditFile);

  const result = spawnSync("npm", ["audit", "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw new Error("npm audit failed");
  }
  return JSON.parse(result.stdout);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function validateAuditCounts(audit) {
  if (
    !isRecord(audit) ||
    audit.error ||
    audit.auditReportVersion !== 2 ||
    !isRecord(audit.vulnerabilities) ||
    !isRecord(audit.metadata) ||
    !isRecord(audit.metadata.vulnerabilities)
  ) {
    throw new Error("invalid audit report");
  }

  const computed = Object.fromEntries(severityNames.map((name) => [name, 0]));
  for (const [name, vulnerability] of Object.entries(audit.vulnerabilities)) {
    if (
      !isRecord(vulnerability) ||
      vulnerability.name !== name ||
      !severityNames.includes(vulnerability.severity) ||
      !Array.isArray(vulnerability.via)
    ) {
      throw new Error("invalid vulnerability");
    }
    computed[vulnerability.severity] += 1;
  }
  computed.total = Object.values(computed).reduce((sum, value) => sum + value, 0);

  for (const name of [...severityNames, "total"]) {
    if (
      !Number.isSafeInteger(audit.metadata.vulnerabilities[name]) ||
      audit.metadata.vulnerabilities[name] < 0 ||
      audit.metadata.vulnerabilities[name] !== computed[name]
    ) {
      throw new Error("audit count mismatch");
    }
  }
  return computed;
}

function validatePolicyDates(policy, todayOverride) {
  if (
    !isRecord(policy) ||
    policy.schemaVersion !== 1 ||
    !Array.isArray(policy.exceptions)
  ) {
    throw new Error("invalid policy");
  }
  const reviewedOn = parseDate(policy.reviewedOn);
  const reviewBy = parseDate(policy.reviewBy);
  const today = parseDate(
    todayOverride ?? new Date().toISOString().slice(0, "YYYY-MM-DD".length),
  );
  if (reviewedOn > today || reviewBy < today || reviewBy < reviewedOn) {
    throw new Error("expired policy");
  }
}

function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error("invalid date");
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error("invalid date");
  }
  return date;
}

function mapConcreteAdvisories(vulnerabilities) {
  const advisories = new Map();
  const packageAdvisories = new Map();
  const resolving = new Set();

  function resolvePackage(name) {
    if (packageAdvisories.has(name)) return packageAdvisories.get(name);
    if (resolving.has(name) || !isRecord(vulnerabilities[name])) {
      throw new Error("invalid wrapper reference");
    }
    resolving.add(name);
    const ids = new Set();
    for (const via of vulnerabilities[name].via) {
      if (typeof via === "string") {
        for (const id of resolvePackage(via)) ids.add(id);
        continue;
      }
      if (!isRecord(via)) throw new Error("invalid advisory");
      const id = advisoryId(via.url);
      if (
        via.name !== name ||
        !severityNames.includes(via.severity) ||
        !id
      ) {
        throw new Error("invalid advisory");
      }
      const existing = advisories.get(id);
      const advisory = { id, url: via.url, severity: via.severity, scope: new Set() };
      if (
        existing &&
        (existing.url !== advisory.url || existing.severity !== advisory.severity)
      ) {
        throw new Error("conflicting advisory");
      }
      if (!existing) advisories.set(id, advisory);
      ids.add(id);
    }
    resolving.delete(name);
    if (ids.size === 0) throw new Error("unmapped vulnerability");
    packageAdvisories.set(name, ids);
    return ids;
  }

  for (const name of Object.keys(vulnerabilities)) {
    for (const id of resolvePackage(name)) advisories.get(id).scope.add(name);
  }
  return advisories;
}

function advisoryId(url) {
  if (typeof url !== "string") return undefined;
  const match = /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/u.exec(
    url,
  );
  return match?.[1];
}

function validateExceptions(exceptions, actual) {
  const declared = new Map();
  for (const exception of exceptions) {
    if (
      !isRecord(exception) ||
      typeof exception.id !== "string" ||
      exception.url !== `https://github.com/advisories/${exception.id}` ||
      !["low", "moderate"].includes(exception.severity) ||
      !Array.isArray(exception.scope) ||
      exception.scope.length === 0 ||
      exception.scope.some((name) => typeof name !== "string" || !name) ||
      new Set(exception.scope).size !== exception.scope.length ||
      typeof exception.rationale !== "string" ||
      !exception.rationale.trim() ||
      typeof exception.remediation !== "string" ||
      !exception.remediation.trim() ||
      declared.has(exception.id)
    ) {
      throw new Error("invalid exception");
    }
    declared.set(exception.id, exception);
  }

  if (declared.size !== actual.size) throw new Error("stale exception set");
  for (const [id, advisory] of actual) {
    const exception = declared.get(id);
    if (
      !exception ||
      exception.url !== advisory.url ||
      exception.severity !== advisory.severity ||
      !sameStrings(exception.scope, [...advisory.scope])
    ) {
      throw new Error("exception mismatch");
    }
  }
}

function sameStrings(left, right) {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function formatResult(status, auditCounts, exceptions) {
  return `Audit policy ${status}: critical=${auditCounts.critical} high=${auditCounts.high} moderate=${auditCounts.moderate} low=${auditCounts.low} exceptions=${exceptions}`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
