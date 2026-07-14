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
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

type CommandCapture = Readonly<{
  args: readonly string[];
  env: Record<string, string>;
  serviceFileMode?: number | null;
  hasPasswordLine?: boolean;
  pid?: number;
  pidfile?: string;
  control?: boolean;
  hang?: "remote-stop" | "cleanup-rm";
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
    child.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
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
  ignoreTermination = false,
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
if (${JSON.stringify(ignoreTermination)}) process.on("SIGTERM", () => undefined);
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  args: process.argv.slice(2), env: process.env,
  pid: process.pid,
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

async function createInterruptibleRealPgDump(
  path: string,
  capturePath: string,
  readyPath: string,
): Promise<void> {
  const realPgDump = requiredEnvironment("PG17_DUMP_BIN");
  await writeExecutable(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const serviceFile = process.env.PGSERVICEFILE;
const serviceContents = serviceFile && fs.existsSync(serviceFile)
  ? fs.readFileSync(serviceFile, "utf8") : "";
const child = spawn(${JSON.stringify(realPgDump)}, process.argv.slice(2), {
  env: process.env, stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  args: process.argv.slice(2), env: process.env, pid: child.pid,
  serviceFileMode: serviceFile ? fs.statSync(serviceFile).mode & 0o777 : null,
  hasPasswordLine: /^password=/mu.test(serviceContents),
}));
fs.writeFileSync(${JSON.stringify(readyPath)}, "");
child.once("error", () => process.exit(1));
child.once("close", (code, signal) => {
  process.exit(code ?? (signal === "SIGTERM" ? 143 : 1));
});
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
const serializedArgs = JSON.stringify(args);
const pidfile = args.find((argument) => /^\\/tmp\\/\\.jobtracker-pg-dump-[0-9a-f]+\\.pid$/u.test(argument));
const startfile = args.find((argument) => /^\\/tmp\\/\\.jobtracker-pg-dump-[0-9a-f]+\\.start$/u.test(argument));
const cancelfile = args.find((argument) => /^\\/tmp\\/\\.jobtracker-pg-dump-[0-9a-f]+\\.cancel$/u.test(argument));
let shouldLog = false;
function containerPath(value) { return value.slice(value.indexOf(":") + 1); }
if (args[0] === "cp") {
  const destination = containerPath(args[2]);
  fs.copyFileSync(args[1], destination);
  shouldLog = true;
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
    shouldLog = true;
  } else if (args.some((argument) => argument.startsWith("--snapshot="))) {
    if (pidfile) fs.writeFileSync(pidfile, String(process.pid), { mode: 0o600 });
    while (startfile && !fs.existsSync(startfile) && !(cancelfile && fs.existsSync(cancelfile))) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    const contents = serviceFile && fs.existsSync(serviceFile)
      ? fs.readFileSync(serviceFile, "utf8") : "";
    entry.serviceFileMode = serviceFile ? fs.statSync(serviceFile).mode & 0o777 : null;
    entry.hasPasswordLine = /^password=/mu.test(contents);
    process.stdout.write("fake-custom-dump");
    if (${JSON.stringify(failDump)}) process.exitCode = 7;
    shouldLog = true;
  } else if (args.some((argument) => argument.includes('test -s "$1"'))) {
    if (!pidfile || !fs.existsSync(pidfile)) process.exitCode = 1;
  } else if (args.some((argument) => argument.includes(': > "$1"'))) {
    const controlPath = startfile ?? cancelfile;
    if (controlPath) fs.writeFileSync(controlPath, "", { mode: 0o600 });
  } else if (command === "rm") {
    for (const candidate of commandArgs.filter((argument) => argument.startsWith("/"))) {
      fs.rmSync(candidate, { force: true });
    }
    shouldLog = true;
  }
}

if (shouldLog) {
  const log = fs.existsSync(${JSON.stringify(logPath)})
    ? JSON.parse(fs.readFileSync(${JSON.stringify(logPath)}, "utf8")) : [];
  log.push(entry);
  fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(log));
}
`,
  );
}

async function createInterruptibleFakeDocker(
  path: string,
  logPath: string,
  readyPath: string,
  options: Readonly<{
    failRemoteStop?: boolean;
    controlReadyPath?: string;
    hangRemoteStop?: boolean;
    hangCleanupRm?: boolean;
    cleanupReadyPath?: string;
  }> = {},
): Promise<void> {
  await writeExecutable(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const entry = { args, env: process.env };
const serializedArgs = JSON.stringify(args);
const pidfileMatch = serializedArgs.match(/\\/tmp\\/\\.jobtracker-pg-dump-[0-9a-f]+\\.pid/u);
entry.pidfile = pidfileMatch?.[0];
function append(value) {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(value) + "\\n");
}
function containerPath(value) { return value.slice(value.indexOf(":") + 1); }
if (args[0] === "cp") {
  fs.copyFileSync(args[1], containerPath(args[2]));
  append(entry);
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
  const isDump = args.some((argument) => argument.startsWith("--snapshot="));
  if (command === "chmod") {
    fs.chmodSync(commandArgs[1], Number.parseInt(commandArgs[0], 8));
    append(entry);
  } else if (isDump) {
    const contents = serviceFile && fs.existsSync(serviceFile)
      ? fs.readFileSync(serviceFile, "utf8") : "";
    entry.pid = process.pid;
    entry.serviceFileMode = serviceFile ? fs.statSync(serviceFile).mode & 0o777 : null;
    entry.hasPasswordLine = /^password=/mu.test(contents);
    if (entry.pidfile) fs.writeFileSync(entry.pidfile, String(process.pid), { mode: 0o600 });
    append(entry);
    fs.writeFileSync(${JSON.stringify(readyPath)}, "");
    process.stdout.write("partial-fake-custom-dump");
    setInterval(() => undefined, 1_000);
  } else if (
    ${JSON.stringify(options.controlReadyPath !== undefined)} &&
    args.some((argument) => argument.includes('test -s "$1"'))
  ) {
    entry.pid = process.pid;
    entry.control = true;
    append(entry);
    fs.writeFileSync(${JSON.stringify(options.controlReadyPath ?? "")}, "");
    setInterval(() => undefined, 1_000);
  } else if (serializedArgs.includes("kill") && entry.pidfile) {
    if (${JSON.stringify(options.hangRemoteStop === true)}) {
      entry.pid = process.pid;
      entry.hang = "remote-stop";
      append(entry);
      fs.writeFileSync(${JSON.stringify(options.cleanupReadyPath ?? "")}, "");
      setInterval(() => undefined, 1_000);
    } else if (${JSON.stringify(options.failRemoteStop === true)}) {
      append({ ...entry, remoteFailure: true });
      process.exitCode = 9;
    } else {
      const pid = Number.parseInt(fs.readFileSync(entry.pidfile, "utf8"), 10);
      process.kill(pid, "SIGTERM");
      append({ ...entry, remoteSignal: "SIGTERM" });
    }
  } else if (command === "rm") {
    if (${JSON.stringify(options.hangCleanupRm === true)}) {
      entry.pid = process.pid;
      entry.hang = "cleanup-rm";
      append(entry);
      fs.writeFileSync(${JSON.stringify(options.cleanupReadyPath ?? "")}, "");
      setInterval(() => undefined, 1_000);
    } else {
      for (const candidate of commandArgs.filter((argument) => argument.startsWith("/"))) {
        fs.rmSync(candidate, { force: true });
      }
      append(entry);
    }
  } else {
    append(entry);
  }
}
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

async function pathIsAbsent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !processIsAlive(pid);
}

async function boundedChildResult(
  result: Promise<ChildResult>,
  milliseconds = 3_500,
): Promise<ChildResult | "timeout"> {
  return Promise.race([
    result,
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), milliseconds),
    ),
  ]);
}

function forceKill(pid: number | undefined): void {
  if (!pid || !processIsAlive(pid)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      process.kill(pid, "SIGKILL");
    }
  }
}

async function readJsonLines(path: string): Promise<CommandCapture[]> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CommandCapture);
}

async function waitForDatabaseSession(
  client: InstanceType<typeof Client>,
  applicationName: string,
  childResult: Promise<ChildResult>,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await client.query(
      `SELECT count(*)::int AS count
       FROM pg_stat_activity
       WHERE application_name = $1`,
      [applicationName],
    );
    if (result.rows[0]?.count > 0) return;
    const ended = await Promise.race([
      childResult.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 10)),
    ]);
    if (ended) throw new Error("backup coordinator exited before pg_dump connected");
  }
  throw new Error("timed out waiting for pg_dump database session");
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
      signal: null,
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
      signal: null,
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

  it("finishes direct child and resource cleanup before exiting 143 on SIGTERM", async () => {
    const dumpPath = join(runDirectory, "interrupted-direct.dump");
    const fingerprintPath = join(runDirectory, "interrupted-direct.json");
    const readyPath = join(runDirectory, "interrupt-direct-ready");
    const capturePath = join(runDirectory, "interrupt-direct-capture.json");
    const gatePath = join(runDirectory, "interrupt-direct-gate");
    const dumpApplicationName = `jobtracker-interrupted-pg-dump-${process.pid}`;
    const interruptedSourceUrl = new URL(secretSourceUrl);
    interruptedSourceUrl.searchParams.set("application_name", dumpApplicationName);
    const lockClient = new Client({ connectionString: sourceUrl });
    await lockClient.connect();
    await lockClient.query("BEGIN");
    await lockClient.query('LOCK TABLE "Application" IN ACCESS EXCLUSIVE MODE');
    await createInterruptibleRealPgDump(gatePath, capturePath, readyPath);
    const execution = runChild(
      process.execPath,
      [coordinator, dumpPath, fingerprintPath],
      {
        ...process.env,
        BACKUP_CREDENTIAL_DIRECTORY: runDirectory,
        DATABASE_URL: interruptedSourceUrl.toString(),
        PRODUCTION_DATABASE_URL: interruptedSourceUrl.toString(),
        PASSWORD_SENTINEL: passwordSentinel,
        PG_DUMP_BIN: gatePath,
      },
    );

    await waitForFile(readyPath, execution.result);
    const capture = JSON.parse(
      await readFile(capturePath, "utf8"),
    ) as CommandCapture;
    expect(capture.pid).toEqual(expect.any(Number));
    await waitForDatabaseSession(
      sourceClient,
      dumpApplicationName,
      execution.result,
    );
    execution.child.kill("SIGTERM");
    const result = await execution.result;
    const childGone = await waitForProcessGone(capture.pid!);
    if (!childGone) process.kill(capture.pid!, "SIGKILL");
    await lockClient.query("ROLLBACK").catch(() => undefined);
    await lockClient.end();

    expect(result).toEqual({
      code: 143,
      signal: null,
      stdout: "",
      stderr: "",
    });
    expect(childGone).toBe(true);
    expectSanitizedCapture(capture, interruptedSourceUrl.toString());
    expect(await pathIsAbsent(capture.env.PGSERVICEFILE)).toBe(true);
    for (const path of [
      dumpPath,
      `${dumpPath}.partial`,
      fingerprintPath,
      `${fingerprintPath}.partial`,
    ]) {
      expect(await pathIsAbsent(path)).toBe(true);
    }
    const sessions = await sourceClient.query(
      `SELECT count(*)::int AS count
       FROM pg_stat_activity
       WHERE application_name = 'jobtracker-backup-coordinator'`,
    );
    expect(sessions.rows).toEqual([{ count: 0 }]);
    expect(`${result.stdout}${result.stderr}`).not.toContain(secretSourceUrl);
    expect(`${result.stdout}${result.stderr}`).not.toContain(passwordSentinel);
  });

  it("escalates an uncooperative direct child to SIGKILL before exiting", async () => {
    const dumpPath = join(runDirectory, "stubborn-direct.dump");
    const fingerprintPath = join(runDirectory, "stubborn-direct.json");
    const readyPath = join(runDirectory, "stubborn-direct-ready");
    const continuePath = join(runDirectory, "stubborn-direct-continue");
    const capturePath = join(runDirectory, "stubborn-direct-capture.json");
    const gatePath = join(runDirectory, "stubborn-direct-gate");
    await createPgDumpGate(
      gatePath,
      capturePath,
      readyPath,
      continuePath,
      true,
    );
    const execution = runChild(
      process.execPath,
      [coordinator, dumpPath, fingerprintPath],
      {
        ...process.env,
        BACKUP_CREDENTIAL_DIRECTORY: runDirectory,
        DATABASE_URL: secretSourceUrl,
        PG_DUMP_BIN: gatePath,
      },
    );

    await waitForFile(readyPath, execution.result);
    const capture = JSON.parse(
      await readFile(capturePath, "utf8"),
    ) as CommandCapture;
    execution.child.kill("SIGINT");
    const result = await execution.result;

    expect(result).toEqual({
      code: 130,
      signal: null,
      stdout: "",
      stderr: "",
    });
    expect(await waitForProcessGone(capture.pid!)).toBe(true);
    expect(await pathIsAbsent(capture.env.PGSERVICEFILE)).toBe(true);
    for (const path of [
      dumpPath,
      `${dumpPath}.partial`,
      fingerprintPath,
      `${fingerprintPath}.partial`,
    ]) {
      expect(await pathIsAbsent(path)).toBe(true);
    }
  });

  it("stops Docker-side dump and cleans resources before exiting 130 on SIGINT", async () => {
    const dumpPath = join(runDirectory, "interrupted-docker.dump");
    const fingerprintPath = join(runDirectory, "interrupted-docker.json");
    const dockerPath = join(runDirectory, "interrupt-fake-docker");
    const logPath = join(runDirectory, "interrupt-docker-log.jsonl");
    const readyPath = join(runDirectory, "interrupt-docker-ready");
    await createInterruptibleFakeDocker(dockerPath, logPath, readyPath);
    const execution = runChild(
      process.execPath,
      [coordinator, dumpPath, fingerprintPath],
      {
        ...process.env,
        BACKUP_CREDENTIAL_DIRECTORY: runDirectory,
        DATABASE_URL: secretSourceUrl,
        PRODUCTION_DATABASE_URL: secretSourceUrl,
        PASSWORD_SENTINEL: passwordSentinel,
        PG_DUMP_DOCKER_CONTAINER: "nonsecret-container-id",
        DOCKER_BIN: dockerPath,
      },
    );

    await waitForFile(readyPath, execution.result);
    const initialCaptures = await readJsonLines(logPath);
    const copy = initialCaptures.find((capture) => capture.args[0] === "cp");
    const dump = initialCaptures.find((capture) => capture.pid !== undefined);
    expect(copy).toBeDefined();
    expect(dump?.pid).toEqual(expect.any(Number));
    execution.child.kill("SIGINT");
    const result = await execution.result;
    const remoteGone = await waitForProcessGone(dump!.pid!);
    if (!remoteGone) process.kill(dump!.pid!, "SIGKILL");
    const captures = await readJsonLines(logPath);
    const hostCredentialPath = copy!.args[1];
    const containerCredentialPath = copy!.args[2].replace(/^[^:]+:/u, "");
    const hostCredentialRemoved = await pathIsAbsent(hostCredentialPath);
    const containerCredentialRemoved = await pathIsAbsent(containerCredentialPath);
    const pidfileRemoved = dump?.pidfile
      ? await pathIsAbsent(dump.pidfile)
      : false;
    await rm(containerCredentialPath, { force: true });
    if (dump?.pidfile) await rm(dump.pidfile, { force: true });

    expect(result).toEqual({
      code: 130,
      signal: null,
      stdout: "",
      stderr: "",
    });
    expect(remoteGone).toBe(true);
    expect(dump?.pidfile).toMatch(
      /^\/tmp\/\.jobtracker-pg-dump-[0-9a-f]+\.pid$/u,
    );
    expect(
      captures.some((capture) => JSON.stringify(capture.args).includes("kill")),
    ).toBe(true);
    expect(hostCredentialRemoved).toBe(true);
    expect(containerCredentialRemoved).toBe(true);
    expect(pidfileRemoved).toBe(true);
    for (const capture of captures) {
      expectSanitizedCapture(capture, secretSourceUrl);
    }
    for (const path of [
      dumpPath,
      `${dumpPath}.partial`,
      fingerprintPath,
      `${fingerprintPath}.partial`,
    ]) {
      expect(await pathIsAbsent(path)).toBe(true);
    }
    const sessions = await sourceClient.query(
      `SELECT count(*)::int AS count
       FROM pg_stat_activity
       WHERE application_name = 'jobtracker-backup-coordinator'`,
    );
    expect(sessions.rows).toEqual([{ count: 0 }]);
    expect(`${result.stdout}${result.stderr}`).not.toContain(secretSourceUrl);
    expect(`${result.stdout}${result.stderr}`).not.toContain(passwordSentinel);
  });

  it("interrupts a hung Docker control CLI as well as the remote dump", async () => {
    const dumpPath = join(runDirectory, "hung-control.dump");
    const fingerprintPath = join(runDirectory, "hung-control.json");
    const dockerPath = join(runDirectory, "hung-control-fake-docker");
    const logPath = join(runDirectory, "hung-control-log.jsonl");
    const dumpReadyPath = join(runDirectory, "hung-control-dump-ready");
    const controlReadyPath = join(runDirectory, "hung-control-cli-ready");
    await createInterruptibleFakeDocker(
      dockerPath,
      logPath,
      dumpReadyPath,
      { controlReadyPath },
    );
    const execution = runChild(
      process.execPath,
      [coordinator, dumpPath, fingerprintPath],
      {
        ...process.env,
        BACKUP_CREDENTIAL_DIRECTORY: runDirectory,
        DATABASE_URL: secretSourceUrl,
        PG_DUMP_DOCKER_CONTAINER: "nonsecret-container-id",
        DOCKER_BIN: dockerPath,
      },
    );

    await waitForFile(controlReadyPath, execution.result);
    const beforeSignal = await readJsonLines(logPath);
    const remote = beforeSignal.find(
      (capture) => capture.pid !== undefined && !capture.control,
    );
    const control = beforeSignal.find((capture) => capture.control);
    execution.child.kill("SIGTERM");
    const result = await execution.result;

    expect(result).toMatchObject({ code: 143, signal: null });
    expect(await waitForProcessGone(remote!.pid!)).toBe(true);
    expect(await waitForProcessGone(control!.pid!)).toBe(true);
    for (const path of [dumpPath, `${dumpPath}.partial`, fingerprintPath]) {
      expect(await pathIsAbsent(path)).toBe(true);
    }
  });

  it("surfaces remote Docker termination failure after local cleanup", async () => {
    const dumpPath = join(runDirectory, "remote-stop-failure.dump");
    const fingerprintPath = join(runDirectory, "remote-stop-failure.json");
    const dockerPath = join(runDirectory, "remote-stop-failure-docker");
    const logPath = join(runDirectory, "remote-stop-failure-log.jsonl");
    const readyPath = join(runDirectory, "remote-stop-failure-ready");
    await createInterruptibleFakeDocker(
      dockerPath,
      logPath,
      readyPath,
      { failRemoteStop: true },
    );
    const execution = runChild(
      process.execPath,
      [coordinator, dumpPath, fingerprintPath],
      {
        ...process.env,
        BACKUP_CREDENTIAL_DIRECTORY: runDirectory,
        DATABASE_URL: secretSourceUrl,
        PG_DUMP_DOCKER_CONTAINER: "nonsecret-container-id",
        DOCKER_BIN: dockerPath,
      },
    );

    await waitForFile(readyPath, execution.result);
    execution.child.kill("SIGINT");
    const result = await execution.result;
    const captures = await readJsonLines(logPath);

    expect(result).toEqual({
      code: 1,
      signal: null,
      stdout: "",
      stderr: "Production backup failed.\n",
    });
    expect(JSON.stringify(captures)).toContain("remoteFailure");
    expect(`${result.stdout}${result.stderr}`).not.toContain(secretSourceUrl);
    expect(`${result.stdout}${result.stderr}`).not.toContain(passwordSentinel);
    for (const path of [dumpPath, `${dumpPath}.partial`, fingerprintPath]) {
      expect(await pathIsAbsent(path)).toBe(true);
    }
  });

  it("bounds a hung remote-stop Docker CLI without leaving the dump child", async () => {
    const dumpPath = join(runDirectory, "hung-remote-stop.dump");
    const fingerprintPath = join(runDirectory, "hung-remote-stop.json");
    const dockerPath = join(runDirectory, "hung-remote-stop-docker");
    const logPath = join(runDirectory, "hung-remote-stop-log.jsonl");
    const dumpReadyPath = join(runDirectory, "hung-remote-stop-dump-ready");
    const cleanupReadyPath = join(runDirectory, "hung-remote-stop-cli-ready");
    await createInterruptibleFakeDocker(
      dockerPath,
      logPath,
      dumpReadyPath,
      { hangRemoteStop: true, cleanupReadyPath },
    );
    const execution = runChild(
      process.execPath,
      [coordinator, dumpPath, fingerprintPath],
      {
        ...process.env,
        BACKUP_CREDENTIAL_DIRECTORY: runDirectory,
        DATABASE_URL: secretSourceUrl,
        PG_DUMP_DOCKER_CONTAINER: "nonsecret-container-id",
        DOCKER_BIN: dockerPath,
      },
    );

    await waitForFile(dumpReadyPath, execution.result);
    const initialCaptures = await readJsonLines(logPath);
    const copy = initialCaptures.find((capture) => capture.args[0] === "cp")!;
    const remote = initialCaptures.find(
      (capture) => capture.pid !== undefined && !capture.hang,
    )!;
    execution.child.kill("SIGTERM");
    await waitForFile(cleanupReadyPath, execution.result);
    const bounded = await boundedChildResult(execution.result);
    const captures = await readJsonLines(logPath);
    const cleanupControl = captures.find(
      (capture) => capture.hang === "remote-stop",
    );
    if (bounded === "timeout") {
      forceKill(cleanupControl?.pid);
      forceKill(remote.pid);
      execution.child.kill("SIGKILL");
      await boundedChildResult(execution.result, 1_000);
    }
    const containerCredentialPath = copy.args[2].replace(/^[^:]+:/u, "");
    await rm(containerCredentialPath, { force: true });
    if (remote.pidfile) await rm(remote.pidfile, { force: true });

    expect(bounded).not.toBe("timeout");
    expect(bounded).toMatchObject({
      code: 1,
      signal: null,
      stderr: "Production backup failed.\n",
    });
    expect(await waitForProcessGone(remote.pid!)).toBe(true);
    expect(await pathIsAbsent(copy.args[1])).toBe(true);
    for (const path of [dumpPath, `${dumpPath}.partial`, fingerprintPath]) {
      expect(await pathIsAbsent(path)).toBe(true);
    }
  }, 10_000);

  it("bounds a hung container credential cleanup CLI and completes best effort", async () => {
    const dumpPath = join(runDirectory, "hung-cleanup-rm.dump");
    const fingerprintPath = join(runDirectory, "hung-cleanup-rm.json");
    const dockerPath = join(runDirectory, "hung-cleanup-rm-docker");
    const logPath = join(runDirectory, "hung-cleanup-rm-log.jsonl");
    const dumpReadyPath = join(runDirectory, "hung-cleanup-rm-dump-ready");
    const cleanupReadyPath = join(runDirectory, "hung-cleanup-rm-cli-ready");
    await createInterruptibleFakeDocker(
      dockerPath,
      logPath,
      dumpReadyPath,
      { hangCleanupRm: true, cleanupReadyPath },
    );
    const execution = runChild(
      process.execPath,
      [coordinator, dumpPath, fingerprintPath],
      {
        ...process.env,
        BACKUP_CREDENTIAL_DIRECTORY: runDirectory,
        DATABASE_URL: secretSourceUrl,
        PG_DUMP_DOCKER_CONTAINER: "nonsecret-container-id",
        DOCKER_BIN: dockerPath,
      },
    );

    await waitForFile(dumpReadyPath, execution.result);
    const initialCaptures = await readJsonLines(logPath);
    const copy = initialCaptures.find((capture) => capture.args[0] === "cp")!;
    const remote = initialCaptures.find((capture) => capture.pid !== undefined)!;
    execution.child.kill("SIGINT");
    await waitForFile(cleanupReadyPath, execution.result);
    const bounded = await boundedChildResult(execution.result);
    const captures = await readJsonLines(logPath);
    const cleanupControl = captures.find(
      (capture) => capture.hang === "cleanup-rm",
    );
    if (bounded === "timeout") {
      forceKill(cleanupControl?.pid);
      execution.child.kill("SIGKILL");
      await boundedChildResult(execution.result, 1_000);
    }
    const containerCredentialPath = copy.args[2].replace(/^[^:]+:/u, "");
    await rm(containerCredentialPath, { force: true });
    if (remote.pidfile) await rm(remote.pidfile, { force: true });

    expect(bounded).not.toBe("timeout");
    expect(bounded).toMatchObject({
      code: 1,
      signal: null,
      stderr: "Production backup failed.\n",
    });
    expect(await waitForProcessGone(remote.pid!)).toBe(true);
    expect(await pathIsAbsent(copy.args[1])).toBe(true);
    for (const path of [dumpPath, `${dumpPath}.partial`, fingerprintPath]) {
      expect(await pathIsAbsent(path)).toBe(true);
    }
  }, 10_000);

  it("removes published outputs when signaled before the success commit point", async () => {
    const dumpPath = join(runDirectory, "post-publish.dump");
    const fingerprintPath = join(runDirectory, "post-publish.json");
    const gatePath = join(runDirectory, "post-publish-release");
    const execution = runChild(
      process.execPath,
      [coordinator, dumpPath, fingerprintPath],
      {
        ...process.env,
        BACKUP_COMMIT_GATE_FILE: gatePath,
        BACKUP_CREDENTIAL_DIRECTORY: runDirectory,
        DATABASE_URL: secretSourceUrl,
        PG_DUMP_BIN: requiredEnvironment("PG17_DUMP_BIN"),
      },
    );

    await waitForFile(dumpPath, execution.result);
    await waitForFile(fingerprintPath, execution.result);
    execution.child.kill("SIGTERM");
    const result = await execution.result;

    expect(result).toMatchObject({ code: 143, signal: null });
    for (const path of [
      dumpPath,
      `${dumpPath}.partial`,
      fingerprintPath,
      `${fingerprintPath}.partial`,
    ]) {
      expect(await pathIsAbsent(path)).toBe(true);
    }
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
      const dump = captures.find(
        (capture) =>
          capture.args.some((argument) => argument.includes("pg_dump")) &&
          capture.args.some((argument) => argument.startsWith("--snapshot=")),
      );
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
