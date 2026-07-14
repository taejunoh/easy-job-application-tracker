import { spawn } from "node:child_process";
import { resolve } from "node:path";

import pg from "pg";

import {
  E2E_ACCESS_TOKEN,
  E2E_CONFIGURED_APP_ORIGIN,
  E2E_ENCRYPTION_SECRET,
} from "./extension-e2e-fixtures.mjs";
import {
  assertLocalPostgres17Identity,
  assertSafeExtensionE2EAdminUrl,
} from "./extension-e2e-support.mjs";

const { Client } = pg;
const root = resolve(import.meta.dirname, "..");
const databaseName = "jobtracker_extension_e2e_test";
const adminUrl =
  process.env.EXTENSION_E2E_POSTGRES_ADMIN_URL ??
  "postgresql://postgres@127.0.0.1:5432/postgres";
const childTerminationTimeout =
  process.env.EXTENSION_E2E_LOCAL_SIGNAL_FIXTURE === "1" ? 250 : 5_000;
const state = {
  admin: null,
  child: null,
  cleanupPromise: null,
  identity: null,
  ownsDatabase: false,
  requestedSignal: null,
  target: null,
  treeTerminationPromise: null,
};

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (state.requestedSignal) return;
    state.requestedSignal = signal;
    state.treeTerminationPromise = terminateActiveChildTree(signal);
  });
}

let failure = null;
try {
  const target = assertSafeExtensionE2EAdminUrl(adminUrl);
  state.target = target;
  const admin = new Client({ connectionString: adminUrl });
  state.admin = admin;
  await admin.connect();
  state.identity = await verifyPostgres17(admin, target);
  throwIfShutdownRequested();

  const existing = await admin.query(
    "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
    [databaseName],
  );
  if (existing.rows[0]?.exists === true) {
    throw new Error("Refusing extension E2E: disposable database already exists");
  }
  throwIfShutdownRequested();

  await admin.query(`CREATE DATABASE ${quotedDatabaseName()}`);
  state.ownsDatabase = true;
  throwIfShutdownRequested();

  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const childEnvironment = {
    ...process.env,
    NODE_ENV: "production",
    RUN_EXTENSION_E2E: "1",
    ALLOW_DESTRUCTIVE_EXTENSION_E2E:
      "jobtracker-extension-e2e-delete-all",
    DATABASE_URL: databaseUrl.toString(),
    EXPECTED_DATABASE_SERVER_ADDRESS: state.identity.address,
    ENCRYPTION_SECRET: E2E_ENCRYPTION_SECRET,
    APP_ACCESS_TOKEN: E2E_ACCESS_TOKEN,
    APP_BASE_URL: E2E_CONFIGURED_APP_ORIGIN,
    CORS_ALLOWED_ORIGINS:
      `${E2E_CONFIGURED_APP_ORIGIN},` +
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
  };
  delete childEnvironment.EXTENSION_E2E_POSTGRES_ADMIN_URL;

  if (process.env.EXTENSION_E2E_LOCAL_SIGNAL_FIXTURE === "1") {
    if (process.env.RUN_EXTENSION_E2E_SIGNAL_INTEGRATION !== "1") {
      throw new Error("Refusing extension E2E: signal fixture sentinel missing");
    }
    await runChild(
      process.execPath,
      [
        resolve(
          root,
          "__tests__/fixtures/extension-e2e/hanging-build-parent.mjs",
        ),
      ],
      childEnvironment,
    );
  } else {
    await runChild("npm", ["run", "build"], childEnvironment);
    throwIfShutdownRequested();
    await runChild(
      process.execPath,
      [resolve(root, "scripts/extension-e2e.mjs")],
      childEnvironment,
    );
  }
} catch (error) {
  if (!state.requestedSignal) failure = error;
} finally {
  try {
    if (state.treeTerminationPromise) await state.treeTerminationPromise;
    await cleanup();
  } catch (error) {
    failure ??= error;
  }
}

