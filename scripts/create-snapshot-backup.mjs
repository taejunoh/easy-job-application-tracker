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

const SIGNAL_EXIT_CODES = new Map([
  ["SIGINT", 130],
  ["SIGTERM", 143],
]);
const TERMINATION_GRACE_MS = 2_000;
const CLEANUP_CONTROL_TIMEOUT_MS = 2_500;
const DOCKER_DUMP_WRAPPER = [
  "set -u",
  "pidfile=$1; startfile=$2; cancelfile=$3; shift 3",
  "umask 077",
  "child=",
  "terminate() {",
  "  if [ -n \"$child\" ]; then",
  "    kill -TERM \"$child\" 2>/dev/null || true",
  "    wait \"$child\" 2>/dev/null || true",
  "  fi",
  "  exit 143",
  "}",
  "trap terminate INT TERM HUP",
  "printf '%s\\n' \"$$\" > \"$pidfile\"",
  "while [ ! -e \"$startfile\" ]; do",
  "  [ -e \"$cancelfile\" ] && exit 143",
  "  sleep 0.05",
  "done",
  "[ -e \"$cancelfile\" ] && exit 143",
  "sh -c 'kill -STOP \"$$\"; exec pg_dump \"$@\"' jobtracker-pg-dump \"$@\" &",
  "child=$!",
  "printf '%s\\n' \"$child\" > \"$pidfile\"",
  "[ -e \"$cancelfile\" ] && terminate",
  "kill -CONT \"$child\"",
  "wait \"$child\"",
  "status=$?",
  "trap - INT TERM HUP",
  "exit \"$status\"",
].join("\n");
const DOCKER_STOP_WRAPPER = [
  "set -eu",
  "pidfile=$1; cancelfile=$2",
  "umask 077; : > \"$cancelfile\"",
  "[ -s \"$pidfile\" ] || exit 0",
  "pid=$(cat \"$pidfile\")",
  "case $pid in (*[!0-9]*|'') exit 0;; esac",
  "kill -0 \"$pid\" 2>/dev/null || exit 0",
  "kill -INT \"$pid\" 2>/dev/null || exit 0",
  "sleep 0.1",
  "kill -TERM \"$pid\" 2>/dev/null || true",
  "sleep 0.1",
  "kill -KILL \"$pid\" 2>/dev/null || true",
  "exit 0",
].join("\n");

function onceAsync(operation) {
  let promise;
  return () => {
    promise ??= Promise.resolve().then(operation);
    return promise;
  };
}

function createSignalSupervisor() {
  let interruption;
  let shutdownError;
  let databaseTermination;
  const activeTerminations = new Set();
  const pending = new Set();
  const listeners = new Map();

  const schedule = (operation) => {
    if (!operation) return;
    const promise = Promise.resolve().then(operation).catch((error) => {
      shutdownError ??= error;
    });
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
  };
  const request = (signal) => {
    if (interruption) return;
    interruption = { signal, exitCode: SIGNAL_EXIT_CODES.get(signal) };
    schedule(databaseTermination);
    for (const termination of activeTerminations) schedule(termination);
  };

  return {
    install() {
      for (const signal of SIGNAL_EXIT_CODES.keys()) {
        const listener = () => request(signal);
        listeners.set(signal, listener);
        process.on(signal, listener);
      }
    },
    remove() {
      for (const [signal, listener] of listeners) {
        process.off(signal, listener);
      }
      listeners.clear();
    },
    get interruption() {
      return interruption;
    },
    get shutdownError() {
      return shutdownError;
    },
    throwIfInterrupted() {
      if (interruption) throw new Error("Backup interrupted");
    },
    track(termination) {
      activeTerminations.add(termination);
      if (interruption) schedule(termination);
      return () => activeTerminations.delete(termination);
    },
    trackDatabase(termination) {
      databaseTermination = termination;
      if (interruption) schedule(termination);
    },
    recordFailure(error) {
      shutdownError ??= error;
    },
    async settle() {
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
    },
  };
}

function childOutcome(child) {
  return new Promise((resolve) => {
    let childError;
    child.once("error", (error) => {
      childError = error;
    });
    child.once("close", (code, signal) =>
      resolve({ code, signal, error: childError }),
    );
  });
}

async function waitBounded(promise, milliseconds) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), milliseconds);
    timer.unref?.();
  });
  const completed = await Promise.race([promise.then(() => true), expired]);
  clearTimeout(timer);
  return completed;
}

