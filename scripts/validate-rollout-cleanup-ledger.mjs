import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_LEDGER_BYTES = 1024 * 1024;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function sha256(value) {
  return typeof value === "string" && SHA256.test(value);
}

function utc(value, millisecondsRequired = false) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return false;
  const canonical = new Date(value).toISOString();
  const seconds = canonical.replace(".000Z", "Z");
  return (value === canonical || value === seconds) && (!millisecondsRequired || value === canonical);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validIds(value, required = false) {
  return Array.isArray(value) && (!required || value.length > 0) &&
    value.every(nonEmptyString) && new Set(value).size === value.length;
}

function validSnapshot(value) {
  return hasKeys(value, ["count", "sha256"]) && Number.isInteger(value.count) && value.count >= 0 && sha256(value.sha256);
}

function validRevocation(value) {
  return hasKeys(value, ["mutationStatus", "credentialStatus", "verified"]) &&
    value.mutationStatus === 200 && value.credentialStatus === 401 && value.verified === true;
}

function validStageEvidence(value, required, stage1Id, grantId, expiresAt) {
  if (!hasKeys(value, [...required, "projectionSha256"]) || !sha256(value.projectionSha256)) return false;
  const { projectionSha256, ...projection } = value;
  if (createHash("sha256").update(canonicalJson(projection)).digest("hex") !== projectionSha256) return false;
  if (projection.schemaVersion !== 1 || projection.deploymentId !== stage1Id ||
      projection.expectedStatus !== 503 || projection.observedStatus !== 503 ||
      projection.cacheControl !== "private, no-store" || projection.retryAfter !== "60" ||
      projection.code !== "writes_stopped" || !utc(projection.observedAt)) return false;
  return grantId === undefined || (
    projection.grantId === grantId && projection.expiresAt === expiresAt &&
    utc(projection.expiresAt, true) && Date.parse(projection.observedAt) < Date.parse(projection.expiresAt)
  );
}

function validConsume(record, ownedInstallations) {
  return hasKeys(record, ["action", "targetId", "expectedTerminalState", "observedResult", "observedAt", "firstExchangeStatus", "createdInstallationId", "replayStatus", "revoke"]) &&
    record.action === "consume_pairing_grant" && record.expectedTerminalState === "replay_401" &&
    record.observedResult === "verified" && utc(record.observedAt) && record.firstExchangeStatus === 201 &&
    nonEmptyString(record.createdInstallationId) && ownedInstallations.has(record.createdInstallationId) &&
    record.replayStatus === 401 && validRevocation(record.revoke);
}

