import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const root = join(__dirname, "../..");
const WORKFLOW_PATH = join(
  root,
  ".github/workflows/production-identity-maintenance.yml",
);
const CHECKOUT_SHA = "df4cb1c069e1874edd31b4311f1884172cec0e10";
const SETUP_NODE_SHA = "249970729cb0ef3589644e2896645e5dc5ba9c38";
const UPLOAD_ARTIFACT_SHA =
  "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";

type Step = Readonly<{
  name: string;
  if?: string;
  uses?: string;
  run?: string;
  "continue-on-error"?: boolean;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}>;

type MaintenanceWorkflow = Readonly<{
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: Readonly<{
    group: string;
    "cancel-in-progress": boolean;
  }>;
  jobs: Readonly<{
    maintain: Readonly<{
      "runs-on": string;
      "timeout-minutes": number;
      if?: string;
      permissions?: Record<string, string>;
      env?: Record<string, string>;
      steps: readonly Step[];
    }>;
  }>;
}>;

function readWorkflow(): Readonly<{
  source: string;
  workflow: MaintenanceWorkflow;
}> {
  const source = readFileSync(WORKFLOW_PATH, "utf8");
  return { source, workflow: parse(source) as MaintenanceWorkflow };
}

function normalizeRun(run: string | undefined): string {
  return (run ?? "").replace(/\s+/gu, " ").trim();
}

function normalizeCondition(condition: string | undefined): string {
  return (condition ?? "")
    .trim()
    .replace(/^\$\{\{\s*/u, "")
    .replace(/\s*\}\}$/u, "")
    .replace(/\s+/gu, " ");
}

function hasShellCommand(run: string | undefined, command: string): boolean {
  return (run ?? "").split(/\r?\n/gu).some((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith(command)
      && (trimmed.length === command.length || /\s/gu.test(trimmed[command.length]));
  });
}

