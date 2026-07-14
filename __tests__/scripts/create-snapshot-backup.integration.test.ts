import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import pg from "pg";
import { assertDatabaseTestSafety } from "../api/database-test-guard";

const { Client } = pg;
const root = join(__dirname, "../..");
const coordinator = join(root, "scripts/create-snapshot-backup.mjs");
const fingerprintScript = join(root, "scripts/fingerprint-database.mjs");
const requested = process.env.RUN_BACKUP_INTEGRATION === "1";
const describeBackup = requested ? describe : describe.skip;
const passwordSentinel = "backup-password-sentinel-never-forward";
const forbiddenChildEnvironment = [
  "DATABASE_URL",
  "PRODUCTION_DATABASE_URL",
  "PASSWORD_SENTINEL",
];
const allowedChildEnvironment = new Set([
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "PGSERVICEFILE",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TMPDIR",
  "__CF_USER_TEXT_ENCODING",
]);

type ChildResult = Readonly<{
  code: number | null;
  stdout: string;
  stderr: string;
}>;

type CommandCapture = Readonly<{
  args: readonly string[];
  env: Record<string, string>;
  serviceFileMode?: number | null;
  hasPasswordLine?: boolean;
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

function databaseUrlWithPassword(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.password = passwordSentinel;
  return url.toString();
}

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source, { mode: 0o700 });
  await chmod(path, 0o700);
}

async function createPgDumpGate(
  path: string,
  capturePath: string,
  readyPath: string,
  continuePath: string,
): Promise<void> {
  const realPgDump = requiredEnvironment("PG17_DUMP_BIN");
  await writeExecutable(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const serviceFile = process.env.PGSERVICEFILE;
const serviceContents = serviceFile && fs.existsSync(serviceFile)
  ? fs.readFileSync(serviceFile, "utf8") : "";
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  args: process.argv.slice(2), env: process.env,
  serviceFileMode: serviceFile ? fs.statSync(serviceFile).mode & 0o777 : null,
  hasPasswordLine: /^password=/mu.test(serviceContents),
}));
fs.writeFileSync(${JSON.stringify(readyPath)}, "");
while (!fs.existsSync(${JSON.stringify(continuePath)})) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
const child = spawnSync(${JSON.stringify(realPgDump)}, process.argv.slice(2), {
  env: process.env, stdio: ["ignore", "inherit", "inherit"],
});
process.exit(child.status ?? 1);
`,
  );
}

async function createFakeDocker(
  path: string,
  logPath: string,
  failDump: boolean,
): Promise<void> {
  await writeExecutable(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const entry = { args, env: process.env };
function containerPath(value) { return value.slice(value.indexOf(":") + 1); }
if (args[0] === "cp") {
  const destination = containerPath(args[2]);
  fs.copyFileSync(args[1], destination);
} else if (args[0] === "exec") {
  let index = 1;
  let serviceFile;
  while (args[index] === "--env") {
    const assignment = args[index + 1];
    if (assignment.startsWith("PGSERVICEFILE=")) serviceFile = assignment.slice(14);
    index += 2;
  }
  index += 1;
  const command = args[index];
  const commandArgs = args.slice(index + 1);
  if (command === "chmod") {
    fs.chmodSync(commandArgs[1], Number.parseInt(commandArgs[0], 8));
  } else if (command === "pg_dump") {
    const contents = serviceFile && fs.existsSync(serviceFile)
      ? fs.readFileSync(serviceFile, "utf8") : "";
    entry.serviceFileMode = serviceFile ? fs.statSync(serviceFile).mode & 0o777 : null;
    entry.hasPasswordLine = /^password=/mu.test(contents);
    process.stdout.write("fake-custom-dump");
    if (${JSON.stringify(failDump)}) process.exitCode = 7;
  } else if (command === "rm") {
    fs.rmSync(commandArgs.at(-1), { force: true });
  }
}
const log = fs.existsSync(${JSON.stringify(logPath)})
  ? JSON.parse(fs.readFileSync(${JSON.stringify(logPath)}, "utf8")) : [];
log.push(entry);
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(log));
`,
  );
}

function expectSanitizedCapture(
  capture: CommandCapture,
  secretDatabaseUrl: string,
): void {
  const serialized = JSON.stringify(capture);
  expect(serialized).not.toContain(secretDatabaseUrl);
  expect(serialized).not.toContain(passwordSentinel);
  for (const name of forbiddenChildEnvironment) {
    expect(capture.env).not.toHaveProperty(name);
  }
  expect(
    Object.keys(capture.env).filter(
      (name) => !allowedChildEnvironment.has(name),
    ),
  ).toEqual([]);
}

