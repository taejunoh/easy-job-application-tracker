import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const { Client } = pg;
const root = join(__dirname, "../..");
const coordinator = join(root, "scripts/create-snapshot-backup.mjs");
const fingerprintScript = join(root, "scripts/fingerprint-database.mjs");
const requested = process.env.RUN_BACKUP_DOCKER_INTEGRATION === "1";
const describeDocker = requested ? describe : describe.skip;
const docker = process.env.DOCKER_BIN ?? "docker";
const postgresImage =
  process.env.PG17_IMAGE ??
  "docker.io/library/postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";
const passwordSentinel = "docker-backup-password-sentinel-never-log";

type ProcessResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

type RunningProcess = Readonly<{
  child: ChildProcessWithoutNullStreams;
  result: Promise<ProcessResult>;
}>;

function runProcess(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  input?: string | Uint8Array,
): RunningProcess {
  const child = spawn(command, args, {
    cwd: root,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  if (input === undefined) child.stdin.end();
  else child.stdin.end(input);
  const result = new Promise<ProcessResult>((resolve) => {
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, result };
}

async function runDocker(
  args: readonly string[],
  input?: string | Uint8Array,
): Promise<ProcessResult> {
  const result = await runProcess(docker, args, process.env, input).result;
  if (result.code !== 0) {
    throw new Error(`Docker ${args[0] ?? "command"} failed`);
  }
  return result;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to reserve a PostgreSQL test port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function boundedResult(
  result: Promise<ProcessResult>,
  timeoutMs = 15_000,
): Promise<ProcessResult | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const settled = await Promise.race([result, timeout]);
  if (timer) clearTimeout(timer);
  return settled;
}

function testDatabaseUrl(port: number): string {
  return `postgresql://jobtracker@127.0.0.1:${port}/jobtracker`;
}

function databaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function secretDatabaseUrl(port: number): string {
  const url = new URL(testDatabaseUrl(port));
  url.password = passwordSentinel;
  return url.toString();
}

async function pathIsAbsent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

describeDocker("real PostgreSQL 17 Docker backup interruption", () => {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const networkName = `jobtracker-backup-net-${suffix}`;
  const sourceContainer = `jobtracker-backup-source-${suffix}`;
  const toolContainer = `jobtracker-backup-tool-${suffix}`;
  const dockerLabel = `jobtracker.backup-integration=${suffix}`;
  let port: number;
  let observer: InstanceType<typeof Client>;
  let runDirectory: string | undefined;
  let lockClient: InstanceType<typeof Client> | undefined;
  let coordinatorProcess: RunningProcess | undefined;

  beforeAll(async () => {
    expect(postgresImage).toBe(
      "docker.io/library/postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193",
    );
    port = await reservePort();
    await runDocker(["network", "create", "--label", dockerLabel, networkName]);
    await runDocker([
      "run",
      "--detach",
      "--name",
      sourceContainer,
      "--label",
      dockerLabel,
      "--network",
      networkName,
      "--publish",
      `127.0.0.1:${port}:${port}`,
      "--env",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "--env",
      "POSTGRES_USER=jobtracker",
      "--env",
      "POSTGRES_DB=jobtracker",
      postgresImage,
      "-p",
      String(port),
    ]);
    await waitUntil(async () => {
      const result = await runProcess(docker, [
        "exec",
        sourceContainer,
        "pg_isready",
        "--host=127.0.0.1",
        `--port=${port}`,
        "--username=jobtracker",
        "--dbname=jobtracker",
      ]).result;
      return result.code === 0;
    }, "PostgreSQL 17 source container did not become ready", 30_000);
    await runDocker([
      "run",
      "--detach",
      "--name",
      toolContainer,
      "--label",
      dockerLabel,
      "--network",
      `container:${sourceContainer}`,
      "--entrypoint",
      "sh",
      postgresImage,
      "-c",
      "while :; do sleep 60; done",
    ]);

    const [dumpVersion, restoreVersion] = await Promise.all([
      runDocker(["exec", toolContainer, "pg_dump", "--version"]),
      runDocker(["exec", toolContainer, "pg_restore", "--version"]),
    ]);
    expect(dumpVersion.stdout).toMatch(/^pg_dump \(PostgreSQL\) 17\./u);
    expect(restoreVersion.stdout).toMatch(/^pg_restore \(PostgreSQL\) 17\./u);

    await runDocker(
      [
        "exec",
        "--interactive",
        sourceContainer,
        "psql",
        "--set=ON_ERROR_STOP=1",
        "--host=127.0.0.1",
        `--port=${port}`,
        "--username=jobtracker",
        "--dbname=jobtracker",
      ],
      `
        CREATE TABLE "Application" (
          "id" TEXT PRIMARY KEY,
          "url" TEXT NOT NULL,
          "jobTitle" TEXT NOT NULL,
          "company" TEXT NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'Applied',
          "appliedDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "description" TEXT,
          "notes" TEXT,
          "salary" TEXT,
          "location" TEXT,
          "jobType" TEXT,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL
        );
        CREATE TABLE "Settings" (
          "id" TEXT PRIMARY KEY,
          "llmProvider" TEXT NOT NULL,
          "apiKey" TEXT NOT NULL,
          "linkedinUrl" TEXT NOT NULL,
          "githubUrl" TEXT NOT NULL,
          "resumeText" TEXT NOT NULL
        );
        CREATE TABLE "_prisma_migrations" (
          "id" VARCHAR(36) PRIMARY KEY,
          "checksum" VARCHAR(64) NOT NULL,
          "finished_at" TIMESTAMPTZ,
          "migration_name" VARCHAR(255) NOT NULL,
          "logs" TEXT,
          "rolled_back_at" TIMESTAMPTZ,
          "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "applied_steps_count" INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE "ExtensionPairingGrant" ("id" TEXT PRIMARY KEY, "digest" TEXT NOT NULL);
        CREATE TABLE "ExtensionInstallation" ("id" TEXT PRIMARY KEY, "digest" TEXT NOT NULL);
        INSERT INTO "Application"
          ("id", "url", "jobTitle", "company", "updatedAt")
        VALUES
          ('proof', 'https://jobs.example.test/proof', 'Proof', 'Example', CURRENT_TIMESTAMP);
      `,
    );
    observer = new Client({ connectionString: testDatabaseUrl(port) });
    await observer.connect();
  }, 60_000);

  beforeEach(async () => {
    runDirectory = await mkdtemp(join(tmpdir(), "jobtracker-pg17-docker-"));
  });

  afterEach(async () => {
    if (coordinatorProcess?.child.exitCode === null) {
      coordinatorProcess.child.kill("SIGKILL");
      await boundedResult(coordinatorProcess.result, 1_000);
    }
    coordinatorProcess = undefined;
    if (lockClient) {
      await lockClient.query("ROLLBACK").catch(() => undefined);
      await lockClient.end().catch(() => undefined);
      lockClient = undefined;
    }
    if (runDirectory) {
      await rm(runDirectory, { recursive: true, force: true });
      runDirectory = undefined;
    }
  });

  afterAll(async () => {
    await observer?.end().catch(() => undefined);
    await runProcess(docker, ["rm", "--force", toolContainer]).result;
    await runProcess(docker, ["rm", "--force", sourceContainer]).result;
    await runProcess(docker, ["network", "rm", networkName]).result;
  }, 30_000);

  it("fingerprints every release-program table without a hard-coded allowlist", async () => {
    const fingerprintPath = join(runDirectory!, "all-tables.json");
    const execution = runProcess(
      process.execPath,
      [fingerprintScript, fingerprintPath],
      { ...process.env, DATABASE_URL: testDatabaseUrl(port), TZ: "UTC" },
    );

    expect(await execution.result).toMatchObject({ code: 0, stderr: "" });
    const fingerprint = JSON.parse(await readFile(fingerprintPath, "utf8"));
    expect(fingerprint.version).toBe(2);
    expect(Object.keys(fingerprint.tables)).toEqual([
      "Application",
      "ExtensionInstallation",
      "ExtensionPairingGrant",
      "Settings",
      "_prisma_migrations",
    ]);
    expect(fingerprint.tables.ExtensionInstallation).toMatchObject({ count: 0 });
    expect(fingerprint.tables.ExtensionPairingGrant).toMatchObject({ count: 0 });
  });

  it("completes a normal Docker snapshot after releasing the start gate", async () => {
    const token = randomBytes(5).toString("hex");
    const restoreDatabase = `jobtracker_restore_${token}`;
    const dumpPath = join(runDirectory!, "normal.dump");
    const fingerprintPath = join(runDirectory!, "normal.json");
    let restoreDatabaseCreated = false;

    coordinatorProcess = runProcess(
      process.execPath,
      [coordinator, dumpPath, fingerprintPath],
      {
        ...process.env,
        BACKUP_CREDENTIAL_DIRECTORY: runDirectory,
        DATABASE_URL: secretDatabaseUrl(port),
        DOCKER_BIN: docker,
        PASSWORD_SENTINEL: passwordSentinel,
        PG_DUMP_DOCKER_CONTAINER: toolContainer,
        PRODUCTION_DATABASE_URL: secretDatabaseUrl(port),
        TZ: "UTC",
      },
    );

    try {
      const result = await boundedResult(coordinatorProcess.result, 15_000);
      if (result === "timeout") {
        const stoppedProcessState = await runDocker([
          "exec",
          toolContainer,
          "sh",
          "-c",
          "set -eu; set -- /tmp/.jobtracker-pg-dump-*.pid; [ -f \"$1\" ]; pid=$(cat \"$1\"); awk '{ print $3 }' \"/proc/$pid/stat\"",
        ]);
        expect(stoppedProcessState.stdout.trim()).toBe("T");
      }
      expect(result).not.toBe("timeout");
      expect(result).toEqual({
        code: 0,
        signal: null,
        stdout: "Production backup snapshot created.\n",
        stderr: "",
      });
      expect((await stat(dumpPath)).size).toBeGreaterThan(0);
      expect((await stat(fingerprintPath)).size).toBeGreaterThan(0);

      await runDocker([
        "exec",
        sourceContainer,
        "createdb",
        "--host=127.0.0.1",
        `--port=${port}`,
        "--username=jobtracker",
        restoreDatabase,
      ]);
      restoreDatabaseCreated = true;
      const dump = await readFile(dumpPath);
      await runDocker(
        [
          "exec",
          "--interactive",
          toolContainer,
          "pg_restore",
          "--exit-on-error",
          "--no-owner",
          "--no-privileges",
          "--host=127.0.0.1",
          `--port=${port}`,
          "--username=jobtracker",
          `--dbname=${restoreDatabase}`,
        ],
        dump,
      );
      const restoredFingerprint = join(runDirectory!, "restored.json");
      const fingerprintResult = await runProcess(
        process.execPath,
        [fingerprintScript, restoredFingerprint],
        {
          ...process.env,
          DATABASE_URL: databaseUrl(testDatabaseUrl(port), restoreDatabase),
          TZ: "UTC",
        },
      ).result;
      expect(fingerprintResult).toMatchObject({ code: 0, stderr: "" });
      expect(await readFile(restoredFingerprint, "utf8")).toBe(
        await readFile(fingerprintPath, "utf8"),
      );
    } finally {
      if (coordinatorProcess?.child.exitCode === null) {
        coordinatorProcess.child.kill("SIGTERM");
        const termination = await boundedResult(coordinatorProcess.result, 5_000);
        if (termination === "timeout") coordinatorProcess.child.kill("SIGKILL");
      }
      if (restoreDatabaseCreated) {
        await runDocker([
          "exec",
          sourceContainer,
          "dropdb",
          "--host=127.0.0.1",
          `--port=${port}`,
          "--username=jobtracker",
          "--if-exists",
          restoreDatabase,
        ]);
      }
    }
  }, 30_000);

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "releases real blocked pg_dump and every owned resource on %s",
    async (signal, expectedCode) => {
      const token = randomBytes(5).toString("hex");
      const lockApplicationName = `jobtracker-pg17-lock-${token}`;
      const databaseUrl = secretDatabaseUrl(port);
      const dumpPath = join(runDirectory!, `${signal}.dump`);
      const fingerprintPath = join(runDirectory!, `${signal}.json`);
      lockClient = new Client({
        connectionString: testDatabaseUrl(port),
        application_name: lockApplicationName,
      });
      await lockClient.connect();
      await lockClient.query("BEGIN");
      await lockClient.query('LOCK TABLE "Application" IN ACCESS EXCLUSIVE MODE');

      coordinatorProcess = runProcess(
        process.execPath,
        [coordinator, dumpPath, fingerprintPath],
        {
          ...process.env,
          BACKUP_CREDENTIAL_DIRECTORY: runDirectory,
          DATABASE_URL: databaseUrl,
          DOCKER_BIN: docker,
          PASSWORD_SENTINEL: passwordSentinel,
          PG_DUMP_DOCKER_CONTAINER: toolContainer,
          PRODUCTION_DATABASE_URL: databaseUrl,
        },
      );

      await waitUntil(async () => {
        const result = await observer.query(
          `SELECT count(*)::int AS count
           FROM pg_locks AS lock
           JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
           WHERE lock.relation = '"Application"'::regclass
             AND lock.mode = 'AccessShareLock'
             AND lock.granted = false`,
        );
        return result.rows[0]?.count >= 1;
      }, "pg_dump did not block behind the Application ACCESS EXCLUSIVE lock");
      await waitUntil(async () => {
        const result = await runDocker([
          "exec",
          toolContainer,
          "sh",
          "-c",
          "for f in /proc/[0-9]*/cmdline; do tr '\\000' ' ' < \"$f\" 2>/dev/null; printf '\\n'; done",
        ]);
        return /(^|\s)pg_dump(\s|$)/mu.test(result.stdout);
      }, "container pg_dump process was not observed");

      coordinatorProcess.child.kill(signal);
      const result = await boundedResult(coordinatorProcess.result);
      if (result === "timeout") {
        coordinatorProcess.child.kill("SIGKILL");
        throw new Error(`Backup coordinator did not exit after ${signal}`);
      }

      expect(result).toEqual({
        code: expectedCode,
        signal: null,
        stdout: "",
        stderr: "",
      });
      expect(`${result.stdout}${result.stderr}`).not.toContain(databaseUrl);
      expect(`${result.stdout}${result.stderr}`).not.toContain(passwordSentinel);

      const immediateProcesses = await runDocker([
        "exec",
        toolContainer,
        "sh",
        "-c",
        "for f in /proc/[0-9]*/cmdline; do tr '\\000' ' ' < \"$f\" 2>/dev/null; printf '\\n'; done",
      ]);
      expect(immediateProcesses.stdout).not.toMatch(/\bpg_dump\b/u);

      let remainingSessions: unknown[] = [];
      await waitUntil(async () => {
        const sessions = await observer.query(
          `SELECT application_name, state, wait_event_type, wait_event
           FROM pg_stat_activity
           WHERE pid <> pg_backend_pid()
             AND application_name <> $1
             AND backend_type = 'client backend'
           ORDER BY application_name`,
          [lockApplicationName],
        );
        remainingSessions = sessions.rows;
        return sessions.rows.length === 0;
      }, "backup database sessions remained after interruption").catch(() => undefined);
      expect(remainingSessions).toEqual([]);
      await waitUntil(async () => {
        const processes = await runDocker([
          "exec",
          toolContainer,
          "sh",
          "-c",
          "for f in /proc/[0-9]*/cmdline; do tr '\\000' ' ' < \"$f\" 2>/dev/null; printf '\\n'; done",
        ]);
        return !/(^|\s)pg_dump(\s|$)/mu.test(processes.stdout);
      }, "container pg_dump process remained after interruption");

      const containerFiles = await runDocker([
        "exec",
        toolContainer,
        "sh",
        "-c",
        "find /tmp -maxdepth 1 -name '.jobtracker-*' -print",
      ]);
      expect(containerFiles.stdout).toBe("");
      expect(await readdir(runDirectory!)).toEqual([]);
      for (const path of [
        dumpPath,
        `${dumpPath}.partial`,
        fingerprintPath,
        `${fingerprintPath}.partial`,
      ]) {
        expect(await pathIsAbsent(path)).toBe(true);
      }

      await lockClient.query("ROLLBACK");
      await lockClient.end();
      lockClient = undefined;
      const residue = await observer.query(
        `SELECT
           count(*) FILTER (WHERE activity.application_name LIKE 'jobtracker-pg17-%')::int AS sessions,
           count(*) FILTER (WHERE lock.relation = '"Application"'::regclass)::int AS application_locks,
           count(*) FILTER (WHERE activity.xact_start IS NOT NULL)::int AS transactions
         FROM pg_stat_activity AS activity
         LEFT JOIN pg_locks AS lock ON lock.pid = activity.pid
         WHERE activity.application_name LIKE 'jobtracker-pg17-%'`,
      );
      expect(residue.rows).toEqual([
        { sessions: 0, application_locks: 0, transactions: 0 },
      ]);
    },
    30_000,
  );
});
