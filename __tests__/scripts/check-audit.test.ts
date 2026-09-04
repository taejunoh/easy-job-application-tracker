import {
  chmodSync,
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

  it("retries transient full and production audit responses before applying policy", () => {
    const logPath = join(temporaryDirectory, "npm-calls.jsonl");
    const fakeNpm = writeFakeNpm({
      logPath,
      fullFixturePath: join(fixtures, "audit-allowed.json"),
      productionFixturePath: join(temporaryDirectory, "production.json"),
      firstResponse: "error-json",
    });
    const policy = structuredClone(allowedExceptions);
    policy.reviewBy = "2099-01-01";
    const policyPath = writeFixture("live-exceptions.json", policy);
    writeFileSync(
      join(temporaryDirectory, "production.json"),
      JSON.stringify({
        auditReportVersion: 2,
        vulnerabilities: {},
        metadata: {
          vulnerabilities: {
            info: 0,
            low: 0,
            moderate: 0,
            high: 0,
            critical: 0,
            total: 0,
          },
        },
      }),
    );

    const result = runLivePolicy(
      policyPath,
      fakeNpm,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(
      readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
    ).toEqual([
      ["audit", "--json"],
      ["audit", "--json"],
      ["audit", "--json", "--omit=dev"],
      ["audit", "--json", "--omit=dev"],
    ]);
  });

  it("fails closed after exhausting transient audit attempts without leaking npm output", () => {
    const logPath = join(temporaryDirectory, "npm-calls.jsonl");
    const fakeNpm = writeFakeNpm({
      logPath,
      fullFixturePath: join(fixtures, "audit-allowed.json"),
      productionFixturePath: join(fixtures, "audit-allowed.json"),
      firstResponse: "exit-2",
    });

    const startedAt = Date.now();
    const result = runLivePolicy(
      join(fixtures, "exceptions-allowed.json"),
      fakeNpm,
    );

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Audit policy failed: counts unavailable");
    expect(`${result.stdout}${result.stderr}`).not.toContain("registry-private-error");
    expect(readFileSync(logPath, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("does not retry a valid v2 high-severity full audit report", () => {
    const clean = emptyAuditReport();
    const high = withHighSeverity(clean);
    const highFixturePath = writeFixture("high-full.json", high);
    const logPath = join(temporaryDirectory, "npm-calls.jsonl");
    const fakeNpm = writeFakeNpm({
      logPath,
      fullFixturePath: writeFixture("clean-full.json", clean),
      productionFixturePath: writeFixture("clean-production.json", clean),
      highFixturePath,
      firstResponse: "high-full",
    });

    const result = runLivePolicy(
      writeFixture("clean-exceptions.json", emptyPolicy()),
      fakeNpm,
    );

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(
      "Audit policy failed: full critical=0 high=1 moderate=0 low=0 production critical=0 high=0 moderate=0 low=0 exceptions=0",
    );
    expect(readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      ["audit", "--json"],
      ["audit", "--json", "--omit=dev"],
    ]);
  });

  it("does not retry a valid v2 high-severity production audit report", () => {
    const clean = emptyAuditReport();
    const highFixturePath = writeFixture("high-production.json", withHighSeverity(clean));
    const logPath = join(temporaryDirectory, "npm-calls.jsonl");
    const fakeNpm = writeFakeNpm({
      logPath,
      fullFixturePath: writeFixture("clean-full.json", clean),
      productionFixturePath: writeFixture("clean-production.json", clean),
      highFixturePath,
      firstResponse: "high-production",
    });

    const result = runLivePolicy(
      writeFixture("clean-exceptions.json", emptyPolicy()),
      fakeNpm,
    );

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(
      "Audit policy failed: full critical=0 high=0 moderate=0 low=0 production critical=0 high=1 moderate=0 low=0 exceptions=0",
    );
    expect(readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      ["audit", "--json"],
      ["audit", "--json", "--omit=dev"],
    ]);
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

  function emptyAuditReport(): AuditFixture {
    return {
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 0,
          critical: 0,
          total: 0,
        },
      },
    };
  }

  function withHighSeverity(audit: ReturnType<typeof emptyAuditReport>) {
    const high = structuredClone(audit);
    high.vulnerabilities["high-package"] = concreteVulnerability(
      "high-package",
      "GHSA-aaaa-bbbb-cccc",
      "high",
    );
    high.metadata.vulnerabilities.high = 1;
    high.metadata.vulnerabilities.total = 1;
    return high;
  }

  function emptyPolicy() {
    return {
      schemaVersion: 1,
      reviewedOn: "2026-01-01",
      reviewBy: "2099-01-01",
      exceptions: [],
    };
  }

  function writeFakeNpm(options: {
    logPath: string;
    fullFixturePath: string;
    productionFixturePath: string;
    highFixturePath?: string;
    firstResponse: "error-json" | "exit-2" | "high-full" | "high-production";
  }) {
    const path = join(temporaryDirectory, "npm");
    writeFileSync(
      path,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const calls = fs.existsSync(${JSON.stringify(options.logPath)})
  ? fs.readFileSync(${JSON.stringify(options.logPath)}, "utf8").trim().split("\\n").filter(Boolean)
  : [];
fs.appendFileSync(${JSON.stringify(options.logPath)}, JSON.stringify(args) + "\\n");
if (${JSON.stringify(options.firstResponse)} === "exit-2") {
  process.stderr.write("registry-private-error");
  process.exit(2);
}
const production = args.includes("--omit=dev");
const priorAttempts = calls.filter((call) => JSON.parse(call).includes("--omit=dev") === production).length;
if (priorAttempts === 0) {
  const highFirst = ${JSON.stringify(options.firstResponse)} === "high-full"
    ? !production
    : ${JSON.stringify(options.firstResponse)} === "high-production"
      ? production
      : false;
  if (highFirst) {
    process.stdout.write(fs.readFileSync(${JSON.stringify(options.highFixturePath ?? "")}, "utf8"));
    process.exit(1);
  }
  if (${JSON.stringify(options.firstResponse)} === "high-full" || ${JSON.stringify(options.firstResponse)} === "high-production") {
    const cleanFixturePath = production
      ? ${JSON.stringify(options.productionFixturePath)}
      : ${JSON.stringify(options.fullFixturePath)};
    process.stdout.write(fs.readFileSync(cleanFixturePath, "utf8"));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ error: { code: "ENOAUDIT", summary: "registry-private-error" } }));
  process.exit(1);
}
const fixturePath = production
  ? ${JSON.stringify(options.productionFixturePath)}
  : ${JSON.stringify(options.fullFixturePath)};
process.stdout.write(fs.readFileSync(fixturePath, "utf8"));
`,
    );
    chmodSync(path, 0o755);
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

function runLivePolicy(exceptionsPath: string, fakeNpm: string) {
  return spawnSync(
    process.execPath,
    [script, "--exceptions-file", exceptionsPath],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(fakeNpm, "..")}:${process.env.PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
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