describeBackup("snapshot-consistent production backup coordinator", () => {
  const sourceUrl = requested
    ? requiredEnvironment("DATABASE_URL")
    : "postgresql://postgres@127.0.0.1:5432/jobtracker_backup_test";
  const sourceIdentity = requested
    ? assertDatabaseTestSafety(process.env)
    : undefined;
  const secretSourceUrl = databaseUrlWithPassword(sourceUrl);
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
    const capturePath = join(runDirectory, "pg-dump-capture.json");
    const gatePath = join(runDirectory, "pg-dump-gate");
    await createPgDumpGate(
      gatePath,
      capturePath,
      readyPath,
      continuePath,
    );
    const execution = runChild(
      process.execPath,
      [coordinator, dumpPath, sourceFingerprintPath],
      {
        ...process.env,
        DATABASE_URL: secretSourceUrl,
        PRODUCTION_DATABASE_URL: secretSourceUrl,
        PASSWORD_SENTINEL: passwordSentinel,
        PG_DUMP_BIN: gatePath,
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
    const capture = JSON.parse(
      await readFile(capturePath, "utf8"),
    ) as CommandCapture;
    expectSanitizedCapture(capture, secretSourceUrl);
    expect(capture.args).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^--dbname=service=jobtracker_backup_[0-9a-f]+$/u),
        expect.stringMatching(/^--snapshot=/u),
      ]),
    );
    expect(capture.serviceFileMode).toBe(0o600);
    expect(capture.hasPasswordLine).toBe(true);
    await expect(stat(capture.env.PGSERVICEFILE)).rejects.toMatchObject({
      code: "ENOENT",
    });

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

  it.each([
    ["success", false, 0],
    ["failure", true, 1],
  ])(
    "keeps Docker %s argv and metadata secret-free and removes credentials",
    async (_label, failDump, expectedCode) => {
      const dumpPath = join(runDirectory, `docker-${String(failDump)}.dump`);
      const fingerprintPath = join(runDirectory, `docker-${String(failDump)}.json`);
      const dockerPath = join(runDirectory, "fake-docker");
      const logPath = join(runDirectory, "docker-log.json");
      await createFakeDocker(dockerPath, logPath, failDump);
      const execution = runChild(
        process.execPath,
        [coordinator, dumpPath, fingerprintPath],
        {
          ...process.env,
          DATABASE_URL: secretSourceUrl,
          PRODUCTION_DATABASE_URL: secretSourceUrl,
          PASSWORD_SENTINEL: passwordSentinel,
          PG_DUMP_DOCKER_CONTAINER: "nonsecret-container-id",
          DOCKER_BIN: dockerPath,
        },
      );

      const result = await execution.result;
      expect(result.code).toBe(expectedCode);
      const captures = JSON.parse(
        await readFile(logPath, "utf8"),
      ) as CommandCapture[];
      expect(captures.map((capture) => capture.args[0])).toEqual(
        expect.arrayContaining(["cp", "exec"]),
      );
      for (const capture of captures) {
        expectSanitizedCapture(capture, secretSourceUrl);
      }
      const copy = captures.find((capture) => capture.args[0] === "cp");
      const dump = captures.find((capture) => capture.args.includes("pg_dump"));
      const cleanup = captures.find(
        (capture) => capture.args.includes("rm") && capture.args.includes("-f"),
      );
      expect(copy).toBeDefined();
      expect(dump).toMatchObject({
        serviceFileMode: 0o600,
        hasPasswordLine: true,
      });
      expect(dump?.args).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^--dbname=service=jobtracker_backup_[0-9a-f]+$/u),
          expect.stringMatching(/^--snapshot=/u),
        ]),
      );
      expect(cleanup).toBeDefined();
      const hostCredentialPath = copy?.args[1] ?? "";
      const containerCredentialPath = (copy?.args[2] ?? "").replace(
        /^[^:]+:/u,
        "",
      );
      await expect(stat(hostCredentialPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(stat(containerCredentialPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      if (failDump) {
        for (const path of [dumpPath, `${dumpPath}.partial`, fingerprintPath]) {
          await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
    },
  );
});
