import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import pg from "pg";
import { assertDatabaseTestSafety } from "../api/database-test-guard";

const { Client } = pg;
const root = join(__dirname, "../..");
const coordinator = join(root, "scripts/create-snapshot-backup.mjs");
const fingerprintScript = join(root, "scripts/fingerprint-database.mjs");
const dumpGate = join(root, "__tests__/fixtures/backup/pg-dump-gate.sh");
const requested = process.env.RUN_BACKUP_INTEGRATION === "1";
const describeBackup = requested ? describe : describe.skip;

type ChildResult = Readonly<{
  code: number | null;
  stdout: string;
  stderr: string;
}>;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function runChild(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): { child: ChildProcessWithoutNullStreams; result: Promise<ChildResult> } {
  const child = spawn(command, args, {
    cwd: root,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const result = new Promise<ChildResult>((resolve) => {
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, result };
}

async function waitForFile(path: string, childResult: Promise<ChildResult>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch {
      const ended = await Promise.race([
        childResult.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 10)),
      ]);
      if (ended) throw new Error("backup coordinator exited before pg_dump gate");
    }
  }
  throw new Error("timed out waiting for pg_dump gate");
}

function databaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

describeBackup("snapshot-consistent production backup coordinator", () => {
  const sourceUrl = requested
    ? requiredEnvironment("DATABASE_URL")
    : "postgresql://postgres@127.0.0.1:5432/jobtracker_backup_test";
  const sourceIdentity = requested
    ? assertDatabaseTestSafety(process.env)
    : undefined;
  const scratchDatabase = `jobtracker_snapshot_${process.pid}_test`;
  const scratchUrl = databaseUrl(sourceUrl, scratchDatabase);
  const adminUrl = databaseUrl(sourceUrl, "postgres");
  let sourceClient: InstanceType<typeof Client>;
  let adminClient: InstanceType<typeof Client>;
  let runDirectory: string;

  beforeAll(async () => {
    expect(sourceIdentity?.host).toMatch(
      /^(?:localhost|127\.0\.0\.1|\[::1\])$/u,
    );
    sourceClient = new Client({ connectionString: sourceUrl });
    adminClient = new Client({ connectionString: adminUrl });
    await sourceClient.connect();
    await adminClient.connect();
    await adminClient.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
  });

  beforeEach(async () => {
    runDirectory = await mkdtemp(join(tmpdir(), "jobtracker-snapshot-test-"));
    await sourceClient.query('DELETE FROM "Application"');
    await sourceClient.query('DELETE FROM "Settings"');
    await sourceClient.query(`
      INSERT INTO "Application"
        ("id", "url", "jobTitle", "company", "status", "updatedAt")
      VALUES
        ('before-snapshot', 'https://jobs.example.test/before', 'Before',
         'Example', 'Applied', CURRENT_TIMESTAMP)
    `);
  });

  afterEach(async () => {
    await adminClient.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`);
    await sourceClient.query('DELETE FROM "Application"');
    await rm(runDirectory, { recursive: true, force: true });
  });

  afterAll(async () => {
    await sourceClient?.end();
    await adminClient?.end();
  });

  it("restores the exported snapshot fingerprint despite a concurrent write", async () => {
    const dumpPath = join(runDirectory, "snapshot.dump");
    const sourceFingerprintPath = join(runDirectory, "source.json");
    const restoreFingerprintPath = join(runDirectory, "restore.json");
    const readyPath = join(runDirectory, "dump-ready");
    const continuePath = join(runDirectory, "dump-continue");
    const execution = runChild(
      process.execPath,
      [coordinator, dumpPath, sourceFingerprintPath],
      {
        ...process.env,
        DATABASE_URL: sourceUrl,
        PG_DUMP_BIN: dumpGate,
        REAL_PG_DUMP: requiredEnvironment("PG17_DUMP_BIN"),
        PG_DUMP_READY_FILE: readyPath,
        PG_DUMP_CONTINUE_FILE: continuePath,
      },
    );

    await waitForFile(readyPath, execution.result);
    await sourceClient.query(`
      INSERT INTO "Application"
        ("id", "url", "jobTitle", "company", "status", "updatedAt")
      VALUES
        ('after-snapshot', 'https://jobs.example.test/after', 'After',
         'Example', 'Applied', CURRENT_TIMESTAMP)
    `);
    await writeFile(continuePath, "", { mode: 0o600 });

    await expect(execution.result).resolves.toEqual({
      code: 0,
      stdout: "Production backup snapshot created.\n",
      stderr: "",
    });
    expect((await stat(dumpPath)).mode & 0o777).toBe(0o600);
    expect((await stat(sourceFingerprintPath)).mode & 0o777).toBe(0o600);

    await adminClient.query(`CREATE DATABASE "${scratchDatabase}"`);
    const restore = runChild(
      requiredEnvironment("PG17_RESTORE_BIN"),
      [
        "--exit-on-error",
        "--no-owner",
        "--no-privileges",
        `--dbname=${scratchUrl}`,
        dumpPath,
      ],
      process.env,
    );
    expect((await restore.result).code).toBe(0);
    const fingerprint = runChild(
      process.execPath,
      [fingerprintScript, restoreFingerprintPath],
      { ...process.env, DATABASE_URL: scratchUrl },
    );
    expect((await fingerprint.result).code).toBe(0);

    const sourceFingerprint = JSON.parse(
      await readFile(sourceFingerprintPath, "utf8"),
    );
    const restoreFingerprint = JSON.parse(
      await readFile(restoreFingerprintPath, "utf8"),
    );
    expect(restoreFingerprint).toEqual(sourceFingerprint);
    expect(sourceFingerprint.tables.Application.count).toBe(1);
    await expect(
      sourceClient.query('SELECT count(*)::int AS count FROM "Application"'),
    ).resolves.toMatchObject({ rows: [{ count: 2 }] });
  });

  it("rolls back, disconnects, and removes partial outputs when pg_dump fails", async () => {
    const dumpPath = join(runDirectory, "failed.dump");
    const fingerprintPath = join(runDirectory, "failed.json");
    const execution = runChild(
      process.execPath,
      [coordinator, dumpPath, fingerprintPath],
      {
        ...process.env,
        DATABASE_URL: sourceUrl,
        PG_DUMP_BIN: join(runDirectory, "missing-pg-dump"),
      },
    );

    const result = await execution.result;
    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: "Production backup failed.\n",
    });
    for (const path of [
      dumpPath,
      `${dumpPath}.partial`,
      fingerprintPath,
      `${fingerprintPath}.partial`,
    ]) {
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const sessions = await sourceClient.query(
      `SELECT count(*)::int AS count
       FROM pg_stat_activity
       WHERE application_name = 'jobtracker-backup-coordinator'`,
    );
    expect(sessions.rows).toEqual([{ count: 0 }]);
    expect(`${result.stdout}${result.stderr}`).not.toContain(sourceUrl);
    expect(`${result.stdout}${result.stderr}`).not.toContain(basename(fingerprintPath));
  });
});