if (failure) {
  process.stderr.write(
    `${failure instanceof Error ? failure.message : "Local extension E2E failed"}\n`,
  );
  process.exitCode = 1;
} else if (state.requestedSignal) {
  process.exitCode = state.requestedSignal === "SIGINT" ? 130 : 143;
}

async function verifyPostgres17(admin, target) {
  const result = await admin.query(
    "SELECT current_database() AS database, host(inet_server_addr()) AS address, inet_server_port() AS port, current_setting('server_version_num')::integer AS version",
  );
  if (result.rows.length !== 1) {
    throw new Error("Refusing extension E2E: live PostgreSQL 17 identity mismatch");
  }
  return assertLocalPostgres17Identity(result.rows[0], target);
}

async function runChild(command, args, environment) {
  throwIfShutdownRequested();
  const child = spawn(command, args, {
    cwd: root,
    detached: true,
    env: environment,
    stdio: "inherit",
  });
  const ownership = {
    child,
    closePromise: null,
    closed: false,
    spawnError: null,
    terminationPromise: null,
  };
  ownership.closePromise = new Promise((resolveClose) => {
    child.once("error", (error) => {
      ownership.spawnError = error;
    });
    child.once("close", (code, signal) => {
      ownership.closed = true;
      resolveClose({ code, signal });
    });
  });
  state.child = ownership;
  if (state.requestedSignal) {
    state.treeTerminationPromise = terminateActiveChildTree(
      state.requestedSignal,
    );
  }
  const result = await ownership.closePromise;
  if (state.child === ownership) state.child = null;
  if (ownership.spawnError) throw ownership.spawnError;
  throwIfShutdownRequested();
  if (result.code !== 0) {
    throw new Error("Local extension E2E child command failed");
  }
}

function terminateActiveChildTree(signal = "SIGTERM") {
  const ownership = state.child;
  if (!ownership || ownership.closed) return Promise.resolve();
  if (ownership.terminationPromise) return ownership.terminationPromise;
  ownership.terminationPromise = (async () => {
    signalChildProcessGroup(ownership.child, signal);
    let closed = await waitForClose(
      ownership.closePromise,
      childTerminationTimeout,
    );
    if (!closed) {
      signalChildProcessGroup(ownership.child, "SIGKILL");
      closed = await waitForClose(
        ownership.closePromise,
        childTerminationTimeout,
      );
    }
    if (!closed) {
      throw new Error("Local extension E2E child process group did not close");
    }
  })();
  return ownership.terminationPromise;
}

function signalChildProcessGroup(child, signal) {
  if (!Number.isInteger(child.pid) || child.pid < 1) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForClose(closePromise, timeout) {
  return Promise.race([
    closePromise.then(() => true),
    new Promise((resolveWait) =>
      setTimeout(() => resolveWait(false), timeout),
    ),
  ]);
}

function cleanup() {
  if (state.cleanupPromise) return state.cleanupPromise;
  state.cleanupPromise = (async () => {
    await terminateActiveChildTree(state.requestedSignal ?? "SIGTERM");
    let cleanupError = null;
    if (state.admin) {
      try {
        if (state.ownsDatabase) {
          if (!state.identity || !state.target) {
            throw new Error(
              "Refusing extension E2E: admin identity was not verified",
            );
          }
          await verifyPostgres17(state.admin, state.target);
          await state.admin.query(
            `DROP DATABASE IF EXISTS ${quotedDatabaseName()} WITH (FORCE)`,
          );
          state.ownsDatabase = false;
        }
      } catch (error) {
        cleanupError = error;
      }
      try {
        await state.admin.end();
      } catch (error) {
        cleanupError ??= error;
      }
      state.admin = null;
    }
    if (cleanupError) throw cleanupError;
  })();
  return state.cleanupPromise;
}

function throwIfShutdownRequested() {
  if (state.requestedSignal) {
    throw new Error("Local extension E2E interrupted");
  }
}

function quotedDatabaseName() {
  return `"${databaseName}"`;
}
