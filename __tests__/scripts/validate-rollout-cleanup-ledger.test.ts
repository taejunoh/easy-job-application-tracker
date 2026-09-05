import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const script = join(__dirname, "../../scripts/validate-rollout-cleanup-ledger.mjs");
const validatorUrl = pathToFileURL(script).href;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function withHash<T extends Record<string, unknown>>(projection: T): T & { projectionSha256: string } {
  return {
    ...projection,
    projectionSha256: createHash("sha256").update(canonical(projection)).digest("hex"),
  };
}

function validLedger(outcome: "consume" | "expire" = "consume") {
  const expiresAt = "2026-09-05T12:10:00.123Z";
  const stage1Id = "dpl_stage1";
  const pairingEvidence = withHash({
    schemaVersion: 1, deploymentId: stage1Id, grantId: "grant_pre", expiresAt,
    expectedStatus: 503, observedStatus: 503, cacheControl: "private, no-store",
    retryAfter: "60", code: "writes_stopped", observedAt: "2026-09-05T12:00:01Z",
  });
  const writeStopEvidence = withHash({
    schemaVersion: 1, deploymentId: stage1Id, expectedStatus: 503, observedStatus: 503,
    cacheControl: "private, no-store", retryAfter: "60", code: "writes_stopped",
    observedAt: "2026-09-05T12:00:01Z",
  });
  const preStop = outcome === "consume"
    ? {
      action: "consume_pairing_grant", targetId: "grant_pre", expectedTerminalState: "replay_401", observedResult: "verified",
      observedAt: "2026-09-05T12:05:00Z", firstExchangeStatus: 201, createdInstallationId: "installation_pre_exchange",
      replayStatus: 401, revoke: { mutationStatus: 200, credentialStatus: 401, verified: true },
    }
    : {
      action: "expire_pairing_grant", targetId: "grant_pre", expectedTerminalState: "expired_401", observedResult: "verified",
      observedAt: "2026-09-05T12:11:00Z", exchangeStatus: 401, pairingEvidenceSha256: pairingEvidence.projectionSha256,
      beforeInstallations: { count: 2, sha256: "a".repeat(64) }, afterInstallations: { count: 2, sha256: "a".repeat(64) },
    };
  return {
    schemaVersion: 1,
    stage1: {
      deploymentId: stage1Id, targetSha: "a".repeat(40), gates: { identity: "1", writes: "0" },
      reviewedGateConfig: { identity: "1", writes: "0", reviewedAt: "2026-09-05T12:00:00Z" },
      ready: true, readyState: "READY", readyEvidence: { deploymentId: stage1Id, state: "READY", observedAt: "2026-09-05T12:00:00Z" },
      canonicalPromotionVerified: true, canonicalPromotion: { origin: "https://easy-job-application-tracker.vercel.app", deploymentId: stage1Id, verified: true, verifiedAt: "2026-09-05T12:00:00Z" },
      compatibilityVerified: true, timestamps: { recordedAt: "2026-09-05T12:00:00Z", readyObservedAt: "2026-09-05T12:00:00Z", canonicalPromotionVerifiedAt: "2026-09-05T12:00:00Z" },
      writeStopEvidence, pairingEvidence,
    },
    fixtureOwnership: {
      applicationIds: ["app_pre"], postResumeApplicationIds: ["app_post"], ownedDeploymentIds: [stage1Id],
      pairingGrantIds: ["grant_pre"], postResumePairingGrantIds: ["grant_post"],
      installationIds: ["installation_pre"], postResumeInstallationIds: outcome === "consume" ? ["installation_pre_exchange", "installation_post_exchange"] : ["installation_post_exchange"],
      applicationSnapshotBefore: { count: 0, sha256: "b".repeat(64) }, preProbeHash: "b".repeat(64), postProbeHash: "b".repeat(64),
      settings: { existedBefore: true, contentHashBefore: "c".repeat(64), contentHashAfter: "c".repeat(64) },
      pairing: { preStopUnconsumedGrantId: "grant_pre", codeReference: "private-code-ref", expiresAt },
      installation: { credentialReference: "private-credential-ref", installationId: "installation_pre" },
      cleanup: [
        preStop,
        { action: "consume_pairing_grant", targetId: "grant_post", expectedTerminalState: "replay_401", observedResult: "verified", observedAt: "2026-09-05T12:12:00Z", firstExchangeStatus: 201, createdInstallationId: "installation_post_exchange", replayStatus: 401, revoke: { mutationStatus: 200, credentialStatus: 401, verified: true } },
        { action: "delete_application", targetId: "app_pre", expectedTerminalState: "deleted_404", observedResult: "verified", observedAt: "2026-09-05T12:13:00Z", deleteStatus: 200, verifyStatus: 404 },
        { action: "delete_application", targetId: "app_post", expectedTerminalState: "deleted_404", observedResult: "verified", observedAt: "2026-09-05T12:13:01Z", deleteStatus: 200, verifyStatus: 404 },
        { action: "revoke_installation", targetId: "installation_pre", expectedTerminalState: "credential_401", observedResult: "verified", observedAt: "2026-09-05T12:14:00Z", mutationStatus: 200, credentialStatus: 401 },
        { action: "reconcile", targetRef: "settings", expectedTerminalState: "matched", observedResult: "verified", observedAt: "2026-09-05T12:15:00Z", applicationSnapshot: { count: 0, sha256: "b".repeat(64) }, settingsSnapshot: { existed: true, contentHash: "c".repeat(64) } },
      ],
    },
  };
}

