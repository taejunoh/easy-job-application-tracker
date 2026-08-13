import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(__dirname, "../..");
const fixtures = join(root, "__tests__/fixtures/audit");
const script = join(root, "scripts/check-audit.mjs");
const allowedAudit = JSON.parse(
  readFileSync(join(fixtures, "audit-allowed.json"), "utf8"),
) as AuditFixture;
const allowedExceptions = JSON.parse(
  readFileSync(join(fixtures, "exceptions-allowed.json"), "utf8"),
) as ExceptionsFixture;

type AuditFixture = {
  auditReportVersion: number;
  vulnerabilities: Record<string, Record<string, unknown>>;
  metadata: {
    vulnerabilities: Record<string, number>;
  };
  error?: unknown;
};

type ExceptionsFixture = {
  schemaVersion: number;
  reviewedOn: string;
  reviewBy: string;
  exceptions: Array<{
    id: string;
    url: string;
    severity: string;
    scope: string[];
    rationale: string;
    remediation: string;
  }>;
};

describe("npm audit exception policy", () => {
  let temporaryDirectory: string;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "audit-policy-test-"));
  });

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it("accepts only bidirectionally mapped concrete advisory exceptions", () => {
    const result = runPolicy(
      join(fixtures, "audit-allowed.json"),
      join(fixtures, "exceptions-allowed.json"),
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "Audit policy passed: full critical=0 high=0 moderate=5 low=0 exceptions=2",
    );
    expect(result.stderr).toBe("");
  });

  it("reports full and production graphs separately while enforcing both gates", () => {
    const production = structuredClone(allowedAudit);
    production.metadata.vulnerabilities.moderate = 0;
    production.metadata.vulnerabilities.total = 0;
    production.vulnerabilities = {};

    const result = runPolicy(
      join(fixtures, "audit-allowed.json"),
      join(fixtures, "exceptions-allowed.json"),
      writeFixture("production.json", production),
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "Audit policy passed: full critical=0 high=0 moderate=5 low=0 production critical=0 high=0 moderate=0 low=0 exceptions=2",
    );
    expect(result.stderr).toBe("");
  });

  it.each(["high", "critical"])("rejects every %s advisory", (severity) => {
    const audit = structuredClone(allowedAudit);
    const policy = structuredClone(allowedExceptions);
    const id = severity === "high" ? "GHSA-aaaa-bbbb-cccc" : "GHSA-dddd-eeee-ffff";
    audit.vulnerabilities[`dangerous-${severity}`] = concreteVulnerability(
      `dangerous-${severity}`,
      id,
      severity,
    );
    audit.metadata.vulnerabilities[severity] = 1;
    audit.metadata.vulnerabilities.total = 6;
    policy.exceptions.push({
      id,
      url: `https://github.com/advisories/${id}`,
      severity,
      scope: [`dangerous-${severity}`],
      rationale: "Even an explicit exception must not permit this severity.",
      remediation: "Remove it immediately.",
    });

    const result = runGenerated(audit, policy);

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(
      `Audit policy failed: full critical=${severity === "critical" ? 1 : 0} high=${severity === "high" ? 1 : 0} moderate=5 low=0 exceptions=3`,
    );
  });

  it.each(["moderate", "low"])(
    "rejects an unexpected %s advisory",
    (severity) => {
      const audit = structuredClone(allowedAudit);
      audit.vulnerabilities[`unexpected-${severity}`] = concreteVulnerability(
        `unexpected-${severity}`,
        "GHSA-gggg-hhhh-jjjj",
        severity,
      );
      audit.metadata.vulnerabilities[severity] += 1;
      audit.metadata.vulnerabilities.total = 6;

      const result = runGenerated(audit, allowedExceptions);

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain("GHSA-");
      expect(result.stderr).not.toContain("unexpected-");
    },
  );

  it("fails closed on malformed or network-error audit output without leaking input", () => {
    const malformed = runPolicy(
      join(fixtures, "malformed-secret.json"),
      join(fixtures, "exceptions-allowed.json"),
    );
    const networkAudit = writeFixture("network.json", {
      error: {
        code: "ENOAUDIT",
        summary: "fixture-private-token at /private/worktree/package-lock.json",
      },
    });
    const network = runPolicy(
      networkAudit,
      join(fixtures, "exceptions-allowed.json"),
    );

    for (const result of [malformed, network]) {
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe("Audit policy failed: counts unavailable");
      expect(`${result.stdout}${result.stderr}`).not.toContain(
        "fixture-private-token",
      );
      expect(`${result.stdout}${result.stderr}`).not.toContain("/private/");
    }
  });

  it("rejects expired and stale exceptions", () => {
    const expired = structuredClone(allowedExceptions);
    expired.reviewBy = "2026-07-13";
    const stale = structuredClone(allowedExceptions);
    stale.exceptions.push({
      id: "GHSA-kkkk-mmmm-nnnn",
      url: "https://github.com/advisories/GHSA-kkkk-mmmm-nnnn",
      severity: "moderate",
      scope: ["removed-package"],
      rationale: "No longer present.",
      remediation: "Delete this stale exception.",
    });

    expect(runGenerated(allowedAudit, expired).status).toBe(1);
    expect(runGenerated(allowedAudit, stale).status).toBe(1);
  });

  it("rejects malformed policy fields, mismatched wrapper scope, URL, and references", () => {
    const malformed = structuredClone(allowedExceptions);
    malformed.exceptions[0].rationale = "";
    const scopeMismatch = structuredClone(allowedExceptions);
    scopeMismatch.exceptions[0].scope = ["@hono/node-server"];
    const urlMismatch = structuredClone(allowedExceptions);
    urlMismatch.exceptions[0].url =
      "https://github.com/advisories/GHSA-qx2v-qp2m-jg93";
    const brokenWrapper = structuredClone(allowedAudit);
    brokenWrapper.vulnerabilities.prisma.via = ["missing-wrapper"];

    expect(runGenerated(allowedAudit, malformed).status).toBe(1);
    expect(runGenerated(allowedAudit, scopeMismatch).status).toBe(1);
    expect(runGenerated(allowedAudit, urlMismatch).status).toBe(1);
    expect(runGenerated(brokenWrapper, allowedExceptions).status).toBe(1);
  });

  function runGenerated(audit: unknown, policy: unknown) {
    return runPolicy(
      writeFixture("audit.json", audit),
      writeFixture("exceptions.json", policy),
    );
  }

  function writeFixture(name: string, value: unknown) {
    const path = join(temporaryDirectory, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  }
});

function runPolicy(
  auditPath: string,
  exceptionsPath: string,
  productionAuditPath?: string,
) {
  const args = [
    script,
    "--audit-file",
    auditPath,
    "--exceptions-file",
    exceptionsPath,
    "--today",
    "2026-07-14",
  ];
  if (productionAuditPath) {
    args.push("--production-audit-file", productionAuditPath);
  }
  return spawnSync(
    process.execPath,
    args,
    { cwd: root, encoding: "utf8" },
  );
}

function concreteVulnerability(name: string, id: string, severity: string) {
  return {
    name,
    severity,
    isDirect: false,
    via: [
      {
        source: 1,
        name,
        severity,
        title: "Fixture advisory",
        url: `https://github.com/advisories/${id}`,
        range: "*",
      },
    ],
    effects: [],
    range: "*",
    nodes: [`node_modules/fixture-${severity}`],
    fixAvailable: false,
  };
}
