import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const root = join(__dirname, "../..");
const CHECKOUT_SHA = "df4cb1c069e1874edd31b4311f1884172cec0e10";
const SETUP_NODE_SHA = "249970729cb0ef3589644e2896645e5dc5ba9c38";
const UPLOAD_ARTIFACT_SHA =
  "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const POSTGRES_17_ALPINE_DIGEST =
  "sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";

type Step = Readonly<{
  name: string;
  if?: string;
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
          image: `docker.io/library/postgres:17-alpine@${POSTGRES_17_ALPINE_DIGEST}`,
          env: {
            POSTGRES_USER: "jobtracker_backup",
            POSTGRES_PASSWORD: "jobtracker_backup",
            POSTGRES_DB: "jobtracker_restore",
          },
          ports: ["5432:5432"],
        },
      },
    });
    const postgresImage = String(
      workflow.jobs.backup.services.postgres &&
        (workflow.jobs.backup.services.postgres as { image?: unknown }).image,
    );
    expect(postgresImage).toMatch(
      /^docker\.io\/library\/postgres:17-alpine@sha256:[0-9a-f]{64}$/u,
    );
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
    const coordinatorSource = readFileSync(
      join(root, "scripts/create-snapshot-backup.mjs"),
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
          env: expect.objectContaining({
            PRODUCTION_DATABASE_URL:
              "${{ secrets.PRODUCTION_DATABASE_URL }}",
          }),
        }),
        expect.objectContaining({
          name: "Encrypt verified backup",
          env: {
            BACKUP_AGE_RECIPIENT: "${{ vars.BACKUP_AGE_RECIPIENT }}",
          },
        }),
      ]),
    );

    expect(coordinatorSource).toContain("pg_dump");
    expect(coordinatorSource).toContain("--dbname=");
    expect(coordinatorSource).toContain("--snapshot=");
    expect(coordinatorSource).toContain("--format=custom");
    expect(coordinatorSource).toContain(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(coordinatorSource).toContain("SELECT pg_export_snapshot()");
    expect(coordinatorSource).toMatch(
      /const dumpPromise = dumpSnapshot[\s\S]*const fingerprintPromise =\s*fingerprintClient\(client\)/u,
    );
    expect(coordinatorSource).toContain("Promise.allSettled");
    expect(coordinatorSource).toContain("fingerprintClient(client)");
    expect(coordinatorSource).toContain("PGSERVICEFILE=");
    expect(coordinatorSource).toContain("CHILD_ENVIRONMENT_ALLOWLIST");
    expect(coordinatorSource).not.toContain("env: process.env");
    expect(coordinatorSource).not.toContain("`--dbname=${databaseUrl}`");
    expect(coordinatorSource).toMatch(
      /finally \{[\s\S]*credential\.containerPath[\s\S]*credential\.hostPath/u,
    );
    expect(coordinatorSource).toContain('client.query("ROLLBACK")');
    expect(coordinatorSource).toContain("client.end()");
    expect(coordinatorSource).not.toMatch(/console\.log|snapshotId|JSON\.stringify\(fingerprint/u);
    const sourceBackupStep = steps.find(
      (step) => step.name === "Create source backup and fingerprint",
    );
    expect(sourceBackupStep?.run).toContain(
      'node scripts/create-snapshot-backup.mjs "$DUMP_FILE" "$SOURCE_FINGERPRINT"',
    );
    expect(sourceBackupStep?.run).not.toContain("fingerprint-database.mjs");
    expect(joinedRuns).toContain("chmod 600");
    expect(joinedRuns).toContain("sha256sum");
    expect(joinedRuns).toContain("pg_restore --list");
    expect(joinedRuns).toContain(
      "pg_dump --version | grep -E '^pg_dump \\(PostgreSQL\\) 17\\.'",
    );
    expect(joinedRuns).toContain(
      "pg_restore --version | grep -E '^pg_restore \\(PostgreSQL\\) 17\\.'",
    );
    expect(fingerprintSource).toContain(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
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

  it("removes every plaintext and partial backup path unconditionally", () => {
    const workflow = parse(
      readFileSync(
        join(root, ".github/workflows/production-backup.yml"),
        "utf8",
      ),
    ) as BackupWorkflow;
    const cleanup = workflow.jobs.backup.steps.find(
      (step) => step.name === "Remove temporary backup files",
    );

    expect(cleanup?.if).toBe("always()");
    const command = cleanup?.run ?? "";
    for (const path of [
      "jobtracker.dump",
      "jobtracker.dump.partial",
      "jobtracker.dump.sha256",
      "jobtracker.toc",
      "source-fingerprint.json",
      "source-fingerprint.json.partial",
      "restore-fingerprint.json",
      "restore-fingerprint.json.partial",
      "jobtracker.dump.age.partial",
      "backup-manifest.json.partial",
    ]) {
      expect(command).toContain(path);
    }
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
      "PGSERVICEFILE",
      "PGPASSFILE",
      "--dbname=service=production_backup",
    ]) {
      expect(runbook).toContain(text);
    }
    expect(runbook).not.toContain('pg_dump "$DATABASE_URL"');
  });
});