function validFinalLedger(ledger) {
  if (!hasKeys(ledger, ["schemaVersion", "stage1", "fixtureOwnership"]) || ledger.schemaVersion !== 1) return false;
  const { stage1, fixtureOwnership: owned } = ledger;
  if (!isObject(stage1) || !nonEmptyString(stage1.deploymentId) || !isObject(owned)) return false;

  const applicationIds = owned.applicationIds;
  const postResumeApplicationIds = owned.postResumeApplicationIds ?? [];
  const pairingGrantIds = owned.pairingGrantIds;
  const postResumePairingGrantIds = owned.postResumePairingGrantIds;
  const installationIds = owned.installationIds ?? [];
  const postResumeInstallationIds = owned.postResumeInstallationIds;
  if (!validIds(applicationIds, true) || !validIds(postResumeApplicationIds) ||
      !validIds(pairingGrantIds, true) || !validIds(postResumePairingGrantIds, true) ||
      !validIds(installationIds) || !validIds(postResumeInstallationIds, true) ||
      !sha256(owned.preProbeHash) || owned.postProbeHash !== owned.preProbeHash || !isObject(owned.settings) ||
      !hasKeys(owned.settings, ["existedBefore", "contentHashBefore", "contentHashAfter"]) ||
      typeof owned.settings.existedBefore !== "boolean" || !sha256(owned.settings.contentHashBefore) ||
      owned.settings.contentHashAfter !== owned.settings.contentHashBefore || !isObject(owned.pairing) ||
      !hasKeys(owned.pairing, ["preStopUnconsumedGrantId", "codeReference", "expiresAt"]) ||
      !nonEmptyString(owned.pairing.preStopUnconsumedGrantId) || !nonEmptyString(owned.pairing.codeReference) ||
      !utc(owned.pairing.expiresAt, true) || !pairingGrantIds.includes(owned.pairing.preStopUnconsumedGrantId) ||
      !isObject(owned.installation) || !hasKeys(owned.installation, ["credentialReference", "installationId"]) ||
      !nonEmptyString(owned.installation.credentialReference) || !nonEmptyString(owned.installation.installationId) ||
      !Array.isArray(owned.cleanup) || owned.cleanup.length === 0) return false;

  const writeStopKeys = ["schemaVersion", "deploymentId", "expectedStatus", "observedStatus", "cacheControl", "retryAfter", "code", "observedAt"];
  const pairingKeys = [...writeStopKeys, "grantId", "expiresAt"];
  if (!validStageEvidence(stage1.writeStopEvidence, writeStopKeys, stage1.deploymentId) ||
      !validStageEvidence(stage1.pairingEvidence, pairingKeys, stage1.deploymentId,
        owned.pairing.preStopUnconsumedGrantId, owned.pairing.expiresAt)) return false;

  const applicationSet = new Set([...applicationIds, ...postResumeApplicationIds]);
  const installationSet = new Set([owned.installation.installationId, ...installationIds, ...postResumeInstallationIds]);
  if (applicationSet.size !== applicationIds.length + postResumeApplicationIds.length) return false;

  const preStop = owned.pairing.preStopUnconsumedGrantId;
  const cleanup = owned.cleanup;
  if (!cleanup.every((record) => isObject(record) && record.observedResult === "verified" && utc(record.observedAt))) return false;
  for (const record of cleanup) {
    if (record.action === "delete_application") {
      if (!applicationSet.has(record.targetId)) return false;
    } else if (record.action === "consume_pairing_grant") {
      if (record.targetId !== preStop && !postResumePairingGrantIds.includes(record.targetId)) return false;
    } else if (record.action === "expire_pairing_grant") {
      if (record.targetId !== preStop) return false;
    } else if (record.action === "revoke_installation") {
      if (!installationSet.has(record.targetId)) return false;
    } else if (record.action === "reconcile") {
      if (record.targetRef !== "settings") return false;
    } else return false;
  }
  const uniqueActions = new Set();
  for (const record of cleanup) {
    const target = record.targetId ?? record.targetRef;
    if (!nonEmptyString(record.action) || !nonEmptyString(target)) return false;
    const key = `${record.action}:${target}`;
    if (uniqueActions.has(key)) return false;
    uniqueActions.add(key);
  }

  const preStopOutcomes = cleanup.filter((record) => record.targetId === preStop &&
    (record.action === "consume_pairing_grant" || record.action === "expire_pairing_grant"));
  if (preStopOutcomes.length !== 1) return false;
  const preStopOutcome = preStopOutcomes[0];
  if (preStopOutcome.action === "consume_pairing_grant") {
    if (!validConsume(preStopOutcome, installationSet)) return false;
  } else if (!hasKeys(preStopOutcome, ["action", "targetId", "expectedTerminalState", "observedResult", "observedAt", "exchangeStatus", "pairingEvidenceSha256", "beforeInstallations", "afterInstallations"]) ||
      preStopOutcome.expectedTerminalState !== "expired_401" || preStopOutcome.exchangeStatus !== 401 ||
      preStopOutcome.pairingEvidenceSha256 !== stage1.pairingEvidence.projectionSha256 ||
      Date.parse(preStopOutcome.observedAt) <= Date.parse(owned.pairing.expiresAt) ||
      !validSnapshot(preStopOutcome.beforeInstallations) || !validSnapshot(preStopOutcome.afterInstallations) ||
      preStopOutcome.beforeInstallations.count !== preStopOutcome.afterInstallations.count ||
      preStopOutcome.beforeInstallations.sha256 !== preStopOutcome.afterInstallations.sha256) return false;

  const postResumeConsumes = cleanup.filter((record) => record.action === "consume_pairing_grant" &&
    postResumePairingGrantIds.includes(record.targetId));
  if (postResumeConsumes.length !== postResumePairingGrantIds.length ||
      new Set(postResumeConsumes.map((record) => record.targetId)).size !== postResumePairingGrantIds.length ||
      !postResumeConsumes.every((record) => record.targetId !== preStop && validConsume(record, installationSet))) return false;

  const deleteRecords = cleanup.filter((record) => record.action === "delete_application");
  if (deleteRecords.length !== applicationSet.size || !deleteRecords.every((record) =>
    applicationSet.has(record.targetId) && record.expectedTerminalState === "deleted_404" &&
    record.deleteStatus === 200 && record.verifyStatus === 404) ||
    new Set(deleteRecords.map((record) => record.targetId)).size !== applicationSet.size) return false;

  const directRevokes = cleanup.filter((record) => record.action === "revoke_installation");
  if (!directRevokes.every((record) => installationSet.has(record.targetId) &&
    record.expectedTerminalState === "credential_401" && record.mutationStatus === 200 && record.credentialStatus === 401)) return false;
  const revokedByConsume = cleanup.filter((record) => record.action === "consume_pairing_grant" && validConsume(record, installationSet))
    .map((record) => record.createdInstallationId);
  const revoked = new Set([...directRevokes.map((record) => record.targetId), ...revokedByConsume]);
  if (revoked.size !== installationSet.size || [...installationSet].some((id) => !revoked.has(id))) return false;

  const reconciliations = cleanup.filter((record) => record.action === "reconcile");
  if (reconciliations.length !== 1) return false;
  const reconcile = reconciliations[0];
  return hasKeys(reconcile, ["action", "targetRef", "expectedTerminalState", "observedResult", "observedAt", "applicationSnapshot", "settingsSnapshot"]) &&
    reconcile.targetRef === "settings" && reconcile.expectedTerminalState === "matched" &&
    validSnapshot(reconcile.applicationSnapshot) && reconcile.applicationSnapshot.sha256 === owned.preProbeHash &&
    hasKeys(reconcile.settingsSnapshot, ["existed", "contentHash"]) &&
    reconcile.settingsSnapshot.existed === owned.settings.existedBefore &&
    reconcile.settingsSnapshot.contentHash === owned.settings.contentHashBefore;
}

