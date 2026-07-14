import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import {
  fingerprintClient,
  writeFingerprint,
} from "./fingerprint-database.mjs";

const { Client } = pg;

const CHILD_ENVIRONMENT_ALLOWLIST = [
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TMPDIR",
];

const RESERVED_SERVICE_PARAMETERS = new Set([
  "dbname",
  "host",
  "password",
  "passfile",
  "port",
  "service",
  "servicefile",
  "user",
]);

async function requireAbsent(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Backup output already exists");
}

function childEnvironment(additions = {}) {
  const environment = {};
  for (const name of CHILD_ENVIRONMENT_ALLOWLIST) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return { ...environment, ...additions };
}

function serviceValue(value) {
  if (/[\0\r\n]/u.test(value) || value.trim() !== value) {
    throw new Error("Invalid database credential");
  }
  return value;
}

async function createServiceCredential(databaseUrl) {
  const url = new URL(databaseUrl);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("Invalid database credential");
  }
  const identifier = randomBytes(16).toString("hex");
  const serviceName = `jobtracker_backup_${identifier}`;
  const directory =
    process.env.BACKUP_CREDENTIAL_DIRECTORY ??
    process.env.RUNNER_TEMP ??
    tmpdir();
  const hostPath = join(directory, `.jobtracker-pg-service-${identifier}.conf`);
  const parameters = new Map([
    ["host", url.hostname.replace(/^\[|\]$/gu, "")],
    ["dbname", decodeURIComponent(url.pathname.replace(/^\//u, ""))],
    ["user", decodeURIComponent(url.username)],
    ["password", decodeURIComponent(url.password)],
  ]);
  if (url.port) parameters.set("port", url.port);
  for (const [name, value] of url.searchParams) {
    if (!/^[a-z_]+$/u.test(name) || RESERVED_SERVICE_PARAMETERS.has(name)) {
      throw new Error("Invalid database credential");
    }
    parameters.set(name, value);
  }
  if (!parameters.get("host") || !parameters.get("dbname")) {
    throw new Error("Invalid database credential");
  }
  const contents = [
    `[${serviceName}]`,
    ...[...parameters].map(
      ([name, value]) => `${name}=${serviceValue(value)}`,
    ),
    "",
  ].join("\n");
  try {
    await writeFile(hostPath, contents, { flag: "wx", mode: 0o600 });
    await chmod(hostPath, 0o600);
  } catch (error) {
    await rm(hostPath, { force: true });
    throw error;
  }
  return { identifier, serviceName, hostPath };
}

function pgDumpCommand(credential, exportedSnapshot) {
  const args = [
    `--dbname=service=${credential.serviceName}`,
    `--snapshot=${exportedSnapshot}`,
    "--format=custom",
    "--no-owner",
    "--no-privileges",
  ];
  const container = process.env.PG_DUMP_DOCKER_CONTAINER;
  if (container) {
    return {
      command: process.env.DOCKER_BIN ?? "docker",
      args: [
        "exec",
        "--env",
        `PGSERVICEFILE=${credential.containerPath}`,
        container,
        "pg_dump",
        ...args,
      ],
      environment: childEnvironment(),
    };
  }
  return {
    command: process.env.PG_DUMP_BIN ?? "pg_dump",
    args,
    environment: childEnvironment({ PGSERVICEFILE: credential.hostPath }),
  };
}

async function runSilent(command, args) {
  const child = spawn(command, args, {
    env: childEnvironment(),
    stdio: ["ignore", "ignore", "ignore"],
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("Credential transport failed"));
    });
  });
}

async function dumpSnapshot(databaseUrl, exportedSnapshot, dumpPath, createdPaths) {
  const partialPath = `${dumpPath}.partial`;
  createdPaths.add(partialPath);
  const credential = await createServiceCredential(databaseUrl);
  const container = process.env.PG_DUMP_DOCKER_CONTAINER;
  const docker = process.env.DOCKER_BIN ?? "docker";
  if (container) {
    credential.containerPath = `/tmp/.jobtracker-pg-service-${credential.identifier}.conf`;
  }
  try {
    if (container) {
      await runSilent(docker, [
        "cp",
        credential.hostPath,
        `${container}:${credential.containerPath}`,
      ]);
      await runSilent(docker, [
        "exec",
        container,
        "chmod",
        "600",
        credential.containerPath,
      ]);
    }
    const output = createWriteStream(partialPath, {
      flags: "wx",
      mode: 0o600,
    });
    const { command, args, environment } = pgDumpCommand(
      credential,
      exportedSnapshot,
    );
    const child = spawn(command, args, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.resume();
    const completion = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error("pg_dump failed"));
      });
    });
    await Promise.all([pipeline(child.stdout, output), completion]);
  } finally {
    const cleanup = [];
    if (container) {
      cleanup.push(
        runSilent(docker, [
          "exec",
          container,
          "rm",
          "-f",
          credential.containerPath,
        ]),
      );
    }
    cleanup.push(rm(credential.hostPath, { force: true }));
    const results = await Promise.allSettled(cleanup);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  await chmod(partialPath, 0o600);
  await rename(partialPath, dumpPath);
  createdPaths.delete(partialPath);
  createdPaths.add(dumpPath);
}

async function createSnapshotBackup(databaseUrl, dumpPath, fingerprintPath) {
  const fingerprintPartialPath = `${fingerprintPath}.partial`;
  const paths = [dumpPath, `${dumpPath}.partial`, fingerprintPath, fingerprintPartialPath];
  await Promise.all(paths.map(requireAbsent));
  const createdPaths = new Set();
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "jobtracker-backup-coordinator",
  });
  let transactionStarted = false;

  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionStarted = true;
    const snapshotResult = await client.query("SELECT pg_export_snapshot()");
    const exportedSnapshot = snapshotResult.rows[0]?.pg_export_snapshot;
    if (typeof exportedSnapshot !== "string" || exportedSnapshot.length === 0) {
      throw new Error("Snapshot export failed");
    }

    const dumpPromise = dumpSnapshot(
      databaseUrl,
      exportedSnapshot,
      dumpPath,
      createdPaths,
    );
    const fingerprintPromise = fingerprintClient(client);
    const [dumpResult, fingerprintResult] = await Promise.allSettled([
      dumpPromise,
      fingerprintPromise,
    ]);
    if (dumpResult.status === "rejected") throw dumpResult.reason;
    if (fingerprintResult.status === "rejected") {
      throw fingerprintResult.reason;
    }
    const fingerprint = fingerprintResult.value;
    createdPaths.add(fingerprintPartialPath);
    await writeFingerprint(fingerprintPartialPath, fingerprint);
    await rename(fingerprintPartialPath, fingerprintPath);
    createdPaths.delete(fingerprintPartialPath);
    createdPaths.add(fingerprintPath);
  } catch (error) {
    await Promise.all(
      [...createdPaths].map((path) => rm(path, { force: true })),
    );
    throw error;
  } finally {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const dumpPath = process.argv[2];
  const fingerprintPath = process.argv[3];
  if (!databaseUrl || !dumpPath || !fingerprintPath || dumpPath === fingerprintPath) {
    throw new Error("Missing backup input");
  }
  await createSnapshotBackup(databaseUrl, dumpPath, fingerprintPath);
}

try {
  await main();
  process.stdout.write("Production backup snapshot created.\n");
} catch {
  process.stderr.write("Production backup failed.\n");
  process.exitCode = 1;
}
