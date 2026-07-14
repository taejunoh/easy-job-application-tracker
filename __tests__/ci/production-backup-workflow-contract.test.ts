import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const root = join(__dirname, "../..");
const CHECKOUT_SHA = "df4cb1c069e1874edd31b4311f1884172cec0e10";
const SETUP_NODE_SHA = "249970729cb0ef3589644e2896645e5dc5ba9c38";
const UPLOAD_ARTIFACT_SHA =
  "ea165f8d65b6e75b540449e92b4886f43607fa02";

type Step = Readonly<{
  name: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}>;

type BackupWorkflow = Readonly<{
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Readonly<{
    backup: Readonly<{
      "runs-on": string;
      "timeout-minutes": number;
      services: Record<string, unknown>;
      steps: readonly Step[];
    }>;
  }>;
}>;

describe("encrypted production backup workflow contract", () => {
  it("runs nightly or manually with a PostgreSQL 17 scratch database", () => {
    const source = readFileSync(
      join(root, ".github/workflows/production-backup.yml"),
      "utf8",
    );
    const workflow = parse(source) as BackupWorkflow;

    expect(workflow.on).toEqual({
      schedule: [{ cron: "41 5 * * *" }],
      workflow_dispatch: null,
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.backup).toMatchObject({
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 20,
      services: {
        postgres: {
          image: "postgres:17-alpine",
          env: {
            POSTGRES_USER: "jobtracker_backup",
            POSTGRES_PASSWORD: "jobtracker_backup",
            POSTGRES_DB: "jobtracker_restore",
          },
          ports: ["5432:5432"],
        },
      },
    });
    expect(source).not.toMatch(/pull_request|\bpush\s*:/u);
  });

  it("creates, verifies, restores, fingerprints, and encrypts without production writes", () => {
    const source = readFileSync(
      join(root, ".github/workflows/production-backup.yml"),
      "utf8",
    );
    const workflow = parse(source) as BackupWorkflow;
    const steps = workflow.jobs.backup.steps;
    const joinedRuns = steps.map((step) => step.run ?? "").join("\n");
    const fingerprintSource = readFileSync(
      join(root, "scripts/fingerprint-database.mjs"),
      "utf8",
    );

    expect(steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Check out repository",
          uses: `actions/checkout@${CHECKOUT_SHA}`,
        }),
        expect.objectContaining({
          name: "Set up Node.js",
          uses: `actions/setup-node@${SETUP_NODE_SHA}`,
          with: { "node-version": "22.22.2", cache: "npm" },
        }),
        expect.objectContaining({
          name: "Create source backup and fingerprint",
          env: {
            PRODUCTION_DATABASE_URL:
              "${{ secrets.PRODUCTION_DATABASE_URL }}",
          },
        }),
        expect.objectContaining({
          name: "Encrypt verified backup",
          env: {
            BACKUP_AGE_RECIPIENT: "${{ vars.BACKUP_AGE_RECIPIENT }}",
          },
        }),
      ]),
    );

    expect(joinedRuns).toContain("pg_dump");
    expect(joinedRuns).toMatch(/pg_dump[\s\S]*--dbname=/u);
    expect(joinedRuns).toMatch(/--format=(?:custom|c)\b/u);
    expect(joinedRuns).toContain("chmod 600");
    expect(joinedRuns).toContain("sha256sum");
    expect(joinedRuns).toContain("pg_restore --list");
    expect(fingerprintSource).toContain("BEGIN TRANSACTION READ ONLY");
    expect(fingerprintSource).toContain('createHash("sha256")');
    expect(fingerprintSource).not.toMatch(/console\.log|JSON\.stringify\(rows/u);
    expect(joinedRuns).toContain("pg_restore --exit-on-error");
    expect(joinedRuns).toContain("jobtracker_restore");
    expect(joinedRuns).toContain("source-fingerprint.json");
    expect(joinedRuns).toContain("restore-fingerprint.json");
    expect(joinedRuns).toContain("cmp --silent");
    expect(joinedRuns).toMatch(/age[\s\S]*--recipient/u);
    expect(joinedRuns).toContain("rm -f \"$DUMP_FILE\"");
    expect(source).not.toMatch(/prisma\s+(?:migrate|db|studio)|psql[\s\S]*(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)/iu);
  });

  it("uploads only the encrypted dump, checksum, and sanitized manifest for 30 days", () => {
    const workflow = parse(
      readFileSync(
        join(root, ".github/workflows/production-backup.yml"),
        "utf8",
      ),
    ) as BackupWorkflow;
    const upload = workflow.jobs.backup.steps.find(
      (step) => step.uses === `actions/upload-artifact@${UPLOAD_ARTIFACT_SHA}`,
    );

    expect(upload).toMatchObject({
      with: {
        name: "production-backup-${{ github.run_id }}",
        path: expect.any(String),
        "retention-days": 30,
        "if-no-files-found": "error",
      },
    });
    const paths = String(upload?.with?.path)
      .split("\n")
      .map((path) => path.trim())
      .filter(Boolean);
    expect(paths).toEqual([
      "${{ runner.temp }}/jobtracker.dump.age",
      "${{ runner.temp }}/jobtracker.dump.age.sha256",
      "${{ runner.temp }}/backup-manifest.json",
    ]);
    expect(paths.join("\n")).not.toMatch(/(?<!\.age)\.dump(?:\s|$)|fingerprint|toc/iu);
  });

  it("documents monitoring, nightly recovery, and private key handling", () => {
    const runbook = readFileSync(
      join(root, "docs/operations/production-runbook.md"),
      "utf8",
    );
    for (const text of [
      "production-monitor.yml",
      "PRODUCTION_APP_URL",
      "PRODUCTION_APP_ACCESS_TOKEN",
      "production-backup.yml",
      "PRODUCTION_DATABASE_URL",
      "BACKUP_AGE_RECIPIENT",
      "backup.agekey",
      "0600",
      "30 days",
      "post-merge",
    ]) {
      expect(runbook).toContain(text);
    }
  });
});