function argumentAfter(run: string | undefined, flag: string): string | undefined {
  const normalized = normalizeRun(run);
  const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = normalized.match(
    new RegExp(`${escapedFlag}(?:\\s+|=)(?:"([^"]+)"|'([^']+)'|(\\S+))`, "u"),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function canonicalPath(path: string | undefined): string | undefined {
  return path?.replace(/\$\{\{\s*runner\.temp\s*\}\}/gu, "$RUNNER_TEMP");
}

function artifactPaths(step: Step | undefined): string[] {
  return String(step?.with?.path ?? "")
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean);
}

describe("production identity maintenance workflow contract", () => {
  it("is manual-only, read-scoped, serialized, and has exact dispatch inputs", () => {
    const { workflow } = readWorkflow();

    expect(workflow.on).toEqual({
      workflow_dispatch: {
        inputs: {
          phase: {
            description: "Identity maintenance phase",
            required: true,
            type: "choice",
            options: ["prepare", "apply"],
          },
          writers_stopped: {
            description: "Attest that every Application writer is stopped",
            required: true,
            type: "boolean",
            default: false,
          },
          prepare_run_id: {
            description: "Approved prepare workflow run ID; required for apply",
            required: false,
            type: "string",
            default: "",
          },
        },
      },
    });
    expect(workflow.permissions).toEqual({ actions: "read", contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "production-identity-maintenance",
      "cancel-in-progress": false,
    });
    expect(Object.keys(workflow.jobs)).toEqual(["maintain"]);
    expect(workflow.jobs.maintain).toMatchObject({
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 15,
    });
    expect(workflow.jobs.maintain.if).toBeUndefined();
  });

  it("pins the toolchain, keeps writers stopped, and runs only additive Prisma checks", () => {
    const { workflow } = readWorkflow();
    const job = workflow.jobs.maintain;
    const guard = job.steps.find((step) =>
      normalizeRun(step.run).includes('test "$CURRENT_REF" = "refs/heads/main"'),
    );
    const guardIndex = job.steps.indexOf(guard as Step);
    const firstRunIndex = job.steps.findIndex((step) => Boolean(step.run));
    const setupNode = job.steps.find((step) =>
      step.uses?.startsWith("actions/setup-node@"),
    );
    const usesSteps = job.steps.filter((step) => step.uses !== undefined);
    const uses = usesSteps.map((step) => step.uses ?? "");
    const approvedUses = new Set([
      `actions/checkout@${CHECKOUT_SHA}`,
      `actions/setup-node@${SETUP_NODE_SHA}`,
      `actions/upload-artifact@${UPLOAD_ARTIFACT_SHA}`,
    ]);
    const unconditionalCommandIndex = (command: string): number => job.steps.findIndex(
      (step) => step.if === undefined && hasShellCommand(step.run, command),
    );
    const npmCiIndex = unconditionalCommandIndex("npm ci");
    const migrateDeployIndex = unconditionalCommandIndex("npx prisma migrate deploy");
    const migrateStatusIndex = unconditionalCommandIndex("npx prisma migrate status");
    const migrateDiffIndex = job.steps.findIndex(
      (step) => step.if === undefined
        && hasShellCommand(step.run, "npx prisma migrate diff")
        && normalizeRun(step.run).includes(
          "--from-config-datasource --to-schema prisma/schema.prisma --exit-code",
        ),
    );

    expect(job.permissions).toBeUndefined();
    expect(job.steps.every((step) => step["continue-on-error"] !== true)).toBe(true);
    expect(job.env).toMatchObject({
      DATABASE_URL: "${{ secrets.PRODUCTION_DATABASE_URL }}",
    });
    expect(job.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uses: `actions/checkout@${CHECKOUT_SHA}`,
      }),
      expect.objectContaining({
        uses: `actions/setup-node@${SETUP_NODE_SHA}`,
      }),
    ]));
    expect(usesSteps).toHaveLength(4);
    expect(uses.filter((value) => value.startsWith("actions/checkout@")).length).toBe(1);
    expect(uses.filter((value) => value.startsWith("actions/setup-node@")).length).toBe(1);
    expect(uses.filter((value) => value.startsWith("actions/upload-artifact@")).length).toBe(2);
    expect(uses.every((value) => approvedUses.has(value))).toBe(true);
    expect(setupNode?.with).toMatchObject({
      "node-version": "22.22.2",
    });
    expect(guard?.env).toMatchObject({
      PHASE: "${{ inputs.phase }}",
      WRITERS_STOPPED: "${{ inputs.writers_stopped }}",
      PREPARE_RUN_ID: "${{ inputs.prepare_run_id }}",
      CURRENT_REF: "${{ github.ref }}",
    });
    expect(guardIndex).toBe(firstRunIndex);
    expect(guard?.if).toBeUndefined();
    expect(npmCiIndex).toBeGreaterThan(guardIndex);
    expect(migrateDeployIndex).toBeGreaterThan(npmCiIndex);
    expect(migrateStatusIndex).toBeGreaterThan(migrateDeployIndex);
    expect(migrateDiffIndex).toBeGreaterThan(migrateStatusIndex);
    const guardRun = normalizeRun(guard?.run);
    expect(guardRun).toContain("set -euo pipefail");
    expect(guardRun).toContain('test "$CURRENT_REF" = "refs/heads/main"');
    expect(guardRun).toContain('test "$WRITERS_STOPPED" = "true"');
    expect(guardRun).toContain('case "$PHASE" in');
    expect(guardRun).toContain('prepare) test -z "$PREPARE_RUN_ID" ;;');
    expect(guardRun).toContain(
      'apply) [[ "$PREPARE_RUN_ID" =~ ^[1-9][0-9]*$ ]] ;;',
    );
    expect(guardRun).toContain("*) exit 1 ;;");
  });

  it("requires approved prepare provenance and compares dry-run evidence before apply", () => {
    const { workflow } = readWorkflow();
    const steps = workflow.jobs.maintain.steps;
    const prepareSteps = steps.filter(
      (step) => normalizeCondition(step.if) === "inputs.phase == 'prepare'",
    );
    const prepareRuns = prepareSteps.map((step) => normalizeRun(step.run)).join("\n");
    const applySteps = steps.filter(
      (step) => normalizeCondition(step.if) === "inputs.phase == 'apply'",
    );
    const prepareBackfill = prepareSteps.find((step) =>
      hasShellCommand(step.run, "npm run backfill:application-identities"),
    );
    const prepareComparator = prepareSteps.find((step) =>
      normalizeRun(step.run).includes(
        "node scripts/compare-application-identity-reports.mjs",
      ) && normalizeRun(step.run).includes("--actual-mode dry-run"),
    );
    const currentDryRun = applySteps.find((step) =>
      hasShellCommand(step.run, "npm run backfill:application-identities")
        && !/(?:^|\s)--apply(?:\s|$)/u.test(normalizeRun(step.run)),
    );
    const applyBackfill = applySteps.find((step) =>
      hasShellCommand(step.run, "npm run backfill:application-identities")
        && /(?:^|\s)--apply(?:\s|$)/u.test(normalizeRun(step.run)),
    );
    const prepareUpload = steps.find(
      (step) => step.uses === `actions/upload-artifact@${UPLOAD_ARTIFACT_SHA}`
        && String(step.with?.name).includes("application-identity-prepare-"),
    );
    const applyUpload = steps.find(
      (step) => step.uses === `actions/upload-artifact@${UPLOAD_ARTIFACT_SHA}`
        && String(step.with?.name).includes("application-identity-apply-"),
    );
    const provenance = steps.find((step) =>
      normalizeRun(step.run).includes(
        'gh api "repos/$GITHUB_REPOSITORY/actions/runs/$PREPARE_RUN_ID"',
      ),
    );
    const download = steps.find((step) =>
      normalizeRun(step.run).includes(
        'gh run download "$PREPARE_RUN_ID" --repo "$GITHUB_REPOSITORY"',
      ),
    );

    expect(prepareSteps.length).toBeGreaterThan(0);
    expect(prepareRuns).toContain("umask 077");
    expect(prepareBackfill).toBeDefined();
    const prepareBackfillRun = normalizeRun(prepareBackfill?.run);
    expect(prepareBackfillRun).not.toMatch(/(?:^|\s)--apply(?:\s|$)/u);
    expect(prepareBackfillRun).not.toMatch(/(?:^|\s)--writers-stopped(?:\s|$)/u);
    const prepareReport = argumentAfter(prepareBackfill?.run, "--report");
    expect(prepareReport).toBeDefined();
    expect(prepareComparator).toBeDefined();
    const prepareComparatorRun = normalizeRun(prepareComparator?.run);
    expect(argumentAfter(prepareComparator?.run, "--expected")).toBe(prepareReport);
    expect(argumentAfter(prepareComparator?.run, "--actual")).toBe(prepareReport);
    expect(prepareComparatorRun).toContain("--actual-mode dry-run");

    const prepareBackfillIndex = steps.indexOf(prepareBackfill as Step);
    const prepareComparatorIndex = steps.indexOf(prepareComparator as Step);
    const prepareUploadIndex = steps.indexOf(prepareUpload as Step);
    const prepareUmask = prepareSteps.find((step) =>
      normalizeRun(step.run).includes("umask 077"),
    );
    const prepareUmaskIndex = steps.indexOf(prepareUmask as Step);
    expect(prepareUmask).toBeDefined();
    expect(prepareUmaskIndex).toBeLessThanOrEqual(prepareBackfillIndex);
    if (prepareUmaskIndex === prepareBackfillIndex) {
      expect(normalizeRun(prepareUmask?.run).indexOf("umask 077")).toBeLessThan(
        normalizeRun(prepareBackfill?.run).indexOf(
          "npm run backfill:application-identities",
        ),
      );
    }
    expect(prepareBackfillIndex).toBeLessThanOrEqual(prepareComparatorIndex);
    if (prepareBackfillIndex === prepareComparatorIndex) {
      expect(normalizeRun(prepareBackfill?.run).indexOf(
        "npm run backfill:application-identities",
      )).toBeLessThan(prepareComparatorRun.indexOf(
        "node scripts/compare-application-identity-reports.mjs",
      ));
    }
    expect(prepareComparatorIndex).toBeLessThan(prepareUploadIndex);

    expect(prepareUpload).toMatchObject({
      uses: `actions/upload-artifact@${UPLOAD_ARTIFACT_SHA}`,
      with: {
        name: "application-identity-prepare-${{ github.run_id }}",
        "retention-days": 7,
        "if-no-files-found": "error",
      },
    });
    expect(normalizeCondition(prepareUpload?.if)).toBe("inputs.phase == 'prepare'");
    const preparePaths = artifactPaths(prepareUpload);
    expect(preparePaths).toHaveLength(1);
    expect(preparePaths[0]).toMatch(/(?:\$\{\{\s*runner\.temp\s*\}\}|\$RUNNER_TEMP)/u);
    expect(preparePaths[0]).toMatch(/\.json$/u);
    expect(canonicalPath(preparePaths[0])).toBe(canonicalPath(prepareReport));
    const prepareReportBasename = canonicalPath(preparePaths[0])?.split("/").pop();
    expect(prepareReportBasename).toBeDefined();
    const approvedExtractedReport = `$RUNNER_TEMP/approved/${prepareReportBasename}`;

    expect(provenance?.env).toMatchObject({
      GH_TOKEN: "${{ github.token }}",
    });
    expect(normalizeCondition(provenance?.if)).toBe("inputs.phase == 'apply'");
    const provenanceRun = normalizeRun(provenance?.run);
    expect(provenanceRun).toContain(
      'metadata="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$PREPARE_RUN_ID")"',
    );
    for (const check of [
      'test "$(jq -r .conclusion <<<"$metadata")" = "success"',
      'test "$(jq -r .event <<<"$metadata")" = "workflow_dispatch"',
      'test "$(jq -r .head_branch <<<"$metadata")" = "main"',
      'test "$(jq -r .head_sha <<<"$metadata")" = "$GITHUB_SHA"',
      'test "$(jq -r .path <<<"$metadata")" = ".github/workflows/production-identity-maintenance.yml"',
    ]) {
      expect(provenanceRun).toContain(check);
    }
    expect(download).toBeDefined();
    expect(normalizeCondition(download?.if)).toBe("inputs.phase == 'apply'");
    const downloadRun = normalizeRun(download?.run);
    expect(downloadRun).toContain(
      'gh run download "$PREPARE_RUN_ID" --repo "$GITHUB_REPOSITORY"',
    );
    expect(downloadRun).toContain(
      '--name "application-identity-prepare-$PREPARE_RUN_ID"',
    );
    expect(downloadRun).toContain('--dir "$RUNNER_TEMP/approved"');

    expect(currentDryRun).toBeDefined();
    const currentDryRunRun = normalizeRun(currentDryRun?.run);
    expect(currentDryRunRun).not.toMatch(/(?:^|\s)--apply(?:\s|$)/u);
    expect(currentDryRunRun).not.toMatch(/(?:^|\s)--writers-stopped(?:\s|$)/u);
    const currentDryRunReport = argumentAfter(currentDryRun?.run, "--report");
    expect(currentDryRunReport).toBeDefined();
    expect(applyBackfill).toBeDefined();
    const applyBackfillRun = normalizeRun(applyBackfill?.run);
    expect(applyBackfillRun).toMatch(/(?:^|\s)--apply(?:\s|$)/u);
    expect(applyBackfillRun).toMatch(/(?:^|\s)--writers-stopped(?:\s|$)/u);
    const applyReport = argumentAfter(applyBackfill?.run, "--report");
    expect(applyReport).toBeDefined();
    expect(applyReport).not.toBe(currentDryRunReport);
    const preApplyComparison = steps.find(
      (step) => normalizeCondition(step.if) === "inputs.phase == 'apply'"
        && normalizeRun(step.run).includes("--actual-mode dry-run"),
    );
    const postApplyComparison = steps.find(
      (step) => normalizeCondition(step.if) === "inputs.phase == 'apply'"
        && normalizeRun(step.run).includes("--actual-mode apply"),
    );
    const preApplyRun = normalizeRun(preApplyComparison?.run);
    const postApplyRun = normalizeRun(postApplyComparison?.run);
    const approvedReport = argumentAfter(preApplyComparison?.run, "--expected");
    expect(approvedReport).toBeDefined();
    expect(canonicalPath(approvedReport)).toBe(approvedExtractedReport);
    expect(argumentAfter(preApplyComparison?.run, "--actual")).toBe(currentDryRunReport);
    expect(canonicalPath(argumentAfter(postApplyComparison?.run, "--expected")))
      .toBe(approvedExtractedReport);
    expect(argumentAfter(postApplyComparison?.run, "--actual")).toBe(applyReport);
    expect(preApplyRun).toContain("--actual-mode dry-run");
    expect(postApplyRun).toContain("--actual-mode apply");
    const provenanceIndex = steps.indexOf(provenance as Step);
    const downloadIndex = steps.indexOf(download as Step);
    const currentDryRunIndex = steps.indexOf(currentDryRun as Step);
    const preApplyComparisonIndex = steps.indexOf(preApplyComparison as Step);
    const applyBackfillIndex = steps.indexOf(applyBackfill as Step);
    const postApplyComparisonIndex = steps.indexOf(postApplyComparison as Step);
    const applyUploadIndex = steps.indexOf(applyUpload as Step);
    expect(provenanceIndex).toBeLessThan(downloadIndex);
    expect(downloadIndex).toBeLessThan(currentDryRunIndex);
    expect(currentDryRunIndex).toBeLessThan(preApplyComparisonIndex);
    expect(preApplyComparisonIndex).toBeLessThan(applyBackfillIndex);
    expect(applyBackfillIndex).toBeLessThan(postApplyComparisonIndex);
    expect(postApplyComparisonIndex).toBeLessThan(applyUploadIndex);

    expect(applyUpload).toMatchObject({
      uses: `actions/upload-artifact@${UPLOAD_ARTIFACT_SHA}`,
      with: {
        name: "application-identity-apply-${{ github.run_id }}",
        "if-no-files-found": "error",
      },
    });
    expect(normalizeCondition(applyUpload?.if)).toBe("inputs.phase == 'apply'");
    const applyPaths = artifactPaths(applyUpload);
    expect(applyPaths).toHaveLength(1);
    expect(applyPaths[0]).toMatch(/(?:\$\{\{\s*runner\.temp\s*\}\}|\$RUNNER_TEMP)/u);
    expect(applyPaths[0]).toMatch(/\.json$/u);
    expect(canonicalPath(applyPaths[0])).toBe(canonicalPath(applyReport));
    expect(applyPaths.join("\n")).not.toMatch(
      /(?:raw|dump|backup|database|\.sql\b|\.csv\b|\.jsonl\b)/iu,
    );
  });

  it("cleans every temporary report unconditionally and forbids production data leaks or destructive commands", () => {
    const { source, workflow } = readWorkflow();
    const steps = workflow.jobs.maintain.steps;
    const guardIndex = steps.findIndex((step) =>
      normalizeRun(step.run).includes('test "$CURRENT_REF" = "refs/heads/main"'),
    );
    const cleanup = steps.find(
      (step) => normalizeCondition(step.if) === "always()",
    );
    const cleanupIndex = steps.indexOf(cleanup as Step);
    const cleanupRun = normalizeRun(cleanup?.run);
    const uploadPaths = steps
      .filter((step) => step.uses === `actions/upload-artifact@${UPLOAD_ARTIFACT_SHA}`)
      .flatMap(artifactPaths);
    const unconditionalCommands = [
      "npm ci",
      "npx prisma migrate deploy",
      "npx prisma migrate status",
      "npx prisma migrate diff",
    ];
    const applySteps = steps.filter(
      (step) => normalizeCondition(step.if) === "inputs.phase == 'apply'",
    );
    const currentDryRun = applySteps.find((step) =>
      hasShellCommand(step.run, "npm run backfill:application-identities")
        && !/(?:^|\s)--apply(?:\s|$)/u.test(normalizeRun(step.run)),
    );
    const applyBackfill = applySteps.find((step) =>
      hasShellCommand(step.run, "npm run backfill:application-identities")
        && /(?:^|\s)--apply(?:\s|$)/u.test(normalizeRun(step.run)),
    );
    const preApplyComparison = applySteps.find((step) =>
      normalizeRun(step.run).includes("--actual-mode dry-run"),
    );
    const currentDryRunReport = argumentAfter(currentDryRun?.run, "--report");
    const applyReport = argumentAfter(applyBackfill?.run, "--report");
    const approvedReport = argumentAfter(preApplyComparison?.run, "--expected");

    expect(cleanup).toBeDefined();
    expect(cleanupIndex).toBe(steps.length - 1);
    expect(cleanupRun).toMatch(/\brm\s+-r?f\b/iu);
    expect(cleanupRun).toMatch(/\$RUNNER_TEMP\/approved/u);
    expect(cleanupRun).toMatch(/(?:\$RUNNER_TEMP\/[^\n]*(?:dry-run|current)|CURRENT[^\s]*DRY[^\s]*RUN)/iu);
    expect(cleanupRun).toMatch(/(?:\$RUNNER_TEMP\/[^\n]*apply|APPLY[^\s]*REPORT)/iu);
    expect(currentDryRunReport).toBeDefined();
    expect(applyReport).toBeDefined();
    expect(approvedReport).toBeDefined();
    expect(cleanupRun).toContain(canonicalPath(currentDryRunReport));
    expect(cleanupRun).toContain(canonicalPath(applyReport));
    expect(cleanupRun).toContain("$RUNNER_TEMP/approved");
    expect(uploadPaths).toHaveLength(2);
    expect(uploadPaths.join("\n")).not.toMatch(
      /(?:raw|dump|backup|database|\.sql\b|\.csv\b|\.jsonl\b)/iu,
    );

    for (const [index, step] of steps.entries()) {
      if (index < guardIndex || index === guardIndex || index === cleanupIndex) continue;
      if (unconditionalCommands.some((command) => hasShellCommand(step.run, command))) {
        expect(step.if).toBeUndefined();
      } else {
        expect(normalizeCondition(step.if)).toMatch(
          /^inputs\.phase == '(?:prepare|apply)'$/u,
        );
      }
    }

    expect(source).not.toMatch(/(?:echo|printf)\b[^\n]*(?:DATABASE_URL|PRODUCTION_DATABASE_URL)/iu);
    expect(source).not.toMatch(/\bprisma\s+db\s+(?:push|reset)\b/iu);
    expect(source).not.toMatch(
      /\b(?:DELETE\s+FROM|DROP\s+(?:TABLE|DATABASE|SCHEMA|INDEX))\b/iu,
    );
    expect(workflow.on).not.toHaveProperty("schedule");
    expect(workflow.on).not.toHaveProperty("push");
    expect(workflow.on).not.toHaveProperty("pull_request");
  });
});