function signalChildTree(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function terminateChild(child, outcome) {
  if (child.exitCode !== null || child.signalCode !== null) {
    await outcome;
    return;
  }
  signalChildTree(child, "SIGTERM");
  if (await waitBounded(outcome, TERMINATION_GRACE_MS)) return;
  signalChildTree(child, "SIGKILL");
  await outcome;
}

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
  const dumpApplicationName = `jobtracker_backup_dump_${identifier}`;
  parameters.set("application_name", dumpApplicationName);
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
        "sh",
        "-c",
        DOCKER_DUMP_WRAPPER,
        "jobtracker-backup",
        credential.pidPath,
        credential.startPath,
        credential.cancelPath,
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

async function runSilent(command, args, options = {}) {
  options.supervisor?.throwIfInterrupted();
  const child = spawn(command, args, {
    env: childEnvironment(),
    stdio: ["ignore", "ignore", "ignore"],
    detached: process.platform !== "win32",
  });
  const outcome = childOutcome(child);
  const termination = onceAsync(() => terminateChild(child, outcome));
  const release = options.supervisor?.track(termination);
  const result = await outcome;
  release?.();
  if (!result.error && result.code === 0) return true;
  if (options.allowFailure) return false;
  throw new Error("Credential transport failed");
}

async function runCleanupControl(command, args) {
  const child = spawn(command, args, {
    env: childEnvironment(),
    stdio: ["ignore", "ignore", "ignore"],
    detached: process.platform !== "win32",
  });
  const outcome = childOutcome(child);
  const completed = await waitBounded(outcome, CLEANUP_CONTROL_TIMEOUT_MS);
  if (!completed) {
    await terminateChild(child, outcome);
    throw new Error("Backup cleanup control timed out");
  }
  const result = await outcome;
  if (result.error || result.code !== 0) {
    throw new Error("Backup cleanup control failed");
  }
}

async function waitForDockerPidFile(docker, container, credential, supervisor) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    supervisor.throwIfInterrupted();
    const ready = await runSilent(
      docker,
      [
        "exec",
        container,
        "sh",
        "-c",
        'test -s "$1"',
        "jobtracker-backup",
        credential.pidPath,
      ],
      { allowFailure: true, supervisor },
    );
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("pg_dump failed");
}

async function dumpSnapshot(
  databaseUrl,
  exportedSnapshot,
  dumpPath,
  createdPaths,
  supervisor,
) {
  const partialPath = `${dumpPath}.partial`;
  createdPaths.add(partialPath);
  const credential = await createServiceCredential(databaseUrl);
  const container = process.env.PG_DUMP_DOCKER_CONTAINER;
  const docker = process.env.DOCKER_BIN ?? "docker";
  if (container) {
    credential.containerPath = `/tmp/.jobtracker-pg-service-${credential.identifier}.conf`;
    credential.pidPath = `/tmp/.jobtracker-pg-dump-${credential.identifier}.pid`;
    credential.startPath = `/tmp/.jobtracker-pg-dump-${credential.identifier}.start`;
    credential.cancelPath = `/tmp/.jobtracker-pg-dump-${credential.identifier}.cancel`;
  }
  try {
    supervisor.throwIfInterrupted();
    if (container) {
      await runSilent(docker, [
        "cp",
        credential.hostPath,
        `${container}:${credential.containerPath}`,
      ], { supervisor });
      await runSilent(docker, [
        "exec",
        container,
        "chmod",
        "600",
        credential.containerPath,
      ], { supervisor });
    }
    supervisor.throwIfInterrupted();
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
      detached: process.platform !== "win32",
    });
    child.stderr.resume();
    const outcome = childOutcome(child);
    const termination = onceAsync(async () => {
      let remoteTerminationError;
      if (container) {
        try {
          await runCleanupControl(docker, [
            "exec",
            container,
            "sh",
            "-c",
            DOCKER_STOP_WRAPPER,
            "jobtracker-backup",
            credential.pidPath,
            credential.cancelPath,
          ]);
        } catch (error) {
          remoteTerminationError = error;
        }
      }
      await terminateChild(child, outcome);
      if (remoteTerminationError) throw new Error("Remote pg_dump cleanup failed");
    });
    const release = supervisor.track(termination);
    try {
      if (container) {
        await waitForDockerPidFile(docker, container, credential, supervisor);
        supervisor.throwIfInterrupted();
        await runSilent(
          docker,
          [
            "exec",
            container,
            "sh",
            "-c",
            'umask 077; : > "$1"',
            "jobtracker-backup",
            credential.startPath,
          ],
          { supervisor },
        );
      }
      const completion = outcome.then((result) => {
        if (result.error || result.code !== 0) throw new Error("pg_dump failed");
      });
      const results = await Promise.allSettled([
        pipeline(child.stdout, output),
        completion,
      ]);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      supervisor.throwIfInterrupted();
    } catch (error) {
      await termination();
      throw error;
    } finally {
      release();
    }
  } finally {
    await supervisor.settle();
    const cleanup = [];
    if (container) {
      cleanup.push(
        runCleanupControl(docker, [
          "exec",
          container,
          "rm",
          "-f",
          credential.containerPath,
          credential.pidPath,
          credential.startPath,
          credential.cancelPath,
        ]),
      );
    }
    cleanup.push(rm(credential.hostPath, { force: true }));
    const results = await Promise.allSettled(cleanup);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      supervisor.recordFailure(failure.reason);
      throw failure.reason;
    }
  }
  await chmod(partialPath, 0o600);
  await rename(partialPath, dumpPath);
  createdPaths.delete(partialPath);
  createdPaths.add(dumpPath);
}

