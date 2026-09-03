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
    expect(workflow.jobs).toEqual(expect.objectContaining({
      maintain: expect.objectContaining({
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 15,
      }),
    }));
  });

  it("pins the toolchain, keeps writers stopped, and runs only additive Prisma checks", () => {
    const { workflow } = readWorkflow();
    const job = workflow.jobs.maintain;
    const runs = job.steps.map((step) => normalizeRun(step.run)).join("\n");
    const guard = job.steps.find((step) =>
      normalizeRun(step.run).includes('test "$CURRENT_REF" = "refs/heads/main"'),
    );
    const guardIndex = job.steps.indexOf(guard as Step);
    const firstRunIndex = job.steps.findIndex((step) => Boolean(step.run));
    const setupNode = job.steps.find((step) =>
      step.uses?.startsWith("actions/setup-node@"),
    );

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
    expect(setupNode?.with).toMatchObject({
      "node-version": "22.22.2",
    });
    expect(runs).toContain("npm ci");
    expect(runs).toContain("npx prisma migrate deploy");
    expect(runs).toContain("npx prisma migrate status");
    expect(runs).toContain(
      "npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code",
    );

    expect(guard?.env).toMatchObject({
      PHASE: "${{ inputs.phase }}",
      WRITERS_STOPPED: "${{ inputs.writers_stopped }}",
      PREPARE_RUN_ID: "${{ inputs.prepare_run_id }}",
      CURRENT_REF: "${{ github.ref }}",
    });
    expect(guardIndex).toBe(firstRunIndex);
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
    const applyRuns = steps
      .filter((step) => normalizeCondition(step.if) === "inputs.phase == 'apply'")
      .map((step) => normalizeRun(step.run))
      .join("\n");
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

    expect(prepareSteps.length).toBeGreaterThan(0);
    expect(prepareRuns).toContain("umask 077");
    expect(prepareRuns).toContain("npm run backfill:application-identities");
    expect(prepareRuns).toContain("--report");
    expect(prepareRuns).toContain(
      "node scripts/compare-application-identity-reports.mjs",
    );
    expect(prepareRuns).toContain("--actual-mode dry-run");

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
    expect(provenanceRun).toContain(
      'gh run download "$PREPARE_RUN_ID" --repo "$GITHUB_REPOSITORY"',
    );
    expect(provenanceRun).toContain(
      '--name "application-identity-prepare-$PREPARE_RUN_ID"',
    );
    expect(provenanceRun).toContain('--dir "$RUNNER_TEMP/approved"');

    expect(applyRuns).toContain(
      "node scripts/compare-application-identity-reports.mjs",
    );
    expect(applyRuns).toContain("--actual-mode dry-run");
    expect(applyRuns).toContain("--actual-mode apply");
    expect(applyRuns).toContain("--apply --writers-stopped");
    expect(applyRuns).toMatch(
      /npm run backfill:application-identities\s+--\s+(?!--apply\b)[^\n]*--report/iu,
    );
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
    expect(preApplyRun).toMatch(/--expected\s+[^\s]*approved/iu);
    expect(postApplyRun).toMatch(/--expected\s+[^\s]*approved/iu);
    expect(applyRuns.indexOf("--actual-mode dry-run")).toBeLessThan(
      applyRuns.indexOf("--apply --writers-stopped"),
    );
    expect(applyRuns.indexOf("--apply --writers-stopped")).toBeLessThan(
      applyRuns.indexOf("--actual-mode apply"),
    );

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
    expect(applyPaths.join("\n")).not.toMatch(
      /(?:raw|dump|backup|database|\.sql\b|\.csv\b|\.jsonl\b)/iu,
    );
  });

  it("cleans every temporary report unconditionally and forbids production data leaks or destructive commands", () => {
    const { source, workflow } = readWorkflow();
    const steps = workflow.jobs.maintain.steps;
    const cleanup = steps.find(
      (step) => normalizeCondition(step.if) === "always()",
    );
    const cleanupRun = normalizeRun(cleanup?.run);
    const uploadPaths = steps
      .filter((step) => step.uses === `actions/upload-artifact@${UPLOAD_ARTIFACT_SHA}`)
      .flatMap(artifactPaths);

    expect(cleanup).toBeDefined();
    expect(cleanupRun).toMatch(/\brm\s+-r?f\b/iu);
    expect(cleanupRun).toMatch(/\$RUNNER_TEMP\/approved/u);
    expect(cleanupRun).toMatch(/(?:\$RUNNER_TEMP\/[^\n]*(?:dry-run|current)|CURRENT[^\s]*DRY[^\s]*RUN)/iu);
    expect(cleanupRun).toMatch(/(?:\$RUNNER_TEMP\/[^\n]*apply|APPLY[^\s]*REPORT)/iu);
    expect(uploadPaths).toHaveLength(2);
    expect(uploadPaths.join("\n")).not.toMatch(
      /(?:raw|dump|backup|database|\.sql\b|\.csv\b|\.jsonl\b)/iu,
    );

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