function validate(ledger: unknown): boolean {
  const source = `import { validateFinalCleanupLedger } from ${JSON.stringify(validatorUrl)}; process.stdout.write(String(validateFinalCleanupLedger(${JSON.stringify(ledger)}, { targetSha: ${JSON.stringify("a".repeat(40))}, canonicalOrigin: "https://easy-job-application-tracker.vercel.app" })));`;
  return execFileSync(process.execPath, ["--input-type=module", "--eval", source], { encoding: "utf8" }) === "true";
}

describe("final production rollout cleanup ledger validator", () => {
  it.each(["consume", "expire"] as const)("accepts a complete %s pre-stop terminal outcome", (outcome) => {
    expect(validate(validLedger(outcome))).toBe(true);
  });

  it("rejects pending, ambiguous, tampered, and incomplete cleanup evidence", () => {
    const pending = validLedger();
    pending.fixtureOwnership.cleanup[0].observedResult = "pending";
    expect(validate(pending)).toBe(false);

    const ambiguous = validLedger();
    ambiguous.fixtureOwnership.cleanup.splice(1, 0, { ...ambiguous.fixtureOwnership.cleanup[0], action: "expire_pairing_grant", expectedTerminalState: "expired_401" });
    expect(validate(ambiguous)).toBe(false);

    const tampered = validLedger("expire");
    tampered.stage1.pairingEvidence.projectionSha256 = "0".repeat(64);
    expect(validate(tampered)).toBe(false);

    const missingDeletion = validLedger();
    missingDeletion.fixtureOwnership.cleanup = missingDeletion.fixtureOwnership.cleanup.filter((entry) => entry.targetId !== "app_post");
    expect(validate(missingDeletion)).toBe(false);

    const unowned = validLedger();
    unowned.fixtureOwnership.cleanup.push({ action: "consume_pairing_grant", targetId: "grant_unowned", expectedTerminalState: "replay_401", observedResult: "verified", observedAt: "2026-09-05T12:16:00Z", firstExchangeStatus: 201, createdInstallationId: "installation_post_exchange", replayStatus: 401, revoke: { mutationStatus: 200, credentialStatus: 401, verified: true } });
    expect(validate(unowned)).toBe(false);
  });

  it("rejects expiry evidence outside the exact Stage 1 binding or with changed snapshots", () => {
    const wrongId = validLedger("expire");
    const { projectionSha256, ...projection } = wrongId.stage1.pairingEvidence;
    expect(projectionSha256).toMatch(/^[0-9a-f]{64}$/u);
    wrongId.stage1.pairingEvidence = withHash({ ...projection, deploymentId: "dpl_other" });
    expect(validate(wrongId)).toBe(false);

    const afterExpiry = validLedger("expire");
    afterExpiry.stage1.pairingEvidence.observedAt = "2026-09-05T12:10:01Z";
    expect(validate(afterExpiry)).toBe(false);

    const changed = validLedger("expire");
    const expiry = changed.fixtureOwnership.cleanup[0] as Record<string, unknown>;
    (expiry.afterInstallations as Record<string, unknown>).sha256 = "d".repeat(64);
    expect(validate(changed)).toBe(false);
  });

  it("requires a distinct fresh post-resume grant and revocation evidence for every owned installation", () => {
    const sameGrant = validLedger();
    (sameGrant.fixtureOwnership.cleanup[1] as Record<string, unknown>).targetId = "grant_pre";
    expect(validate(sameGrant)).toBe(false);

    const missingRevoke = validLedger();
    missingRevoke.fixtureOwnership.installationIds.push("installation_extra");
    expect(validate(missingRevoke)).toBe(false);

    const overlapping = validLedger();
    overlapping.fixtureOwnership.postResumePairingGrantIds = ["grant_pre"];
    expect(validate(overlapping)).toBe(false);

    const tamperedStage1 = validLedger();
    tamperedStage1.stage1.readyEvidence.deploymentId = "dpl_other";
    expect(validate(tamperedStage1)).toBe(false);

    const preexistingCreated = validLedger();
    (preexistingCreated.fixtureOwnership.cleanup[0] as Record<string, unknown>).createdInstallationId = "installation_pre";
    expect(validate(preexistingCreated)).toBe(false);
  });

  it("CLI accepts only a bounded private regular ledger and emits generic errors", () => {
    const root = mkdtempSync(join(tmpdir(), "rollout-cleanup-validator-"));
    try {
      const privateRoot = join(root, "private");
      mkdirSync(privateRoot, { mode: 0o700 });
      chmodSync(privateRoot, 0o700);
      const ledger = join(privateRoot, "rollout-ledger.json");
      const forCli = validLedger();
      forCli.stage1.targetSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      writeFileSync(ledger, JSON.stringify(forCli), { mode: 0o600 });
      expect(spawnSync(process.execPath, [script, ledger], { encoding: "utf8" }).status).toBe(0);

      chmodSync(ledger, 0o644);
      const unsafeMode = spawnSync(process.execPath, [script, ledger], { encoding: "utf8" });
      expect(unsafeMode.status).not.toBe(0);
      expect(unsafeMode.stderr).toBe("Invalid rollout cleanup ledger\n");

      chmodSync(ledger, 0o600);
      const link = join(privateRoot, "link.json");
      symlinkSync(ledger, link);
      const linked = spawnSync(process.execPath, [script, link], { encoding: "utf8" });
      expect(linked.status).not.toBe(0);
      expect(linked.stderr).toBe("Invalid rollout cleanup ledger\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