/** Returns true only for a complete, internally-bound cleanup ledger. */
export function validateFinalCleanupLedger(ledger) {
  try {
    return validFinalLedger(ledger);
  } catch {
    return false;
  }
}

function readPrivateLedger(path) {
  if (process.platform === "win32" || typeof path !== "string" || !path.startsWith("/")) throw new Error();
  const parent = realpathSync(dirname(path));
  const candidate = resolve(parent, basename(path));
  const repository = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const commonRepository = basename(dirname(repository)) === ".worktrees"
    ? dirname(dirname(repository))
    : repository;
  if (candidate === repository || candidate.startsWith(`${repository}/`) ||
      candidate === commonRepository || candidate.startsWith(`${commonRepository}/`)) throw new Error();
  const parentStat = lstatSync(parent);
  const before = lstatSync(candidate);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o777) !== 0o700 ||
      !before.isFile() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o600 ||
      before.size > MAX_LEDGER_BYTES) throw new Error();
  const parsed = JSON.parse(readFileSync(candidate, "utf8"));
  const after = lstatSync(candidate);
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      !after.isFile() || after.isSymbolicLink() || (after.mode & 0o777) !== 0o600) throw new Error();
  return parsed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || !validateFinalCleanupLedger(readPrivateLedger(process.argv[2]))) throw new Error();
    process.exitCode = 0;
  } catch {
    process.stderr.write("Invalid rollout cleanup ledger\n");
    process.exitCode = 1;
  }
}
