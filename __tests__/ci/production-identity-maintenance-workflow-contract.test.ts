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
const PREPARE_REPORT_PATH = "$RUNNER_TEMP/application-identity-prepare.json";
const APPROVED_REPORT_PATH = "$RUNNER_TEMP/approved/application-identity-prepare.json";
const CURRENT_DRY_RUN_REPORT_PATH =
  "$RUNNER_TEMP/application-identity-current-dry-run.json";
const APPLY_REPORT_PATH = "$RUNNER_TEMP/application-identity-apply.json";

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
      "continue-on-error"?: boolean;
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

function effectiveCommandLines(run: string | undefined): string[] {
  const commands: string[] = [];
  let continuation = "";
  for (const rawLine of (run ?? "").split(/\r?\n/gu)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const combined = continuation ? `${continuation} ${line}` : line;
    if (combined.endsWith("\\")) {
      continuation = combined.slice(0, -1).trim();
    } else {
      commands.push(combined);
      continuation = "";
    }
  }
  if (continuation) commands.push(continuation);
  return commands;
}

function hasExactCommand(run: string | undefined, expected: string): boolean {
  return effectiveCommandLines(run).includes(expected);
}

function hasCommandMatching(run: string | undefined, pattern: RegExp): boolean {
  return effectiveCommandLines(run).some((command) => pattern.test(command));
}

function exactCommandLine(
  run: string | undefined,
  pattern: RegExp,
): string | undefined {
  return effectiveCommandLines(run).find((command) => pattern.test(command));
}

function isSafeAssignment(command: string): boolean {
  return /^(?:[A-Z][A-Z0-9_]*(?:REPORT|FILE|DIR|PATH)|METADATA)=(?:"[^"]*"|'[^']*'|\S+)$/u.test(command)
    && !command.includes("$(")
    && !command.includes("`");
}