async function createSnapshotBackup(
  databaseUrl,
  dumpPath,
  fingerprintPath,
  supervisor,
) {
  const fingerprintPartialPath = `${fingerprintPath}.partial`;
  const paths = [dumpPath, `${dumpPath}.partial`, fingerprintPath, fingerprintPartialPath];
  await Promise.all(paths.map(requireAbsent));
  const createdPaths = new Set();
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "jobtracker-backup-coordinator",
  });
  const endClient = onceAsync(() => client.end().catch(() => undefined));
  const cancelAndEndClient = onceAsync(async () => {
    if (client.processID) {
      const cancellationClient = new Client({
        connectionString: databaseUrl,
        application_name: "jobtracker-backup-cleanup",
      });
      try {
        await cancellationClient.connect();
        await cancellationClient.query("SELECT pg_cancel_backend($1)", [
          client.processID,
        ]);
      } finally {
        await cancellationClient.end().catch(() => undefined);
      }
    }
    await endClient();
  });
  supervisor.trackDatabase(cancelAndEndClient);
  let transactionStarted = false;

  try {
    supervisor.throwIfInterrupted();
    await client.connect();
    supervisor.throwIfInterrupted();
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
      supervisor,
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
    supervisor.throwIfInterrupted();
    const fingerprint = fingerprintResult.value;
    createdPaths.add(fingerprintPartialPath);
    await writeFingerprint(fingerprintPartialPath, fingerprint);
    supervisor.throwIfInterrupted();
    await rename(fingerprintPartialPath, fingerprintPath);
    createdPaths.delete(fingerprintPartialPath);
    createdPaths.add(fingerprintPath);
    supervisor.throwIfInterrupted();
  } catch (error) {
    await supervisor.settle();
    await Promise.all(
      [...createdPaths].map((path) => rm(path, { force: true })),
    );
    throw error;
  } finally {
    if (transactionStarted && !supervisor.interruption) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    await endClient();
  }
}

async function waitForCommitGate(supervisor) {
  const gatePath = process.env.BACKUP_COMMIT_GATE_FILE;
  if (!gatePath) return;
  while (true) {
    try {
      await access(gatePath);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    supervisor.throwIfInterrupted();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function removeBackupOutputs(dumpPath, fingerprintPath) {
  await Promise.all([
    rm(dumpPath, { force: true }),
    rm(`${dumpPath}.partial`, { force: true }),
    rm(fingerprintPath, { force: true }),
    rm(`${fingerprintPath}.partial`, { force: true }),
  ]);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const dumpPath = process.argv[2];
  const fingerprintPath = process.argv[3];
  if (!databaseUrl || !dumpPath || !fingerprintPath || dumpPath === fingerprintPath) {
    throw new Error("Missing backup input");
  }
  const supervisor = createSignalSupervisor();
  supervisor.install();
  let listenersInstalled = true;
  try {
    await createSnapshotBackup(
      databaseUrl,
      dumpPath,
      fingerprintPath,
      supervisor,
    );
    await waitForCommitGate(supervisor);
    await supervisor.settle();
    supervisor.throwIfInterrupted();
    supervisor.remove();
    listenersInstalled = false;
  } catch (error) {
    await supervisor.settle();
    if (supervisor.interruption) {
      await removeBackupOutputs(dumpPath, fingerprintPath);
    }
    if (!supervisor.interruption || supervisor.shutdownError) throw error;
  } finally {
    if (listenersInstalled) supervisor.remove();
  }
  return supervisor.interruption;
}

try {
  const interruption = await main();
  if (interruption) process.exitCode = interruption.exitCode;
  else process.stdout.write("Production backup snapshot created.\n");
} catch {
  process.stderr.write("Production backup failed.\n");
  process.exitCode = 1;
}
