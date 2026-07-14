import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, chmod, rename, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import {
  fingerprintClient,
  writeFingerprint,
} from "./fingerprint-database.mjs";

const { Client } = pg;

async function requireAbsent(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Backup output already exists");
}

function pgDumpCommand(databaseUrl, exportedSnapshot) {
  const args = [
    `--dbname=${databaseUrl}`,
    `--snapshot=${exportedSnapshot}`,
    "--format=custom",
    "--no-owner",
    "--no-privileges",
  ];
  const container = process.env.PG_DUMP_DOCKER_CONTAINER;
  if (container) {
    return { command: "docker", args: ["exec", container, "pg_dump", ...args] };
  }
  return { command: process.env.PG_DUMP_BIN ?? "pg_dump", args };
}

async function dumpSnapshot(databaseUrl, exportedSnapshot, dumpPath, createdPaths) {
  const partialPath = `${dumpPath}.partial`;
  createdPaths.add(partialPath);
  const output = createWriteStream(partialPath, {
    flags: "wx",
    mode: 0o600,
  });
  const { command, args } = pgDumpCommand(databaseUrl, exportedSnapshot);
  const child = spawn(command, args, {
    env: process.env,
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