function normalizeCondition(condition: string | undefined): string {
  return (condition ?? "")
    .trim()
    .replace(/^\$\{\{\s*/u, "")
    .replace(/\s*\}\}$/u, "")
    .replace(/\s+/gu, " ");
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
    expect(workflow.jobs.maintain["continue-on-error"]).toBeUndefined();
  });

  it("pins the toolchain, keeps writers stopped, and runs only additive Prisma checks", () => {
    const { workflow } = readWorkflow();
    const job = workflow.jobs.maintain;
    const guard = job.steps.find((step) =>
      hasExactCommand(step.run, 'test "$CURRENT_REF" = "refs/heads/main"'),
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
      (step) => step.if === undefined && hasExactCommand(step.run, command),
    );
    const npmCiIndex = unconditionalCommandIndex("npm ci");
    const migrateDeployIndex = unconditionalCommandIndex("npx prisma migrate deploy");
    const migrateStatusIndex = unconditionalCommandIndex("npx prisma migrate status");
    const migrateDiffIndex = job.steps.findIndex(
      (step) => step.if === undefined
        && hasExactCommand(
          step.run,
          "npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code",
        ),
    );

    expect(job.permissions).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
    expect(job.steps.every((step) => step["continue-on-error"] === undefined)).toBe(true);
    for (const step of job.steps) {
      if (step.run === undefined) continue;
      expect(effectiveCommandLines(step.run)[0]).toBe("set -euo pipefail");
      expect(step.run).not.toMatch(/\bset\s+\+e\b/iu);
      expect(step.run).not.toMatch(/\bset\s+\+o\s+errexit\b/iu);
      expect(step.run).not.toMatch(/\|\|\s*(?:true|:|exit\s+0|continue|return(?:\s+0)?)\b/iu);
      expect(step.run).not.toMatch(/\btrap\b[^\n]*\bERR\b/iu);
    }
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
    expect(effectiveCommandLines(guard?.run)[0]).toBe("set -euo pipefail");
    expect(hasExactCommand(guard?.run, 'test "$CURRENT_REF" = "refs/heads/main"')).toBe(true);
    expect(hasExactCommand(guard?.run, 'test "$WRITERS_STOPPED" = "true"')).toBe(true);
    expect(hasExactCommand(guard?.run, 'case "$PHASE" in')).toBe(true);
    expect(hasExactCommand(guard?.run, 'prepare) test -z "$PREPARE_RUN_ID" ;;')).toBe(true);
    expect(hasExactCommand(
      guard?.run,
      'apply) [[ "$PREPARE_RUN_ID" =~ ^[1-9][0-9]*$ ]] ;;',
    )).toBe(true);
    expect(hasExactCommand(guard?.run, "*) exit 1 ;;")).toBe(true);
  });

  it("requires approved prepare provenance and compares dry-run evidence before apply", () => {
    const { workflow } = readWorkflow();
    const steps = workflow.jobs.maintain.steps;
    const prepareSteps = steps.filter(
      (step) => normalizeCondition(step.if) === "inputs.phase == 'prepare'",
    );
    const applySteps = steps.filter(
      (step) => normalizeCondition(step.if) === "inputs.phase == 'apply'",
    );
    const prepareBackfill = prepareSteps.find((step) =>
      hasCommandMatching(
        step.run,
        /^npm run backfill:application-identities -- --report (?:"[^"]+"|'[^']+'|\S+)$/u,
      ),
    );
    const prepareComparator = prepareSteps.find((step) =>
      hasCommandMatching(
        step.run,
        /^node scripts\/compare-application-identity-reports\.mjs --expected (?:"[^"]+"|'[^']+'|\S+) --actual (?:"[^"]+"|'[^']+'|\S+) --actual-mode dry-run$/u,
      ),
    );
    const currentDryRun = applySteps.find((step) =>
      hasCommandMatching(
        step.run,
        /^npm run backfill:application-identities -- --report (?:"[^"]+"|'[^']+'|\S+)$/u,
      ),
    );
    const applyBackfill = applySteps.find((step) =>
      hasCommandMatching(
        step.run,
        /^npm run backfill:application-identities -- --apply --writers-stopped --report (?:"[^"]+"|'[^']+'|\S+)$/u,
      ),
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
      hasExactCommand(
        step.run,
        'metadata="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$PREPARE_RUN_ID")"',
      ),
    );
    const download = steps.find((step) =>
      hasExactCommand(
        step.run,
        'gh run download "$PREPARE_RUN_ID" --repo "$GITHUB_REPOSITORY" --name "application-identity-prepare-$PREPARE_RUN_ID" --dir "$RUNNER_TEMP/approved"',
      ),
    );
    const prepareBackfillCommand = exactCommandLine(
      prepareBackfill?.run,
      /^npm run backfill:application-identities -- --report (?:"[^"]+"|'[^']+'|\S+)$/u,
    );
    const prepareComparatorCommand = exactCommandLine(
      prepareComparator?.run,
      /^node scripts\/compare-application-identity-reports\.mjs --expected (?:"[^"]+"|'[^']+'|\S+) --actual (?:"[^"]+"|'[^']+'|\S+) --actual-mode dry-run$/u,
    );
    const downloadCommand = exactCommandLine(
      download?.run,
      /^gh run download "\$PREPARE_RUN_ID" --repo "\$GITHUB_REPOSITORY" --name "application-identity-prepare-\$PREPARE_RUN_ID" --dir "\$RUNNER_TEMP\/approved"$/u,
    );

    expect(prepareSteps.length).toBeGreaterThan(0);
    expect(prepareSteps.some((step) => hasExactCommand(step.run, "umask 077"))).toBe(true);
    expect(prepareBackfill).toBeDefined();
    expect(prepareBackfillCommand).toBeDefined();
    const prepareReport = argumentAfter(prepareBackfillCommand, "--report");
    expect(prepareReport).toBeDefined();
    expect(prepareReport).toBe(PREPARE_REPORT_PATH);
    expect(prepareComparator).toBeDefined();
    expect(prepareComparatorCommand).toBeDefined();
    expect(argumentAfter(prepareComparatorCommand, "--expected")).toBe(prepareReport);
    expect(argumentAfter(prepareComparatorCommand, "--actual")).toBe(prepareReport);

    const prepareBackfillIndex = steps.indexOf(prepareBackfill as Step);
    const prepareComparatorIndex = steps.indexOf(prepareComparator as Step);
    const prepareUploadIndex = steps.indexOf(prepareUpload as Step);
    const prepareUmask = prepareSteps.find((step) =>
      hasExactCommand(step.run, "umask 077"),
    );
    const prepareUmaskIndex = steps.indexOf(prepareUmask as Step);
    expect(prepareUmask).toBeDefined();
    expect(prepareUmaskIndex).toBeLessThanOrEqual(prepareBackfillIndex);
    if (prepareUmaskIndex === prepareBackfillIndex) {
      const sameStepCommands = effectiveCommandLines(prepareUmask?.run);
      expect(sameStepCommands.indexOf("umask 077")).toBeLessThan(
        sameStepCommands.indexOf(prepareBackfillCommand ?? ""),
      );
    }
    expect(prepareBackfillIndex).toBeLessThanOrEqual(prepareComparatorIndex);
    if (prepareBackfillIndex === prepareComparatorIndex) {
      const sameStepCommands = effectiveCommandLines(prepareBackfill?.run);
      expect(sameStepCommands.indexOf(prepareBackfillCommand ?? "")).toBeLessThan(
        sameStepCommands.indexOf(prepareComparatorCommand ?? ""),
      );
    }
    expect(prepareUploadIndex).toBe(prepareComparatorIndex + 1);

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
    expect(canonicalPath(preparePaths[0])).toBe(PREPARE_REPORT_PATH);
    const approvedExtractedReport = APPROVED_REPORT_PATH;

    expect(provenance?.env).toMatchObject({
      GH_TOKEN: "${{ github.token }}",
    });
    expect(normalizeCondition(provenance?.if)).toBe("inputs.phase == 'apply'");
    expect(hasExactCommand(
      provenance?.run,
      'metadata="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$PREPARE_RUN_ID")"',
    )).toBe(true);
    for (const check of [
      'test "$(jq -r .conclusion <<<"$metadata")" = "success"',
      'test "$(jq -r .event <<<"$metadata")" = "workflow_dispatch"',
      'test "$(jq -r .head_branch <<<"$metadata")" = "main"',
      'test "$(jq -r .head_sha <<<"$metadata")" = "$GITHUB_SHA"',
      'test "$(jq -r .path <<<"$metadata")" = ".github/workflows/production-identity-maintenance.yml@main"',
    ]) {
      expect(hasExactCommand(provenance?.run, check)).toBe(true);
    }
    expect(download).toBeDefined();
    expect(downloadCommand).toBeDefined();
    expect(normalizeCondition(download?.if)).toBe("inputs.phase == 'apply'");
    expect(download?.env).toMatchObject({ GH_TOKEN: "${{ github.token }}" });

    expect(currentDryRun).toBeDefined();
    const currentDryRunCommand = exactCommandLine(
      currentDryRun?.run,
      /^npm run backfill:application-identities -- --report (?:"[^"]+"|'[^']+'|\S+)$/u,
    );
    const applyBackfillCommand = exactCommandLine(
      applyBackfill?.run,
      /^npm run backfill:application-identities -- --apply --writers-stopped --report (?:"[^"]+"|'[^']+'|\S+)$/u,
    );
    expect(currentDryRunCommand).toBeDefined();
    const currentDryRunReport = argumentAfter(currentDryRunCommand, "--report");
    expect(currentDryRunReport).toBeDefined();
    expect(currentDryRunReport).toBe(CURRENT_DRY_RUN_REPORT_PATH);
    expect(canonicalPath(currentDryRunReport)).toMatch(/^\$RUNNER_TEMP\/.+\.json$/u);
    expect(applyBackfill).toBeDefined();
    expect(applyBackfillCommand).toBeDefined();
    const applyReport = argumentAfter(applyBackfillCommand, "--report");
    expect(applyReport).toBeDefined();
    expect(applyReport).toBe(APPLY_REPORT_PATH);
    const canonicalCurrentDryRunReport = canonicalPath(currentDryRunReport);
    const canonicalApplyReport = canonicalPath(applyReport);
    expect(canonicalCurrentDryRunReport).toMatch(/^\$RUNNER_TEMP\/.+\.json$/u);
    expect(canonicalApplyReport).toMatch(/^\$RUNNER_TEMP\/.+\.json$/u);
    expect(canonicalCurrentDryRunReport).not.toBe(approvedExtractedReport);
    expect(canonicalApplyReport).not.toBe(approvedExtractedReport);
    expect(canonicalApplyReport).not.toMatch(/^\$RUNNER_TEMP\/approved\//u);
    expect(canonicalCurrentDryRunReport).not.toBe(canonicalApplyReport);
    const preApplyComparison = steps.find(
      (step) => normalizeCondition(step.if) === "inputs.phase == 'apply'"
        && hasCommandMatching(
          step.run,
          /^node scripts\/compare-application-identity-reports\.mjs --expected (?:"[^"]+"|'[^']+'|\S+) --actual (?:"[^"]+"|'[^']+'|\S+) --actual-mode dry-run$/u,
        ),
    );
    const postApplyComparison = steps.find(
      (step) => normalizeCondition(step.if) === "inputs.phase == 'apply'"
        && hasCommandMatching(
          step.run,
          /^node scripts\/compare-application-identity-reports\.mjs --expected (?:"[^"]+"|'[^']+'|\S+) --actual (?:"[^"]+"|'[^']+'|\S+) --actual-mode apply$/u,
        ),
    );
    const preApplyCommand = exactCommandLine(
      preApplyComparison?.run,
      /^node scripts\/compare-application-identity-reports\.mjs --expected (?:"[^"]+"|'[^']+'|\S+) --actual (?:"[^"]+"|'[^']+'|\S+) --actual-mode dry-run$/u,
    );
    const postApplyCommand = exactCommandLine(
      postApplyComparison?.run,
      /^node scripts\/compare-application-identity-reports\.mjs --expected (?:"[^"]+"|'[^']+'|\S+) --actual (?:"[^"]+"|'[^']+'|\S+) --actual-mode apply$/u,
    );
    expect(preApplyCommand).toBeDefined();
    expect(postApplyCommand).toBeDefined();
    const approvedReport = argumentAfter(preApplyCommand, "--expected");
    const phaseCommandCount = (phase: "prepare" | "apply", pattern: RegExp): number =>
      steps
        .filter((step) => normalizeCondition(step.if) === `inputs.phase == '${phase}'`)
        .flatMap((step) => effectiveCommandLines(step.run))
        .filter((command) => pattern.test(command)).length;
    const allCommands = steps.flatMap((step) => effectiveCommandLines(step.run));
    const backfillPattern = /^npm run backfill:application-identities -- --report (?:"[^"]+"|'[^']+'|\S+)$/u;
    const applyBackfillPattern = /^npm run backfill:application-identities -- --apply --writers-stopped --report (?:"[^"]+"|'[^']+'|\S+)$/u;
    const comparatorPattern = /^node scripts\/compare-application-identity-reports\.mjs --expected (?:"[^"]+"|'[^']+'|\S+) --actual (?:"[^"]+"|'[^']+'|\S+) --actual-mode (?:dry-run|apply)$/u;
    const allowedGuardCommands = new Set([
      'test "$CURRENT_REF" = "refs/heads/main"',
      'test "$WRITERS_STOPPED" = "true"',
      'case "$PHASE" in',
      'prepare) test -z "$PREPARE_RUN_ID" ;;',
      'apply) [[ "$PREPARE_RUN_ID" =~ ^[1-9][0-9]*$ ]] ;;',
      "*) exit 1 ;;",
      "esac",
    ]);
    const allowedCriticalCommand = (command: string): boolean =>
      allowedGuardCommands.has(command)
      || command === "npm ci"
      || command === "npx prisma migrate deploy"
      || command === "npx prisma migrate status"
      || command === "npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code"
      || command === "umask 077"
      || command === 'metadata="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$PREPARE_RUN_ID")"'
      || /^test "\$\(jq -r \.(?:conclusion|event|head_branch|head_sha|path) <<<"\$metadata"\)" = ".+"$/u.test(command)
      || /^gh run download "\$PREPARE_RUN_ID" --repo "\$GITHUB_REPOSITORY" --name "application-identity-prepare-\$PREPARE_RUN_ID" --dir "\$RUNNER_TEMP\/approved"$/u.test(command)
      || backfillPattern.test(command)
      || applyBackfillPattern.test(command)
      || comparatorPattern.test(command)
      || isSafeAssignment(command);
    expect(approvedReport).toBeDefined();
    expect(approvedReport).toBe(approvedExtractedReport);
    expect(argumentAfter(preApplyCommand, "--actual")).toBe(currentDryRunReport);
    expect(argumentAfter(postApplyCommand, "--expected")).toBe(approvedExtractedReport);
    expect(argumentAfter(postApplyCommand, "--actual")).toBe(applyReport);
    for (const reportPath of [
      prepareReport,
      approvedReport,
      currentDryRunReport,
      applyReport,
    ]) {
      expect(reportPath).toMatch(/^\$RUNNER_TEMP(?:\/approved)?\/[a-z0-9-]+\.json$/u);
      expect(reportPath).not.toMatch(/(?:\.\.?\/|[*?\[\]{}])/u);
    }
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
    expect(applyBackfillIndex).toBe(preApplyComparisonIndex + 1);
    expect(applyBackfillIndex).toBeLessThan(postApplyComparisonIndex);
    expect(postApplyComparisonIndex).toBe(applyUploadIndex - 1);

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
    expect(canonicalPath(applyPaths[0])).toBe(APPLY_REPORT_PATH);
    expect(applyPaths.join("\n")).not.toMatch(
      /(?:raw|dump|backup|database|\.sql\b|\.csv\b|\.jsonl\b)/iu,
    );

    const guardIndex = steps.findIndex((step) =>
      hasExactCommand(step.run, 'test "$CURRENT_REF" = "refs/heads/main"'),
    );
    const cleanupIndex = steps.findIndex(
      (step) => normalizeCondition(step.if) === "always()",
    );
    for (const [index, step] of steps.entries()) {
      if (step.run === undefined) continue;
      const commands = effectiveCommandLines(step.run);
      expect(commands[0]).toBe("set -euo pipefail");
      const body = commands.slice(1);
      if (index === cleanupIndex) {
        expect(body).toHaveLength(1);
        expect(body[0]).toMatch(/^rm (?:-f|-rf)\s+/u);
        expect(body[0]).not.toMatch(/[;&|`]|\$\(/u);
        continue;
      }
      expect(body.length).toBeGreaterThan(0);
      expect(body.every((command) => allowedCriticalCommand(command))).toBe(true);
      expect(body.some((command) => command !== "umask 077" && !isSafeAssignment(command))).toBe(true);
    }
    expect(guardIndex).toBe(steps.findIndex((step) => step.run !== undefined));
    expect(allCommands.filter((command) => command === "npm ci")).toHaveLength(1);
    expect(allCommands.filter((command) => command === "npx prisma migrate deploy")).toHaveLength(1);
    expect(allCommands.filter((command) => command === "npx prisma migrate status")).toHaveLength(1);
    expect(allCommands.filter((command) => command === "npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code")).toHaveLength(1);
    expect(phaseCommandCount("prepare", backfillPattern)).toBe(1);
    expect(phaseCommandCount("prepare", applyBackfillPattern)).toBe(0);
    expect(phaseCommandCount("apply", backfillPattern)).toBe(1);
    expect(phaseCommandCount("apply", applyBackfillPattern)).toBe(1);
    expect(phaseCommandCount("prepare", comparatorPattern)).toBe(1);
    expect(phaseCommandCount("apply", comparatorPattern)).toBe(2);
    expect(allCommands.filter((command) => command === 'metadata="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$PREPARE_RUN_ID")"')).toHaveLength(1);
    expect(allCommands.filter((command) => /^gh run download "\$PREPARE_RUN_ID" --repo "\$GITHUB_REPOSITORY" --name "application-identity-prepare-\$PREPARE_RUN_ID" --dir "\$RUNNER_TEMP\/approved"$/u.test(command))).toHaveLength(1);

    const preparePhaseCommands = steps
      .filter((step) => normalizeCondition(step.if) === "inputs.phase == 'prepare'")
      .flatMap((step) => effectiveCommandLines(step.run));
    const applyPhaseCommands = steps
      .filter((step) => normalizeCondition(step.if) === "inputs.phase == 'apply'")
      .flatMap((step) => effectiveCommandLines(step.run));
    const comparatorCommands = (commands: readonly string[]): string[] =>
      commands.filter((command) => comparatorPattern.test(command));
    const isApplyProvenance = (command: string): boolean =>
      command === 'metadata="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$PREPARE_RUN_ID")"'
      || /^test "\$\(jq -r \.(?:conclusion|event|head_branch|head_sha|path) <<<"\$metadata"\)" = ".+"$/u.test(command)
      || /^gh run download "\$PREPARE_RUN_ID" --repo "\$GITHUB_REPOSITORY" --name "application-identity-prepare-\$PREPARE_RUN_ID" --dir "\$RUNNER_TEMP\/approved"$/u.test(command);
    expect(preparePhaseCommands.some((command) => applyBackfillPattern.test(command))).toBe(false);
    expect(preparePhaseCommands.some((command) => isApplyProvenance(command))).toBe(false);
    expect(comparatorCommands(preparePhaseCommands).every((command) =>
      argumentAfter(command, "--actual-mode") !== "apply"
        && argumentAfter(command, "--expected") === argumentAfter(command, "--actual"),
    )).toBe(true);
    expect(comparatorCommands(applyPhaseCommands).every((command) =>
      argumentAfter(command, "--actual-mode") !== "dry-run"
        || argumentAfter(command, "--expected") !== argumentAfter(command, "--actual"),
    )).toBe(true);
  });

  it("cleans every temporary report unconditionally and forbids production data leaks or destructive commands", () => {
    const { source, workflow } = readWorkflow();
    const steps = workflow.jobs.maintain.steps;
    const guardIndex = steps.findIndex((step) =>
      hasExactCommand(step.run, 'test "$CURRENT_REF" = "refs/heads/main"'),
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
      "npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code",
    ];
    const applySteps = steps.filter(
      (step) => normalizeCondition(step.if) === "inputs.phase == 'apply'",
    );
    const currentDryRun = applySteps.find((step) =>
      hasCommandMatching(
        step.run,
        /^npm run backfill:application-identities -- --report (?:"[^"]+"|'[^']+'|\S+)$/u,
      ),
    );
    const applyBackfill = applySteps.find((step) =>
      hasCommandMatching(
        step.run,
        /^npm run backfill:application-identities -- --apply --writers-stopped --report (?:"[^"]+"|'[^']+'|\S+)$/u,
      ),
    );
    const preApplyComparison = applySteps.find((step) =>
      hasCommandMatching(
        step.run,
        /^node scripts\/compare-application-identity-reports\.mjs --expected (?:"[^"]+"|'[^']+'|\S+) --actual (?:"[^"]+"|'[^']+'|\S+) --actual-mode dry-run$/u,
      ),
    );
    const currentDryRunCommand = exactCommandLine(
      currentDryRun?.run,
      /^npm run backfill:application-identities -- --report (?:"[^"]+"|'[^']+'|\S+)$/u,
    );
    const applyBackfillCommand = exactCommandLine(
      applyBackfill?.run,
      /^npm run backfill:application-identities -- --apply --writers-stopped --report (?:"[^"]+"|'[^']+'|\S+)$/u,
    );
    const preApplyCommand = exactCommandLine(
      preApplyComparison?.run,
      /^node scripts\/compare-application-identity-reports\.mjs --expected (?:"[^"]+"|'[^']+'|\S+) --actual (?:"[^"]+"|'[^']+'|\S+) --actual-mode dry-run$/u,
    );
    const currentDryRunReport = argumentAfter(currentDryRunCommand, "--report");
    const applyReport = argumentAfter(applyBackfillCommand, "--report");
    const approvedReport = argumentAfter(preApplyCommand, "--expected");

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
    expect(cleanupRun).toContain(CURRENT_DRY_RUN_REPORT_PATH);
    expect(cleanupRun).toContain(APPLY_REPORT_PATH);
    expect(cleanupRun).toContain("$RUNNER_TEMP/approved");
    expect(uploadPaths).toHaveLength(2);
    expect(uploadPaths.join("\n")).not.toMatch(
      /(?:raw|dump|backup|database|\.sql\b|\.csv\b|\.jsonl\b)/iu,
    );

    for (const [index, step] of steps.entries()) {
      if (index < guardIndex || index === guardIndex || index === cleanupIndex) continue;
      if (unconditionalCommands.some((command) => hasExactCommand(step.run, command))) {
        expect(step.if).toBeUndefined();
      } else {
        expect(normalizeCondition(step.if)).toMatch(
          /^inputs\.phase == '(?:prepare|apply)'$/u,
        );
      }
    }

    expect(source).not.toMatch(/(?:echo|printf)\b[^\n]*(?:DATABASE_URL|PRODUCTION_DATABASE_URL)/iu);
    expect(source).not.toMatch(/\bprisma\s+db\s+(?:push|reset)\b/iu);
    expect(source).not.toMatch(/\bprisma\s+migrate\s+reset\b/iu);
    expect(source).not.toMatch(
      /\b(?:DELETE\s+FROM|DROP\s+(?:TABLE|DATABASE|SCHEMA|INDEX))\b/iu,
    );
    expect(workflow.on).not.toHaveProperty("schedule");
    expect(workflow.on).not.toHaveProperty("push");
    expect(workflow.on).not.toHaveProperty("pull_request");
  });
});
